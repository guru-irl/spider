import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { EVENT_POLICIES } from "@spider/db-core/roam/event-policy";
import { PERSISTED_EVENT_TYPES } from "../rpc-child";
import * as schemas from "../schemas";

const packages = join(dirname(fileURLToPath(import.meta.url)), "../../../");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "dist" ? [] : files(join(dir, entry.name));
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts") ? [join(dir, entry.name)] : [];
  });
}

function collect(source: string, name: string, result: Set<string>): void {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "appendRunEvent") {
      const object = node.arguments[1];
      if (!object || !ts.isObjectLiteralExpression(object)) throw new Error(`Unresolved event producer in ${name}`);
      const type = object.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(file) === "type");
      if (!type || !ts.isPropertyAssignment(type)) throw new Error(`Missing event type in ${name}`);
      if (ts.isStringLiteral(type.initializer)) result.add(type.initializer.text);
      else {
        let parent: ts.Node | undefined = node;
        while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
        const body = parent?.getText(file) ?? "";
        if (type.initializer.getText(file) !== "event.type" || !body.includes("PERSISTED_EVENT_TYPES.includes(event.type)")) {
          throw new Error(`Unresolved dynamic event producer in ${name}`);
        }
        for (const variant of PERSISTED_EVENT_TYPES) result.add(variant);
      }
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /INSERT\s+INTO\s+run_events\s*\(/i.test(node.text)) {
      if (name.endsWith("db-core/src/events.ts")) return;
      const match = node.text.match(/INSERT\s+INTO\s+run_events\s*\(([^)]*)\)\s*(?:SELECT|VALUES\s*\()\s*([\s\S]*?)(?:\s+FROM\s|\s+WHERE\s|\)|$)/i);
      if (!match) throw new Error(`Unresolved run-event SQL in ${name}`);
      const columns = match[1].split(",").map(x => x.trim().toLowerCase());
      const value = match[2].split(",")[columns.indexOf("type")]?.trim();
      const literal = value?.match(/^'([^']+)'$/);
      if (!literal) throw new Error(`Unresolved run-event SQL type in ${name}`);
      result.add(literal[1]);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
}

function sourceProducers(): Set<string> {
  const result = new Set<string>();
  const roots = readdirSync(packages, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => join(packages, x.name, "src"));
  for (const root of roots) {
    let sources: string[];
    try { sources = files(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const path of sources) collect(readFileSync(path, "utf8"), relative(packages, path), result);
  }
  return result;
}

const sorted = (types: Iterable<string>) => [...types].sort();
describe("run-event producer inventory", () => {
  it("every known producer has an explicit export policy", () => {
    const actual = sorted(sourceProducers());
    expect(actual).toEqual(sorted(Object.keys(EVENT_POLICIES)));
    const known = (schemas as unknown as { KNOWN_RUN_EVENT_TYPES?: string[] }).KNOWN_RUN_EVENT_TYPES;
    expect(known && sorted(known)).toEqual(actual);
  }, 5000);

  it("new literal or dynamic producer without policy fails the check", () => {
    const literal = new Set<string>();
    collect('appendRunEvent(db, {type: "new_event"});', "example.ts", literal);
    expect(sorted(literal).filter(type => !(type in EVENT_POLICIES))).toEqual(["new_event"]);
    expect(() => collect('appendRunEvent(db, {type: event.type});', "example.ts", new Set())).toThrow(/Unresolved dynamic/);
    const sql = new Set<string>();
    collect("db.prepare(`INSERT INTO run_events (run_id,type) SELECT ?, 'new_marker'`);", "example.ts", sql);
    expect(sorted(sql).filter(type => !(type in EVENT_POLICIES))).toEqual(["new_marker"]);
  }, 5000);
});
