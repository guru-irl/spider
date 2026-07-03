import type { Runner } from "./runner";
import type { RunRow } from "./run-store";

export async function runParallel(
  runner: Runner,
  tasks: Array<{ agent: string; task: string; name?: string; count?: number; model?: string; context?: "fresh" | "fork" }>,
  opts: { concurrency?: number; context: "fresh" | "fork"; async?: boolean }
): Promise<RunRow[]> {
  const expanded: Array<{ agent: string; task: string; name?: string; model?: string; context: "fresh" | "fork"; childIndex: number }> = [];
  let idx = 0;
  for (const t of tasks)
    for (let c = 0; c < (t.count ?? 1); c++)
      expanded.push({ agent: t.agent, task: t.task, name: t.name, model: t.model, context: t.context ?? opts.context, childIndex: idx++ });
  // Async: spawn every subagent in the background and return the running rows (with ids)
  // immediately — the caller (main agent) gets its run ids without blocking.
  if (opts.async) {
    return expanded.map((e) => runner.runAsync({ agent: e.agent, task: e.task, name: e.name, model: e.model, context: e.context, childIndex: e.childIndex }));
  }
  const limit = Math.max(1, opts.concurrency ?? 4);
  const results: RunRow[] = new Array(expanded.length);
  let next = 0;
  async function worker() {
    while (next < expanded.length) {
      const i = next++;
      const e = expanded[i];
      results[i] = await runner.runForeground({ agent: e.agent, task: e.task, name: e.name, model: e.model, context: e.context, childIndex: e.childIndex });
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, expanded.length) }, () => worker()));
  return results;
}
