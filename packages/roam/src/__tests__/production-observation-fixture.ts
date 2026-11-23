import { vi } from "vitest";
import type { Db } from "@spider/db-core";
import type { BatchHeader, JsonObject } from "@spider/db-core/roam/types";
import type { Operation, RoamConfig, StorePort, Transport } from "../contracts";
import type { StandaloneHubPorts } from "../hub";
import * as runtime from "../runtime";
import * as hub from "../hub";
import * as hc from "@spider/herdr/client/hc";
import * as diagnostics from "../local-diagnostics";
import * as hostConfig from "../host-config";
import * as transport from "../transport";
import { startProductionHub } from "../production-hub";
import { unexpectedBootstrapProbe } from "./transport-fixture";

// An already synchronized global store has nothing to transfer. Keep the real
// inventory, pull, push and observation paths without another artifact network.
export function noChangeSyncFixture(config: RoamConfig): {
  stores: StorePort; transport: Transport;
  setUnavailable(value: boolean): void; setIncomplete(value: boolean): void;
  setRefused(value: boolean): void; setReplaced(value: boolean): void;
} {
  const localStream = "00000000-0000-4000-8000-000000000010";
  const remoteStream = "00000000-0000-4000-8000-000000000011";
  let unavailable = false, incomplete = false, refused = false, replaced = false;
  const header = (machine: string, stream: string, batchId: string, after: number): BatchHeader => ({
    protocol: 1, schema: 14, batchId, senderMachine: machine, senderStream: stream,
    storeKey: "global", after, through: after, count: 0,
  });
  const stores: StorePort = {
    list: () => ["global"], cursor: () => 0,
    async export(key, after, _bytes, batchId) {
      if (key !== "global" || after !== 0) throw new Error("Unexpected local export");
      return { header: header(config.machineId, localStream, batchId, after), file: "", byteLength: 0, sha256: "" };
    },
    async accept() { throw new Error("No batch should be transferred"); },
  };
  const wire: Transport = {
    bootstrapProbe: unexpectedBootstrapProbe,
    async resolve(peer) { if (unavailable) throw new Error("unavailable"); return peer; },
    async exec(peer, argv) {
      if (argv[0] !== "roam") throw new Error("Unexpected command");
      if (argv[1] === "observe" && argv[2] === "hosting") return Buffer.from(JSON.stringify({
        version: 1, machineId: peer.machineId, kind: "hosting", value: { readiness: [], suspensions: [] },
      }));
      if (argv[1] !== "agent") throw new Error("Unexpected command");
      const op = JSON.parse(argv[2]) as Operation;
      const identity = { protocol: 1, schema: 14, machineId: replaced ? config.machineId : peer.machineId };
      let value: JsonObject;
      switch (op.kind) {
        case "stores": value = { ...identity, stores: ["global"], ungathered: incomplete
          ? [{ key: null, scope: "worktree", path: "/home/fixture/missing", code: "missing", check: "stat" }] : [] }; break;
        case "inventory": value = { ...identity, storeKey: "global", stream: remoteStream, captureEnabled: true, roamable: true }; break;
        case "export": value = { header: { ...header(peer.machineId, remoteStream, op.id, Number(op.args.after)) }, artifact: null }; break;
        case "cursor": value = { lastSeq: 0 }; break;
        default: throw new Error(`Unexpected sync operation: ${op.kind}`);
      }
      return Buffer.from(JSON.stringify({ code: refused ? 1 : 0, reason: refused ? "Invalid peer value" : "ok", operationId: op.id,
        home: null, epoch: null, repairCommand: null, value: refused ? null : value }));
    },
    async read() { throw new Error("No artifact should be read"); },
    async write() { throw new Error("No artifact should be written"); },
    async run() { throw new Error("No remote process should be launched"); },
  };
  return { stores, transport: wire, setUnavailable(value: boolean) { unavailable = value; },
    setIncomplete(value: boolean) { incomplete = value; }, setRefused(value: boolean) { refused = value; },
    setReplaced(value: boolean) { replaced = value; } };
}

export async function productionObservationFixture(root: string, config: RoamConfig, db: Db, wire: Transport): Promise<{
  observe: StandaloneHubPorts["observe"]; stop(): Promise<void>; setState(value: string): void;
}> {
  let state = "connected";
  vi.spyOn(runtime, "openLocalCore").mockReturnValue({ root, config, db, close() {} });
  vi.spyOn(hostConfig, "loadHerdrConfig").mockReturnValue({ core: { binary: "/home/fixture/hc" } } as never);
  vi.spyOn(diagnostics, "createLocalDiagnosticPorts").mockReturnValue({ async probeProcess() { return { kind: "live", startIdentity: "process-1" }; } } as never);
  vi.spyOn(hc, "createHcClient").mockReturnValue({ async identity() { return { coreId: "core-1" }; }, async dispose() {} } as never);
  vi.spyOn(hc, "invokeCli").mockImplementation(async () => ({ machines: config.peers.map(peer => ({ name: peer.alias, state })) }) as never);
  vi.spyOn(transport, "createTransport").mockReturnValue(wire);
  let ports: StandaloneHubPorts | undefined;
  vi.spyOn(hub, "runStandaloneHub").mockImplementation(async input => { ports = input; return { async stop() {}, agentPorts: {} as never }; });
  const handle = await startProductionHub(root);
  if (!ports) throw new Error("Hub was not composed");
  return { observe: ports.observe, stop: () => handle.stop(), setState(value: string) { state = value; } };
}
