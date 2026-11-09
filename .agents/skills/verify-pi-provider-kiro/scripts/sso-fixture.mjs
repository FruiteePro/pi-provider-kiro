#!/usr/bin/env node
// ABOUTME: Prepare a fake-only native Pi SSO fixture without reading real credential stores.
// ABOUTME: Start fake-kiro.mjs in hc separately, then use pi.sh to drive this fixture.
// Usage: node sso-fixture.mjs <runDir> <loopbackFakeURL> <piBinary> [profile|runtime|expired]
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const [runArg, fake, piBin, variant = "profile"] = process.argv.slice(2);
if (!runArg || !/^http:\/\/127\.0\.0\.1:\d+$/.test(fake ?? "") || !piBin || !["profile", "runtime", "expired"].includes(variant)) {
  throw new Error("usage: sso-fixture.mjs <runDir> <http://127.0.0.1:port> <piBinary> [profile|runtime|expired]");
}
const run = resolve(runArg);
const repo = fileURLToPath(new URL("../../../..", import.meta.url));
for (const name of ["home", "agent", "work", "sessions", "evidence", "logs"]) mkdirSync(join(run, name), { recursive: true, mode: 0o700 });
const credential = {
  type: "oauth", access: "verify-sso-old-access",
  refresh: "verify-sso-old-refresh|verify-sso-client|verify-sso-secret|idc",
  expires: variant === "expired" ? 0 : Date.now() + 3600000,
  authMethod: "idc", region: "ap-southeast-1",
  clientId: "verify-sso-client", clientSecret: "verify-sso-secret",
  startUrl: "https://verify-only.awsapps.com/start", isEnterprise: true,
};
if (variant === "runtime") credential.profileArn = "arn:aws:codewhisperer:us-east-1:000000000000:profile/VERIFYFAKE";
writeFileSync(join(run, "agent/auth.json"), JSON.stringify({ kiro: credential }, null, 2), { mode: 0o600 });
writeFileSync(join(run, "repo"), repo + "\n");
writeFileSync(join(run, "env"), [
  `HOME=${run}/home`, `PI_CODING_AGENT_DIR=${run}/agent`, `PI_CODING_AGENT_SESSION_DIR=${run}/sessions`,
  "KIRO_VERIFY_MODE=fake", `KIRO_VERIFY_RUN=${run}`, `KIRO_VERIFY_FAKE_URL=${fake}`,
  `KIRO_DEBUG_LOG=${run}/logs/kiro-debug.log`, "KIRO_DEBUG=1", `PI_BIN=${piBin}`,
].join("\n") + "\n");
console.log(`Prepared fake-only ${variant} SSO fixture at ${run}; real stores were not read.`);
