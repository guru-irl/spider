import { afterEach, expect, it } from "vitest";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as selected from "../selected-files";

type File = { path: string; bytes: Buffer; mode: 0o600 | 0o700 };
type Prepared = { files: readonly File[]; credentialFiles: readonly File[]; providers: readonly string[] };
type Prepare = (input: { sourceRoot: string; selected: readonly string[]; maxBytes: number }) => Prepared;
type Install = (input: { destinationRoot: string; files: readonly File[] }) => void;
const prepare = (selected as { prepareSelectedFiles?: Prepare }).prepareSelectedFiles;
const install = (selected as { installSelectedFiles?: Install }).installSelectedFiles;
const roots: string[] = [];

function fixture() {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "selected-files-")); roots.push(root);
  const sourceRoot = join(root, "source"), destinationRoot = join(root, "destination");
  mkdirSync(sourceRoot, { mode: 0o700 }); mkdirSync(destinationRoot, { mode: 0o700 });
  const write = (base: string, name: string, contents: string | Buffer, mode = 0o600) => {
    const file = join(base, name); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, contents, { mode }); return file;
  };
  const run = (names: readonly string[]) => prepare!({ sourceRoot, selected: names, maxBytes: 1024 * 1024 });
  return { root, sourceRoot, destinationRoot, write, run };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("accepts non-writable readable resource directories and normalizes copied modes", () => {
  expect(prepare).toBeTypeOf("function"); expect(install).toBeTypeOf("function");
  const f = fixture(); chmodSync(f.sourceRoot, 0o755); chmodSync(f.destinationRoot, 0o755);
  f.write(f.sourceRoot, "AGENTS.md", "instructions", 0o644);
  f.write(f.sourceRoot, "skills/check/SKILL.md", "skill", 0o644);
  chmodSync(join(f.sourceRoot, "skills"), 0o755); chmodSync(join(f.sourceRoot, "skills", "check"), 0o755);
  mkdirSync(join(f.destinationRoot, "skills"), { mode: 0o755 });
  expect(() => f.run(["AGENTS.md", "skills/check"])).not.toThrow();
  const result = f.run(["AGENTS.md", "skills/check"]);
  install!({ destinationRoot: f.destinationRoot, files: result.files });
  expect(readFileSync(join(f.destinationRoot, "AGENTS.md"), "utf8")).toBe("instructions");
  expect(readFileSync(join(f.destinationRoot, "skills/check/SKILL.md"), "utf8")).toBe("skill");
  expect(lstatSync(join(f.destinationRoot, "AGENTS.md")).mode & 0o777).toBe(0o600);
  expect(lstatSync(f.destinationRoot).mode & 0o777).toBe(0o755);
}, 5000);

it("refuses credential-bearing settings that are readable by other users", () => {
  expect(prepare).toBeTypeOf("function");
  const f = fixture(); f.write(f.sourceRoot, "models.json", JSON.stringify({ providers: { demo: { apiKey: "fixture-secret" } } }), 0o644);
  expect(() => f.run(["models.json"])).toThrow(expect.objectContaining({ code: "unsafe-file" }));
}, 5000);

it("selects only allowed files and includes a skill's supporting files", () => {
  expect(prepare).toBeTypeOf("function");
  const f = fixture();
  f.write(f.sourceRoot, "AGENTS.md", "instructions");
  f.write(f.sourceRoot, "skills/check/SKILL.md", "instructions");
  f.write(f.sourceRoot, "skills/check/references/guide.md", "guide");
  f.write(f.sourceRoot, "skills/check/scripts/run.sh", "#!/bin/sh\nexit 0\n", 0o700);
  f.write(f.sourceRoot, "trust.json", "not selected");
  f.write(f.sourceRoot, "sessions/private.jsonl", "not selected");
  const result = f.run(["AGENTS.md", "skills/check"]);
  expect(result.files.map(file => file.path)).toEqual(["AGENTS.md", "skills/check/SKILL.md", "skills/check/references/guide.md", "skills/check/scripts/run.sh"]);
  expect(result.files.find(file => file.path.endsWith("run.sh"))?.mode).toBe(0o700);
  expect(result.credentialFiles).toEqual([]);
  expect(result.providers).toEqual([]);
}, 5000);

