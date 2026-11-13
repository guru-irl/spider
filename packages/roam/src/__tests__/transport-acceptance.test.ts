import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { migrate, openDb } from "@spider/db-core";
import { createExportPolicy } from "@spider/db-core/roam/event-policy";
import { exportBatch } from "@spider/db-core/roam/export";
import { enableMemoryCapture } from "@spider/db-core/roam/seed";
import { buildRoamEntries } from "../../../../scripts/build-roam.mjs";
import { stageArtifact, transferArtifact } from "../artifacts";
import { DEFAULT_LIMITS, type Operation, type Peer } from "../contracts";
import { openJournal } from "../journal";
import { createTransport } from "../transport";

const HUB = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
let built: string;
beforeAll(async () => { built = mkdtempSync(join(resolve(".spider/scratch"), "accept-build-")); await buildRoamEntries(join(built, "roam")); });
afterAll(() => rmSync(built, { recursive: true, force: true }));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("A8 chunk transport composes with durable apply", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "transport-accept-")); roots.push(root);
  const hub = join(root, "hub"), box = join(root, "box"), socket = join(root, "hc.sock"), calls = join(root, "calls");
  for (const [dir, id, role] of [[hub, HUB, "hub"], [box, BOX, "box"]] as const) {
    mkdirSync(dir); mkdirSync(join(dir, "roam"), { mode: 0o700 });
    writeFileSync(join(dir, "roam", "machine.json"), JSON.stringify({ machineId: id }), { mode: 0o600 });
    writeFileSync(join(dir, "roam", "config.json"), JSON.stringify({ enabled: false, role, machineId: id,
      hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
    const db = openDb(join(dir, "spider.db"));
    migrate(db, "global", { machineId: id, globalRoot: dir });
    if (id === HUB) db.prepare("INSERT INTO global_memory(uuid,category,content,created_at) VALUES ('memory-a','insight',?,1)").run("portable ".repeat(100));
    enableMemoryCapture(db, "global"); db.close();
  }
  const cli = join(built, "roam", "cli.mjs"), hc = join(root, "hc"), alias = "-box-1.invalid";
  writeFileSync(hc, `#!${process.execPath}\nimport {appendFileSync,readFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process';\nconst a=process.argv.slice(2); appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');\nif(a[0]==='server') console.log(JSON.stringify({core:{id:'local-core'},version:'0.1.16'}));\nelse if(a[0]==='machine') console.log(JSON.stringify({machines:[{name:${JSON.stringify(alias)},id:'remote-core',state:'connected'}]}));\nelse if(a[0]==='exec' && a.includes(${JSON.stringify(`--on=${alias}`)})) {const c=a.slice(a.indexOf('--')+1); if(c[0]==='cat' && c.at(-1)===${JSON.stringify(join(box, "roam", "machine.json"))})process.stdout.write(readFileSync(c.at(-1))); else if(c[0]===${JSON.stringify(process.execPath)} && c[1]===${JSON.stringify(cli)} && c[2]==='--global-root' && c[3]===${JSON.stringify(box)}){const r=spawnSync(c[0],c.slice(1),{env:{...process.env,HOME:${JSON.stringify(box)}},input:a.includes('--stdin')?readFileSync(0):undefined});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exitCode=r.status??1;}else process.exitCode=2;}\nelse process.exitCode=1;\n`, { mode: 0o700 });
  const env = { ...process.env, HOME: hub, SPIDER_GLOBAL_ROOT: hub, HC_SOCKET: socket };
  const peer: Peer = { machineId: BOX, alias, node: process.execPath, pi: process.execPath, cli, core: hc, globalRoot: box };
  const server = createServer(connection => connection.end()); await new Promise<void>(done => server.listen(socket, done));
  const source = openDb(join(hub, "spider.db"));
  try {
    const batch = await exportBatch(source, { after: 0, targetBytes: 16_384, batchId: "batch-1" },
      createExportPolicy((_file, machineId) => ({ machineId, reference: "unavailable" })));
    const limits = { ...DEFAULT_LIMITS, chunkBytes: 512, retryDelaysMs: [] };
    const staging = join(hub, "roam", "staging");
    const manifest = await stageArtifact(batch.file, "batch", limits, { root: staging, artifactId: "artifact-1" });
    expect(manifest.chunks.length).toBeGreaterThan(1);
    const transport = createTransport({ binary: hc, env, enrolled: [peer] });
    const journal = openJournal(join(hub, "roam", "journal.db"));
    const sent = await transferArtifact(peer, manifest, { transport, journal, limits, root: staging, operationId: "transfer-1" });
    expect(sent.code, sent.reason).toBe(0);
    const receivedDigest = createHash("sha256").update(readFileSync(sent.value!.file)).digest("hex");
    expect(receivedDigest).toBe(batch.sha256);
    const operation: Operation = { id: "import-1", machineId: BOX, expectedEpoch: null, kind: "import", args: {
      storeKey: "global", sourceMachine: HUB, transferId: "transfer-1", artifactId: manifest.id, sha256: manifest.sha256, header: { ...batch.header },
    } };
    const handle = await transport.resolve(peer);
    const invoke = async (value: Operation) => JSON.parse((await transport.exec(handle, ["roam", "agent", JSON.stringify(value)],
      { timeoutMs: 3000, maxBytes: limits.replyBytes })).toString("utf8"));
    const applied = await invoke(operation);
    expect(applied).toMatchObject({ code: 0, value: { through: batch.header.through, sha256: batch.sha256 } });
    expect(await invoke(operation)).toEqual(applied);
    const receipt = await invoke({ id: "receipt-1", machineId: BOX, expectedEpoch: null, kind: "receipt",
      args: { storeKey: "global", sourceMachine: HUB, batchId: batch.header.batchId } });
    expect(receipt).toMatchObject({ code: 0, value: { through: batch.header.through, sha256: batch.sha256 } });
    const restarted = openDb(join(box, "spider.db"));
    try {
      expect(restarted.prepare("SELECT uuid,content FROM global_memory").all()).toEqual([{ uuid: "memory-a", content: "portable ".repeat(100) }]);
      expect(restarted.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine=? AND peer_stream=?").get(HUB, batch.header.senderStream))
        .toEqual({ last_seq: batch.header.through });
      expect(restarted.prepare("SELECT count(*) AS count FROM roam_receipts").get()).toEqual({ count: 1 });
    } finally { restarted.close(); }
    const entries = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(entries.filter(args => args[0] === "exec").every(args => args.includes(`--on=${alias}`))).toBe(true);
    expect(entries.some(args => args.includes("--stdin") && args.includes("receive"))).toBe(true);
  } finally { source.close(); await new Promise<void>(done => server.close(() => done())); }
}, 5000);
