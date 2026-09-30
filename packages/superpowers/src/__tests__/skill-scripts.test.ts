import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { testScratchPath } from "./testutil.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const polluterScript = path.join(packageRoot, "skills/systematic-debugging/find-polluter.sh");
const renderScript = path.join(packageRoot, "skills/writing-skills/render-graphs.js");
const brainstormScripts = process.env.SUPERPOWERS_TEST_SCRIPTS_ROOT ?? path.join(packageRoot, "skills/brainstorming/scripts");
const roots: string[] = [];
let sequence = 0;

function freshRoot(label: string): string {
  const root = testScratchPath(`skill-scripts-${label}-${process.pid}-${sequence++}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
  roots.push(root);
  return root;
}

afterEach(() => {
  const stopErrors: string[] = [];
  for (const root of roots.splice(0)) {
    for (const parent of [path.join(root, ".spider/scratch/superpowers/brainstorm"), path.join(root, ".superpowers/brainstorm")]) {
      if (fs.existsSync(parent)) {
        for (const name of fs.readdirSync(parent)) {
          const session = path.join(parent, name);
          if (fs.existsSync(path.join(session, "state/server.pid"))) {
            const result = spawnSync("bash", [path.join(brainstormScripts, "stop-server.sh"), session], { encoding: "utf8" });
            if (result.status !== 0) stopErrors.push(`Failed to stop brainstorm server: ${result.stdout} ${result.stderr}`);
          }
        }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (stopErrors.length) throw new Error(stopErrors.join("\n"));
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
  it("rejects every value flag without its value instead of looping", () => {
    const project = freshRoot("args");
    for (const flag of ["--port", "--host", "--project-dir", "--url-host", "--idle-timeout-minutes"]) {
      for (const suffix of [[], ["--open"], [""]]) {
        const result = spawnSync("bash", [path.join(brainstormScripts, "start-server.sh"), flag, ...suffix], {
          cwd: project, encoding: "utf8", timeout: 1200,
        });
        expect(result.error, flag).toBeUndefined();
        expect(result.status, flag).toBe(1);
        expect(JSON.parse(result.stdout).error, flag).toContain(`${flag} requires a value`);
      }
    }
  });

  it("uses the explicitly requested port and records it for a durable session", async () => {
    const project = freshRoot("chosen-port");
    const freePort = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close((error) => error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 0));
      });
    });
    const result = spawnSync("bash", [path.join(brainstormScripts, "start-server.sh"), "--project-dir", project, "--port", String(freePort)], {
      cwd: project, encoding: "utf8", timeout: 15000,
      env: { ...process.env, BRAINSTORM_PORT: "" },
    });
    expect(result.status, `${result.stdout} ${result.stderr}`).toBe(0);
    const info = JSON.parse(result.stdout.trim());
    expect(info.port).toBe(freePort);
    expect(fs.readFileSync(path.join(project, ".superpowers/brainstorm/.last-port"), "utf8").trim()).toBe(String(freePort));
  });

  it("removes a scratch session stopped through a relative path", async () => {
    const { project, session } = await startSession(false);
    const relative = path.relative(project, session);
    const result = spawnSync("bash", [path.join(brainstormScripts, "stop-server.sh"), relative], {
      cwd: project, encoding: "utf8", timeout: 15000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("stopped");
    expect(fs.existsSync(session)).toBe(false);
  });

  it("returns not_running for missing sessions and ignores CDPATH when stopping", async () => {
    const { project, session } = await startSession(false);
    const decoyRoot = path.join(project, "decoy");
    const decoyState = path.join(decoyRoot, path.relative(project, session), "state");
    fs.mkdirSync(decoyState, { recursive: true });
    fs.writeFileSync(path.join(decoyState, "server.pid"), "999999\n");
    const result = spawnSync("bash", [path.join(brainstormScripts, "stop-server.sh"), path.relative(project, session)], {
      cwd: project, encoding: "utf8", env: { ...process.env, CDPATH: decoyRoot },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("stopped");
    expect(fs.existsSync(session)).toBe(false);
    expect(fs.readFileSync(path.join(decoyState, "server.pid"), "utf8")).toBe("999999\n");
    const again = spawnSync("bash", [path.join(brainstormScripts, "stop-server.sh"), session], { cwd: project, encoding: "utf8" });
    expect(again.status).toBe(0);
    expect(JSON.parse(again.stdout).status).toBe("not_running");
  });

  it("creates a 0600 session-key log with the documented Pi launch recipe", async () => {
    const project = freshRoot("recipe");
    const guide = fs.readFileSync(path.join(packageRoot, "skills/brainstorming/visual-companion.md"), "utf8");
    const recipe = guide.split("**Launching from Pi:**")[1]?.split("```bash")[1]?.split("```")[0] ?? "";
    const command = recipe.replaceAll("<id>", "recipe-fixture")
      .replaceAll("<skill-dir>", path.join(packageRoot, "skills/brainstorming"))
      .replaceAll(" --open", "");
    const nested = path.join(project, "nested");
    fs.mkdirSync(nested);
    const result = spawnSync("bash", ["-c", `umask 022; ${command}`], {
      cwd: nested, encoding: "utf8", timeout: 15000,
      env: { ...process.env, BRAINSTORM_PORT: "0" },
    });
    expect(result.status, `${result.stdout} ${result.stderr}`).toBe(0);
    const log = path.join(project, ".spider/scratch/superpowers/brainstorm/recipe-fixture/server.log");
    let output = "";
    for (let attempt = 0; attempt < 150; attempt++) {
      if (fs.existsSync(log)) output = fs.readFileSync(log, "utf8");
      if (output.includes('"type":"server-started"') || output.includes('"error"')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(output).toContain('"type":"server-started"');
    expect(fs.statSync(log).mode & 0o777).toBe(0o600);
  });

  it("rejects Pi launch outside a git repository without creating a root scratch path", () => {
    const project = freshRoot("non-git");
    const dir = path.join(project, "outside");
    fs.mkdirSync(dir);
    const guide = fs.readFileSync(path.join(packageRoot, "skills/brainstorming/visual-companion.md"), "utf8");
    const recipe = guide.split("**Launching from Pi:")[1]?.split("```bash")[1]?.split("```")[0] ?? "";
    const command = recipe.replaceAll("<id>", "non-git-fixture")
      .replaceAll("<skill-dir>", path.join(packageRoot, "skills/brainstorming"))
      .replaceAll(" --open", "");
    const result = spawnSync("bash", ["-c", command], {
      cwd: dir, encoding: "utf8", timeout: 15000,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: project },
    });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(project, ".spider/scratch/superpowers/brainstorm/non-git-fixture"))).toBe(false);
  });

  it("documents an owner-only Pi launch log and a consistent URL lookup", () => {
    const guide = fs.readFileSync(path.join(packageRoot, "skills/brainstorming/visual-companion.md"), "utf8");
    const recipe = guide.split("**Launching from Pi:**")[1]?.split("```bash")[1]?.split("```")[0] ?? "";
    expect(recipe).toMatch(/umask 077/);
    expect(recipe).toMatch(/<skill-dir>\/scripts\/start-server\.sh/);
    expect(recipe).toMatch(/git rev-parse --show-toplevel/);
    expect(guide).toMatch(/<project-root>\/\.spider\/scratch\/superpowers\/brainstorm\/<id>\/server\.log[^\n]*url/);
  });

  async function startSession(durable: boolean) {
    const project = freshRoot("brainstorm");
    const args = [path.join(brainstormScripts, "start-server.sh"), "--port", "0"];
    if (durable) args.push("--project-dir", project);
    const result = spawnSync("bash", args, {
      cwd: project,
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, BRAINSTORM_PORT: "" },
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
