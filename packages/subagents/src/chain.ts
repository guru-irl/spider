import type { Runner } from "./runner.js";
import type { RunRow } from "./run-store.js";

function interpolate(tmpl: string, vars: { task: string; previous: string }): string {
  return tmpl.replace(/\{task\}/g, vars.task).replace(/\{previous\}/g, vars.previous);
}

export async function runChain(
  runner: Runner,
  steps: Array<{ agent?: string; task?: string; model?: string; context?: "fresh" | "fork" }>,
  base: { task: string; context: "fresh" | "fork" }
): Promise<RunRow[]> {
  const out: RunRow[] = [];
  let previous = "";
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const tmpl = s.task ?? (i === 0 ? "{task}" : "");
    const task = interpolate(tmpl, { task: base.task, previous });
    const row = await runner.runForeground({
      agent: s.agent ?? "worker",
      task,
      model: s.model,
      context: s.context ?? base.context,
      phase: `step-${i + 1}`,
    });
    out.push(row);
    previous = row.result ?? "";
  }
  return out;
}
