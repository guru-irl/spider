import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbAt } from "@spider/db-core";
import type { V0AgentRequest, V0Endpoint, V0Reply } from "@spider/intercom/roam-v0";
import { main } from "../cli";
import { createV0Intercom } from "../relocate/intercom";

const MAC = "11111111-1111-4111-8111-111111111111";
const BOX = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];

function boxFixture(): { root: string; agentDir: string } {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "ic2-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  mkdirSync(join(root, "herdr"), { mode: 0o700 });
  mkdirSync(agentDir, { mode: 0o700 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify({
    enabled: true, role: "box", machineId: BOX, hubMachineId: MAC,
    peers: [], discoveryRoots: [], coreUnit: "core.service",
  }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "intercom-v0.json"), JSON.stringify({
    version: 1, sendTo: [], acceptFrom: [{ machineId: MAC, alias: "mac" }],
  }), { mode: 0o600 });
  writeFileSync(join(root, "herdr", "config.json"), JSON.stringify({
    mode: "core-only", core: { binary: "/usr/bin/env", config: join(root, "core.toml") },
    globalRoot: root, agentDirectory: agentDir, shellRc: join(root, "shell.rc"), machines: [],
  }), { mode: 0o600 });
  const db = openDbAt(join(root, "spider.db"), "global");
  try {
    db.prepare("UPDATE roam_meta SET machine_id=?,store_key='global' WHERE id=1").run(BOX);
    const insert = db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at,state) VALUES (?,?,?,1,'running')");
    insert.run("alice", MAC, 1);
    insert.run("ben", BOX, 2);
  } finally { db.close(); }
  return { root, agentDir };
}

const ben: V0Endpoint = {
  address: { sessionId: "ben", scopeId: "scope-1" }, name: "ben", homeEpoch: 2, endpointEpoch: "ben-connection",
};
const findBen: V0AgentRequest = {
  version: 1, requestId: "request-1", toMachineId: BOX, kind: "lookup",
  from: { machineId: MAC, address: { sessionId: "alice", scopeId: "scope-1" }, name: "alice", homeEpoch: 1, endpointEpoch: "alice-connection" },
  selector: { by: "name", value: "ben" },
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("roaming v0 intercom", () => {
  it("dispatches via the private v0 agent mode", async () => {
    const { root, agentDir } = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    const broker = vi.fn(async (_dir: string, _op: unknown): Promise<V0Reply> => ({ kind: "matches", targets: [ben] }));
    let out = "", err = "";
    const io = { out: (text: string) => { out += text; }, err: (text: string) => { err += text; } };
    const intercom = async (input: unknown, targetRoot: string) => createV0Intercom(targetRoot, { broker }).handle(input);
    const code = await main(["--global-root", root, "roam", "agent", "--v0", "intercom"], io,
      { stdin: Buffer.from(JSON.stringify(findBen)), v0: { intercom } });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ version: 1, requestId: "request-1", machineId: BOX, kind: "matches", targets: [ben] });
    expect(err).toBe("");
    expect(broker).toHaveBeenCalledWith(agentDir, { kind: "lookup", scopeId: "scope-1", selector: { by: "name", value: "ben" } }, expect.anything());
  });

  it("keeps an unhomed caller local and refuses an explicit remote target", async () => {
    const { root } = boxFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    const from = { id: "transient", address: { sessionId: "transient", scopeId: "scope-1" },
      endpointEpoch: "transient-connection", cwd: "", model: "", pid: 1, startedAt: 1, lastActivity: 1 };
    const { prepare } = createV0Intercom(root);
    expect(await prepare({ to: "local", from, locals: [from] })).toEqual({ kind: "legacy" });
    expect(await prepare({ to: "box/ben", from, locals: [from] })).toEqual({ kind: "refused", code: "not-configured" });
  });
});
