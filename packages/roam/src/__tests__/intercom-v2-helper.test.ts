import { paths } from "@spider/db-core";
import { afterEach, beforeAll, afterAll, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { buildRoamEntries } from "../../../../scripts/build-roam.mjs";
import { createMessageReader, writeMessage } from "../../../intercom/src/broker/framing";
import { makeMessageFrame } from "../intercom-codec";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const roots: string[] = []; let built: string;
beforeAll(async () => { built = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "v2-build-")); await buildRoamEntries(join(built, "roam")); }, 5000);
afterAll(() => { if (built) rmSync(built, { recursive: true, force: true }); }, 5000);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "vh-")); roots.push(root);
  const agentDir = join(root, "agent"), intercom = join(agentDir, "intercom"), state = join(root, "roam", "intercom");
  mkdirSync(intercom, { recursive: true, mode: 0o700 }); mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(agentDir, 0o700); chmodSync(join(root, "roam"), 0o700);
  const token = "a".repeat(64); writeFileSync(join(state, "helper.json"), JSON.stringify({ version: 1, agentDir, token }), { mode: 0o600 });
  return { root, token, socket: join(intercom, "broker.sock") };
}
function request(protocol: number, frames: unknown[] = []) {
  return { version: 1, holdMs: 0, deadlineMs: 1000, exchange: { protocol, senderMachine: A, recipientMachine: B,
    generation: { edgeEpoch: "edge", channel: "push", generation: 1 }, frames, acknowledgements: [], receipts: [], controls: [], presence: [] } };
}
async function server(path: string, handler: (message: Record<string, unknown>, socket: Socket) => void): Promise<{ server: Server; clients: Set<Socket> }> {
  const clients = new Set<Socket>();
  const result = createServer(socket => { clients.add(socket); socket.once("close", () => clients.delete(socket)); socket.on("error", () => {});
    socket.on("data", createMessageReader(value => handler(value as Record<string, unknown>, socket), () => socket.destroy())); });
  result.listen(path); await once(result, "listening"); chmodSync(path, 0o600); return { server: result, clients };
}
async function run(root: string, input: unknown) {
  const child = spawn(process.execPath, [join(built, "roam", "cli.mjs"), "--global-root", root, "roam", "intercom", "exchange"],
    { env: { ...process.env, HOME: root, SPIDER_GLOBAL_ROOT: root }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = ""; child.stdout.on("data", bytes => { out += bytes.toString(); }); child.stderr.on("data", bytes => { err += bytes.toString(); });
  child.stdin.end(JSON.stringify(input)); const [code] = await once(child, "close") as [number | null]; return { code, out, err };
}
async function closeServer(value: { server: Server; clients: Set<Socket> }) { for (const socket of value.clients) socket.destroy(); await new Promise<void>(done => value.server.close(() => done())); }

it("returns a named peer-version-mismatch without contacting the local broker", async () => {
  const f = fixture(), seen: string[] = [];
  const stub = await server(f.socket, (message) => { seen.push(String(message.type)); });
  try { const result = await run(f.root, request(1)); expect(result.code).toBe(0); expect(result.err).toBe("");
    expect(JSON.parse(result.out)).toEqual({ version: 1, kind: "intercom-exchange", ok: false, reason: "peer-version-mismatch" }); expect(seen).toEqual([]);
  } finally { await closeServer(stub); }
}, 5000);

it("forwards a malformed v2 frame intact so the owning bridge can record its rejection", async () => {
  const f = fixture(), seen: Record<string, unknown>[] = [];
  const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
  const endpoint = { address: to, machineId: B, homeEpoch: null, activationEpoch: "recipient-1" };
  const full = makeMessageFrame({ from, endpoint, originMachineId: A, sequence: 1, message: { id: "bad", timestamp: 1, content: { text: "synthetic" } } });
  const { originMachineId: _origin, ...missing } = full, input = request(2, [missing]);
  const resultExchange = { ...input.exchange, senderMachine: B, recipientMachine: A, frames: [], refusals: [{ identity: full.identity, reason: "missing-origin" }] };
  const stub = await server(f.socket, (message, socket) => { seen.push(message);
    if (message.type === "health") writeMessage(socket, { type: "health_ok", requestId: message.requestId, protocol: "pi-intercom", version: 1, features: ["intercom-exchange-v1"] });
    else if (message.type === "helper_register" && message.token === f.token) writeMessage(socket, { type: "helper_registered", requestId: message.requestId });
    else if (message.type === "helper_exchange") writeMessage(socket, { type: "helper_result", requestId: message.requestId, output: { version: 1, exchange: resultExchange } }); });
  try { const result = await run(f.root, input); expect(result.code).toBe(0); expect(result.err).toBe("");
    expect(JSON.parse(result.out)).toMatchObject({ ok: true, value: { exchange: { refusals: [{ reason: "missing-origin" }] } } });
    expect(seen.map(message => message.type)).toEqual(["health", "helper_register", "helper_exchange"]); expect(seen[2]?.input).toEqual(input);
  } finally { await closeServer(stub); }
}, 5000);
