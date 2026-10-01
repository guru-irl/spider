// Run with node scripts/probe-reload.mjs. Only fixture shims/bundles are loaded.
import assert from "node:assert/strict";
import vm from "node:vm";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = join(root, ".spider/scratch/build-id");
mkdirSync(base, { recursive: true });
const fixture = mkdtempSync(join(base, "reload-probe-"));
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const loaders = [
  ["SDK alias", await import(sdkEntry)],
  ["CLI virtualModules tryNative:false", await import(new URL("./bundle/index.js", sdkEntry).href)],
];
let failures = 0;
const originalCompile = vm.runInThisContext;
const originalEmitWarning = process.emitWarning;
const warnings = [];
const onWarning = warning => warnings.push(warning);
process.on("warning", onWarning);
vm.runInThisContext = function(source, options) {
  if (options?.importModuleDynamically !== vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER) {
    return originalCompile.call(this, source, options);
  }
  process.emitWarning("unrelated compile warning", "ReloadProbeWarning");
  const nativeImport = originalCompile.call(this, source, options);
  return function(url) {
    process.emitWarning("unrelated import warning", "ReloadProbeWarning");
    return nativeImport(url);
  };
};
syncBuiltinESMExports();
try {
  for (const [loaderName, pi] of loaders) {
    for (const variant of ["stable", "dev"]) {
      const install = join(fixture, loaderName, variant, "install");
      const cwd = join(fixture, loaderName, variant, "app");
      const home = join(fixture, loaderName, variant, "home");
      const agent = join(home, ".pi/agent");
      mkdirSync(join(install, "scripts"), { recursive: true });
      mkdirSync(join(install, "dist"), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      for (const script of ["link.mjs", "dev-link.mjs", "extension-shim.mjs"]) {
        const source = join(root, "scripts", script);
        if (existsSync(source)) copyFileSync(source, join(install, "scripts", script));
      }
      execFileSync(process.execPath, [join(install, "scripts", variant === "stable" ? "link.mjs" : "dev-link.mjs")], {
        cwd, env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent }, stdio: "pipe",
      });
      const bundle = join(install, "dist/extension.js");
      const write = (stamp, seconds) => {
        writeFileSync(bundle, `globalThis.__spiderReloadEvaluations = (globalThis.__spiderReloadEvaluations || 0) + 1;\nexport default function() { globalThis.__spiderReloadProbe = { stamp: ${JSON.stringify(stamp)}, evaluations: globalThis.__spiderReloadEvaluations, url: import.meta.url }; }\n`);
        utimesSync(bundle, seconds, seconds);
      };
      globalThis.__spiderReloadEvaluations = 0;
      const load = async (stage) => {
        // Use the real package entry's jiti configuration, not an approximation.
        const result = await pi.discoverAndLoadExtensions([], cwd, agent);
        assert.equal(result.errors.length, 0, result.errors.map(e => e.error).join("\n"));
        assert.equal(result.extensions.length, 1);
        const observed = globalThis.__spiderReloadProbe;
        console.log(`${loaderName} ${variant} ${stage}: code=${observed.stamp}, module evaluations=${observed.evaluations}, loader errors=${result.errors.length}`);
        return observed;
      };
      try {
        write("A", 1700000000);
        const first = await load("first");
        assert.equal(first.stamp, "A");
        assert.equal(first.evaluations, 1);
        const unchanged = await load("unchanged");
        assert.equal(unchanged.evaluations, 1);
        assert.equal(unchanged.url, first.url);
        write("B", 1700000002); // Same size, only mtime changes.
        const mtimeOnly = await load("mtime-only rebuilt");
        assert.equal(mtimeOnly.stamp, "B");
        assert.equal(mtimeOnly.evaluations, 2);
        assert.notEqual(mtimeOnly.url, first.url);
        write("C-new", 1700000002); // Same mtime, only size changes.
        const sizeOnly = await load("size-only rebuilt");
        assert.equal(sizeOnly.stamp, "C-new");
        assert.equal(sizeOnly.evaluations, 3);
        assert.notEqual(sizeOnly.url, mtimeOnly.url);
        const unchangedAgain = await load("unchanged rebuilt");
        assert.equal(unchangedAgain.evaluations, 3);
        assert.equal(unchangedAgain.url, sizeOnly.url);
      } catch (error) {
        failures++;
        console.error(`${loaderName} ${variant}: ${error.message}`);
      }
    }
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(process.emitWarning, originalEmitWarning, "shim must restore emitWarning");
  assert.equal(warnings.filter(w => w.name === "ExperimentalWarning").length, 0);
  assert.ok(warnings.some(w => w.name === "ReloadProbeWarning" && w.message === "unrelated compile warning"));
  assert.ok(warnings.some(w => w.name === "ReloadProbeWarning" && w.message === "unrelated import warning"));
  console.log("PASS: no ExperimentalWarning; unrelated compile/import warnings forwarded; emitWarning restored.");
} finally {
  vm.runInThisContext = originalCompile;
  syncBuiltinESMExports();
  process.off("warning", onWarning);
  delete globalThis.__spiderReloadProbe;
  delete globalThis.__spiderReloadEvaluations;
  rmSync(fixture, { recursive: true, force: true });
}
assert.equal(failures, 0, "generated shims must reload changed bundles and reuse unchanged modules");
console.log("PASS: both generated shims reload new code and reuse unchanged modules through both pi loader configurations.");