it("rewrites settings so extensions and prompts load only when selected", () => {
  expect(prepare).toBeTypeOf("function");
  const f = fixture();
  f.write(f.sourceRoot, "settings.json", JSON.stringify({ theme: "sample", defaultProjectTrust: "always", sessionDir: "sessions",
    packages: ["npm:pi-intercom", "npm:unselected"], extensions: ["./extensions/check.ts"], prompts: ["./prompts/check.md"], skills: ["./skills/check"] }));
  f.write(f.sourceRoot, "extensions/check.ts", "export default 1;");
  f.write(f.sourceRoot, "prompts/check.md", "prompt");
  f.write(f.sourceRoot, "skills/check/SKILL.md", "skill");
  f.write(f.sourceRoot, "mcp.json", JSON.stringify({ mcpServers: {} }));
  const onlySettings = JSON.parse(f.run(["settings.json"]).files[0].bytes.toString());
  expect(onlySettings).toEqual({ theme: "sample", packages: [], extensions: [], prompts: [], skills: [] });
  const chosen = f.run(["settings.json", "extensions/check.ts", "prompts/check.md", "skills/check", "mcp.json"]);
  const settings = JSON.parse(chosen.files.find(file => file.path === "settings.json")!.bytes.toString());
  expect(settings.extensions).toEqual(["./extensions/check.ts"]);
  expect(settings.prompts).toEqual(["./prompts/check.md"]);
  expect(settings.skills).toEqual(["./skills/check"]);
  expect(chosen.files.map(file => file.path)).toContain("mcp.json");
}, 5000);

it.each(["../auth.json", "/etc/passwd", "auth.json", "trust.json", "sessions/x", "skills/check/.cache/item", "node_modules/pkg/index.js"]) (
  "refuses non-allowlisted or excluded selection %s", name => {
    expect(prepare).toBeTypeOf("function");
    const f = fixture();
    expect(() => f.run([name])).toThrow(expect.objectContaining({ code: "selection-not-allowed" }));
  }, 5000,
);

it("reports selected files with Mac absolute paths without exposing their values", () => {
  expect(prepare).toBeTypeOf("function");
  const f = fixture(), foreign = ["", "Users", "example", "private"].join("/");
  f.write(f.sourceRoot, "models.json", JSON.stringify({ providers: { demo: { baseUrl: foreign } } }));
  let error: unknown;
  try { f.run(["models.json"]); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code: "unsupported-path", files: ["models.json"] });
  expect(String(error)).not.toContain(foreign);
}, 5000);

it("refuses credential commands without executing them", () => {
  expect(prepare).toBeTypeOf("function");
  const f = fixture(), sentinel = join(f.root, "sentinel");
  f.write(f.sourceRoot, "models.json", JSON.stringify({ providers: { demo: { apiKey: `!touch ${sentinel}` } } }));
  expect(() => f.run(["models.json"])).toThrow(expect.objectContaining({ code: "unsupported-credential-command", files: ["models.json"] }));
  expect(existsSync(sentinel)).toBe(false);
}, 5000);

it("keeps credential-bearing configuration out of the ordinary artifact", () => {
  expect(prepare).toBeTypeOf("function");
  const f = fixture();
  f.write(f.sourceRoot, "models.json", JSON.stringify({ providers: { demo: { apiKey: "fixture-secret" }, other: { apiKey: "${OTHER_KEY}" } } }));
  f.write(f.sourceRoot, "AGENTS.md", "ordinary");
  const result = f.run(["models.json", "AGENTS.md"]);
  expect(result.files.map(file => file.path)).toEqual(["AGENTS.md"]);
  expect(result.credentialFiles.map(file => file.path)).toEqual(["models.json"]);
  expect(result.providers).toEqual(["demo"]);
  expect(Buffer.concat(result.files.map(file => file.bytes)).toString()).not.toContain("fixture-secret");
}, 5000);

