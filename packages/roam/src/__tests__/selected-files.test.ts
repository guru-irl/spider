import { afterEach, expect, it } from "vitest";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import * as selected from "../selected-files";

type File = { path: string; bytes: Buffer; mode: 0o600 | 0o700 };
type Prepared = { files: readonly File[]; credentialFiles: readonly File[]; providers: readonly string[] };
type Prepare = (input: { sourceRoot: string; selected: readonly string[]; maxBytes: number; sourceHome?: string }) => Prepared;
type Install = (input: { destinationRoot: string; files: readonly File[]; expectedSettingsFingerprint?: string }) => void;
type SettingDigest = { path: readonly string[]; sha256: string };
type SettingsProbe = { fingerprint: string; changedKeys: readonly string[] };
const settingDigests = (selected as { selectedSettingsDigests?: (file: File) => readonly SettingDigest[] }).selectedSettingsDigests;
const inspectSettings = (selected as { inspectDestinationSettings?: (input: { home: string; destinationRoot: string; entries: readonly SettingDigest[]; maximum: number }) => SettingsProbe }).inspectDestinationSettings;
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

it("does not remove a hard-linked temporary-looking file while previewing the source", () => {
  const f = fixture(), source = f.write(f.sourceRoot, "AGENTS.md", "instructions");
  const sibling = join(f.sourceRoot, ".spider-roam-11111111-1111-4111-8111-111111111111.tmp");
  linkSync(source, sibling);
  expect(() => f.run(["AGENTS.md"])).toThrow(expect.objectContaining({ code: "unsafe-file", files: ["AGENTS.md"] }));
  expect(existsSync(source)).toBe(true); expect(existsSync(sibling)).toBe(true);
  expect(lstatSync(source).nlink).toBe(2);
}, 5000);

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

it("excludes extensions, prompts, MCP and system prompts inside selected skill trees", () => {
  const f = fixture();
  f.write(f.sourceRoot, "skills/check/SKILL.md", "skill");
  f.write(f.sourceRoot, "skills/check/references/guide.md", "support");
  const excluded = ["extensions/extra.ts", "prompts/extra.md", "mcp.json", ".mcp.json", "mcp-config.json", "mcp.yaml", "SYSTEM.md", "APPEND_SYSTEM.md"];
  for (const name of excluded) f.write(f.sourceRoot, `skills/check/${name}`, "excluded");
  const result = f.run(["skills/check"]);
  expect(result.files.map(file => file.path)).toEqual(["skills/check/SKILL.md", "skills/check/references/guide.md"]);
  for (const name of excluded) {
    const path = `skills/check/${name}`;
    expect(() => f.run([path])).toThrow(expect.objectContaining({ code: "selection-not-allowed" }));
    expect(() => install!({ destinationRoot: f.destinationRoot, files: [{ path, bytes: Buffer.from("excluded"), mode: 0o600 }] }))
      .toThrow(expect.objectContaining({ code: "selection-not-allowed" }));
  }
}, 5000);

it("refuses a fixed file that is a directory and a theme directory that is a file", () => {
  const first = fixture(); first.write(first.sourceRoot, "settings.json/nested", "not settings");
  expect(() => first.run(["settings.json"])).toThrow(expect.objectContaining({ code: "unsafe-file", files: ["settings.json"] }));
  const second = fixture(); second.write(second.sourceRoot, "themes", "not a directory");
  expect(() => second.run(["themes"])).toThrow(expect.objectContaining({ code: "unsafe-file", files: ["themes"] }));
}, 5000);

it("does not copy a nested skill unless it is explicitly selected", () => {
  const f = fixture();
  f.write(f.sourceRoot, "skills/outer/SKILL.md", "outer");
  f.write(f.sourceRoot, "skills/outer/reference.md", "outer support");
  f.write(f.sourceRoot, "skills/outer/inner/SKILL.md", "inner");
  f.write(f.sourceRoot, "skills/outer/inner/helper.md", "inner support");
  expect(f.run(["skills/outer"]).files.map(file => file.path)).toEqual(["skills/outer/SKILL.md", "skills/outer/reference.md"]);
  expect(f.run(["skills/outer", "skills/outer/inner"]).files.map(file => file.path)).toEqual([
    "skills/outer/SKILL.md", "skills/outer/inner/SKILL.md", "skills/outer/inner/helper.md", "skills/outer/reference.md",
  ]);
}, 5000);

