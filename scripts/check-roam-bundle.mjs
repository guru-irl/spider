import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

export function assertRoamBundle(root) {
  const directory = join(root, "dist/roam");
  const entries = ["cli.mjs", "supervisor.mjs"];
  if (!lstatSync(directory).isDirectory() || readdirSync(directory).sort().join() !== entries.join()) {
    throw new Error("roaming entries missing or unexpected runtime chunk");
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new Error(`invalid roaming entry: ${path}`);
    const code = readFileSync(path, "utf8");
    if (!code.startsWith("#!/usr/bin/env node\n")) throw new Error(`invalid roaming entry: ${path}`);
    checkImports(code, path);
  }
}
