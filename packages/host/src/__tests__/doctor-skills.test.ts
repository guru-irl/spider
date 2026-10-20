import { afterEach, expect, it } from "vitest";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setGlobalDbPathForTests } from "@spider/db-core";
import { controlDoctor } from "../control.js";

let root: string | undefined;
afterEach(() => {
  setGlobalDbPathForTests(null);
  if (root) rmSync(root, { recursive: true, force: true });
});
it("reports resolved bundled folders and the skill count of each collection", () => {
  root = resolve(".spider/scratch", `doctor-skills-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  setGlobalDbPathForTests(join(root, "global.db"));
  const report = controlDoctor(root);
  for (const collection of ["superpowers", "pstack"]) {
    const dir = resolve(`packages/${collection}/skills`);
    const count = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).length;
    expect(report.lines).toContain(`- bundled ${collection} skills: ${dir} (${count} skills)`);
  }
  expect(report.lines.join("\n")).toContain("(31 skills)");
});
