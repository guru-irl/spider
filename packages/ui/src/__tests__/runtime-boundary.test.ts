import { expect, it } from "vitest";
import { buildFixture as build } from "../../../../scripts/test-bundle";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

it("fixture metadata retains resolved modules discarded from emitted code", async () => {
  const root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "bundle-boundary-"));
  const discarded = join(root, "discarded.js");
  writeFileSync(discarded, 'export const unused = "UNUSED_BOUNDARY_MODULE";');
  try {
    const bundle = await build({
      stdin: { contents: 'import "node:fs"; import "./discarded.js"; export const value = 42;', resolveDir: root, sourcefile: "entry.js" },
      write: false, metafile: true,
    });
    expect(bundle.outputFiles[0].text).not.toContain("UNUSED_BOUNDARY_MODULE");
    expect(Object.keys(bundle.metafile.inputs)).toContain(discarded);
    expect(Object.keys(bundle.metafile.inputs)).not.toContain("node:fs");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("importing the UI does not pull in database code or native modules", async () => {
  const bundle = await build({
    entryPoints: [join(process.cwd(), "packages/ui/src/index.ts")],
    bundle: true, write: false, metafile: true, platform: "node", format: "esm",
    external: ["@earendil-works/pi-tui"],
  });
  expect(Object.keys(bundle.metafile!.inputs).filter(path => /db-core|better-sqlite3|sqlite-vec/.test(path))).toEqual([]);
  expect(bundle.outputFiles[0].text).not.toMatch(/better-sqlite3|sqlite-vec/);
});
