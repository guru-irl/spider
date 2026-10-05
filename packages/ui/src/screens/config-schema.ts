import { isAbsolutePathList } from "./absolute-paths.js";

export type ConfigFieldType = "boolean" | "number" | "string" | "enum" | "model-map" | "absolute-path-list";
export interface ConfigField {
	key: string; label: string; type: ConfigFieldType; default: unknown;
	enum?: readonly string[]; min?: number; max?: number; description: string; restart?: boolean;
}
export interface ConfigGroup { id: string; label: string; fields: ConfigField[]; }

export const CONFIG_SCHEMA: ConfigGroup[] = [
	{ id: "auxiliary", label: "Auxiliary model", fields: [
		{ key: "auxiliary.background_review.provider", label: "Provider", type: "string", default: "", description: "Optional background review provider override; default github-copilot." },
		{ key: "auxiliary.background_review.model", label: "Model", type: "string", default: "", description: "Optional model override; default github-copilot/gpt-6-luna with low thinking, never the session model." },
	]},
	{ id: "organism", label: "Organism", fields: [
		{ key: "organism.enabled", label: "Master enable", type: "boolean", default: true, description: "Enable organism background work in parent sessions only; always disabled in subagents." },
		...(["runMemoryTodo", "todoMemory", "learning", "consolidation", "reflection", "insights"] as const).map(name => ({ key: `organism.passes.${name}`, label: name, type: "boolean" as const, default: true, description: `Enable ${name} pass.` })),
		{ key: "organism.selfNaming", label: "Self naming", type: "boolean", default: true, description: "Allow organism to name projects." },
		{ key: "organism.autoWriteBudget", label: "Auto-write budget", type: "number", default: 20, min: 0, max: 1000, description: "Maximum staged writes per drain." },
		{ key: "organism.maxSkillProposals", label: "Skill proposals per drain", type: "number", default: 1, min: 0, max: 1000, description: "Maximum deterministic-valid skill proposals before model review in a drain." },
		{ key: "organism.maxMemoryProposals", label: "Memory proposals per pass", type: "number", default: 3, min: 0, max: 1000, description: "Maximum supported memory candidates from each memory-producing pass." },
	]},
	{ id: "curator", label: "Skill curator", fields: [
		{ key: "curator.staleAfterDays", label: "Stale after (days)", type: "number", default: 30, min: 0, description: "Age at which skills become stale." },
		{ key: "curator.archiveAfterDays", label: "Archive after (days)", type: "number", default: 90, min: 0, description: "Age at which skills are archived." },
		{ key: "curator.minIntervalHours", label: "Min interval (h)", type: "number", default: 24, min: 1, max: 336, description: "Minimum hours between curator runs." },
		{ key: "curator.consolidate", label: "Consolidate", type: "boolean", default: false, description: "Consolidate skill candidates." },
	]},
	{ id: "memory", label: "Memory", fields: [
		{ key: "memory.snapshotCharCap", label: "Snapshot char cap", type: "number", default: "unlimited", min: 500, max: 40000, description: "Optional explicit snapshot body limit. By default inject all active memory; a lower cap may omit entries and reports their count." },
		{ key: "memory.reviewer.enabled", label: "Review remembers", type: "boolean", default: true, description: "Review foreground memory proposals before saving. Failures store as requested." },
		{ key: "memory.reviewer.model", label: "Reviewer model", type: "string", default: "github-copilot/gpt-6-luna", description: "Authenticated provider/model for the foreground memory reviewer." },
		{ key: "memory.reviewer.thinking", label: "Reviewer thinking", type: "enum", default: "medium", enum: [], description: "Reasoning level for this reviewer, independent of learner and session thinking." },
		{ key: "memory.reviewer.timeoutMs", label: "Reviewer timeout (ms)", type: "number", default: 45000, min: 1000, max: 120000, description: "Maximum wait before the proposed memory is stored as requested." },
	]},
	{ id: "embeddings", label: "Embeddings", fields: [
		{ key: "embeddings.drain", label: "Background drain", type: "boolean", default: true, description: "Drain repo and content embeddings in parent sessions using an off-thread model worker." },
	] },
	{ id: "skills", label: "Skill reviewer", fields: [
		{ key: "skills.reviewer.enabled", label: "Review skill proposals", type: "boolean", default: true, description: "Gate skill proposals. When disabled, learner skill proposals are off; agent requests stage with review skipped." },
		{ key: "skills.reviewer.model", label: "Reviewer model", type: "string", default: "github-copilot/gpt-6-luna", description: "Authenticated provider/model for skill review." },
		{ key: "skills.reviewer.thinking", label: "Reviewer thinking", type: "enum", default: "xhigh", enum: [], description: "Reasoning level for this reviewer, independent of learner and session thinking." },
		{ key: "skills.reviewer.timeoutMs", label: "Reviewer timeout (ms)", type: "number", default: 180000, min: 1000, max: 600000, description: "Maximum skill review wait. Deterministic failures always reject." },
	]},
	{ id: "routing", label: "Routing / safety", fields: [
		{ key: "routing.tracking", label: "Universal tracking", type: "boolean", default: true, description: "Log all tool intents/results." },
		{ key: "routing.secret_scrub", label: "Secret scrub", type: "boolean", default: true, description: "Scrub secrets from tool results." },
		{ key: "routing.injection_scan", label: "Injection scan", type: "boolean", default: true, description: "Scan tool results for prompt injection." },
		{ key: "routing.auto_index_threshold", label: "Auto-index threshold (bytes)", type: "number", default: 10000, min: 0, max: 1000000, description: "Large-output auto-index cutoff." },
	]},
	{ id: "models", label: "Model routing", fields: [
		{ key: "models.defaults", label: "Role defaults", type: "model-map", default: {}, description: "Explicit agent-role overrides; shipped defaults resolve from the catalog." },
	]},
	{ id: "subagents", label: "Subagents", fields: [
		{ key: "subagents.keepCacheWarm", label: "Keep parent cache warm", type: "boolean", default: true, description: "Override pi's cache-warming decision while this parent session has starting or running subagents. Applies at the next decision." },
		{ key: "subagents.extensions", label: "Child extensions", type: "absolute-path-list", default: [], description: "Global-only JSON array of fully absolute extension file paths. Only the user can edit it in the global config file. Missing files are skipped with a run warning." },
		{ key: "subagents.childMode", label: "Child mode", type: "enum", enum: ["rpc", "print"], default: "rpc", description: "RPC permits steering. Print retains legacy one-shot behavior. Applies to new runs." },
	]},
	{ id: "exec", label: "Exec enforcement", fields: [
		{ key: "exec.enforce", label: "Enforce spider exec", type: "boolean", default: true, description: "Block bash tool; model must use spider exec." },
	]},
	{ id: "ui", label: "UI", fields: [
		{ key: "ui.footer", label: "Agents footer", type: "boolean", default: true, description: "Show the agents footer from the next session.", restart: true },
	]},
];

