/**
 * Hardened threat scanner for `@spider/memory`.
 *
 * Faithful TypeScript port of `hermes-agent/tools/threat_patterns.py`
 * (the `_PATTERNS` table, `_FILLER`, `MAX_SCAN_CHARS`, `INVISIBLE_CHARS`,
 * NFKC handling, and the scope-filtered scan function), merged with the
 * `SECRET_PATTERNS` credential detectors from
 * `pi-hermes-memory/src/store/content-scanner.ts`.
 *
 * Scope-tier semantics (authoritative — matches the Python scan function):
 * a pattern is tagged with the LOOSEST scan mode at which it applies, and a
 * scan MODE runs its own tier plus every looser tier:
 *   - mode "all"     → runs patterns tagged "all"
 *   - mode "context" → runs patterns tagged "all" + "context"
 *   - mode "strict"  → runs patterns tagged "all" + "context" + "strict"
 * Secret patterns run in every mode.
 */

/** Hard cap on the number of characters scanned with regexes. */
export const MAX_SCAN_CHARS = 65_536;

/**
 * Bounded filler used between key attack words. Eight filler words is enough
 * for the intended obfuscation bypasses without unbounded backtracking (ReDoS
 * safe). Mirrors `_FILLER` in threat_patterns.py.
 */
const FILLER = String.raw`(?:\w+\s+){0,8}`;

export type ThreatScope = "all" | "context" | "strict";

/**
 * Invisible / bidirectional unicode characters used in injection attacks.
 * Verbatim port of `INVISIBLE_CHARS` (frozenset) in threat_patterns.py.
 */
export const INVISIBLE_CHARS: ReadonlySet<string> = new Set<string>([
  "\u200b", // zero-width space
  "\u200c", // zero-width non-joiner
  "\u200d", // zero-width joiner
  "\u2060", // word joiner
  "\u2062", // invisible times
  "\u2063", // invisible separator
  "\u2064", // invisible plus
  "\ufeff", // zero-width no-break space (BOM)
  "\u202a", // left-to-right embedding
  "\u202b", // right-to-left embedding
  "\u202c", // pop directional formatting
  "\u202d", // left-to-right override
  "\u202e", // right-to-left override
  "\u2066", // left-to-right isolate
  "\u2067", // right-to-left isolate
  "\u2068", // first strong isolate
  "\u2069", // pop directional isolate
]);