it("refuses a skill file or a directory without a skill definition", () => {
  const f = fixture();
  f.write(f.sourceRoot, "skills/check/SKILL.md", "skill");
  f.write(f.sourceRoot, "skills/group/tool.txt", "not a skill");
  for (const name of ["skills/check/SKILL.md", "skills/group"]) {
    expect(() => f.run([name])).toThrow(expect.objectContaining({ code: "selection-not-allowed" }));
  }
}, 5000);

it("copies only the documented default, theme, compaction, and retry settings", () => {
  const f = fixture();
  f.write(f.sourceRoot, "settings.json", JSON.stringify({
    defaultProvider: "example", defaultModel: "model", defaultThinkingLevel: "high", theme: "sample",
    modelThinkingLevels: { "example/model": "low" }, thinkingBudgets: { high: 100 }, enabledModels: ["model"],
    defaultProjectTrust: "always", packages: ["npm:example"], extensions: ["extensions/example.ts"], unknown: "remove",
    compaction: { enabled: false, reserveTokens: 10, keepRecentTokens: 20, unknown: "remove",
      modelOverrides: { "example/model": { reserveTokens: 30, keepRecentTokens: 40, unknown: "remove" } } },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 3, maxAgentDelayMs: 4, unknown: "remove",
      provider: { timeoutMs: 5, maxRetries: 6, maxRetryDelayMs: 7, unknown: "remove" } },
  }));
  const settings = f.run(["settings.json"]).files[0].bytes;
  install!({ destinationRoot: f.destinationRoot, files: [{ path: "settings.json", bytes: settings, mode: 0o600 }] });
  expect(JSON.parse(readFileSync(join(f.destinationRoot, "settings.json"), "utf8"))).toEqual({
    defaultProvider: "example", defaultModel: "model", defaultThinkingLevel: "high", theme: "sample",
    compaction: { enabled: false, reserveTokens: 10, keepRecentTokens: 20,
      modelOverrides: { "example/model": { reserveTokens: 30, keepRecentTokens: 40 } } },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 3, maxAgentDelayMs: 4,
      provider: { timeoutMs: 5, maxRetries: 6, maxRetryDelayMs: 7 } },
  });
}, 5000);

it("copies only documented default thinking levels", () => {
  const f = fixture();
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    f.write(f.sourceRoot, "settings.json", JSON.stringify({ defaultThinkingLevel: level }));
    expect(JSON.parse(f.run(["settings.json"]).files[0].bytes.toString("utf8"))).toEqual({ defaultThinkingLevel: level });
  }
  f.write(f.sourceRoot, "settings.json", '{"defaultThinkingLevel":"beyond"}');
  expect(() => f.run(["settings.json"]))
    .toThrow(expect.objectContaining({ code: "invalid-configuration", files: ["settings.json"] }));
}, 5000);

it("preserves allowed compaction overrides with object-property model names", () => {
  const f = fixture();
  f.write(f.sourceRoot, "settings.json", '{"compaction":{"modelOverrides":{"__proto__":{"reserveTokens":256},"constructor":{"keepRecentTokens":512}}}}');
  const prepared = f.run(["settings.json"]);
  install!({ destinationRoot: f.destinationRoot, files: prepared.files });
  const overrides = JSON.parse(readFileSync(join(f.destinationRoot, "settings.json"), "utf8")).compaction.modelOverrides;
  expect(Object.hasOwn(overrides, "__proto__")).toBe(true);
  expect(overrides["__proto__"]).toEqual({ reserveTokens: 256 });
  expect(overrides.constructor).toEqual({ keepRecentTokens: 512 });
}, 5000);

it.each([
  { reserveTokens: -1 }, { keepRecentTokens: 1.5 }, { reserveTokens: Number.MAX_SAFE_INTEGER + 1 },
  { modelOverrides: { "demo/model": { keepRecentTokens: -1 } } },
])("refuses invalid compaction token values %#", compaction => {
  const f = fixture(); f.write(f.sourceRoot, "settings.json", JSON.stringify({ compaction }));
  expect(() => f.run(["settings.json"])).toThrow(expect.objectContaining({ code: "invalid-configuration", files: ["settings.json"] }));
}, 5000);

