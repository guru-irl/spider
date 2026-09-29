import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { testScratchPath } from "./testutil.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const polluterScript = path.join(packageRoot, "skills/systematic-debugging/find-polluter.sh");
const renderScript = path.join(packageRoot, "skills/writing-skills/render-graphs.js");
const roots: string[] = [];
let sequence = 0;

function freshRoot(label: string): string {
  const root = testScratchPath(`skill-scripts-${label}-${process.pid}-${sequence++}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function polluterRun(pattern: string): ReturnType<typeof spawnSync> {
  const project = freshRoot("polluter");
  fs.mkdirSync(path.join(project, "src/feature"), { recursive: true });
  fs.mkdirSync(path.join(project, "bin"), { recursive: true });
  fs.writeFileSync(path.join(project, "src/top.test.ts"), "test('top')\n");
  fs.writeFileSync(path.join(project, "src/feature/nested.test.ts"), "test('nested')\n");
  const npmStub = path.join(project, "bin/npm");
  fs.writeFileSync(npmStub, "#!/usr/bin/env bash\ntouch pollution.marker\n");
  fs.chmodSync(npmStub, 0o755);

  return spawnSync("bash", [polluterScript, "pollution.marker", pattern], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, PATH: `${path.join(project, "bin")}:${process.env.PATH ?? ""}` },
  });
}

describe("systematic-debugging find-polluter", () => {
  it("matches nested and top-level tests for a **/ pattern", () => {
    const result = polluterRun("src/**/*.test.ts");
    expect(result.stdout).toContain("Found 2 test files");
    expect(result.stdout).toContain("FOUND POLLUTER");
  });

  it("accepts a leading ./ on the pattern", () => {
    const result = polluterRun("./src/**/*.test.ts");
    expect(result.stdout).toContain("Found 2 test files");
  });

  it("reports an honest zero for a non-matching pattern", () => {
    const result = polluterRun("nomatch/**/*.test.ts");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Found 0 test files");
    expect(result.stdout).toContain("No polluter found");
  });
});

function renderFixture(): string {
  const root = freshRoot("render");
  const fixture = path.join(root, "fixture-skill");
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, "SKILL.md"), `---\nname: fixture-skill\n---\n\n# Fixture\n\n\`\`\`dot\ndigraph fixture_graph {\n  start -> end;\n}\n\`\`\`\n`);
  return fixture;
}

const dotAvailable = spawnSync("dot", ["-V"], { encoding: "utf8" }).status === 0;

describe("writing-skills render-graphs", () => {
  it("runs as ESM and reports missing Graphviz clearly", () => {
    const fixture = renderFixture();
    const emptyPath = path.join(path.dirname(fixture), "empty-path");
    fs.mkdirSync(emptyPath);
    const result = spawnSync(process.execPath, [renderScript, fixture], {
      encoding: "utf8",
      env: { ...process.env, PATH: emptyPath },
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain("Error: graphviz (dot) not found.");
    expect(output).not.toContain("ReferenceError: require is not defined");
  });

  it.runIf(dotAvailable)("renders a discovered diagram to SVG", () => {
    const fixture = renderFixture();
    const result = spawnSync(process.execPath, [renderScript, fixture], { encoding: "utf8" });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toContain("Found 1 diagram(s)");
    expect(output).toContain("Rendered: fixture_graph.svg");
    expect(fs.readFileSync(path.join(fixture, "diagrams/fixture_graph.svg"), "utf8")).toContain("<svg");
  });
});
