import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KiroCredentials } from "../src/oauth.js";
import { refreshKiroToken } from "../src/oauth.js";
import { getPiHostKiroCredentialsForToken, refreshPiHostKiroCredentials } from "../src/pi-auth-store.js";
import { resetProfileArnCache, streamKiro } from "../src/stream.js";
import { concatMessages, encodeEventMessage } from "./helpers/event-stream.js";

const sources = vi.hoisted(() => ({ cli: vi.fn(), ide: vi.fn(), refreshCli: vi.fn(), saveCli: vi.fn() }));
vi.mock("../src/kiro-cli.js", () => ({
  getKiroCliCredentials: sources.cli,
  getKiroCliCredentialsAllowExpired: vi.fn(() => undefined),
  getKiroCliSocialToken: vi.fn(() => undefined),
  getKiroCliSocialTokenAllowExpired: vi.fn(() => undefined),
  refreshViaKiroCli: sources.refreshCli,
  saveKiroCliCredentials: sources.saveCli,
}));
vi.mock("../src/kiro-ide.js", () => ({
  getKiroIdeCredentials: sources.ide,
  getKiroIdeCredentialsAllowExpired: vi.fn(() => undefined),
}));

const arn = "arn:aws:codewhisperer:us-east-1:000000000000:profile/SSOTEST";
const model = {
  id: "claude-sonnet-4-5",
  name: "Sonnet",
  provider: "kiro",
  api: "kiro-api",
  baseUrl: "https://runtime.us-east-1.kiro.dev",
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  contextWindow: 200000,
  maxTokens: 65536,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = { messages: [{ role: "user" as const, content: "Hello", timestamp: 1 }] };

function credential(overrides: Partial<KiroCredentials> = {}) {
  return {
    type: "oauth" as const,
    access: "sso-old-access",
    refresh: "sso-refresh|sso-client|sso-secret|idc",
    expires: Date.now() + 3600000,
    authMethod: "idc" as const,
    region: "ap-southeast-1",
    clientId: "sso-client",
    clientSecret: "sso-secret",
    startUrl: "https://org.awsapps.com/start",
    isEnterprise: true,
    ...overrides,
  };
}
function json(body: unknown, status = 200) {
  return Response.json(body, { status, statusText: status === 403 ? "Forbidden" : undefined });
}
function chat() {
  const frame = concatMessages(
    encodeEventMessage({ content: "SSO-RECOVERED" }),
    encodeEventMessage({ contextUsagePercentage: 0.1 }),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(frame);
        controller.close();
      },
    }),
  );
}

