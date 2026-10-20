import { Errors } from "typebox/schema";

export const configKinds = ["models", "settings", "keybindings", "theme"] as const;
export type ConfigKind = typeof configKinds[number];
export type Schemas = Record<ConfigKind, Record<string, unknown>>;
export interface ConfigExample {
  source: string;
  line: number;
  kind: ConfigKind;
  partial: boolean;
  json: string;
}

/**
 * Detection rule: scan JSON fences in all Markdown files, not a fixture allowlist.
 * Identify pi config by its $schema URL, then a filename in the fence label,
 * nearest preceding paragraph or current heading, or custom-theme prose.
 * An adjacent <!-- pi-config: settings --> explicitly selects a schema. The other
 * names are models, keybindings and theme. Use <!-- pi-config: theme partial -->
 * for deliberately incomplete root objects. These still
 * validate every supplied value; only required-property constraints are relaxed,
 * recursively, including referenced schemas. Partial examples are never skipped.
 * Non-pi JSON (spider config, manifests, tool payloads, etc.) is not pi config.
 */
export function findPiConfigExamples(markdown: string, source: string): ConfigExample[] {
  const lines = markdown.split(/\r?\n/);
  const examples: ConfigExample[] = [];
  let heading = "";
  let prose: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const opening = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!opening) {
      if (/^#{1,6}\s/.test(lines[i])) heading = lines[i];
      prose.push(lines[i]);
      continue;
    }
    const start = i;
    const [, delimiter, label] = opening;
    const body: string[] = [];
    const closing = new RegExp(`^\\s{0,3}${delimiter[0]}{${delimiter.length},}\\s*$`);
    while (++i < lines.length && !closing.test(lines[i])) body.push(lines[i]);
    const context = prose.join("\n").trimEnd();
    prose = [];
    if (!/^json(?:\s|$)/i.test(label)) continue;
    const json = body.join("\n");
    const paragraph = context.split(/\n\s*\n/).at(-1) ?? "";
    const markers = [...context.matchAll(/<!--\s*pi-config:([^>]*?)-->/g)];
    const marker = markers.at(-1)?.[1].trim();
    const schemaKind = /"\$schema"\s*:\s*"[^"\n]*\/(models|settings|keybindings|theme)\.schema\.json"/.exec(json)?.[1];
    let kind: ConfigKind | undefined;
    let partial = false;
    if (marker !== undefined) {
      const match = /^(models|settings|keybindings|theme)( partial)?$/.exec(marker);
      if (!match) throw new Error(`${source}:${start + 1}: invalid pi-config marker: ${marker}`);
      kind = match[1] as ConfigKind;
      partial = Boolean(match[2]);
      if (schemaKind && kind !== schemaKind) throw new Error(`${source}:${start + 1}: pi-config marker conflicts with $schema`);
    } else {
      const contextKinds = [label, paragraph, heading]
        .map(text => configKinds.filter(candidate => new RegExp(`\\b${candidate}\\.json\\b`).test(text)))
        .find(kinds => kinds.length > 0) ?? [];
      if (contextKinds.length > 1 && !schemaKind) {
        throw new Error(`${source}:${start + 1}: ambiguous pi config; add a pi-config marker`);
      }
      kind = (schemaKind ?? contextKinds[0]) as ConfigKind | undefined;
      if (!kind && /\bthemes?\b/i.test(`${paragraph}\n${heading}`)) kind = "theme";
    }
    if (!kind) continue;
    if (i === lines.length) throw new Error(`${source}:${start + 1}: unclosed pi configuration fence`);
    examples.push({ source, line: start + 1, kind, partial, json });
  }
  return examples;
}

// Traverse schema positions only, preserving data in const/enum/default and
// property names such as "required". Do not mutate the published schema.
function withoutRequired(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null) return schema;
  const result = { ...schema } as Record<string, unknown>;
  delete result.required;
  for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
    const map = result[key];
    if (map && typeof map === "object") {
      result[key] = Object.fromEntries(Object.entries(map).map(([name, value]) => [name, withoutRequired(value)]));
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    if (Array.isArray(result[key])) result[key] = result[key].map(withoutRequired);
  }
  for (const key of ["items", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedProperties", "unevaluatedItems"]) {
    if (key in result) result[key] = withoutRequired(result[key]);
  }
  return result;
}

export function validatePiConfigExample(example: ConfigExample, schemas: Schemas): string[] {
  const location = `${example.source}:${example.line} (${example.kind}${example.partial ? " partial" : ""})`;
  let value: unknown;
  try {
    value = JSON.parse(example.json);
  } catch (error) {
    return [`${location}: invalid JSON: ${String(error)}`];
  }
  const schema = example.partial ? withoutRequired(schemas[example.kind]) as Record<string, unknown> : schemas[example.kind];
  const [, errors] = Errors(schema, value);
  const messages = errors.map(error => `${location}${error.instancePath}: ${error.message}`);
  if (example.kind === "theme" && value && typeof value === "object" && "$schema" in value && value.$schema !== "https://pi.dev/schemas/theme.schema.json") {
    messages.push(`${location}: use https://pi.dev/schemas/theme.schema.json`);
  }
  return messages;
}