/** Fill the reviewer enums from the host's single shared policy. No runtime
 * database or model dependencies belong in this data-only UI schema. */
export function createConfigSchema(thinkingLevels: readonly string[]): ConfigGroup[] {
  return CONFIG_SCHEMA.map(group => ({ ...group, fields: group.fields.map(field =>
    field.key.endsWith(".reviewer.thinking") ? { ...field, enum: thinkingLevels } : field) }));
}

export function getField(key: string, schema: ConfigGroup[] = CONFIG_SCHEMA): ConfigField | undefined {
	for (const g of schema) for (const f of g.fields) if (f.key === key) return f;
	return undefined;
}

export function coerce(field: ConfigField, raw: string): { ok: boolean; value?: unknown; error?: string } {
	switch (field.type) {
		case "boolean": {
			if (raw === "true") return { ok: true, value: true };
			if (raw === "false") return { ok: true, value: false };
			return { ok: false, error: "expected true|false" };
		}
		case "number": {
			if (field.key === "memory.snapshotCharCap" && (raw.trim() === "" || raw.trim().toLowerCase() === "unlimited"))
				return { ok: true, value: undefined };
			const n = Number(raw);
			if (!Number.isFinite(n)) return { ok: false, error: "expected a number" };
			if (field.min !== undefined && n < field.min) return { ok: false, error: `min ${field.min}` };
			if (field.max !== undefined && n > field.max) return { ok: false, error: `max ${field.max}` };
			return { ok: true, value: n };
		}
		case "absolute-path-list": {
			try {
				const value: unknown = JSON.parse(raw);
				if (isAbsolutePathList(value)) return { ok: true, value };
			} catch { /* invalid JSON */ }
			return { ok: false, error: "expected a JSON array of absolute file paths" };
		}
		case "model-map": {
			try {
				const value: unknown = JSON.parse(raw);
				if (value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(v => typeof v === "string")) return { ok: true, value };
			} catch { /* invalid JSON */ }
			return { ok: false, error: "expected a JSON object of role-to-model strings" };
		}
		case "enum": {
			if (!field.enum?.length) return { ok: false, error: "host must inject supported enum levels before editing this field" };
			if (!field.enum.includes(raw)) return { ok: false, error: `one of ${field.enum?.join("|")}` };
			return { ok: true, value: raw };
		}
		default:
			return { ok: true, value: raw };
	}
}