it("excludes resource lists while copying an explicitly selected skill", () => {
  expect(prepare).toBeTypeOf("function");
  const f = fixture();
  f.write(f.sourceRoot, "settings.json", JSON.stringify({ theme: "sample", defaultProjectTrust: "always", sessionDir: "sessions",
    packages: ["npm:pi-intercom", "npm:unselected"], extensions: ["./extensions/check.ts"], prompts: ["./prompts/check.md"], skills: ["./skills/check"] }));
  f.write(f.sourceRoot, "skills/check/SKILL.md", "skill");
  const chosen = f.run(["settings.json", "skills/check"]);
  const settings = JSON.parse(chosen.files.find(file => file.path === "settings.json")!.bytes.toString());
  expect(settings).toEqual({ theme: "sample" });
  for (const key of ["defaultProjectTrust", "sessionDir", "packages", "extensions", "prompts", "skills"]) expect(settings).not.toHaveProperty(key);
  expect(chosen.files.map(file => file.path)).toEqual(["settings.json", "skills/check/SKILL.md"]);
}, 5000);

it.each(["extensions/check.ts", "prompts/check.md", "mcp.json", "SYSTEM.md", "APPEND_SYSTEM.md", "skills"]) (
  "refuses forbidden selection and installation of %s", name => {
    const f = fixture(); f.write(f.sourceRoot, name === "skills" ? "skills/check/SKILL.md" : name, name === "mcp.json" ? "{}" : "not portable");
    expect(() => f.run([name])).toThrow(expect.objectContaining({ code: "selection-not-allowed" }));
    expect(() => install!({ destinationRoot: f.destinationRoot, files: [{ path: name, bytes: Buffer.from("not portable"), mode: 0o600 }] }))
      .toThrow(expect.objectContaining({ code: "selection-not-allowed" }));
    expect(existsSync(join(f.destinationRoot, name))).toBe(false);
  }, 5000,
);

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

it("lists every selected file containing a raw or JSON-escaped Mac path", () => {
  const f = fixture(), foreign = ["", "Users", "example", "private"].join("/");
  const encoded = "\\u002f" + "Users" + "\\u002fexample\\u002fprivate";
  f.write(f.sourceRoot, "AGENTS.md", `avoid ${foreign}`);
  f.write(f.sourceRoot, "models.json", `{"providers":{"demo":{"baseUrl":"${encoded}"}}}`);
  let error: unknown;
  try { f.run(["models.json", "AGENTS.md"]); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code: "unsupported-path", files: ["AGENTS.md", "models.json"] });
  expect(String(error)).not.toContain(foreign);
}, 5000);

it("refuses a configured source home even outside the standard Mac home directory", () => {
  const f = fixture(), foreign = "/opt/example-home/private";
  f.write(f.sourceRoot, "AGENTS.md", `avoid ${foreign}`);
  expect(() => prepare!({ sourceRoot: f.sourceRoot, selected: ["AGENTS.md"], maxBytes: 1024, sourceHome: "/opt/example-home" }))
    .toThrow(expect.objectContaining({ code: "unsupported-path", files: ["AGENTS.md"] }));
}, 5000);

it("names selected instructions and skill files that reference credential commands", () => {
  const f = fixture();
  f.write(f.sourceRoot, "AGENTS.md", "apiKey: '!read-credential'\n");
  f.write(f.sourceRoot, "skills/check/SKILL.md", "Use token: \"!obtain-token\"\n");
  expect(() => f.run(["AGENTS.md", "skills/check"]))
    .toThrow(expect.objectContaining({ code: "unsupported-credential-command", files: ["AGENTS.md", "skills/check/SKILL.md"] }));
  expect(existsSync(join(f.destinationRoot, "AGENTS.md"))).toBe(false);
}, 5000);

