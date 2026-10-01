// Real-pi probe: a subagent survives /reload.
//
//   npm run build && node scripts/probe-child-survival.mjs
//
// Isolation: the probe never writes to this checkout's dist/. Each scenario works on its own COPY of
// the bundle inside the scratch dir (and "a different build" means appending to that copy). HOME,
// the pi agent dir, the spider global root and TMPDIR are scratch paths, and every PI_* variable of
// the calling environment is dropped, so running it from inside a pi session cannot leak that
// session's identity (e.g. PI_INTERCOM_SESSION_ID) into the fixture. pi is the version pinned by this
// repo (node_modules/.bin/pi), put first on PATH for the host AND the children it spawns, so the
// probe exercises the pi spider is built and tested against, not whatever `pi` the machine has.
//
// A real `pi --mode rpc` host loads spider from this checkout's built bundle (dist/extension.js)
// through the stable shim, plus a fixture extension with a fake provider (no network, no model).
// The host dispatches a child (a second real pi process) whose only tool waits on a release file.
// The probe then triggers /reload through an extension command (ctx.reload()), appends a comment
// to the bundle first so the reload loads a DIFFERENT build, releases the child, and checks that:
//   - the child pid is the same and alive across the reload,
//   - the reloaded activation delivers exactly one spider.subagent_done message,
//   - the run row is finalized as done.
// Scenario B: reload, then quit while the child still runs: the child must be killed.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { extensionShim } from "./extension-shim.mjs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const bundle = join(root, "dist", "extension.js");
if (!existsSync(bundle)) throw new Error("run `npm run build` first");
const base = join(root, ".spider/scratch/child-survival-probe");
const pinnedBin = join(root, "node_modules", ".bin");
const pinnedPi = join(pinnedBin, process.platform === "win32" ? "pi.cmd" : "pi");
if (!existsSync(pinnedPi)) throw new Error(`the repo's pinned pi is missing (${pinnedPi}); run the repo's install first`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
let failures = 0; let lastHost;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failures++; };

const probeExtension = `
import { Type, createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const dir = process.env.PROBE_DIR;
const log = line => appendFileSync(dir + "/lifecycle.log", process.pid + " " + (process.env.PI_SUBAGENT_CHILD === "1" ? "child" : "host") + " " + line + "\\n");
const text = m => typeof m.content === "string" ? m.content : (m.content || []).map(c => c.text ?? "").join("");
const factory = context => {
  const msgs = context.messages.filter(m => m.role !== "system");
  const last = msgs[msgs.length - 1];
  if (last.role === "toolResult") {
    if (last.toolName === "probe_wait") return fauxAssistantMessage("CHILD FINAL ANSWER");
    if (last.toolName === "spider") return fauxAssistantMessage("dispatched");
    return fauxAssistantMessage("ok");
  }
  const t = text(last);
  if (t.includes("CHILD FINAL ANSWER")) return fauxAssistantMessage("SAW COMPLETION");
  if (t.includes("PROBE_CHILD_WAIT")) return fauxAssistantMessage(fauxToolCall("probe_wait", {}), { stopReason: "toolUse" });
  if (t.includes("PROBE_HOST_RUN")) return fauxAssistantMessage(fauxToolCall("spider", { action: "run", agent: "worker", task: "PROBE_CHILD_WAIT", name: "probe-child" }), { stopReason: "toolUse" });
  return fauxAssistantMessage("noop");
};
export default function (pi) {
  const core = createFauxCore({ api: "probe-api", provider: "probe", models: [{ id: "probe-1" }] });
  core.setResponses(Array.from({ length: 200 }, () => factory));
  pi.registerProvider("probe", {
    baseUrl: "http://127.0.0.1:1", apiKey: "x", api: "probe-api", streamSimple: core.streamSimple,
    models: [{ id: "probe-1", name: "probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4000 }],
  });
  pi.registerTool({
    name: "probe_wait", label: "probe wait", description: "wait for release", parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      writeFileSync(dir + "/started.json", JSON.stringify({ pid: process.pid }));
      while (!existsSync(dir + "/release") && !signal?.aborted) await new Promise(r => setTimeout(r, 50));
      return { content: [{ type: "text", text: "released" }], details: {} };
    },
  });
  pi.registerCommand("probereload", { description: "reload", handler: async (_a, ctx) => { await ctx.reload(); } });
  pi.on("session_start", e => log("session_start:" + e.reason));
  pi.on("session_shutdown", e => log("session_shutdown:" + e.reason));
}
`;

