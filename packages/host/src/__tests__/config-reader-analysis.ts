import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import ts from "typescript";
import { isDeepStrictEqual } from "node:util";
import type { ConfigField } from "@spider/ui";
import { ORGANISM_CONFIG_KEYS, CURATOR_CONFIG_KEYS } from "@spider/organism";
import { AUXILIARY_CONFIG_KEYS } from "../organism-runtime";

/** Follow production imports from the extension entry point, not every loose .ts file. */
export function productionReaders(root: string, overrides: Record<string, string> = {}): Set<string> {
  const base = resolve(root);
  const seen = new Set<string>();
  const readers = new Set<string>([...ORGANISM_CONFIG_KEYS, ...CURATOR_CONFIG_KEYS, ...AUXILIARY_CONFIG_KEYS]);
  const visit = (file: string): void => {
    if (!file.startsWith(base + "/") || !file.endsWith(".ts") || file.includes("/__tests__/") || seen.has(file)) return;
    if (!(file in overrides) && !existsSync(file)) return;
    seen.add(file);
    const source = ts.createSourceFile(file, overrides[file] ?? readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const imported = (specifier: string): void => {
      if (specifier === "@spider/organism") { visit(join(base, "organism/src/index.ts")); return; }
      if (!specifier.startsWith(".")) return;
      const stem = resolve(dirname(file), specifier.replace(/\.(?:js|ts)$/, ""));
      const next = [stem + ".ts", join(stem, "index.ts")].find(p => p in overrides || existsSync(p));
      if (next) visit(next);
    };
    const walk = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imported(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imported(node.arguments[0].text);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "controlConfig"
        && node.arguments.length >= 3 && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "get"
        && ts.isStringLiteral(node.arguments[2])) readers.add(node.arguments[2].text);
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "values"
        && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text.startsWith("usage.")) {
        readers.add(node.argumentExpression.text);
      }
      if (ts.isElementAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "config" && ts.isStringLiteral(node.argumentExpression)) {
        readers.add(node.argumentExpression.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  visit(join(base, "host/src/extension.ts"));
  return readers;
}

export function mismatchedDefaults(defaults: Readonly<Record<string, unknown>>, fields: ConfigField[]): string[] {
  return Object.entries(defaults).filter(([key, value]) =>
    !fields.some(field => field.key === key && isDeepStrictEqual(field.default, value))).map(([key]) => key);
}
