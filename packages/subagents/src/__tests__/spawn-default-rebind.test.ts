import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { testScratchPath } from "./helpers/testutil";
import { defaultSpawner } from "../spawn-default";
import type { ChildHandle } from "../runner";

// The REAL spawner (not a fake): a reloaded activation can only rebind a child's events if the handle
// the production spawner returns exposes bind/unbind, in rpc and print mode alike.
const handles: ChildHandle[] = [];
const files: string[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) {
    try { await h.killAsync?.(25); } catch { /* fixture cleanup */ }
    if (h.pid) { try { process.kill(process.platform === "win32" ? h.pid : -h.pid, "SIGKILL"); } catch { /* already gone */ } }
  }
  for (const f of files.splice(0)) rmSync(f, { force: true });
});

const script = (body: string) => {
  const file = testScratchPath(`spawn-rebind-${process.pid}-${files.length}.mjs`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body); files.push(file);
  return file;
};
const spec = (file: string, extra: Record<string, unknown>) => ({
  argv: [process.execPath, file], cwd: dirname(file), env: {}, prompt: "go", ...extra,
}) as never;

describe("defaultSpawner event rebinding", () => {
  it("rpc: exposes bindEvents/unbindEvents and routes later events to the NEW sink only", async () => {
    const file = script(`
      process.stdin.setEncoding('utf8');
      let buf = '';
      process.stdin.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\\n')) !== -1) {
        const cmd = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (cmd.type === 'prompt') {
          process.stdout.write(JSON.stringify({ type: 'response', id: cmd.id, command: 'prompt', success: true }) + '\\n');
          setTimeout(() => process.stdout.write(JSON.stringify({ type: 'warning', message: 'emitted in the gap' }) + '\\n'), 150);
        }
      } });
      setInterval(() => {}, 1000);`);
    const first: Array<Record<string, any>> = [], second: Array<Record<string, any>> = [];
    const handle = defaultSpawner(spec(file, { childMode: "rpc", onRpcEvent: (e: Record<string, any>) => first.push(e) }));
    handles.push(handle);
    expect(typeof handle.bindEvents).toBe("function");
    expect(typeof handle.unbindEvents).toBe("function");
    handle.unbindEvents!();
    await new Promise(r => setTimeout(r, 400));
    expect(first.filter(e => e.message === "emitted in the gap")).toEqual([]);
    handle.bindEvents!(e => second.push(e));
    expect(second.filter(e => e.message === "emitted in the gap")).toHaveLength(1);
  });

  it("print: exposes bind/unbind too, so spawner warnings never reach a dead sink", async () => {
    const file = script("setInterval(() => {}, 1000);");
    const handle = defaultSpawner(spec(file, { childMode: "print", onRpcEvent: () => {} }));
    handles.push(handle);
    expect(typeof handle.bindEvents).toBe("function");
    expect(typeof handle.unbindEvents).toBe("function");
  });
});
