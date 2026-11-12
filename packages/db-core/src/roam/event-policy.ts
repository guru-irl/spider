import type { ExportPolicy, JsonObject, MachineId, Locator, HistoryRef } from "./types";

export const EVENT_POLICIES: Readonly<Record<string, "inert" | "supervisor" | "transcript" | "chain">> = {
  tool_intent: "inert", tool_result: "inert", status: "inert", handoff: "inert",
  escalation: "inert", message: "inert", log: "inert", warning: "inert", steer: "inert",
  extension_error: "inert", queue_update: "inert", steer_delivery: "inert",
  spider_usage: "inert", spider_compaction: "inert",
  completion_delivered: "inert", spider_usage_reported: "inert",
  child_supervisor: "supervisor", child_transcript: "transcript", chain_steps: "chain",
};

export function createExportPolicy(resolve: (path: string, origin: MachineId) => Locator | HistoryRef): ExportPolicy {
  return {
    encode(entity, body, origin) {
      if (entity !== "run_events" || typeof body.type !== "string") return body;
      const kind = EVENT_POLICIES[body.type];
      if (kind !== "supervisor" && kind !== "transcript" && kind !== "chain") return body;
      let value: unknown;
      try { value = typeof body.payload === "string" ? JSON.parse(body.payload) : null; }
      catch { value = null; }
      const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      // Unknown or malformed versions remain inert, but never carry arbitrary fields.
      let portable: JsonObject = { ...(typeof input.version === "number" && Number.isSafeInteger(input.version) ? { version: input.version } : {}), history: null };
      if (kind === "chain" && (input.version === undefined || input.version === 1) && Array.isArray(input.remaining)) {
        // The source retains this event and its UUID identifies the original chain history.
        portable = { count: input.remaining.length, history: { machineId: origin, reference: `run-event:${body.uuid}` } };
      } else if (kind !== "chain" && input.version === 1) {
        portable = { version: 1 };
        if (typeof input.directory === "string") {
          const ref = resolve(input.directory, origin);
          portable.history = "reference" in ref ? { machineId: ref.machineId, reference: ref.reference }
            : { machineId: ref.machineId, repoKey: ref.repoKey, workspaceId: ref.workspaceId, relativePath: ref.relativePath };
        }
      }
      return { uuid: body.uuid, run_id: body.run_id, session_id: body.session_id, ts: body.ts,
        type: body.type, tool: null, summary: null, payload: JSON.stringify(portable) };
    },
  };
}
