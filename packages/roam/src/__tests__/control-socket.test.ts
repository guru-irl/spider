import { afterEach, expect, it } from "vitest";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { requestHubControl, startHubControl } from "../control-socket";

const roots: string[] = [];
const endpoints: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() { const root = mkdtempSync(join(resolve(".spider/scratch"), "sock-")); roots.push(root); return { root, file: join(root, "control.sock") }; }
function send(file: string, text: string): Promise<Record<string, unknown>> {
  return new Promise((resolveReply, reject) => {
    const socket = createConnection(file); let reply = "";
    socket.on("connect", () => socket.write(text));
    socket.on("data", bytes => { reply += String(bytes); });
    socket.on("end", () => { try { resolveReply(JSON.parse(reply)); } catch (error) { reject(error); } });
    socket.on("error", reject);
  });
}

it("uses a private socket for local requests and closes it cleanly", async () => {
  const { root, file } = fixture(); const observed: string[] = [];
  const endpoint = await startHubControl(file, async request => { observed.push(request.op); return { code: 0, reason: "ok", value: { enabled: true } }; });
  endpoints.push(endpoint);
  expect((lstatSync(root).mode & 0o777)).toBe(0o700);
  expect((lstatSync(file).mode & 0o777)).toBe(0o600);
  expect(await requestHubControl(file, { op: "status" })).toEqual({ code: 0, reason: "ok", value: { enabled: true } });
  expect(observed).toEqual(["status"]);
  await endpoint.close();
  await expect(requestHubControl(file, { op: "status" })).rejects.toThrow();
}, 5000);

it("rejects malformed, oversized, and multiple requests before dispatch", async () => {
  const { file } = fixture(); const observed: string[] = [];
  const endpoint = await startHubControl(file, async request => { observed.push(request.op); return { code: 0, reason: "ok", value: null }; }); endpoints.push(endpoint);
  expect(await send(file, '{"op":"unknown"}\n')).toMatchObject({ code: 2 });
  expect(await send(file, '{"op":"status","extra":true}\n')).toMatchObject({ code: 2 });
  expect(await send(file, '{"op":"status"}\n{"op":"status"}\n')).toMatchObject({ code: 2 });
  expect(await send(file, `${"x".repeat(32_769)}\n`)).toMatchObject({ code: 2 });
  expect(observed).toEqual([]);
}, 5000);

it("refuses a socket symlink without touching its target", async () => {
  const { root, file } = fixture(); const target = join(root, "target");
  writeFileSync(target, "untouched"); symlinkSync(target, file);
  await expect(startHubControl(file, async () => ({ code: 0, reason: "ok", value: null }))).rejects.toThrow(/unsafe|symlink/i);
  expect(readFileSync(target, "utf8")).toBe("untouched");
}, 5000);
