import type { ModelEntry } from "./catalog.js";
import type { PickResult } from "./pick.js";
import type { Db } from "@spider/db-core";
export interface CompleteOpts { system?: string; thinkingLevel?: string; maxTokens?: number }
export interface CompleteDeps {
  getModel: (provider: string, id: string) => unknown;
  run: (model: unknown, prompt: string, opts: CompleteOpts) => Promise<string>;
}
// Default runner wires @earendil-works/pi-ai (getModel + streamProxy). Kept lazy + injectable so
// unit tests never hit the network; VALIDATE the streamProxy arg shape against the installed dep.
// Accepts a bare ModelEntry OR a pick() PickResult — when given a PickResult, pick's resolved
// thinkingLevel is threaded into the runner automatically (explicit opts.thinkingLevel still wins).
export async function complete(model: ModelEntry | PickResult, prompt: string, opts: CompleteOpts = {}, deps?: CompleteDeps): Promise<string> {
  const entry = "entry" in model ? model.entry : model;
  const pickedThinking = "entry" in model ? model.thinkingLevel : undefined;
  const d = deps ?? (await defaultDeps());
  const handle = d.getModel(entry.provider, entry.id);
  return d.run(handle, prompt, { ...opts, thinkingLevel: opts.thinkingLevel ?? pickedThinking });
}
async function defaultDeps(): Promise<CompleteDeps> {
  const ai = await import("@earendil-works/pi-ai");
  return {
    getModel: (p, id) => (ai as any).getModel(p, id),
    run: async (handle, prompt, o) => {
      // VALIDATE-FIRST: confirm streamProxy(model, context, options) signature (TC8) and collect text deltas.
      const stream = (ai as any).streamProxy(handle, buildContext(prompt, o.system), { thinkingLevel: o.thinkingLevel, maxTokens: o.maxTokens });
      let text = "";
      for await (const ev of stream) if (ev?.type === "text" && typeof ev.delta === "string") text += ev.delta;
      return text;
    },
  };
}
function buildContext(prompt: string, system?: string) {
  const msgs = system ? [{ role: "system", content: system }, { role: "user", content: prompt }] : [{ role: "user", content: prompt }];
  return { messages: msgs } as any;
}
export function recordModelStat(db: Db, s: { model: string; ms: number; ok: boolean; tokens: number }): void {
  db.prepare("INSERT INTO model_stats (model, ms, ok, tokens, ts) VALUES (?, ?, ?, ?, ?)")
    .run(s.model, s.ms, s.ok ? 1 : 0, s.tokens, Date.now());
}
