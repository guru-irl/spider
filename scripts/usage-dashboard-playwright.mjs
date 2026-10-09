import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = resolve(root, ".spider/scratch/playwright");
for (const name of ["tmp", "results", "report", "npm-cache", "npm-logs"]) mkdirSync(resolve(scratch, name), { recursive: true });
const env = { ...process.env, SPIDER_PLAYWRIGHT_ORIGINAL_TMPDIR: process.env.SPIDER_PLAYWRIGHT_ORIGINAL_TMPDIR || tmpdir(), TMPDIR: resolve(scratch, "tmp"), npm_config_cache: resolve(scratch, "npm-cache"), npm_config_logs_dir: resolve(scratch, "npm-logs") };
for (const name of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_DB_PATH", "PI_SPIDER_SESSION_ID"]) delete env[name];
const child = spawn(process.execPath, [resolve(root, "node_modules/playwright/cli.js"), "test", ...process.argv.slice(2)], { cwd: root, env, stdio: "inherit" });
let killTimer;
function terminate(signal) { child.kill(signal); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5000); }
process.on("SIGINT", () => terminate("SIGINT")); process.on("SIGTERM", () => terminate("SIGTERM"));
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code, signal) => { clearTimeout(killTimer); process.exitCode = code ?? (signal ? 1 : 0); });
