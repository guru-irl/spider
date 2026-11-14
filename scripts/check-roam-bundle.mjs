import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";

function checkImports(code, path) {
  const tree = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) throw new Error(`invalid roaming JavaScript: ${path}`);
  const visit = node => {
    if (ts.isStringLiteralLike(node) && node.text.startsWith("@earendil-works/pi-")) {
      throw new Error(`pi import in roaming entry: ${path}`);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isIdentifier(node.expression) && node.expression.text === "require") &&
      (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0]))) {
      throw new Error(`pi import cannot be excluded from a nonliteral import in roaming entry: ${path}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (code.includes("node_modules/@earendil-works/pi-")) throw new Error(`pi import in roaming entry: ${path}`);
}

function checkHelper(code, path) {
  if (/better-sqlite3|sqlite-vec|node:sqlite|@earendil-works\/pi-|transcript|terminal/i.test(code)) throw new Error(`forbidden heavyweight path in helper: ${path}`);
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  const tree = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier &&
        (!ts.isStringLiteral(node.moduleSpecifier) || !builtins.has(node.moduleSpecifier.text))) throw new Error(`non-builtin helper import: ${path}`);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
      throw new Error(`dynamic helper import: ${path}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

export function assertRoamBundle(root, options = {}) {
  const directory = join(root, "dist/roam");
  const legacy = ["cli.mjs", "supervisor.mjs"], current = ["cli-main.mjs", "cli.mjs", "intercom-helper.mjs", "supervisor.mjs"];
  const found = lstatSync(directory).isDirectory() ? readdirSync(directory).sort().join() : "";
  const entries = found === current.join() ? current : !options.requireHelper && found === legacy.join() ? legacy : null;
  if (!entries) throw new Error("roaming entries missing or unexpected runtime chunk");
  for (const entry of entries) {
    const path = join(directory, entry);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new Error(`invalid roaming entry: ${path}`);
    const code = readFileSync(path, "utf8");
    if (!code.startsWith("#!/usr/bin/env node\n")) throw new Error(`invalid roaming entry: ${path}`);
    checkImports(code, path);
    if (entry === "intercom-helper.mjs") checkHelper(code, path);
    if (entry === "cli.mjs" && entries === current && (!code.includes('import("./intercom-helper.mjs")') || !code.includes('import("./cli-main.mjs")') || /better-sqlite3|sqlite-vec/i.test(code))) {
      throw new Error(`invalid roaming helper dispatcher: ${path}`);
    }
  }
}