it("refuses credential commands without executing them", () => {
  expect(prepare).toBeTypeOf("function");
  const f = fixture(), sentinel = join(f.root, "sentinel");
  f.write(f.sourceRoot, "models.json", JSON.stringify({ providers: { demo: { apiKey: `!touch ${sentinel}` } } }));
  expect(() => f.run(["models.json"])).toThrow(expect.objectContaining({ code: "unsupported-credential-command", files: ["models.json"] }));
  expect(existsSync(sentinel)).toBe(false);
}, 5000);

it("copies Pi model JSON with line comments and trailing commas without changing its bytes", () => {
  const f = fixture();
  const models = '{\n  // environment reference\n  "providers": { "demo": { "baseUrl": "https://model.invalid/a//b", "apiKey": "${DEMO_KEY}", "models": [{"id":"demo",}], }, },\n}\n';
  f.write(f.sourceRoot, "models.json", models);
  const result = f.run(["models.json"]);
  expect(result.files.map(file => file.path)).toEqual(["models.json"]);
  expect(result.credentialFiles).toEqual([]); expect(result.providers).toEqual([]);
  expect(result.files[0].bytes.toString("utf8")).toBe(models);
  install!({ destinationRoot: f.destinationRoot, files: result.files });
  expect(readFileSync(join(f.destinationRoot, "models.json"), "utf8")).toBe(models);
}, 5000);

