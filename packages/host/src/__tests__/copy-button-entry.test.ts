import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PACKED_ENTRIES, verifyPackedRoot } from "../../../herdr/e2e/harness/pack.js";
import { RELEASE_ENTRIES } from "../../../roam/src/release-request.js";
import { pathToFileURL } from "node:url";
import { paths } from "@spider/db-core";

const require = createRequire(import.meta.url);
const { extensionShim } = require("../../../../scripts/extension-shim.mjs");
const root = join(paths.scratch("worktree", process.cwd()), "copy-button-entry-tests");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("ships the generated package bridge as the pi extension entry", () => {
  const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  expect(manifest.pi.extensions).toEqual(["./scripts/package-extension.ts"]);
  expect(manifest.files).toContain("scripts/package-extension.ts");
  expect(readFileSync(resolve("scripts/package-extension.ts"), "utf8")).toBe(extensionShim(undefined));
});

it("requires the package bridge in provisioned releases", () => {
  expect(RELEASE_ENTRIES).toContain("scripts/package-extension.ts");
});

it("validates staged packages and exposes the pi-facing bridge separately from the bundle", () => {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "stage-")); dirs.push(dir);
  for (const name of new Set([...PACKED_ENTRIES, "scripts/package-extension.ts"])) {
    const file = join(dir, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "fixture");
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ files: ["scripts/package-extension.ts"], pi: { extensions: ["./scripts/package-extension.ts"] } }));
  const packed = verifyPackedRoot(dir);
  expect(packed.extension).toBe(join(dir, "dist/extension.js"));
  expect(packed.extensionEntry).toBe(join(dir, "scripts/package-extension.ts"));
});

it.each(["package", "linked"])("passes pi's actual bundled classes through the %s entry", kind => {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "case-")); dirs.push(dir);
  mkdirSync(join(dir, "scripts")); mkdirSync(join(dir, "dist"));
  const bundle = join(dir, "dist/extension.js");
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  writeFileSync(bundle, "export default (_pi, ports) => ports;\n");
  const entry = join(dir, "scripts/entry.ts");
  writeFileSync(entry, kind === "package" ? readFileSync(resolve("scripts/package-extension.ts"), "utf8") : extensionShim(bundle));
  const chunks = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks");
  const one = (prefix: string) => {
    const found = readdirSync(chunks).filter(name => name.startsWith(prefix) && name.endsWith(".js"));
    expect(found).toHaveLength(1);
    return pathToFileURL(join(chunks, found[0])).href;
  };
  const loader = one("jiti-static-loader-");
  const virtual = one("virtual-modules-");
  const script = `
    import { createJiti } from ${JSON.stringify(loader)};
    import { VIRTUAL_MODULES } from ${JSON.stringify(virtual)};
    const load = createJiti(import.meta.url, { moduleCache: false, virtualModules: VIRTUAL_MODULES, tryNative: false });
    const factory = await load.import(${JSON.stringify(entry)}, { default: true });
    const result = await factory({});
    const pi = VIRTUAL_MODULES['@earendil-works/pi-coding-agent'];
    const tui = VIRTUAL_MODULES['@earendil-works/pi-tui'];
    if (result?.copyButtons?.host?.AssistantMessageComponent !== pi.AssistantMessageComponent ||
        result?.copyButtons?.host?.ToolExecutionComponent !== pi.ToolExecutionComponent ||
        result?.copyButtons?.host?.Markdown !== tui.Markdown || result?.copyButtons?.host?.Spacer !== tui.Spacer ||
        result?.copyButtons?.copy !== pi.copyToClipboard) {
      throw new Error('bridge did not pass host classes and clipboard');
    }
    const id = s => s;
    const theme = Object.fromEntries(['heading','link','linkUrl','code','codeBlock','codeBlockBorder','quote','quoteBorder','hr','listBullet','bold','italic','strikethrough','underline'].map(k => [k, id]));
    const assistant = new pi.AssistantMessageComponent(undefined, false, theme, undefined, 0);
    assistant.updateContent({ role: 'assistant', content: [{ type: 'text', text: 'Hello' }], stopReason: 'stop' }, false);
    if (!assistant.contentContainer.children.some(child => child instanceof result.copyButtons.host.Markdown)) {
      throw new Error('pi renderer did not construct the injected Markdown class');
    }
  `;
  const probe = join(dir, "probe.mjs");
  writeFileSync(probe, script);
  expect(() => execFileSync(process.execPath, [probe], { stdio: "pipe" })).not.toThrow();
});