// Each entry: [regex source, pattern id, scope]
// Verbatim port of `_PATTERNS` in hermes-agent/tools/threat_patterns.py.
const RAW_PATTERNS: Array<[string, string, ThreatScope]> = [
  // ── Classic prompt injection (applies everywhere) ────────────────
  [String.raw`ignore\s+${FILLER}(previous|all|above|prior)\s+${FILLER}instructions`, "prompt_injection", "all"],
  [String.raw`system\s+prompt\s+override`, "sys_prompt_override", "all"],
  [String.raw`disregard\s+${FILLER}(your|all|any)\s+${FILLER}(instructions|rules|guidelines)`, "disregard_rules", "all"],
  [String.raw`act\s+as\s+(if|though)\s+${FILLER}you\s+${FILLER}(have\s+no|don't\s+have)\s+${FILLER}(restrictions|limits|rules)`, "bypass_restrictions", "all"],
  [String.raw`<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->`, "html_comment_injection", "all"],
  [String.raw`<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none`, "hidden_div", "all"],
  [String.raw`translate\s+[^\n]{0,512}\s+into\s+[^\n]{0,512}\s+and\s+(execute|run|eval)`, "translate_execute", "all"],
  [String.raw`do\s+not\s+${FILLER}tell\s+${FILLER}the\s+user`, "deception_hide", "all"],

  // ── Role-play / identity hijack (context + strict) ───────────────
  [String.raw`you\s+are\s+${FILLER}now\s+(?:a|an|the)\s+`, "role_hijack", "context"],
  [String.raw`pretend\s+${FILLER}(you\s+are|to\s+be)\s+`, "role_pretend", "context"],
  [String.raw`output\s+${FILLER}(system|initial)\s+prompt`, "leak_system_prompt", "context"],
  [String.raw`(respond|answer|reply)\s+without\s+${FILLER}(restrictions|limitations|filters|safety)`, "remove_filters", "context"],
  [String.raw`you\s+have\s+been\s+${FILLER}(updated|upgraded|patched)\s+to`, "fake_update", "context"],
  [String.raw`\bname\s+yourself\s+\w+`, "identity_override", "context"],

  // ── C2 / Brainworm-style promptware (context scope) ──────────────
  [String.raw`register\s+(as\s+)?a?\s*node`, "c2_node_registration", "context"],
  [String.raw`(heartbeat|beacon|check[\s\-]?in)\s+(to|with)\s+`, "c2_heartbeat", "context"],
  [String.raw`pull\s+(down\s+)?(?:new\s+)?task(?:ing|s)?\b`, "c2_task_pull", "context"],
  [String.raw`connect\s+to\s+the\s+network\b`, "c2_network_connect", "context"],
  [String.raw`you\s+must\s+(?:\w+\s+){0,3}(register|connect|report|beacon)\b`, "forced_action", "context"],
  [String.raw`only\s+use\s+one[\s\-]?liners?\b`, "anti_forensic_oneliner", "context"],
  [String.raw`never\s+${FILLER}(?:create|write)\s+${FILLER}(?:script|file)\s+${FILLER}disk`, "anti_forensic_disk", "context"],
  [String.raw`unset\s+\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC)\w*`, "env_var_unset_agent", "context"],

  // ── Known C2 / red-team framework names (context scope) ──────────
  [String.raw`\b(?:cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b`, "known_c2_framework", "context"],
  [String.raw`\bc2\s+(?:server|channel|infrastructure|beacon)\b`, "c2_explicit", "context"],
  [String.raw`\bcommand\s+and\s+control\b`, "c2_explicit_long", "context"],

  // ── Exfiltration via curl/wget/cat with secrets (applies everywhere) ──
  [String.raw`curl\s+[^\n]{0,2048}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`, "exfil_curl", "all"],
  [String.raw`wget\s+[^\n]{0,2048}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`, "exfil_wget", "all"],
  [String.raw`cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)`, "read_secrets", "all"],
  [String.raw`(send|post|upload|transmit)\s+[^\n]{0,2048}\s+(to|at)\s+https?://`, "send_to_url", "strict"],
  [String.raw`(include|output|print|share)\s+${FILLER}(conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)`, "context_exfil", "strict"],

  // ── Persistence / SSH backdoor (strict scope — memory + skills) ──
  [String.raw`authorized_keys`, "ssh_backdoor", "strict"],
  [String.raw`\$HOME/\.ssh|\~/\.ssh`, "ssh_access", "strict"],
  [String.raw`\$HOME/\.hermes/\.env|\~/\.hermes/\.env`, "hermes_env", "strict"],
  [String.raw`(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules)`, "agent_config_mod", "strict"],
  [String.raw`(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}\.hermes/(config\.yaml|SOUL\.md)`, "hermes_config_mod", "strict"],

  // ── Hardcoded secrets ────────────────────────────────────────────
  [String.raw`(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}`, "hardcoded_secret", "strict"],
];

interface CompiledPattern {
  re: RegExp;
  id: string;
}

/**
 * Compiled pattern sets indexed by scan mode. Mirrors `_compile()` in
 * threat_patterns.py: an "all"-tagged pattern lands in every mode's set, a
 * "context"-tagged pattern lands in context + strict, a "strict"-tagged
 * pattern lands in strict only. The mode key selects the set to run.
 */
const COMPILED: Record<ThreatScope, CompiledPattern[]> = (() => {
  const all: CompiledPattern[] = [];
  const context: CompiledPattern[] = [];
  const strict: CompiledPattern[] = [];

  for (const [source, id, scope] of RAW_PATTERNS) {
    const entry: CompiledPattern = { re: new RegExp(source, "i"), id };
    if (scope === "all") {
      all.push(entry);
      context.push(entry);
      strict.push(entry);
    } else if (scope === "context") {
      context.push(entry);
      strict.push(entry);
    } else {
      strict.push(entry);
    }
  }

  return { all, context, strict };
})();

