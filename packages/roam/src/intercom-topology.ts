import { createHash } from "node:crypto";
import type { Db } from "@spider/db-core";
import type { IntercomMode, IntercomTopologyAudit, IntercomTopologyStore, IntercomTopologyTransition } from "./intercom-contracts";
import { isMachineId } from "./machine-id";

/** Retries of one approved graph address the same durable transition, even after enrollment completed. */
export function topologyTransitionId(machineId: string, operationId: string, graphDigest: string): string {
  const hex = createHash("sha256").update(JSON.stringify([machineId, operationId, graphDigest])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Shares the queue connection so custody, mode and rebind evidence commit together. */
export function createIntercomTopologyStore(db: Db, machineId: string, initialMode: IntercomMode, now: () => number): IntercomTopologyStore {
  db.prepare("INSERT OR IGNORE INTO intercom_topology(id,mode) VALUES(1,?)").run(initialMode);
  const topology: IntercomTopologyStore["topology"] = () => {
    const row = db.prepare("SELECT mode,transition_json,switched FROM intercom_topology WHERE id=1").get() as
      { mode: IntercomMode; transition_json: string | null; switched: string | null };
    if (!row || row.mode !== "hub-only" && row.mode !== "peers") throw new Error("intercom-topology-invalid");
    return { mode: row.mode, transition: row.transition_json === null ? null : JSON.parse(row.transition_json) as IntercomTopologyTransition, switched: row.switched };
  };
  const write = (value: IntercomTopologyTransition) => db.prepare("UPDATE intercom_topology SET transition_json=? WHERE id=1").run(JSON.stringify(value));
  const validId = (id: string) => { if (!isMachineId(id)) throw new Error("intercom-topology-invalid"); };
  return {
    topology,
    startTopologyTransition(input) {
      if (input.from !== "hub-only" || input.to !== "peers") throw new Error("intercom-transition-unsupported");
      validId(input.transitionId);
      if (!input.boxes.length || input.boxes.length > 64 || new Set(input.boxes).size !== input.boxes.length ||
          input.boxes.some(id => !isMachineId(id) || id === machineId)) throw new Error("intercom-topology-invalid");
      return db.raw.transaction(() => {
        const current = topology();
        if (current.transition) {
          if (current.transition.transitionId !== input.transitionId ||
              JSON.stringify(Object.keys(current.transition.boxes).sort()) !== JSON.stringify([...input.boxes].sort())) throw new Error("intercom-transition-conflict");
          return current.transition;
        }
        if (current.mode !== input.from) throw new Error("intercom-transition-unsupported");
        const next: IntercomTopologyTransition = { transitionId: input.transitionId, from: "hub-only", to: "peers", state: "draining",
          boxes: Object.fromEntries([...input.boxes].sort().map(id => [id, "pending" as const])) };
        write(next); return next;
      }).immediate();
    },
    advanceTopologyTransition() {
      return db.raw.transaction(() => {
        const current = topology().transition;
        if (!current) throw new Error("intercom-transition-missing");
        if (current.state !== "draining") return current;
        // Custody includes unresolved delivery and the return receipt until its origin acknowledges it.
        const pending = db.prepare(`SELECT 1 FROM intercom_copies c JOIN intercom_messages m ON m.id=c.id
          WHERE c.direction='inbound' AND json_extract(c.endpoint_json,'$.machineId')!=?
          AND (c.payload_json IS NOT NULL OR EXISTS (SELECT 1 FROM intercom_receipts r WHERE r.id=c.id AND r.acknowledged=0)) LIMIT 1`).get(machineId);
        if (pending) return current;
        const next = { ...current, state: "switching" as const }; write(next); return next;
      }).immediate();
    },
    acknowledgeTopologySwitch(transitionId, peer) {
      db.raw.transaction(() => {
        const current = topology().transition;
        if (!current || current.transitionId !== transitionId || current.state === "draining" || !Object.hasOwn(current.boxes, peer)) throw new Error("intercom-transition-conflict");
        current.boxes[peer] = "switched";
        if (Object.values(current.boxes).every(state => state === "switched")) {
          current.state = "complete"; db.prepare("UPDATE intercom_topology SET mode='peers' WHERE id=1").run();
        }
        write(current);
      }).immediate();
    },
    switchTopology(input) {
      validId(input.transitionId); validId(input.hubMachineId);
      if (input.hubMachineId === machineId || input.directPeers.some(id => !isMachineId(id) || id === input.hubMachineId)) throw new Error("intercom-topology-invalid");
      return db.raw.transaction(() => {
        const current = topology();
        if (current.switched === input.transitionId) return { rebound: 0, missing: [] };
        if (current.switched !== null || current.mode !== "hub-only") throw new Error("intercom-transition-conflict");
        const rows = db.prepare(`SELECT c.id,c.peer,c.state,c.transmitted,c.ack_kind,c.unknown_outcome,
          json_extract(c.endpoint_json,'$.machineId') AS destination,
          EXISTS(SELECT 1 FROM intercom_topology_refusals r WHERE r.id=c.id AND r.peer=c.peer) AS refused
          FROM intercom_copies c JOIN intercom_messages m ON m.id=c.id
          WHERE c.direction='outbound' AND c.peer=? AND json_extract(c.endpoint_json,'$.machineId')!=?
          AND (c.payload_json IS NOT NULL OR c.state IN ('expired','cancelled') AND coalesce(c.ack_kind,'') NOT IN ('message','tombstone'))
          AND json_extract(m.identity_json,'$.originMachineId')=? ORDER BY c.rowid`)
          .all(input.hubMachineId, input.hubMachineId, machineId) as Array<{
            id: string; peer: string; state: string; transmitted: number; ack_kind: string | null; unknown_outcome: number; destination: string; refused: number;
          }>;
        // Validate the entire set before changing even its first route.
        if (rows.some(row => row.ack_kind === "message")) throw new Error("intercom-topology-hub-custody");
        if (rows.some(row => row.unknown_outcome || row.state === "unknown" || row.transmitted && !row.refused)) throw new Error("intercom-topology-outcome-unknown");
        const peers = new Set(input.directPeers), missing = new Set<string>(); let rebound = 0;
        for (const row of rows) {
          if (!peers.has(row.destination)) { missing.add(row.destination); continue; }
          db.prepare("UPDATE intercom_copies SET peer=?,transmitted=0,sent_kind=NULL,ack_kind=NULL WHERE direction='outbound' AND id=?").run(row.destination, row.id);
          db.prepare("INSERT INTO intercom_topology_audit(id,transition_id,old_next_hop,new_next_hop,at) VALUES(?,?,?,?,?)")
            .run(row.id, input.transitionId, row.peer, row.destination, now());
          rebound++;
        }
        db.prepare("UPDATE intercom_topology SET mode='peers',switched=? WHERE id=1").run(input.transitionId);
        return { rebound, missing: [...missing].sort() };
      }).immediate();
    },
    recordTopologyRefusal(input) {
      validId(input.peer);
      db.raw.transaction(() => {
        const row = db.prepare(`SELECT c.peer,c.ack_kind,m.identity_json FROM intercom_copies c JOIN intercom_messages m ON m.id=c.id
          WHERE c.direction='outbound' AND c.id=?`).get(input.identity.id) as { peer: string; ack_kind: string | null; identity_json: string } | undefined;
        if (!row) throw new Error("intercom-topology-invalid-refusal");
        const { originMachineId: _origin, ...identity } = JSON.parse(row.identity_json);
        if (JSON.stringify(identity) !== JSON.stringify(input.identity)) throw new Error("intercom-topology-invalid-refusal");
        if (row.peer !== input.peer) {
          // A prior exchange can return its refusal after the atomic route switch.
          // Only the exact audited former hop may replay it; it grants no new authority.
          const current = topology();
          const audited = db.prepare(`SELECT 1 FROM intercom_topology_audit WHERE id=? AND transition_id=? AND old_next_hop=? AND new_next_hop=?`)
            .get(input.identity.id, current.switched, input.peer, row.peer);
          if (current.mode !== "peers" || !audited) throw new Error("intercom-topology-invalid-refusal");
          return;
        }
        if (row.ack_kind === "message") throw new Error("intercom-topology-invalid-refusal");
        db.prepare("INSERT OR IGNORE INTO intercom_topology_refusals(id,peer) VALUES(?,?)").run(input.identity.id, input.peer);
      }).immediate();
    },
    missingTopologyRoutes() {
      if (topology().mode !== "peers") return [];
      return (db.prepare(`SELECT DISTINCT json_extract(c.endpoint_json,'$.machineId') AS destination
        FROM intercom_copies c JOIN intercom_messages m ON m.id=c.id
        WHERE c.direction='outbound' AND c.peer!=json_extract(c.endpoint_json,'$.machineId') AND c.payload_json IS NOT NULL
        AND json_extract(m.identity_json,'$.originMachineId')=? ORDER BY destination`).all(machineId) as { destination: string }[]).map(row => row.destination);
    },
    topologyAudit() {
      return (db.prepare("SELECT id,transition_id,old_next_hop,new_next_hop,at FROM intercom_topology_audit ORDER BY rowid").all() as Array<{
        id: string; transition_id: string; old_next_hop: string; new_next_hop: string; at: number;
      }>).map((row): IntercomTopologyAudit => ({ id: row.id, reason: "topology-transition", transitionId: row.transition_id,
        oldNextHop: row.old_next_hop, newNextHop: row.new_next_hop, timestamp: row.at }));
    },
  };
}
