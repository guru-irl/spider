import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { scratchDbPath } from "@spider/db-core/testutil";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(dirname(scratchDbPath("roam-link")), "roam-link-"));
  roots.push(root);
  const home = join(root, "home"), agent = join(root, "agent"), globalRoot = join(root, "global");
  mkdirSync(home); mkdirSync(agent);
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, SPIDER_GLOBAL_ROOT: globalRoot };
  const link = (script: string, ...args: string[]) => spawnSync(process.execPath, [resolve(`scripts/${script}.mjs`), ...args], {
    cwd: root, env, encoding: "utf8", timeout: 3000,
  });
  return { root, home, agent, globalRoot, env, link, executable: join(home, ".local", "bin", "spider") };
}

it.each(["link", "dev-link"])("Mac %s installs the actual shell executable", script => {
  const f = fixture();
  const result = f.link(script);
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(f.executable)).toBe(true);
  const shellResolvedEntry = realpathSync(f.executable);
  const packedCliEntry = realpathSync(resolve("dist/roam/cli.mjs"));
  expect(shellResolvedEntry).toBe(packedCliEntry);
}, 5000);

it("installed spider help is side-effect free", () => {
  const f = fixture();
  expect(f.link("link").status).toBe(0);
  const result = spawnSync(f.executable, ["--help"], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 3000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/usage:/i);
  expect(result.stderr).toBe("");
  expect(existsSync(f.globalRoot)).toBe(false);
}, 5000);

it.each(["link", "dev-link"])("%s unlink removes only the command it installed", script => {
  const f = fixture();
  expect(f.link(script).status).toBe(0);
  expect(existsSync(f.executable)).toBe(true);
  expect(f.link(script, "--unlink").status).toBe(0);
  expect(existsSync(f.executable)).toBe(false);
  mkdirSync(dirname(f.executable), { recursive: true });
  writeFileSync(f.executable, "unrelated executable", { mode: 0o700 });
  expect(f.link(script, "--unlink").status).toBe(0);
  expect(readFileSync(f.executable, "utf8")).toBe("unrelated executable");
}, 5000);

it("link refuses to replace an unrelated shell command", () => {
  const f = fixture();
  mkdirSync(dirname(f.executable), { recursive: true });
  writeFileSync(f.executable, "unrelated executable", { mode: 0o700 });
  const result = f.link("link");
  expect(result.status).not.toBe(0);
  expect(readFileSync(f.executable, "utf8")).toBe("unrelated executable");
}, 5000);
