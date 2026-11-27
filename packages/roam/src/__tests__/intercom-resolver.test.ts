import { afterEach, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { scratchDbPath } from "@spider/db-core/testutil";
import { inspectIntercomReadiness } from "../intercom-readiness";
// @ts-expect-error The release shim is an executable JavaScript build helper.
import { extensionShim } from "../../../../scripts/extension-shim.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each([
  ["narrow", ["manager", "settings"]],
  ["symlink", ["manager", "settings"]],
  ["fallback", ["sdk"]],
  ["missing-manager", ["sdk"]],
  ["missing-settings", ["manager", "sdk"]],
  ["invalid-export", ["manager", "sdk", "settings"]],
] as const)("resolves the same Pi resources using the %s layout", async (layout, expectedImports) => {
  const root = mkdtempSync(join(dirname(scratchDbPath("resolver")), "resolver-")); roots.push(root);
  const agentDir = join(root, "agent"), release = join(root, "release"), sdkDir = join(root, "sdk"), marker = join(root, "imports");
  for (const dir of [agentDir, join(agentDir, "extensions"), join(release, "dist"), join(release, "scripts"), sdkDir])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bundle = join(release, "dist", "extension.js");
  writeFileSync(bundle, "export default () => {};", { mode: 0o600 });
  writeFileSync(join(agentDir, "extensions", "spider.ts"), extensionShim(bundle), { mode: 0o600 });
  writeFileSync(join(agentDir, "settings.json"), "{}", { mode: 0o600 });
  for (const file of ["intercom-switchover.mjs", "extension-shim.mjs"])
    copyFileSync(join(process.cwd(), "scripts", file), join(release, "scripts", file));

  const pi = resolve("node_modules/@earendil-works/pi-coding-agent/dist/core");
  const manager = pathToFileURL(join(pi, "package-manager.js")).href, settings = pathToFileURL(join(pi, "settings-manager.js")).href;
  const realSdk = pathToFileURL(join(dirname(pi), "index.js")).href;
  const record = (name: string) => `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)},${JSON.stringify(name + "\n")});\n`;
  writeFileSync(join(sdkDir, "package.json"), '{"type":"module"}');
  writeFileSync(join(sdkDir, "index.js"), record("sdk") + `export {DefaultPackageManager, SettingsManager} from ${JSON.stringify(realSdk)};`);
  if (layout !== "fallback") {
    mkdirSync(join(sdkDir, "core"));
    if (layout !== "missing-manager") writeFileSync(join(sdkDir, "core", "package-manager.js"), record("manager") +
      (layout === "invalid-export" ? "export const changed = true;" : `export {DefaultPackageManager} from ${JSON.stringify(manager)};`));
    if (layout !== "missing-settings") writeFileSync(join(sdkDir, "core", "settings-manager.js"), record("settings") + `export {SettingsManager} from ${JSON.stringify(settings)};`);
  }
  const sdk = layout === "symlink" ? join(root, "linked-sdk.js") : join(sdkDir, "index.js");
  if (layout === "symlink") symlinkSync(join(sdkDir, "index.js"), sdk);
  const result = await inspectIntercomReadiness({ agentDir, release, sdk, cwd: root });
  expect(result).toEqual({ intercomUnique: true, legacyDrained: false, federation: false,
    intercomEvidence: { settings: "settings-unique", legacy: "legacy-drained-offline", federation: "intercom-broker-unavailable", otherExtensions: [] } });
  expect(readFileSync(marker, "utf8").trim().split("\n").sort()).toEqual(expectedImports);
});
