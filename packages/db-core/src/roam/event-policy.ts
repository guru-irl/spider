import type { ExportPolicy, JsonObject, MachineId, Locator, HistoryRef } from "./types";

export const EVENT_POLICIES: Readonly<Record<string, "inert" | "supervisor" | "transcript" | "chain">> = {
  tool_intent: "inert", tool_result: "inert", status: "inert", handoff: "inert",
  escalation: "inert", message: "inert", log: "inert", warning: "inert", steer: "inert",
  extension_error: "inert", queue_update: "inert", steer_delivery: "inert",
  spider_usage: "inert", spider_compaction: "inert",
  child_supervisor: "supervisor", child_transcript: "transcript", chain_steps: "chain",
};

export function createExportPolicy(resolve: (path: string, origin: MachineId) => Locator | HistoryRef): ExportPolicy {
  return {
    encode(entity, body, origin) {
      if (entity !== "run_events" || typeof body.type !== "string" || typeof body.payload !== "string") return body;
      const kind = EVENT_POLICIES[body.type];
      if (kind !== "supervisor" && kind !== "transcript" && kind !== "chain") return body;
      let value: unknown;
      try { value = JSON.parse(body.payload); } catch { return body; }
      if (!value || typeof value !== "object" || Array.isArray(value)) return body;
      const input = value as Record<string, unknown>;
      let portable: JsonObject;
      if (kind === "chain") {
        if ((input.version !== undefined && input.version !== 1) || !Array.isArray(input.remaining)) return body;
        // The source retains this event and its UUID identifies the original chain history.
        portable = { count: input.remaining.length, history: { machineId: origin, reference: `run-event:${body.uuid}` } };
      } else {
        if (input.version !== 1) return body;
        portable = { version: 1 };
        if (typeof input.directory === "string") {
          const ref = resolve(input.directory, origin);
          portable.history = { ...ref };
        }
      }
      return { ...body, payload: JSON.stringify(portable) };
    },
  };
}
