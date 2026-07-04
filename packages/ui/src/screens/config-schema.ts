export type ConfigFieldType = "boolean" | "number" | "string" | "enum";
export interface ConfigField {
	key: string; label: string; type: ConfigFieldType; default: unknown;
	enum?: string[]; min?: number; max?: number; description: string; restart?: boolean;
}
export interface ConfigGroup { id: string; label: string; fields: ConfigField[]; }

export const CONFIG_SCHEMA: ConfigGroup[] = [
	{ id: "organism", label: "Organism", fields: [
		{ key: "organism.enabled", label: "Master enable", type: "boolean", default: true, description: "Autonomic organism master toggle." },
		{ key: "organism.runToMemory", label: "run→memory", type: "boolean", default: true, description: "Digest run outputs into memory/todo." },
		{ key: "organism.todoToMemory", label: "todo→memory", type: "boolean", default: true, description: "Digest completed todos into memory." },
		{ key: "organism.learningLoop", label: "Learning loop", type: "boolean", default: true, description: "Failures/corrections learning pass." },
		{ key: "organism.selfName", label: "Self-name update", type: "boolean", default: true, description: "Session self-naming pass." },
		{ key: "organism.reflection", label: "Reflection", type: "boolean", default: true, description: "Vector-cluster umbrella memories." },
		{ key: "organism.crossProject", label: "Cross-project insights", type: "boolean", default: true, description: "Cross-project insight graph pass." },
	]},
	{ id: "embeddings", label: "Embeddings", fields: [
		{ key: "embeddings.provider", label: "Provider", type: "enum", default: "fastembed", enum: ["fastembed", "copilot", "openai", "mistral", "google", "fts-only"], description: "Embedding backend.", restart: true },
		{ key: "embeddings.model", label: "Model", type: "string", default: "BGE-small-en-v1.5", description: "Embedding model id (dim-locked).", restart: true },
		{ key: "embeddings.dim", label: "Dimensions", type: "number", default: 384, min: 8, max: 4096, description: "Vector dim (change → control reembed).", restart: true },
		{ key: "embeddings.queue", label: "Background queue", type: "boolean", default: true, description: "Async embed queue on/off." },
	]},
	{ id: "memory", label: "Memory", fields: [
		{ key: "memory.autoWriteBudget", label: "Auto-write budget", type: "number", default: 20, min: 0, max: 1000, description: "Per-session staged auto-write cap." },
		{ key: "memory.stagingFailClosed", label: "Staging fail-closed", type: "boolean", default: true, description: "Stage all auto/background writes." },
		{ key: "memory.snapshotCharCap", label: "Snapshot char cap", type: "number", default: 6000, min: 500, max: 40000, description: "Frozen snapshot character budget." },
	]},
	{ id: "routing", label: "Routing / safety", fields: [
		{ key: "routing.tracking", label: "Universal tracking", type: "boolean", default: true, description: "Log all tool intents/results." },
		{ key: "routing.secretScrub", label: "Secret scrub", type: "boolean", default: true, description: "Scrub secrets from results." },
		{ key: "routing.injectionScan", label: "Injection scan", type: "boolean", default: true, description: "Prompt-injection scan of results." },
		{ key: "routing.autoIndexThreshold", label: "Auto-index threshold (bytes)", type: "number", default: 4000, min: 0, max: 1000000, description: "Large-output auto-index cutoff." },
	]},
	{ id: "curator", label: "Skill curator", fields: [
		{ key: "curator.minIntervalHours", label: "Min interval (h)", type: "number", default: 24, min: 1, max: 336, description: "Minimum hours between curator runs." },
	]},
	{ id: "self_naming", label: "Self-naming", fields: [
		{ key: "self_naming.enabled", label: "Enabled", type: "boolean", default: true, description: "Session self-naming on/off." },
		{ key: "self_naming.budget", label: "Aux budget", type: "enum", default: "cheap", enum: ["cheap", "normal", "premium"], description: "Aux-model budget tier." },
	]},
	{ id: "models", label: "Model routing", fields: [
		{ key: "models.autoSelect", label: "Auto-select", type: "boolean", default: true, description: "Router picks per-task model." },
	]},
	{ id: "ui", label: "UI", fields: [
		{ key: "ui.footer", label: "Agents footer", type: "boolean", default: true, description: "Show the agents footer." },
		{ key: "ui.gridHotkey", label: "Grid hotkey", type: "string", default: "ctrl+g", description: "Live grid toggle chord." },
		{ key: "ui.theme", label: "Theme", type: "enum", default: "auto", enum: ["auto", "light", "dark"], description: "spider UI theme preference." },
	]},
];

export function getField(key: string): ConfigField | undefined {
	for (const g of CONFIG_SCHEMA) for (const f of g.fields) if (f.key === key) return f;
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
			const n = Number(raw);
			if (!Number.isFinite(n)) return { ok: false, error: "expected a number" };
			if (field.min !== undefined && n < field.min) return { ok: false, error: `min ${field.min}` };
			if (field.max !== undefined && n > field.max) return { ok: false, error: `max ${field.max}` };
			return { ok: true, value: n };
		}
		case "enum": {
			if (!field.enum?.includes(raw)) return { ok: false, error: `one of ${field.enum?.join("|")}` };
			return { ok: true, value: raw };
		}
		default:
			return { ok: true, value: raw };
	}
}
