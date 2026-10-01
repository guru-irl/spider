import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

it("generated stable and dev shims reload changed bundles through pi's real loader but cache unchanged files", () => {
  const result = spawnSync(process.execPath, ["scripts/probe-reload.mjs"], { cwd: root, encoding: "utf8", timeout: 30000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("PASS: both generated shims");
  for (const loader of ["SDK alias", "CLI virtualModules tryNative:false"]) {
    for (const variant of ["stable", "dev"]) {
      expect(result.stdout).toContain(`${loader} ${variant} mtime-only rebuilt: code=B, module evaluations=2, loader errors=0`);
      expect(result.stdout).toContain(`${loader} ${variant} size-only rebuilt: code=C-new, module evaluations=3, loader errors=0`);
    }
  }
  expect(result.stderr).not.toContain("ExperimentalWarning");
  expect(result.stderr).toContain("ReloadProbeWarning: unrelated compile warning");
  expect(result.stderr).toContain("ReloadProbeWarning: unrelated import warning");
}, 35000);

it("the real Vite config produces a distinct identity on each watch rebuild", () => {
  const result = spawnSync(process.execPath, ["scripts/probe-build-watch.mjs"], { cwd: root, encoding: "utf8", timeout: 30000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("PASS: two watch builds");
}, 35000);
