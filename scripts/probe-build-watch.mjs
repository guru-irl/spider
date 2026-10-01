import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import config from "../vite.config.mjs";
import { parseBuildId } from "./build-id.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = join(root, ".spider/scratch/build-id");
mkdirSync(base, { recursive: true });
const fixture = mkdtempSync(join(base, "watch-probe-"));
const entry = join(fixture, "entry.ts");
const outDir = join(fixture, "dist");
const bundle = join(outDir, "extension.js");
writeFileSync(entry, "export const identity = __SPIDER_BUILD__; export const revision = 1;\n");
let watcher;
try {
  const identities = [];
  await new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("watch probe timed out")), 20000);
    try {
      watcher = await build({ ...config, configFile: false, root, logLevel: "silent", build: { ...config.build, ssr: entry, outDir, watch: {} } });
      watcher.on("event", async event => {
        if (event.code === "ERROR") { clearTimeout(timeout); reject(event.error); }
        if (event.code !== "END") return;
        try {
          const number = identities.length + 1;
          const marker = parseBuildId(readFileSync(bundle, "utf8").slice(0, 16384));
          const module = await import(pathToFileURL(bundle).href + `?build=${number}`);
          assert.ok(marker, "watch output must have a valid marker");
          assert.deepEqual({ ...marker, version: module.identity.version }, module.identity, "banner must match runtime identity");
          assert.equal(module.revision, number);
          identities.push(marker);
          console.log(`watch build ${number}: ${JSON.stringify(marker)}`);
          if (number === 1) {
            writeFileSync(entry, "export const identity = __SPIDER_BUILD__; export const revision = 2;\n");
          } else {
            assert.notEqual(identities[0].builtAt, identities[1].builtAt, "each watch rebuild needs a fresh build time");
            assert.equal(marker.version, module.identity.version, "marker must include the package version");
            clearTimeout(timeout);
            resolve();
          }
        } catch (error) { clearTimeout(timeout); reject(error); }
      });
    } catch (error) { clearTimeout(timeout); reject(error); }
  });
  console.log("PASS: two watch builds have distinct times and matching banner/runtime identities.");
} finally {
  await watcher?.close();
  rmSync(fixture, { recursive: true, force: true });
}