it("backs up overwritten files once and replaces only selected files on retry", () => {
  expect(install).toBeTypeOf("function");
  const f = fixture();
  f.write(f.destinationRoot, "settings.json", "original"); f.write(f.destinationRoot, "AGENTS.md", "leave alone");
  const files: File[] = [{ path: "settings.json", bytes: Buffer.from("new"), mode: 0o600 }];
  install!({ destinationRoot: f.destinationRoot, files });
  expect(readFileSync(join(f.destinationRoot, "settings.json"), "utf8")).toBe("new");
  expect(existsSync(join(f.destinationRoot, "settings.json.spider-roam.bak"))).toBe(true);
  expect(readFileSync(join(f.destinationRoot, "settings.json.spider-roam.bak"), "utf8")).toBe("original");
  f.write(f.destinationRoot, "settings.json", "hand edit");
  install!({ destinationRoot: f.destinationRoot, files });
  expect(readFileSync(join(f.destinationRoot, "settings.json"), "utf8")).toBe("new");
  expect(readFileSync(join(f.destinationRoot, "settings.json.spider-roam.bak"), "utf8")).toBe("original");
  expect(readFileSync(join(f.destinationRoot, "AGENTS.md"), "utf8")).toBe("leave alone");
  expect(lstatSync(join(f.destinationRoot, "settings.json")).mode & 0o777).toBe(0o600);
}, 5000);

it("recovers its own leftover publication link on an interrupted retry", () => {
  expect(install).toBeTypeOf("function");
  const f = fixture(), file = join(f.destinationRoot, "AGENTS.md"), temp = join(f.destinationRoot, ".spider-roam-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp");
  install!({ destinationRoot: f.destinationRoot, files: [{ path: "AGENTS.md", bytes: Buffer.from("new"), mode: 0o600 }] });
  linkSync(file, temp);
  install!({ destinationRoot: f.destinationRoot, files: [{ path: "AGENTS.md", bytes: Buffer.from("new"), mode: 0o600 }] });
  expect(readFileSync(file, "utf8")).toBe("new"); expect(existsSync(temp)).toBe(false);
}, 5000);

it("retries safely after an unsafe destination interrupts installation", () => {
  expect(install).toBeTypeOf("function");
  const f = fixture();
  f.write(f.destinationRoot, "AGENTS.md", "old");
  const target = f.write(f.root, "outside", "untouched"), link = join(f.destinationRoot, "keybindings.json");
  symlinkSync(target, link);
  const files: File[] = [{ path: "AGENTS.md", bytes: Buffer.from("new"), mode: 0o600 }, { path: "keybindings.json", bytes: Buffer.from("keys"), mode: 0o600 }];
  expect(() => install!({ destinationRoot: f.destinationRoot, files })).toThrow();
  expect(readFileSync(target, "utf8")).toBe("untouched");
  rmSync(link);
  install!({ destinationRoot: f.destinationRoot, files });
  expect(readFileSync(join(f.destinationRoot, "AGENTS.md.spider-roam.bak"), "utf8")).toBe("old");
  expect(readFileSync(link, "utf8")).toBe("keys");
}, 5000);

it("refuses source symlinks and unsafe destination modes", () => {
  expect(prepare).toBeTypeOf("function"); expect(install).toBeTypeOf("function");
  const f = fixture(), outside = f.write(f.root, "outside", "private");
  symlinkSync(outside, join(f.sourceRoot, "AGENTS.md"));
  expect(() => f.run(["AGENTS.md"])).toThrow();
  const dest = f.write(f.destinationRoot, "keybindings.json", "keep"); chmodSync(dest, 0o644);
  expect(() => install!({ destinationRoot: f.destinationRoot, files: [{ path: "keybindings.json", bytes: Buffer.from("new"), mode: 0o600 }] })).toThrow();
  expect(readFileSync(dest, "utf8")).toBe("keep");
  expect(lstatSync(dest).mode & 0o777).toBe(0o644);
}, 5000);

it("does not copy native Mac binaries as supporting files", () => {
  expect(prepare).toBeTypeOf("function");
  const f = fixture();
  f.write(f.sourceRoot, "skills/check/SKILL.md", "skill");
  f.write(f.sourceRoot, "skills/check/bin/helper", Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]), 0o700);
  expect(() => f.run(["skills/check"])).toThrow(expect.objectContaining({ code: "unsupported-binary" }));
}, 5000);
