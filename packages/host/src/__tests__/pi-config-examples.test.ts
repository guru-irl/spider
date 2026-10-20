import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  configKinds, findPiConfigExamples, validatePiConfigExample,
  type ConfigExample, type ConfigKind, type Schemas,
} from "./pi-config-examples.helpers.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
// Use the schemas shipped with the installed pi version, never a network copy.
// typebox/schema is already installed through pi and supports JSON Schema 2020-12.
const schemas = Object.fromEntries(configKinds.map(kind => [kind, JSON.parse(readFileSync(
  join(root, "node_modules/@earendil-works/pi-coding-agent/schemas", `${kind}.schema.json`), "utf8",
))])) as Schemas;

function example(kind: ConfigKind, value: unknown, partial = false): ConfigExample {
  return { source: "example.md", line: 3, kind, json: JSON.stringify(value), partial };
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith(".md") ? [path] : [];
  }).sort();
}

describe("pi configuration example discovery", () => {
  it.each(["models", "settings", "keybindings"] as const)("detects %s.json in the preceding paragraph", kind => {
    const found = findPiConfigExamples(`Edit \`${kind}.json\`:\n\n\`\`\`json\n{}\n\`\`\``, "guide.md");
    expect(found).toEqual([{ source: "guide.md", line: 3, kind, partial: false, json: "{}" }]);
  });

  it("keeps a filename heading in scope for successive examples", () => {
    const found = findPiConfigExamples("## settings.json\n\nFirst:\n\n```json\n{}\n```\n\nSecond:\n\n```json\n{}\n```", "guide.md");
    expect(found.map(item => item.kind)).toEqual(["settings", "settings"]);
  });

  it("uses the nearest filename rather than an unrelated filename in the heading", () => {
    const found = findPiConfigExamples("## settings.json\n\nEdit `models.json`:\n\n```json\n{}\n```", "guide.md");
    expect(found.map(item => item.kind)).toEqual(["models"]);
  });

  it("rejects markers that select a different schema from the example's schema URL", () => {
    expect(() => findPiConfigExamples('<!-- pi-config: settings -->\n```json\n{"$schema":"https://pi.dev/schemas/theme.schema.json"}\n```', "guide.md"))
      .toThrow(/guide.md.*conflict/);
  });

  it("detects schema URLs, theme prose, and filenames in fence labels", () => {
    const found = findPiConfigExamples([
      '```json\n{"$schema":"https://pi.dev/schemas/theme.schema.json"}\n```',
      'A custom theme example:\n\n~~~json\n{"name":"test","colors":{}}\n~~~',
      '```json title="keybindings.json"\n{}\n```',
    ].join("\n\n"), "guide.md");
    expect(found.map(item => item.kind)).toEqual(["theme", "theme", "keybindings"]);
  });

  it("does not mistake spider config, manifests, or nested fences in source examples for pi config", () => {
    const found = findPiConfigExamples([
      'Edit `.spider/config.json`:\n\n```json\n{"subagents.childMode":"rpc"}\n```',
      'Write `package.json`:\n\n```json\n{"pi":{"extensions":[]}}\n```',
      '````typescript\nconst sample = `\n```json\n{"$schema":"https://pi.dev/schemas/models.schema.json"}\n```\n`;\n````',
    ].join("\n\n"), "guide.md");
    expect(found).toEqual([]);
  });

  it("discovers incomplete theme examples so missing partial markers fail validation", () => {
    const found = findPiConfigExamples('A custom theme example:\n\n```json\n{"colors":{"accent":"#fff"}}\n```', "guide.md");
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("theme");
    expect(validatePiConfigExample(found[0], schemas).length).toBeGreaterThan(0);
  });

  it("recognizes partial markers without leaking them to later fences", () => {
    const found = findPiConfigExamples("<!-- pi-config: theme partial -->\n\n```json\n{}\n```\n\nEdit `settings.json`:\n\n```json\n{}\n```", "guide.md");
    expect(found.map(item => [item.kind, item.partial])).toEqual([["theme", true], ["settings", false]]);
  });

  it("rejects malformed explicit markers instead of silently skipping them", () => {
    expect(() => findPiConfigExamples("<!-- pi-config: model partial -->\n```json\n{}\n```", "guide.md"))
      .toThrow(/guide.md.*pi-config/);
  });
});

describe("published pi configuration schemas", () => {
  it.each([
    ["models", { providers: { example: { models: [{ id: 42 }] } } }],
    ["settings", { defaultThinkingLevel: "invalid" }],
    ["keybindings", { "app.session.new": 42 }],
    ["theme", { name: "example", colors: {} }],
  ] as const)("rejects invalid %s configuration with a source location", (kind, value) => {
    expect(validatePiConfigExample(example(kind, value), schemas).join("\n")).toMatch(/example.md:3/);
  });

  it("reports malformed JSON rather than skipping the example", () => {
    expect(validatePiConfigExample({ ...example("settings", {}), json: '{"theme":}' }, schemas).join("\n"))
      .toMatch(/example.md:3.*JSON/);
  });

  it("allows explicitly partial examples to omit required fields but still validates supplied values", () => {
    expect(validatePiConfigExample(example("theme", { colors: { accent: "#ff0000" } }, true), schemas)).toEqual([]);
    expect(validatePiConfigExample(example("theme", { colors: { accent: false } }, true), schemas).length).toBeGreaterThan(0);
    expect(validatePiConfigExample(example("theme", { colors: { inventedColor: "#fff" } }, true), schemas).length).toBeGreaterThan(0);
    expect(validatePiConfigExample(example("theme", { colors: { accent: "#ff0000" } }), schemas).length).toBeGreaterThan(0);
  });

  it("accepts model metadata extensions such as compactAtPercent without weakening known fields", () => {
    expect(validatePiConfigExample(example("models", {
      providers: { example: { modelOverrides: { example: { compactAtPercent: 60 } } } },
    }), schemas)).toEqual([]);
  });

  it("rejects obsolete theme schema URLs even when the schema allows any string", () => {
    expect(validatePiConfigExample(example("theme", {
      $schema: "https://example.com/theme.schema.json", colors: {},
    }, true), schemas).join("\n")).toContain("https://pi.dev/schemas/theme.schema.json");
  });
});

describe("README and docs pi configuration examples", () => {
  const examples = [join(root, "README.md"), ...markdownFiles(join(root, "docs"))].flatMap(path =>
    findPiConfigExamples(readFileSync(path, "utf8"), relative(root, path)),
  );

  it("discovers pi configuration examples rather than passing an empty scan", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(examples)("$source:$line validates as $kind", item => {
    expect(validatePiConfigExample(item, schemas)).toEqual([]);
  });
});
