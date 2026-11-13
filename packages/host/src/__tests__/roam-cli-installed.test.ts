import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

it.each(["link", "dev-link"])("%s installs the loader without replacing an unrelated command", script => {
  const f = fixture();
  mkdirSync(dirname(f.executable), { recursive: true });
  writeFileSync(f.executable, "unrelated executable", { mode: 0o700 });
  const result = f.link(script);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(f.executable, "utf8")).toBe("unrelated executable");
  expect(existsSync(join(f.agent, "extensions", script === "link" ? "spider.ts" : "spider-dev.ts"))).toBe(true);
  expect(result.stderr).toMatch(/warning.*existing command/i);
}, 5000);

it.each(["link", "dev-link"])("%s keeps an unrelated live symlink and installs the loader", script => {
  const f = fixture();
  const target = join(f.root, "foreign-command");
  writeFileSync(target, "foreign executable", { mode: 0o700 });
  mkdirSync(dirname(f.executable), { recursive: true });
  symlinkSync(target, f.executable);
  const result = f.link(script);
  expect(result.status, result.stderr).toBe(0);
  expect(readlinkSync(f.executable)).toBe(target);
  expect(readFileSync(f.executable, "utf8")).toBe("foreign executable");
  expect(existsSync(join(f.agent, "extensions", script === "link" ? "spider.ts" : "spider-dev.ts"))).toBe(true);
  expect(result.stderr).toMatch(/warning.*existing command/i);
}, 5000);

it.each(["link", "dev-link"])("%s preserves a foreign checkout with a matching CLI path", script => {
  const f = fixture();
  const foreignRoot = join(f.root, "foreign-checkout");
  const foreignEntry = join(foreignRoot, "dist", "roam", "cli.mjs");
  mkdirSync(dirname(foreignEntry), { recursive: true });
  writeFileSync(join(foreignRoot, "package.json"), JSON.stringify({ name: "unrelated" }));
  writeFileSync(foreignEntry, "foreign executable", { mode: 0o700 });
  mkdirSync(dirname(f.executable), { recursive: true });
  symlinkSync(foreignEntry, f.executable);
  const result = f.link(script);
  expect(result.status, result.stderr).toBe(0);
  expect(readlinkSync(f.executable)).toBe(foreignEntry);
  expect(result.stderr).toMatch(/warning.*existing command/i);
}, 5000);

it.each(["link", "dev-link"])("%s replaces a dangling command link", script => {
  const f = fixture();
  mkdirSync(dirname(f.executable), { recursive: true });
  symlinkSync(join(f.root, "missing-command"), f.executable);
  const result = f.link(script);
  expect(result.status, result.stderr).toBe(0);
  expect(lstatSync(f.executable).isSymbolicLink()).toBe(true);
  expect(realpathSync(f.executable)).toBe(realpathSync(resolve("dist/roam/cli.mjs")));
}, 5000);

it.each(["link", "dev-link"])("%s updates a link to another spider checkout", script => {
  const f = fixture();
  const oldRoot = join(f.root, "old-checkout");
  const oldEntry = join(oldRoot, "dist", "roam", "cli.mjs");
  mkdirSync(dirname(oldEntry), { recursive: true });
  writeFileSync(join(oldRoot, "package.json"), JSON.stringify({ name: "@guru-irl/spider" }));
  writeFileSync(oldEntry, "old spider", { mode: 0o700 });
  mkdirSync(dirname(f.executable), { recursive: true });
  symlinkSync(oldEntry, f.executable);
  const result = f.link(script);
  expect(result.status, result.stderr).toBe(0);
  expect(realpathSync(f.executable)).toBe(realpathSync(resolve("dist/roam/cli.mjs")));
}, 5000);

it.each(["link", "dev-link"])("%s writes the loader before linking the shell command", script => {
  const f = fixture();
  const scripts = join(f.root, "ordered", "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const name of ["link.mjs", "dev-link.mjs", "extension-shim.mjs", "pi-agent-dir.mjs"]) {
    copyFileSync(resolve("scripts", name), join(scripts, name));
  }
  const shim = script === "link" ? "spider.ts" : "spider-dev.ts";
  writeFileSync(join(scripts, "link-roam.mjs"), `
    import { existsSync } from "node:fs";
    import { join } from "node:path";
    export function linkRoamCommand() {
      if (!existsSync(join(process.env.PI_CODING_AGENT_DIR, "extensions", ${JSON.stringify(shim)}))) throw new Error("loader not yet written");
      console.error("loader already written");
    }
  `);
  const result = spawnSync(process.execPath, [join(scripts, `${script}.mjs`)], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 3000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toMatch(/loader already written/);
}, 5000);

it.each(["link", "dev-link"])("%s writes the loader when the roaming CLI is not built", script => {
  const f = fixture();
  const scripts = join(f.root, "unbuilt", "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const name of ["link.mjs", "dev-link.mjs", "link-roam.mjs", "extension-shim.mjs", "pi-agent-dir.mjs"]) {
    copyFileSync(resolve("scripts", name), join(scripts, name));
  }
  const result = spawnSync(process.execPath, [join(scripts, `${script}.mjs`)], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 3000 });
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(f.agent, "extensions", script === "link" ? "spider.ts" : "spider-dev.ts"))).toBe(true);
  expect(existsSync(f.executable)).toBe(false);
  expect(result.stderr).toMatch(/warning/i);
}, 5000);
