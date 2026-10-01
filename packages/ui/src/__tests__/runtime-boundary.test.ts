import { expect, it } from "vitest";
import { build } from "esbuild";
import { join } from "node:path";

it("importing the UI does not pull in database code or native modules", async () => {
  const bundle = await build({
    entryPoints: [join(process.cwd(), "packages/ui/src/index.ts")],
    bundle: true, write: false, metafile: true, platform: "node", format: "esm",
    external: ["@earendil-works/pi-tui"],
  });
  expect(Object.keys(bundle.metafile!.inputs).filter(path => /db-core|better-sqlite3|sqlite-vec/.test(path))).toEqual([]);
  expect(bundle.outputFiles[0].text).not.toMatch(/better-sqlite3|sqlite-vec/);
});