function setup(name) {
  const dir = join(base, name);
  rmSync(dir, { recursive: true, force: true });
  const home = join(dir, "home"), agent = join(home, ".pi/agent"), app = join(dir, "app"), probe = join(dir, "probe"), tmp = join(dir, "tmp");
  for (const d of [agent, join(agent, "extensions"), app, probe, tmp, join(dir, "global")]) mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, SPIDER_GLOBAL_ROOT: join(dir, "global"), PROBE_DIR: probe, TMPDIR: tmp, PI_OFFLINE: "1", GIT_CEILING_DIRECTORIES: base,
    PATH: `${pinnedBin}${delimiter}${process.env.PATH ?? ""}` };
  // Drop every inherited PI_* variable (PI_INTERCOM_*, PI_SUBAGENT_*, PI_SPIDER_*, ...); keep only what is set above.
  for (const k of Object.keys(env)) if (k.startsWith("PI_") && !["PI_CODING_AGENT_DIR", "PI_OFFLINE"].includes(k)) delete env[k];
  // The shim points at this scenario's own COPY of the bundle, never at dist/ itself.
  const bundleCopy = join(dir, "bundle", "extension.js");
  mkdirSync(dirname(bundleCopy), { recursive: true });
  copyFileSync(bundle, bundleCopy);
  writeFileSync(join(agent, "extensions", "spider.ts"), extensionShim(bundleCopy));
  // The child loads only the spider bundle and extensions from a package named pi-intercom, so the
  // fixture (fake provider + wait tool + reload command) ships as that package for host AND child.
  const pkg = join(dir, "pkg");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pi-intercom", version: "0.0.0", pi: { extensions: ["./index.ts"] } }));
  writeFileSync(join(pkg, "index.ts"), probeExtension);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [pkg] }));
  return { dir, app, probe, env, bundleCopy };
}

function startHost(fx) {
  const proc = spawn(pinnedPi, ["--mode", "rpc", "--provider", "probe", "--model", "probe-1", "--no-session", "--no-context-files", "--no-skills"], { cwd: fx.app, env: fx.env, stdio: ["pipe", "pipe", "pipe"] });
  const events = []; const waiters = []; let buf = ""; let stderr = "";
  proc.stderr.on("data", d => { stderr += d; });
  proc.stdout.on("data", d => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const e = JSON.parse(line); events.push(e); for (const w of [...waiters]) if (w.test(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); } } catch { /* non-JSON noise */ }
    }
  });
  const send = c => proc.stdin.write(JSON.stringify(c) + "\n");
  const waitFor = (test, ms = 30000) => new Promise((resolve, reject) => {
    const hit = events.find(test); if (hit) return resolve(hit);
    const w = { test, resolve }; waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error("timeout waiting for event; stderr tail: " + stderr.slice(-800))); } }, ms);
  });
  let n = 0;
  const call = async (command) => { const id = `c${++n}`; send({ id, ...command }); return waitFor(e => e.type === "response" && e.id === id); };
  lastHost = { events, stderr: () => stderr };
  return { proc, events, send, waitFor, call, stderr: () => stderr };
}
async function until(cond, ms = 30000, what = "condition") { const t = Date.now(); while (Date.now() - t < ms) { if (await cond()) return true; await sleep(100); } throw new Error("timeout: " + what); }
const lifecycle = fx => existsSync(join(fx.probe, "lifecycle.log")) ? readFileSync(join(fx.probe, "lifecycle.log"), "utf8").trim().split("\n") : [];
const runRow = fx => { const p = join(fx.app, ".spider/project.db"); if (!existsSync(p)) return undefined; const db = new DatabaseSync(p, { readOnly: true }); try { return db.prepare("SELECT status, pid FROM runs ORDER BY started_at DESC LIMIT 1").get(); } catch { return undefined; } finally { db.close(); } };

async function dispatchAndReload(fx, host) {
  await until(() => lifecycle(fx).some(l => l.includes("host session_start:startup")), 30000, "host startup");
  const first = await host.call({ type: "prompt", message: "PROBE_HOST_RUN" });
  check(first.success === true, "host accepted the dispatch prompt");
  await until(() => existsSync(join(fx.probe, "started.json")), 60000, "child to start waiting");
  const childPid = JSON.parse(readFileSync(join(fx.probe, "started.json"), "utf8")).pid;
  check(alive(childPid), `child pid ${childPid} is running before the reload`);
  await until(() => runRow(fx)?.status === "running", 20000, "run row running");
  // A different build: change size and mtime so the shim's cache key changes.
  appendFileSync(fx.bundleCopy, `\n// reload-survival probe ${Date.now()}\n`);
  await host.call({ type: "prompt", message: "/probereload" });
  await until(() => lifecycle(fx).some(l => l.includes("host session_start:reload")), 30000, "reload to complete");
  const log = lifecycle(fx).filter(l => l.includes(" host "));
  check(log.some(l => l.includes("session_shutdown:reload")) && log.some(l => l.includes("session_start:reload")), "host saw session_shutdown(reload) then session_start(reload)");
  check(alive(childPid), "child is still alive after the reload");
  return childPid;
}

