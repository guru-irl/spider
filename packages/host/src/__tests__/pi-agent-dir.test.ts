import { afterEach, expect, it } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { piAgentDir } from "../../../../scripts/pi-agent-dir.mjs";

const original = process.env.PI_CODING_AGENT_DIR;
const roots: string[] = [];
afterEach(() => {
  if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = original;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([undefined, "/abs/x", "/abs/x/", "~", "~/x", "file:///x", "rel/x"])(
  "matches pi's getAgentDir for %s",
  async input => {
    if (input === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = input;
    expect(await piAgentDir()).toBe(getAgentDir());
  },
);

it("returns a promise for callers to await", () => {
  expect(piAgentDir()).toBeInstanceOf(Promise);
});

function fixture(exports: string | Record<string, never>) {
  const scratch = resolve(".spider/scratch/tmp");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "pi-agent-dir-"));
  roots.push(root);
  const pkg = join(root, "node_modules/@earendil-works/pi-coding-agent");
  mkdirSync(pkg, { recursive: true });
  copyFileSync(resolve("scripts/pi-agent-dir.mjs"), join(root, "pi-agent-dir.mjs"));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module", exports }));
  writeFileSync(join(pkg, "index.mjs"), `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.MARKER, 'loaded');
export function getAgentDir() { return 'fallback'; }
`);
  return root;
}

function runFixture(root: string, dir: string | undefined, invoke = true) {
  const env = { ...process.env, HOME: root, USERPROFILE: root, MARKER: join(root, "loaded") };
  if (dir === undefined) delete env.PI_CODING_AGENT_DIR;
  else env.PI_CODING_AGENT_DIR = dir;
  return spawnSync(process.execPath, ["--input-type=module", "-e", invoke
    ? `import { piAgentDir } from './pi-agent-dir.mjs'; console.log(await piAgentDir());`
    : `import './pi-agent-dir.mjs';`], { cwd: root, env, encoding: "utf8", timeout: 10000 });
}

it.each([undefined, ...(process.platform === "win32" ? [] : ["/abs/x/"])])(
  "does not evaluate pi for fast-path input %s",
  dir => {
    const root = fixture("./index.mjs");
    const result = runFixture(root, dir);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(dir ?? join(root, ".pi", "agent"));
    expect(existsSync(join(root, "loaded"))).toBe(false);
  },
);

it("loads pi for paths that need its normalization", () => {
  const root = fixture("./index.mjs");
  const result = runFixture(root, "~/x");
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("fallback");
  expect(existsSync(join(root, "loaded"))).toBe(true);
});

it("fails on import when pi cannot be resolved, even without calling piAgentDir", () => {
  const root = fixture({});
  const result = runFixture(root, "/abs/x", false);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/ERR_PACKAGE_PATH_NOT_EXPORTED/);
});
