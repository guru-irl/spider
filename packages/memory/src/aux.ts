import type {} from "./types.js";

// ---------------------------------------------------------------------------
// Aux-model digest routing — ported 1:1 from hermes-agent
// `agent/background_review.py` `_resolve_review_runtime` (L46) and
// `_digest_history` (L112).
//
// The review fork runs on the MAIN model by default, replaying the full
// conversation (warm in the prompt cache -> cheap cache reads). A user can
// route the review to a different, cheaper model via
// `auxiliary.background_review.{provider,model}`. A different model cannot
// reuse the parent's cache (different key), so when (and only when) routed to a
// different model we replay a compact DIGEST to minimise cold-written tokens.
// Same model -> full replay; different model -> digest. That's the whole
// policy.
//
// Per amendment A1 this module only resolves the CONFIGURED override (the
// routing profile / cheap-tier intent). The actual model selection and
// completion defer elsewhere to `@spider/models` — this module does NOT import
// or depend on it (keeps the module graph a leaf).
// ---------------------------------------------------------------------------

export interface AuxRuntime {
  provider?: string;
  model?: string;
  routed: boolean;
}

/** Defensive string read: returns a trimmed non-empty string or undefined. */
function readStr(obj: unknown, key: string): string | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}

/** Defensive object read: returns a plain object or undefined. */
function readObj(obj: unknown, key: string): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "object" && v !== null ? v : undefined;
}

/**
 * Resolve the configured aux runtime override for the background review.
 *
 * Reads `cfg.auxiliary.background_review.{provider,model}` defensively (cfg is
 * `unknown` — every access is guarded). `routed` is true iff the config names a
 * concrete model that differs from the parent's model; same-as-parent or
 * absent config is not routed. `provider`/`model` are undefined when absent.
 *
 * Mirrors `_resolve_review_runtime`'s policy: a differing configured model =>
 * routed (cold cache => digest replay). Note: unlike the python source we do
 * NOT resolve credentials/base_url here — model selection defers to
 * `@spider/models.pick` per amendment A1.
 */
export function resolveAuxRuntime(cfg: unknown, parentModel: string): AuxRuntime {
  const aux = readObj(cfg, "auxiliary");
  const task = readObj(aux, "background_review");
  const provider = readStr(task, "provider");
  const model = readStr(task, "model");

  // routed iff a concrete model is named and it differs from the parent.
  const routed = model !== undefined && model !== parentModel;

  const rt: AuxRuntime = { routed };
  if (provider !== undefined) rt.provider = provider;
  if (model !== undefined) rt.model = model;
  return rt;
}

export interface DigestMsg {
  role: "user" | "assistant";
  content: string;
}

function msgText(m: DigestMsg): string {
  return typeof m?.content === "string" ? m.content.replace(/\n/g, " ").trim() : "";
}

/**
 * Compact replay for the routed (different-model) path only.
 *
 * Keeps the recent `tail` messages verbatim and collapses older turns into one
 * synthetic user-role digest prepended before the tail, preserving role
 * alternation. Used ONLY when routed to a different model (cache cold
 * regardless, so fewer cold-written tokens is a pure win); never on the
 * main-model path (full replay stays warm).
 *
 * Ported from `_digest_history`. If `messages.length <= tail`, returns a copy
 * unchanged.
 */
export function digestHistory(messages: DigestMsg[], tail = 24): DigestMsg[] {
  const msgs = Array.isArray(messages) ? messages.slice() : [];
  if (msgs.length <= tail) {
    return msgs;
  }

  const keep = msgs.slice(-tail);
  const old = msgs.slice(0, msgs.length - keep.length);

  const lines: string[] = [];
  for (const m of old) {
    if (typeof m !== "object" || m === null) continue;
    const role = m.role;
    const text = msgText(m);
    if (role === "user" && text) {
      lines.push(`USER: ${text.slice(0, 300)}`);
    } else if (role === "assistant" && text) {
      lines.push(`ASSISTANT: ${text.slice(0, 200)}`);
    }
  }

  const digest: DigestMsg = {
    role: "user",
    content:
      "[Earlier conversation digest — older turns summarised to bound the " +
      "review's cold-write cost on the routed aux model. Recent turns " +
      "follow verbatim below.]\n" +
      lines.join("\n"),
  };

  return [digest, ...keep];
}
