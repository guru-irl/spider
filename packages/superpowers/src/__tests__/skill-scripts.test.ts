import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { testScratchPath } from "./testutil.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const polluterScript = path.join(packageRoot, "skills/systematic-debugging/find-polluter.sh");
const renderScript = path.join(packageRoot, "skills/writing-skills/render-graphs.js");
const brainstormScripts = path.join(packageRoot, "skills/brainstorming/scripts");
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
  for (const root of roots.splice(0)) {
    for (const parent of [path.join(root, ".spider/scratch/superpowers/brainstorm"), path.join(root, ".superpowers/brainstorm")]) {
      if (fs.existsSync(parent)) {
        for (const name of fs.readdirSync(parent)) {
          const session = path.join(parent, name);
          if (fs.existsSync(path.join(session, "state/server.pid"))) {
            const result = spawnSync("bash", [path.join(brainstormScripts, "stop-server.sh"), session], { encoding: "utf8" });
            if (result.status !== 0) throw new Error(`Failed to stop brainstorm server: ${result.stdout} ${result.stderr}`);
          }
        }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
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

describe("brainstorming companion scripts", () => {
  async function startSession(durable: boolean) {
    const project = freshRoot("brainstorm");
    const args = [path.join(brainstormScripts, "start-server.sh"), "--port", "0"];
    if (durable) args.push("--project-dir", project);
    const result = spawnSync("bash", args, {
      cwd: project,
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, BRAINSTORM_PORT: "", CODEX_CI: "" },
    });
    expect(result.status, `${result.stdout} ${result.stderr}`).toBe(0);
    const info = JSON.parse(result.stdout.trim());
    const state = info.state_dir as string;
    const session = path.dirname(state);
    expect(info.type).toBe("server-started");
    expect(info.port).toBeGreaterThan(0);
    expect(info.port).toBeLessThan(65536);
    expect(info.url).toContain(`:${info.port}/?key=`);
    expect(info.screen_dir).toBe(path.join(session, "content"));
    expect(JSON.parse(fs.readFileSync(path.join(state, "server-info"), "utf8"))).toEqual(info);
    expect(fs.readFileSync(path.join(state, "server.log"), "utf8")).toContain('"type":"server-started"');
    const response = await fetch(info.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Brainstorm Companion");
    return { project, session, state };
  }

  it("starts in project scratch, serves HTTP and stops without leaving session files", async () => {
    const { project, session, state } = await startSession(false);
    const pid = Number(fs.readFileSync(path.join(state, "server.pid"), "utf8"));
    expect(session.startsWith(path.join(project, ".spider/scratch/superpowers/brainstorm") + path.sep)).toBe(true);
    const stopped = spawnSync("bash", [path.join(brainstormScripts, "stop-server.sh"), session], { encoding: "utf8" });
    expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
    expect(JSON.parse(stopped.stdout).status).toBe("stopped");
    expect(() => process.kill(pid, 0)).toThrow();
    expect(fs.existsSync(session)).toBe(false);
  });

  it("preserves durable project mockups while stopping the server", async () => {
    const { project, session, state } = await startSession(true);
    const pid = Number(fs.readFileSync(path.join(state, "server.pid"), "utf8"));
    expect(session.startsWith(path.join(project, ".superpowers/brainstorm") + path.sep)).toBe(true);
    const mockup = path.join(session, "content/example.html");
    fs.writeFileSync(mockup, "<h1>Saved mockup</h1>");
    const stopped = spawnSync("bash", [path.join(brainstormScripts, "stop-server.sh"), session], { encoding: "utf8" });
    expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
    expect(JSON.parse(stopped.stdout).status).toBe("stopped");
    expect(() => process.kill(pid, 0)).toThrow();
    expect(fs.existsSync(path.join(state, "server.pid"))).toBe(false);
    expect(fs.readFileSync(mockup, "utf8")).toContain("Saved mockup");
    expect(JSON.parse(fs.readFileSync(path.join(state, "server-stopped"), "utf8")).reason).toBe("stop-server.sh");
  });
});

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

  it("renders a discovered diagram to SVG", () => {
    const fixture = renderFixture();
    const root = path.dirname(fixture);
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const dot = path.join(bin, "dot");
    fs.writeFileSync(dot, `#!/bin/sh
printf '%s\\n' "$*" >> "$DOT_LOG"
if [ "$1" = '-V' ]; then exit 0; fi
if [ "$1" != '-Tsvg' ]; then exit 2; fi
cat > "$DOT_INPUT"
printf '<svg id="fixture-graph"/>\\n'
`);
    fs.chmodSync(dot, 0o755);
    const log = path.join(root, "dot-args");
    const input = path.join(root, "dot-input");
    const result = spawnSync(process.execPath, [renderScript, fixture], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, DOT_LOG: log, DOT_INPUT: input },
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toContain("Found 1 diagram(s)");
    expect(output).toContain("Rendered: fixture_graph.svg");
    expect(fs.readFileSync(log, "utf8")).toBe("-V\n-Tsvg\n");
    expect(fs.readFileSync(input, "utf8")).toBe("digraph fixture_graph {\n  start -> end;\n}");
    expect(fs.readFileSync(path.join(fixture, "diagrams/fixture_graph.svg"), "utf8")).toBe('<svg id="fixture-graph"/>\n');
  });
});