mkdirSync(base, { recursive: true });

/** Leave nothing behind, whatever the scenario did: SIGKILL the host and the child (and its group), and release the fixture tool. */
function cleanup(fx, host) {
  try { host.proc.kill("SIGKILL"); } catch { /* already gone */ }
  try { writeFileSync(join(fx.probe, "release"), "1"); } catch { /* best-effort */ }
  try {
    const { pid } = JSON.parse(readFileSync(join(fx.probe, "started.json"), "utf8"));
    for (const target of process.platform === "win32" ? [pid] : [-pid, pid]) { try { process.kill(target, "SIGKILL"); } catch { /* not running */ } }
  } catch { /* the child never started */ }
}

try {
  // Scenario A: reload, release, exactly one completion notice from the reloaded activation.
  {
    const fx = setup("a"); const host = startHost(fx);
    try {
      const childPid = await dispatchAndReload(fx, host);
      writeFileSync(join(fx.probe, "release"), "1");
      await until(async () => {
        const r = await host.call({ type: "get_messages" });
        const msgs = r.data?.messages ?? [];
        return msgs.some(m => m.customType === "spider.subagent_done");
      }, 60000, "completion notice");
      await until(() => runRow(fx)?.status === "done", 20000, "run row done");
      await sleep(1500); // give a duplicate time to show up
      const msgs = (await host.call({ type: "get_messages" })).data.messages;
      const notices = msgs.filter(m => m.customType === "spider.subagent_done");
      check(notices.length === 1, `exactly one spider.subagent_done notice (got ${notices.length})`);
      check(JSON.stringify(notices[0] ?? {}).includes("CHILD FINAL ANSWER"), "notice carries the child's final answer");
      check(runRow(fx)?.status === "done", "run row is done");
      check(!alive(childPid), "child exited after release");
    } finally { cleanup(fx, host); }
    check(true, "scenario A finished");
  }
  // Scenario C: release the child right before the reload so it may finish inside the gap.
  {
    const fx = setup("c"); const host = startHost(fx);
    try {
      await until(() => lifecycle(fx).some(l => l.includes("host session_start:startup")), 30000, "host startup");
      await host.call({ type: "prompt", message: "PROBE_HOST_RUN" });
      await until(() => existsSync(join(fx.probe, "started.json")), 60000, "child to start waiting");
      await until(() => runRow(fx)?.status === "running", 20000, "run row running");
      appendFileSync(fx.bundleCopy, `\n// reload-survival probe C ${Date.now()}\n`);
      writeFileSync(join(fx.probe, "release"), "1");
      host.send({ id: "reload", type: "prompt", message: "/probereload" });
      await until(async () => (await host.call({ type: "get_messages" })).data.messages.some(m => m.customType === "spider.subagent_done"), 60000, "completion notice");
      await until(() => runRow(fx)?.status === "done", 20000, "run row done");
      await sleep(1500);
      const notices = (await host.call({ type: "get_messages" })).data.messages.filter(m => m.customType === "spider.subagent_done");
      check(notices.length === 1, `release-then-reload: exactly one notice (got ${notices.length})`);
      check(lifecycle(fx).some(l => l.includes("host session_start:reload")), "release-then-reload: reload happened");
    } finally { cleanup(fx, host); }
  }
  // Scenario B: reload, then quit while the child still runs: the child is killed.
  {
    const fx = setup("b"); const host = startHost(fx);
    let childPid;
    try {
      childPid = await dispatchAndReload(fx, host);
      host.proc.kill("SIGTERM"); // pi emits session_shutdown(quit)
      await until(() => !alive(childPid), 15000, "child to die on quit");
      check(!alive(childPid), "quit after reload killed the adopted child");
      check(lifecycle(fx).some(l => l.includes("session_shutdown:quit")), "host saw session_shutdown(quit)");
    } finally { cleanup(fx, host); }
  }
} catch (error) {
  failures++; console.log("FAIL  probe error: " + (error?.stack ?? error));
  if (lastHost) { console.log("last events:", lastHost.events.slice(-12).map(e => JSON.stringify(e).slice(0, 400)).join("\n")); console.log("stderr:", lastHost.stderr().slice(-1500)); }
}
console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