it("classifies a credential assignment in a model comment as private", () => {
  const f = fixture();
  const models = '{\n // token: fixture-secret\n "providers": {"demo": {"apiKey": "${DEMO_KEY}"}}\n}';
  f.write(f.sourceRoot, "models.json", models);
  const result = f.run(["models.json"]);
  expect(result.files).toEqual([]);
  expect(result.providers).toEqual(["models.json"]);
  expect(result.credentialFiles[0].bytes.toString("utf8")).toBe(models);
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

it("treats literal custom model headers as credentials even when their names are unfamiliar", () => {
  const f = fixture();
  f.write(f.sourceRoot, "models.json", JSON.stringify({ providers: { demo: { headers: { "X-Session": "fixture-secret" } } } }));
  const result = f.run(["models.json"]);
  expect(result.files).toEqual([]);
  expect(result.credentialFiles.map(file => file.path)).toEqual(["models.json"]);
  expect(result.providers).toEqual(["demo"]);
}, 5000);

it("refuses credential commands in custom model headers without executing them", () => {
  const f = fixture(), sentinel = join(f.root, "sentinel");
  f.write(f.sourceRoot, "models.json", JSON.stringify({ providers: { demo: { headers: { "X-Session": `!touch ${relative(process.cwd(), sentinel)}` } } } }));
  expect(() => f.run(["models.json"])).toThrow(expect.objectContaining({ code: "unsupported-credential-command", files: ["models.json"] }));
  expect(existsSync(sentinel)).toBe(false);
}, 5000);

it("compares only selected settings leaves without exposing their values or changing the box", () => {
  expect(settingDigests).toBeTypeOf("function"); expect(inspectSettings).toBeTypeOf("function");
  const f = fixture();
  f.write(f.sourceRoot, "settings.json", JSON.stringify({ defaultModel: "same-model", theme: "new-theme",
    compaction: { reserveTokens: 200, modelOverrides: { "demo/a": { reserveTokens: 900 } } } }));
  const original = JSON.stringify({ defaultModel: "same-model", theme: "old-theme", defaultProjectTrust: "never",
    compaction: { reserveTokens: 100, modelOverrides: { "demo/a": { reserveTokens: 800, local: "keep" } } } });
  const target = f.write(f.destinationRoot, "settings.json", original), entries = settingDigests!(f.run(["settings.json"]).files[0]);
  expect(JSON.stringify(entries)).not.toContain("same-model"); expect(JSON.stringify(entries)).not.toContain("new-theme");
  const preview = inspectSettings!({ home: f.root, destinationRoot: f.destinationRoot, entries, maximum: 1024 * 1024 });
  expect(preview.changedKeys).toEqual(["compaction.modelOverrides.demo/a.reserveTokens", "compaction.reserveTokens", "theme"]);
  expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(preview)).not.toContain("old-theme"); expect(JSON.stringify(preview)).not.toContain("new-theme");
  expect(readFileSync(target, "utf8")).toBe(original); expect(existsSync(`${target}.spider-roam.bak`)).toBe(false);
}, 5000);

it("reports all selected settings keys for a missing box directory without creating it", () => {
  expect(settingDigests).toBeTypeOf("function"); expect(inspectSettings).toBeTypeOf("function");
  const f = fixture(); f.write(f.sourceRoot, "settings.json", '{"theme":"sample"}');
  const entries = settingDigests!(f.run(["settings.json"]).files[0]), destinationRoot = join(f.root, "missing", "agent");
  expect(inspectSettings!({ home: f.root, destinationRoot, entries, maximum: 1024 * 1024 }).changedKeys).toEqual(["theme"]);
  expect(existsSync(join(f.root, "missing"))).toBe(false);
}, 5000);

it("merges selected settings leaves into box settings without deleting box-only values", () => {
  const f = fixture();
  const box = { defaultProvider: "box-provider", defaultModel: "box-model", defaultThinkingLevel: "high", theme: "box-theme",
    defaultProjectTrust: "never", images: { blockImages: true }, packages: ["npm:other", "npm:pi-intercom"], extensions: ["./extensions/box.ts"],
    compaction: { enabled: false, reserveTokens: 111, keepRecentTokens: 222, local: "keep",
      modelOverrides: { "demo/a": { reserveTokens: 1, keepRecentTokens: 2, local: "keep" }, "box/model": { reserveTokens: 9 } } },
    retry: { enabled: false, maxRetries: 9, local: "keep", provider: { timeoutMs: 1000, local: "keep" } } };
  const original = JSON.stringify(box, null, 2) + "\n";
  f.write(f.destinationRoot, "settings.json", original); f.write(f.destinationRoot, "AGENTS.md", "unrelated");
  f.write(f.sourceRoot, "settings.json", JSON.stringify({ theme: "source-theme", defaultProjectTrust: "always", images: { blockImages: false },
    compaction: { reserveTokens: 333, modelOverrides: { "demo/a": { keepRecentTokens: 4 }, "demo/b": { reserveTokens: 5 } } },
    retry: { provider: { maxRetries: 4 } } }));
  const files = f.run(["settings.json"]).files;
  install!({ destinationRoot: f.destinationRoot, files });
  const target = join(f.destinationRoot, "settings.json"), backup = `${target}.spider-roam.bak`;
  const first = readFileSync(target), inode = lstatSync(target).ino;
  expect(JSON.parse(first.toString("utf8"))).toEqual({ ...box, theme: "source-theme",
    compaction: { ...box.compaction, reserveTokens: 333, modelOverrides: { ...box.compaction.modelOverrides,
      "demo/a": { ...box.compaction.modelOverrides["demo/a"], keepRecentTokens: 4 }, "demo/b": { reserveTokens: 5 } } },
    retry: { ...box.retry, provider: { ...box.retry.provider, maxRetries: 4 } } });
  expect(readFileSync(backup, "utf8")).toBe(original); expect(readFileSync(join(f.destinationRoot, "AGENTS.md"), "utf8")).toBe("unrelated");
  install!({ destinationRoot: f.destinationRoot, files });
  expect(readFileSync(target)).toEqual(first); expect(lstatSync(target).ino).toBe(inode);
  expect(readFileSync(backup, "utf8")).toBe(original);
}, 5000);

it("preserves large and high-exponent numbers in box-only settings", () => {
  const f = fixture(); f.write(f.sourceRoot, "settings.json", '{"theme":"source-theme"}');
  const target = f.write(f.destinationRoot, "settings.json", '{"theme":"old-theme","large":9007199254740993,"nested":{"huge":1e400}}');
  const files = f.run(["settings.json"]).files;
  const preview = inspectSettings!({ home: f.root, destinationRoot: f.destinationRoot, entries: settingDigests!(files[0]), maximum: 1024 * 1024 });
  install!({ destinationRoot: f.destinationRoot, files, expectedSettingsFingerprint: preview.fingerprint });
  const result = readFileSync(target, "utf8");
  expect(result).toContain('"large": 9007199254740993'); expect(result).toContain('"huge": 1e400');
  expect(JSON.parse(result).theme).toBe("source-theme");
}, 5000);

it.each([["1000", "1e3"], ["0", "0e999999999999999999999"]])("treats numeric spellings %s and %s as the same settings value", (source, box) => {
  const f = fixture(); f.write(f.sourceRoot, "settings.json", `{"retry":{"maxRetries":${source}}}`);
  const original = `{"retry":{"maxRetries":${box}},"defaultProjectTrust":"never"}`;
  const target = f.write(f.destinationRoot, "settings.json", original), files = f.run(["settings.json"]).files;
  const preview = inspectSettings!({ home: f.root, destinationRoot: f.destinationRoot, entries: settingDigests!(files[0]), maximum: 1024 * 1024 });
  expect(preview.changedKeys).toEqual([]);
  install!({ destinationRoot: f.destinationRoot, files, expectedSettingsFingerprint: preview.fingerprint });
  expect(readFileSync(target, "utf8")).toBe(original); expect(existsSync(`${target}.spider-roam.bak`)).toBe(false);
}, 5000);

it("reports a selected large number that differs beyond JavaScript integer precision", () => {
  const f = fixture(); f.write(f.sourceRoot, "settings.json", '{"retry":{"maxRetries":9007199254740992}}');
  const target = f.write(f.destinationRoot, "settings.json", '{"retry":{"maxRetries":9007199254740993}}');
  const files = f.run(["settings.json"]).files;
  const preview = inspectSettings!({ home: f.root, destinationRoot: f.destinationRoot, entries: settingDigests!(files[0]), maximum: 1024 * 1024 });
  expect(preview.changedKeys).toEqual(["retry.maxRetries"]);
  install!({ destinationRoot: f.destinationRoot, files, expectedSettingsFingerprint: preview.fingerprint });
  expect(readFileSync(target, "utf8")).toContain('"maxRetries": 9007199254740992');
}, 5000);

it("treats positive and negative JSON zero as the same settings value", () => {
  const f = fixture(); f.write(f.sourceRoot, "settings.json", '{"compaction":{"reserveTokens":0}}');
  const original = '{"compaction":{"reserveTokens":-0},"defaultProjectTrust":"never"}';
  const target = f.write(f.destinationRoot, "settings.json", original), files = f.run(["settings.json"]).files;
  const preview = inspectSettings!({ home: f.root, destinationRoot: f.destinationRoot, entries: settingDigests!(files[0]), maximum: 1024 * 1024 });
  expect(preview.changedKeys).toEqual([]);
  install!({ destinationRoot: f.destinationRoot, files, expectedSettingsFingerprint: preview.fingerprint });
  expect(readFileSync(target, "utf8")).toBe(original); expect(existsSync(`${target}.spider-roam.bak`)).toBe(false);
}, 5000);

it("previews an interrupted settings publication without deleting its recovery link", () => {
  const f = fixture(); f.write(f.sourceRoot, "settings.json", '{"theme":"source-theme"}');
  const files = f.run(["settings.json"]).files, target = f.write(f.destinationRoot, "settings.json", files[0].bytes);
  const temporary = join(f.destinationRoot, ".spider-roam-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp"); linkSync(target, temporary);
  const entries = settingDigests!(files[0]);
  const preview = inspectSettings!({ home: f.root, destinationRoot: f.destinationRoot, entries, maximum: 1024 * 1024 });
  expect(preview.changedKeys).toEqual([]); expect(existsSync(temporary)).toBe(true); expect(lstatSync(target).nlink).toBe(2);
  install!({ destinationRoot: f.destinationRoot, files, expectedSettingsFingerprint: preview.fingerprint });
  expect(existsSync(temporary)).toBe(false); expect(readFileSync(target)).toEqual(files[0].bytes);
  expect(existsSync(`${target}.spider-roam.bak`)).toBe(false);
}, 5000);

it("does not accept an unrelated hard link as an interrupted publication", () => {
  const f = fixture(); f.write(f.sourceRoot, "settings.json", '{"theme":"source-theme"}');
  const target = f.write(f.destinationRoot, "settings.json", '{"theme":"old-theme"}');
  const link = join(f.destinationRoot, "unrelated-link"); linkSync(target, link);
  expect(() => inspectSettings!({ home: f.root, destinationRoot: f.destinationRoot, entries: settingDigests!(f.run(["settings.json"]).files[0]), maximum: 1024 * 1024 }))
    .toThrow(expect.objectContaining({ code: "unsafe-destination" }));
  expect(existsSync(link)).toBe(true); expect(lstatSync(target).nlink).toBe(2);
}, 5000);

it("does not undo a concurrent box mode change when selected values already match", () => {
  const f = fixture(); f.write(f.sourceRoot, "settings.json", '{"theme":"same"}');
  const target = f.write(f.destinationRoot, "settings.json", '{"theme":"same","defaultProjectTrust":"never"}');
  const files = f.run(["settings.json"]).files;
  const preview = inspectSettings!({ home: f.root, destinationRoot: f.destinationRoot, entries: settingDigests!(files[0]), maximum: 1024 * 1024 });
  expect(preview.changedKeys).toEqual([]); chmodSync(target, 0o700);
  expect(() => install!({ destinationRoot: f.destinationRoot, files, expectedSettingsFingerprint: preview.fingerprint }))
    .toThrow(expect.objectContaining({ code: "settings-preview-changed" }));
  expect(lstatSync(target).mode & 0o777).toBe(0o700); expect(existsSync(`${target}.spider-roam.bak`)).toBe(false);
}, 5000);

it("refuses a stale settings preview without overwriting a concurrent box edit", () => {
  const f = fixture(); f.write(f.sourceRoot, "settings.json", '{"theme":"source-theme"}');
  const target = f.write(f.destinationRoot, "settings.json", '{"theme":"old-theme","defaultProjectTrust":"never"}');
  const files = f.run(["settings.json"]).files, entries = settingDigests!(files[0]);
  const preview = inspectSettings!({ home: f.root, destinationRoot: f.destinationRoot, entries, maximum: 1024 * 1024 });
  const edited = '{"theme":"other-theme","defaultProjectTrust":"never","images":{"blockImages":true}}';
  f.write(f.destinationRoot, "settings.json", edited);
  expect(() => install!({ destinationRoot: f.destinationRoot, files, expectedSettingsFingerprint: preview.fingerprint }))
    .toThrow(expect.objectContaining({ code: "settings-preview-changed", files: ["settings.json"] }));
  expect(readFileSync(target, "utf8")).toBe(edited); expect(existsSync(`${target}.spider-roam.bak`)).toBe(false);
}, 5000);

it.each(["{invalid", "[]", "null", "42"]) ("refuses invalid box settings %s without writing or creating a backup", contents => {
  const f = fixture();
  const target = f.write(f.destinationRoot, "settings.json", contents);
  f.write(f.sourceRoot, "settings.json", '{"theme":"source-theme"}');
  expect(() => install!({ destinationRoot: f.destinationRoot, files: f.run(["settings.json"]).files }))
    .toThrow(expect.objectContaining({ code: "invalid-destination-settings", files: ["settings.json"] }));
  expect(readFileSync(target, "utf8")).toBe(contents);
  expect(existsSync(`${target}.spider-roam.bak`)).toBe(false);
}, 5000);

it("backs up overwritten files once and replaces only selected files on retry", () => {
  expect(install).toBeTypeOf("function");
  const f = fixture();
  const original = '{"theme":"original"}', updated = '{\n  "theme": "new"\n}\n';
  f.write(f.destinationRoot, "settings.json", original); f.write(f.destinationRoot, "AGENTS.md", "leave alone");
  const files: File[] = [{ path: "settings.json", bytes: Buffer.from(updated), mode: 0o600 }];
  install!({ destinationRoot: f.destinationRoot, files });
  expect(readFileSync(join(f.destinationRoot, "settings.json"), "utf8")).toBe(updated);
  expect(existsSync(join(f.destinationRoot, "settings.json.spider-roam.bak"))).toBe(true);
  expect(readFileSync(join(f.destinationRoot, "settings.json.spider-roam.bak"), "utf8")).toBe(original);
  f.write(f.destinationRoot, "settings.json", '{"theme":"hand edit"}');
  install!({ destinationRoot: f.destinationRoot, files });
  expect(readFileSync(join(f.destinationRoot, "settings.json"), "utf8")).toBe(updated);
  expect(readFileSync(join(f.destinationRoot, "settings.json.spider-roam.bak"), "utf8")).toBe(original);
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
