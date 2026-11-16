import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchDbPath } from "@spider/db-core/testutil";
import { inspectIntercomReadiness, validIntercomReadiness } from "../intercom-readiness";
const resolver = vi.hoisted(() => ({ release: "" }));
vi.mock("node:child_process", () => ({ spawnSync: () => ({ status: 0, stdout: JSON.stringify({ legacy: false, shim: "fixture", extensions: [{ path: `${resolver.release}/dist/extension.js`, enabled: true, metadata: { scope: "user" } }] }) }) }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it.each(["missing-directory", "missing-socket", "pending-asks"] as const)("inspects %s without spawning or creating broker state", async state => {
  const root = mkdtempSync(join(dirname(scratchDbPath("offline-readiness")), "offline-")); roots.push(root); resolver.release = join(root, "release");
  const agentDir = join(root, "agent"); mkdirSync(agentDir, { mode: 0o700 }); writeFileSync(join(agentDir, "settings.json"), "{}", { mode: 0o600 });
  if (state !== "missing-directory") mkdirSync(join(agentDir, "intercom"), { mode: 0o700 });
  if (state === "pending-asks") { mkdirSync(join(agentDir, "intercom", "pending-asks"), { mode: 0o700 }); writeFileSync(join(agentDir, "intercom", "pending-asks", "ask.json"), "{}", { mode: 0o600 }); }
  const before = readdirSync(agentDir, { recursive: true });
  const result = await inspectIntercomReadiness({ agentDir, release: resolver.release, sdk: "/fixture/sdk", cwd: root });
  expect(validIntercomReadiness(result)).toBe(true);
  expect(result).toMatchObject({ intercomUnique: true, federation: false, legacyDrained: false, intercomEvidence: { federation: "intercom-broker-unavailable", legacy: state === "pending-asks" ? "legacy-pending-asks" : "legacy-drained-offline" } });
  expect(readdirSync(agentDir, { recursive: true })).toEqual(before);
});