/**
 * Secret detection patterns — credentials, API keys, tokens, and env-var
 * leaks. Verbatim port of `SECRET_PATTERNS` in
 * pi-hermes-memory/src/store/content-scanner.ts. Run in every scan mode.
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; id: string; severity: "high" | "medium" }> = [
  // API keys
  { pattern: /\bsk-ant-api\S{10,}\b/, id: "anthropic_api_key", severity: "high" },
  { pattern: /\bsk-or-v1-\S{10,}\b/, id: "openrouter_api_key", severity: "high" },
  { pattern: /\bsk-\S{20,}\b/, id: "openai_api_key", severity: "high" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, id: "aws_access_key", severity: "high" },
  // Tokens
  { pattern: /\bghp_\S{10,}\b/, id: "github_personal_token", severity: "high" },
  { pattern: /\bghu_\S{10,}\b/, id: "github_user_token", severity: "high" },
  { pattern: /\bxoxb-\S{10,}\b/, id: "slack_bot_token", severity: "high" },
  { pattern: /\bxapp-\S{10,}\b/, id: "slack_app_token", severity: "high" },
  { pattern: /\bntn_\S{10,}\b/, id: "notion_token", severity: "high" },
  { pattern: /\bBearer\s+\S{20,}\b/, id: "bearer_auth_token", severity: "high" },
  // SSH keys
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\sKEY-----/, id: "private_key_block", severity: "high" },
  // Environment variable names that indicate secrets
  { pattern: /\bANTHROPIC_API_KEY\b/, id: "env_anthropic_key", severity: "medium" },
  { pattern: /\bOPENAI_API_KEY\b/, id: "env_openai_key", severity: "medium" },
  { pattern: /\bOPENROUTER_API_KEY\b/, id: "env_openrouter_key", severity: "medium" },
  { pattern: /\bGITHUB_TOKEN\b/, id: "env_github_token", severity: "medium" },
  { pattern: /\bAWS_SECRET_ACCESS_KEY\b/, id: "env_aws_secret", severity: "medium" },
  { pattern: /\bDATABASE_URL\b/, id: "env_database_url", severity: "medium" },
  // Inline secret assignments (likely accidental paste)
  { pattern: /\bpassword\s*[=:]\s*\S{6,}\b/i, id: "password_assignment", severity: "medium" },
  { pattern: /\bsecret\s*[=:]\s*\S{6,}\b/i, id: "secret_assignment", severity: "medium" },
  { pattern: /\btoken\s*[=:]\s*\S{10,}\b/i, id: "token_assignment", severity: "medium" },
];

const SECRET_BY_ID = new Map(SECRET_PATTERNS.map((p) => [p.id, p]));

function invisibleCodepointId(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  return `invisible_unicode_U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Return the list of matched threat/secret IDs in `content` at the given
 * scan mode. Includes `invisible_unicode_U+XXXX` entries for invisible
 * unicode found on the RAW (pre-NFKC) sliced content, plus secret IDs.
 *
 * @param content Text to scan.
 * @param scope Scan mode (default `"context"`).
 */
export function scanForThreats(content: string, scope: ThreatScope = "context"): string[] {
  if (!content) {
    return [];
  }

  const findings: string[] = [];

  // (1) Slice to the hard cap.
  const sliced = content.slice(0, MAX_SCAN_CHARS);

  // (2) Invisible unicode — detect on the RAW slice before NFKC, since
  // normalisation can strip some of these codepoints. Single pass building
  // the char set, mirroring the Python `set(content) & INVISIBLE_CHARS`.
  const charSet = new Set(sliced);
  for (const ch of INVISIBLE_CHARS) {
    if (charSet.has(ch)) {
      findings.push(invisibleCodepointId(ch));
    }
  }

  // (3) Normalise to NFKC so full-width / compatibility variants fold to
  // their ASCII counterparts before the regex engine sees them.
  const normalised = sliced.normalize("NFKC");

  // (4) Run the active mode's compiled patterns against the normalised text.
  for (const { re, id } of COMPILED[scope]) {
    if (re.test(normalised)) {
      findings.push(id);
    }
  }

  // (5) Secret patterns run in every mode, against the sliced (raw) content.
  for (const { pattern, id } of SECRET_PATTERNS) {
    if (pattern.test(sliced)) {
      findings.push(id);
    }
  }

  return findings;
}

/**
 * Return a human-readable block message for the first threat found, or
 * `null` if the content is clean.
 *
 * @param content Text to scan.
 * @param scope Scan mode (default `"strict"`).
 */
export function firstThreatMessage(content: string, scope: ThreatScope = "strict"): string | null {
  const findings = scanForThreats(content, scope);
  if (findings.length === 0) {
    return null;
  }

  const id = findings[0]!;

  if (id.startsWith("invisible_unicode_")) {
    const codepoint = id.replace("invisible_unicode_", "");
    return `Blocked: content contains invisible unicode character ${codepoint} (possible injection).`;
  }

  const secret = SECRET_BY_ID.get(id);
  if (secret) {
    return (
      `Blocked: content looks like a ${secret.severity}-severity credential or secret ('${id}'). ` +
      `Never persist API keys, tokens, or passwords to memory. ` +
      `Use an .env file or secrets manager instead.`
    );
  }

  return (
    `Blocked: content matches threat pattern '${id}'. ` +
    `Content is injected into the system prompt and must not contain ` +
    `injection or exfiltration payloads.`
  );
}