describe("Pi native enterprise SSO recovery", () => {
  let agentDir: string;
  let previousAgentDir: string | undefined;
  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "kiro-sso-recovery-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    sources.cli.mockReset();
    sources.ide.mockReset();
    sources.refreshCli.mockReset();
    sources.saveCli.mockReset();
    resetProfileArnCache(false);
  });
  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    vi.unstubAllGlobals();
    rmSync(agentDir, { recursive: true, force: true });
  });
  function save(creds = credential()) {
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify({ kiro: creds, other: { type: "api_key", key: "other-dummy" } }),
    );
  }
  function stored() {
    return JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
  }

  it("recovers regional profile 403s using Pi's SSO refresh token, without kiro-cli", async () => {
    save();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 403))
      .mockResolvedValueOnce(json({}, 403))
      .mockResolvedValueOnce(json({ accessToken: "sso-new-access", refreshToken: "sso-new-refresh", expiresIn: 3600 }))
      .mockResolvedValueOnce(json({ profiles: [{ arn }] }))
      .mockResolvedValueOnce(chat());
    vi.stubGlobal("fetch", fetchMock);
    const result = await streamKiro(model, context, { apiKey: "sso-old-access" }).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "SSO-RECOVERED" });
    expect(fetchMock.mock.calls[2][0]).toBe("https://oidc.ap-southeast-1.amazonaws.com/token");
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      clientId: "sso-client",
      refreshToken: "sso-refresh",
      grantType: "refresh_token",
    });
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe("Bearer sso-new-access");
    expect(fetchMock.mock.calls[4][1].headers.Authorization).toBe("Bearer sso-new-access");
    expect(stored().kiro).toMatchObject({
      access: "sso-new-access",
      refresh: "sso-new-refresh|sso-client|sso-secret|idc",
      region: "ap-southeast-1",
      type: "oauth",
    });
    expect(stored().other.key).toBe("other-dummy");
    expect(sources.refreshCli).not.toHaveBeenCalled();
    expect(sources.saveCli).not.toHaveBeenCalled();
  });

  it("recovers a runtime 403 and uses the written-back token on the next call", async () => {
    save(credential({ profileArn: arn }));
    sources.cli.mockReturnValue(
      credential({ access: "unrelated-cli-access", refresh: "unrelated|other-client|other-secret|idc" }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 403))
      .mockResolvedValueOnce(json({ accessToken: "sso-new-access", refreshToken: "sso-new-refresh", expiresIn: 3600 }))
      .mockResolvedValueOnce(chat())
      .mockResolvedValueOnce(chat());
    vi.stubGlobal("fetch", fetchMock);
    expect((await streamKiro(model, context, { apiKey: "sso-old-access" }).result()).stopReason).toBe("stop");
    expect(fetchMock.mock.calls[1][0]).toBe("https://oidc.ap-southeast-1.amazonaws.com/token");
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe("Bearer sso-new-access");
    expect((await streamKiro(model, context, { apiKey: "sso-old-access" }).result()).stopReason).toBe("stop");
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe("Bearer sso-new-access");
    expect(sources.refreshCli).not.toHaveBeenCalled();
  });

  it("can refresh an expired access token even when the normal Pi credential reader hides it", async () => {
    save(credential({ expires: 0 }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(json({ accessToken: "fresh", refreshToken: "rotated", expiresIn: 3600 })),
    );
    expect((await refreshPiHostKiroCredentials("sso-old-access", agentDir))?.access).toBe("fresh");
    expect(stored().kiro.expires).toBeGreaterThan(Date.now());
  });

  it("forces renewal after 403 even when the local expiry still says the token is valid", async () => {
    save();
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ accessToken: "fresh", expiresIn: 3600 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await refreshPiHostKiroCredentials("sso-old-access", agentDir))?.access).toBe("fresh");
    expect(stored().kiro.refresh).toBe("sso-refresh|sso-client|sso-secret|idc");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent refreshes so a rotating refresh token is used once", async () => {
    save();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: "fresh", refreshToken: "rotated", expiresIn: 3600 }));
    vi.stubGlobal("fetch", fetchMock);
    const results = await Promise.all([
      refreshPiHostKiroCredentials("sso-old-access", agentDir),
      refreshPiHostKiroCredentials("sso-old-access", agentDir),
    ]);
    expect(results.map((r) => r?.access)).toEqual(["fresh", "fresh"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not replace or refresh a stored account whose token does not match the request", async () => {
    save();
    const before = stored();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await refreshPiHostKiroCredentials("different-token", agentDir)).toBeUndefined();
    expect(stored()).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves credentials intact and reports SSO refresh failure instead of switching to CLI", async () => {
    save(credential({ profileArn: arn }));
    const before = stored();
    sources.cli.mockReturnValue(credential({ access: "unrelated-cli-access" }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 403))
      .mockResolvedValueOnce(json({ error: "invalid_grant" }, 400));
    vi.stubGlobal("fetch", fetchMock);
    const result = await streamKiro(model, context, { apiKey: "sso-old-access" }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Token refresh failed: 400");
    expect(result.errorMessage).toContain("[auth-refresh]");
    expect(result.errorMessage).not.toContain("sso-refresh|");
    expect(stored()).toEqual(before);
    expect(sources.refreshCli).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed successful refresh responses without corrupting auth.json", async () => {
    save();
    const before = stored();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ expiresIn: 3600 })));
    await expect(refreshPiHostKiroCredentials("sso-old-access", agentDir)).rejects.toThrow("missing accessToken");
    expect(stored()).toEqual(before);
  });

  it("does not fabricate a stored login when auth.json is absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await refreshPiHostKiroCredentials("sso-old-access", agentDir)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normal SSO renewal does not adopt another IDE or CLI session", async () => {
    sources.ide.mockReturnValue(credential({ access: "ide-account", refresh: "ide|ide-client|ide-secret|idc" }));
    sources.cli.mockReturnValue(credential({ access: "cli-account", refresh: "cli|cli-client|cli-secret|idc" }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: "own-new-access", refreshToken: "own-rotated", expiresIn: 3600 }));
    vi.stubGlobal("fetch", fetchMock);
    const fresh = await refreshKiroToken(credential({ expires: 0 }));
    expect(fresh.access).toBe("own-new-access");
    expect(fetchMock.mock.calls[0][0]).toBe("https://oidc.ap-southeast-1.amazonaws.com/token");
  });

  it("rejects invalid expiry without writing an unusable credential", async () => {
    save();
    const before = stored();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ accessToken: "fresh", expiresIn: -1 })));
    await expect(refreshPiHostKiroCredentials("sso-old-access", agentDir)).rejects.toThrow("invalid expiresIn");
    expect(stored()).toEqual(before);
  });

  it("does not overwrite a concurrent login while waiting for Pi's credential lock", async () => {
    save();
    const lockfile = createRequire(import.meta.url)("proper-lockfile") as {
      lock(path: string, opts: object): Promise<() => Promise<void>>;
    };
    const release = await lockfile.lock(join(agentDir, "auth.json"), { realpath: false });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const pending = refreshPiHostKiroCredentials("sso-old-access", agentDir);
    const changed = credential({ access: "other-account", refresh: "other-session|other-client|other-secret|idc" });
    save(changed);
    await release();
    await expect(pending).rejects.toThrow("Pi Kiro login changed");
    expect(stored().kiro.access).toBe("other-account");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tracks successive renewals for a long-running call without adopting a different login", async () => {
    save();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ accessToken: "fresh-1", refreshToken: "refresh-1", expiresIn: 3600 }))
        .mockResolvedValueOnce(json({ accessToken: "fresh-2", refreshToken: "refresh-2", expiresIn: 3600 })),
    );
    await refreshPiHostKiroCredentials("sso-old-access", agentDir);
    await refreshPiHostKiroCredentials("fresh-1", agentDir);
    expect(getPiHostKiroCredentialsForToken("sso-old-access", agentDir)?.access).toBe("fresh-2");
    save(credential({ access: "unrelated-login" }));
    expect(getPiHostKiroCredentialsForToken("sso-old-access", agentDir)).toBeUndefined();
  });

  it("does not switch to CLI when a native login changes during the request", async () => {
    save(credential({ profileArn: arn }));
    sources.cli.mockReturnValue(credential({ access: "unrelated-cli-access" }));
    const fetchMock = vi.fn().mockImplementationOnce(async () => {
      save(credential({ access: "new-login", refresh: "new-login-refresh|cid|secret|idc" }));
      return json({}, 403);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await streamKiro(model, context, { apiKey: "sso-old-access" }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Pi Kiro login changed");
    expect(stored().kiro.access).toBe("new-login");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sources.refreshCli).not.toHaveBeenCalled();
  });
});
