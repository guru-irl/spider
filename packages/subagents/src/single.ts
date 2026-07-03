import type { Runner } from "./runner";
import type { RunRow } from "./run-store";

export function runSingle(
  runner: Runner,
  spec: { agent: string; task?: string; model?: string; skill?: string; context: "fresh" | "fork"; async?: boolean }
): Promise<RunRow> | RunRow {
  const opts = { agent: spec.agent, task: spec.task ?? "", model: spec.model, skill: spec.skill, context: spec.context };
  return spec.async ? runner.runAsync(opts) : runner.runForeground(opts);
}
