// ABOUTME: Reads the Kiro credential pi itself persists in ~/.pi/agent/auth.json.
// ABOUTME: This is the credential pi hands the provider at runtime, so the footer
// ABOUTME: can resolve usage even when no kiro-cli/IDE credential exists locally.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { type KiroCredentials, refreshKiroTokenDirect } from "./oauth.js";
import { getPiAgentDir } from "./usage-tracking.js";

/** Refresh a little early so a near-expiry token doesn't slip through. */
const EXPIRY_BUFFER_MS = 2 * 60 * 1000;

/**
 * Read pi's own persisted Kiro credential. Returns undefined when the file is
 * missing, unparseable, lacks a usable kiro entry, or the access token has
 * expired. Never logs file contents because auth.json holds many providers'
 * secrets.
 */
export function getPiHostKiroCredentials(agentDir = getPiAgentDir()): KiroCredentials | undefined {
  return readPiHostKiroCredentials(agentDir, false);
}

/** Also expose expired credentials so a rejected access token can be renewed. */
export function getPiHostKiroCredentialsAllowExpired(agentDir = getPiAgentDir()): KiroCredentials | undefined {
  return readPiHostKiroCredentials(agentDir, true);
}

function readPiHostKiroCredentials(agentDir: string, allowExpired: boolean): KiroCredentials | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"));
  } catch {
    return undefined;
  }

  const kiro = asRecord(asRecord(raw)?.kiro);
  if (!kiro || typeof kiro.access !== "string" || !kiro.access) return undefined;

  if (!allowExpired && typeof kiro.expires === "number" && Number.isFinite(kiro.expires)) {
    if (Date.now() >= kiro.expires - EXPIRY_BUFFER_MS) return undefined;
  }

  return kiro as unknown as KiroCredentials;
}

// Use the same lock path/protocol as Pi, without importing its private store.
const lockfile = createRequire(import.meta.url)("proper-lockfile") as {
  lock(path: string, options: Record<string, unknown>): Promise<() => Promise<void>>;
};

const pendingRefreshes = new Map<string, Promise<KiroCredentials | undefined>>();
// A long tool loop can keep passing the original apiKey after we renew it.
// Remember only proven replacements, never adopt an unrelated stored login.
const recoveredTokens = new Map<string, string>();
function tokenKey(token: string, agentDir: string): string {
  return `${agentDir}:${createHash("sha256").update(token).digest("hex")}`;
}

export function getPiHostKiroCredentialsForToken(
  token: string,
  agentDir = getPiAgentDir(),
): KiroCredentials | undefined {
  const current = getPiHostKiroCredentialsAllowExpired(agentDir);
  if (current && (current.access === token || recoveredTokens.get(tokenKey(token, agentDir)) === current.access)) {
    return current;
  }
  return undefined;
}

function rememberReplacement(oldToken: string, newToken: string, agentDir: string): void {
  for (const [key, value] of recoveredTokens) {
    if (key.startsWith(`${agentDir}:`) && value === oldToken) recoveredTokens.set(key, newToken);
  }
  recoveredTokens.set(tokenKey(oldToken, agentDir), newToken);
  if (recoveredTokens.size > 64) {
    const oldest = recoveredTokens.keys().next().value;
    if (oldest !== undefined) recoveredTokens.delete(oldest);
  }
}

/**
 * Recover the native /login credential, not an unrelated CLI/IDE account. A 403
 * overrides the local expiry: always perform the grant when the token matches.
 * Uses Pi's cross-process lock protocol through refresh + atomic persistence, so
 * the rotated refresh token is saved without overwriting other provider entries.
 * A refresh already started survives request cancellation, with its own deadline.
 */
export async function refreshPiHostKiroCredentials(
  rejectedToken: string,
  agentDir = getPiAgentDir(),
): Promise<KiroCredentials | undefined> {
  const key = tokenKey(rejectedToken, agentDir);
  const pending = pendingRefreshes.get(key);
  if (pending) return pending;

  const snapshot = getPiHostKiroCredentialsForToken(rejectedToken, agentDir);
  if (!snapshot?.refresh || snapshot.authMethod === "apikey") return undefined;
  if (snapshot.access !== rejectedToken && snapshot.expires > Date.now() + EXPIRY_BUFFER_MS) return snapshot;

  const request = (async () => {
    const authPath = join(agentDir, "auth.json");
    let compromised = false;
    const release = await lockfile.lock(authPath, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 20, minTimeout: 100, maxTimeout: 2000 },
      onCompromised: () => {
        compromised = true;
      },
    });
    let refreshed: KiroCredentials | undefined;
    const temporaryPath = `${authPath}.${randomUUID()}.tmp`;
    try {
      let data: Record<string, unknown> | undefined;
      try {
        data = asRecord(JSON.parse(readFileSync(authPath, "utf-8")));
      } catch {
        // JSON.parse errors can contain credential fragments; never surface them.
        throw new Error("Pi Kiro auth file is unreadable; refusing to overwrite it.");
      }
      const current = asRecord(data?.kiro);
      if (!data || current?.type !== "oauth")
        throw new Error("Pi Kiro login changed; retry the request with the current login.");
      if (current.access !== snapshot.access) {
        if (
          current.refresh === snapshot.refresh &&
          typeof current.expires === "number" &&
          current.expires > Date.now()
        ) {
          return current as unknown as KiroCredentials;
        }
        throw new Error("Pi Kiro login changed; retry the request with the current login.");
      }
      const renewed = await refreshKiroTokenDirect(current as unknown as KiroCredentials, AbortSignal.timeout(15_000));
      if (compromised) throw new Error("Pi Kiro credential lock was compromised; refusing to overwrite the login.");
      refreshed = { ...current, ...renewed } as KiroCredentials;
      data.kiro = { ...refreshed, type: "oauth" };
      // Rename under the shared lock: a process crash cannot leave half a JSON file.
      writeFileSync(temporaryPath, JSON.stringify(data, null, 2), { mode: statSync(authPath).mode & 0o777 });
      renameSync(temporaryPath, authPath);
      rememberReplacement(snapshot.access, refreshed.access, agentDir);
    } finally {
      rmSync(temporaryPath, { force: true });
      await release().catch(() => {
        console.warn("[pi-provider-kiro] Failed to release the Pi Kiro credential lock.");
      });
    }
    return refreshed;
  })();
  pendingRefreshes.set(key, request);
  try {
    return await request;
  } finally {
    if (pendingRefreshes.get(key) === request) pendingRefreshes.delete(key);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
