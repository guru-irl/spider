import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMcpDirectToolNames } from "./mcp-direct-tool-allowlist";
import { getPiSpawnCommand } from "./pi-spawn";

// Vendored locally from pi-subagents' structured-output module: these are just
// the two env-name constants (the full structured-output runtime is not ported).
export const STRUCTURED_OUTPUT_SCHEMA_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA";
export const STRUCTURED_OUTPUT_CAPTURE_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE";

// Inlined from pi-subagents' shared/types (only this alias was used here).
type JsonSchemaObject = Record<string, unknown>;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const TASK_ARG_LIMIT = 8000;
// The spider subagent CHILD loads the spider extension bundle itself; in child mode
// (PI_SUBAGENT_CHILD=1) it self-attaches the run-event reporter (see subagents/index.ts).
// When bundled, every module collapses into dist/extension.js, so import.meta.url here IS
// the extension entry. (The upstream subagent-prompt-runtime.ts / fanout-child.ts helper
// extensions were never ported into spider — referencing them made every child fail to start.)

export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SUBAGENT_ORCHESTRATOR_TARGET_ENV = "PI_SUBAGENT_ORCHESTRATOR_TARGET";
export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
export const SUBAGENT_CHILD_INDEX_ENV = "PI_SUBAGENT_CHILD_INDEX";
export const SUBAGENT_FANOUT_CHILD_ENV = "PI_SUBAGENT_FANOUT_CHILD";
export const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";

/** Path to the spider run database, threaded to every child process. */
export const SPIDER_DB_PATH_ENV = "PI_SPIDER_DB_PATH";
// The owning spider session id. Passed to the child so its run_events are tagged with
// the PARENT session (headless children can't resolve getSessionName() and would
// otherwise fall back to the runId, which the UI's per-session bus filter drops).
export const SPIDER_SESSION_ID_ENV = "PI_SPIDER_SESSION_ID";

interface BuildPiArgsInput {
	baseArgs: string[];
	task: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	sessionFile?: string;
	/** Session id/path to fork the child from (pi `--fork <path|id>`). */
	forkFromSessionId?: string;
	model?: string;
	thinking?: string;
	systemPromptMode?: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	requireReadTool?: boolean;
	tools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	systemPrompt?: string | null;
	mcpDirectTools?: string[];
	cwd?: string;
	promptFileStem?: string;
	intercomSessionName?: string;
	orchestratorIntercomTarget?: string;
	runId?: string;
	childAgentName?: string;
	childIndex?: number;
	/** Scratch root for task/prompt overflow temp files (never the system temp dir). */
	scratchRoot?: string;
	/** Absolute path to the shared spider run database. */
	dbPath?: string;
	structuredOutput?: {
		schema: JsonSchemaObject;
		schemaPath: string;
		outputPath: string;
	};
}

interface BuildPiArgsResult {
	args: string[];
	env: Record<string, string | undefined>;
	tempDir?: string;
}

export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined, replaceExisting = false): string | undefined {
	if (!model || !thinking) return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) {
		return replaceExisting ? `${model.slice(0, colonIdx)}:${thinking}` : model;
	}
	return `${model}:${thinking}`;
}

/** Extract a thinking-level suffix from a model id (e.g. "prov/model:high" → "high"), or undefined.
 *  Only recognises whitelisted levels so a stray colon in a base id is never mistaken for one. */
export function thinkingFromModel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) return model.substring(colonIdx + 1);
	return undefined;
}

/** Return the base model id with any thinking-level suffix removed. */
export function stripThinkingSuffix(model: string | undefined): string | undefined {
	if (!model) return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) return model.slice(0, colonIdx);
	return model;
}

function mkdtempInScratch(scratchRoot: string | undefined): string {
	if (!scratchRoot) {
		throw new Error("buildPiArgs requires scratchRoot to spill oversized task/prompt args (the system temp dir is not permitted).");
	}
	fs.mkdirSync(scratchRoot, { recursive: true });
	return fs.mkdtempSync(path.join(scratchRoot, "subagent-tasks-"));
}

export function buildPiArgs(input: BuildPiArgsInput): BuildPiArgsResult {
	const args = [...input.baseArgs];

	if (input.forkFromSessionId) {
		args.push("--fork", input.forkFromSessionId);
	}

	if (input.sessionFile) {
		fs.mkdirSync(path.dirname(input.sessionFile), { recursive: true });
		args.push("--session", input.sessionFile);
	} else {
		if (!input.sessionEnabled) {
			args.push("--no-session");
		}
		if (input.sessionDir) {
			fs.mkdirSync(input.sessionDir, { recursive: true });
			args.push("--session-dir", input.sessionDir);
		}
	}

	const modelArg = applyThinkingSuffix(input.model, input.thinking);
	if (modelArg) {
		args.push("--model", modelArg);
	}

	const declaredBuiltinToolsBase = input.tools?.filter((tool) => !(tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js"))) ?? [];
	const declaredBuiltinTools = input.requireReadTool && input.tools?.length && !declaredBuiltinToolsBase.includes("read")
		? ["read", ...declaredBuiltinToolsBase]
		: declaredBuiltinToolsBase;
	const fanoutAuthorized = declaredBuiltinTools.includes("subagent");
	const toolExtensionPaths: string[] = [];
	if (input.tools?.length) {
		const builtinTools = [...declaredBuiltinTools];
		for (const tool of input.tools) {
			if (!declaredBuiltinTools.includes(tool) && (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js"))) {
				toolExtensionPaths.push(tool);
			}
		}
		if (builtinTools.length > 0) {
			if (input.mcpDirectTools?.length) {
				builtinTools.push(...resolveMcpDirectToolNames(input.mcpDirectTools, input.cwd));
			}
			args.push("--tools", builtinTools.join(","));
		}
	}

	// Spider children do not load the upstream helper extensions (not ported); the child
	// extension (the spider bundle) is supplied via input.extensions by buildChildSpawnSpec.
	const runtimeExtensions: string[] = [];
	if (input.extensions !== undefined) {
		args.push("--no-extensions");
		for (const extPath of [...new Set([...runtimeExtensions, ...toolExtensionPaths, ...input.extensions, ...(input.subagentOnlyExtensions ?? [])])]) {
			args.push("--extension", extPath);
		}
	} else {
		for (const extPath of [...new Set([...runtimeExtensions, ...toolExtensionPaths, ...(input.subagentOnlyExtensions ?? [])])]) {
			args.push("--extension", extPath);
		}
	}

	if (!input.inheritSkills) {
		args.push("--no-skills");
	}

	let tempDir: string | undefined;
	if (input.systemPrompt !== undefined && input.systemPrompt !== null) {
		tempDir = mkdtempInScratch(input.scratchRoot);
		const stem = (input.promptFileStem ?? "prompt").replace(/[^\w.-]/g, "_");
		const promptPath = path.join(tempDir, `${stem}.md`);
		fs.writeFileSync(promptPath, input.systemPrompt, { mode: 0o600 });
		args.push(input.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", promptPath);
	}

	if (input.task.length > TASK_ARG_LIMIT) {
		if (!tempDir) {
			tempDir = mkdtempInScratch(input.scratchRoot);
		}
		const taskFilePath = path.join(tempDir, "task.md");
		fs.writeFileSync(taskFilePath, `Task: ${input.task}`, { mode: 0o600 });
		args.push(`@${taskFilePath}`);
	} else {
		args.push(`Task: ${input.task}`);
	}

	const env: Record<string, string | undefined> = {};
	env[SUBAGENT_CHILD_ENV] = "1";
	env[SUBAGENT_FANOUT_CHILD_ENV] = fanoutAuthorized ? "1" : "0";
	env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = input.inheritProjectContext ? "1" : "0";
	env.PI_SUBAGENT_INHERIT_SKILLS = input.inheritSkills ? "1" : "0";
	if (input.intercomSessionName) {
		env[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = input.intercomSessionName;
	}
	if (input.orchestratorIntercomTarget) {
		env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = input.orchestratorIntercomTarget;
	}
	if (input.runId) {
		env[SUBAGENT_RUN_ID_ENV] = input.runId;
	}
	if (input.childAgentName) {
		env[SUBAGENT_CHILD_AGENT_ENV] = input.childAgentName;
	}
	if (input.childIndex !== undefined) {
		env[SUBAGENT_CHILD_INDEX_ENV] = String(input.childIndex);
	}
	if (input.dbPath) {
		env[SPIDER_DB_PATH_ENV] = input.dbPath;
	}
	if (input.mcpDirectTools?.length) {
		env.MCP_DIRECT_TOOLS = input.mcpDirectTools.join(",");
	} else {
		env.MCP_DIRECT_TOOLS = "__none__";
	}
	if (input.structuredOutput) {
		env[STRUCTURED_OUTPUT_CAPTURE_ENV] = input.structuredOutput.outputPath;
		env[STRUCTURED_OUTPUT_SCHEMA_ENV] = input.structuredOutput.schemaPath;
	}

	return { args, env, tempDir };
}

export interface ChildSpawnSpec {
	argv: string[];
	env: Record<string, string>;
	cwd: string;
	sessionFile: string;
}

export interface BuildChildSpawnSpecInput {
	runId: string;
	sessionId: string;
	agent: string;
	role?: string;
	task: string;
	model?: string;
	thinking?: string;
	context: "fresh" | "fork";
	parentSessionId: string;
	childIndex: number;
	skill?: string;
	dbPath: string;
	scratchRoot: string;
	orchestratorTarget?: string;
	intercomSessionName?: string;
	/** Extension the child loads (the spider bundle). Defaults to this module's own
	 * bundled entry (dist/extension.js). Injectable for tests. */
	childExtensionPath?: string;
}

/**
 * Build the full argv/env/cwd/sessionFile needed to spawn a spider subagent
 * child process. Pure arg-building over getPiSpawnCommand + buildPiArgs; the
 * only filesystem side effect is a best-effort mkdir of the session directory
 * under the spider scratch root (never the system temp dir).
 */
export function buildChildSpawnSpec(input: BuildChildSpawnSpecInput): ChildSpawnSpec {
	const cwd = process.cwd();
	const sessionFile = path.join(input.scratchRoot, "subagent-sessions", input.runId, `${input.runId}.jsonl`);
	try {
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	} catch {
		// Session dir creation is best-effort here; the launcher re-creates it at spawn time.
	}

	const isFork = input.context === "fork";
	// The child loads ONLY the spider bundle (child-mode → run-event reporter); disable
	// pi's extension auto-discovery so nothing else is pulled in.
	const spiderExtension = input.childExtensionPath ?? fileURLToPath(import.meta.url);
	// --session is threaded through baseArgs (not the sessionFile input) so
	// buildPiArgs does not hard-mkdir the session dir; buildChildSpawnSpec owns
	// that best-effort mkdir above.
	const { args, env: builtEnv } = buildPiArgs({
		baseArgs: ["--mode", "json", "-p", "--session", sessionFile],
		task: input.task,
		sessionEnabled: true,
		forkFromSessionId: isFork ? input.parentSessionId : undefined,
		model: input.model,
		thinking: input.thinking,
		inheritProjectContext: true,
		inheritSkills: true,
		runId: input.runId,
		childAgentName: input.agent,
		childIndex: input.childIndex,
		scratchRoot: input.scratchRoot,
		dbPath: input.dbPath,
		extensions: [spiderExtension],
		intercomSessionName: input.intercomSessionName,
		orchestratorIntercomTarget: input.orchestratorTarget,
	});

	const { command, args: spawnArgs } = getPiSpawnCommand(args);
	const argv = [command, ...spawnArgs];

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(builtEnv)) {
		if (value !== undefined) env[key] = value;
	}
	env[SUBAGENT_CHILD_ENV] = "1";
	env[SPIDER_DB_PATH_ENV] = input.dbPath;
	env[SPIDER_SESSION_ID_ENV] = input.sessionId;
	env[SUBAGENT_RUN_ID_ENV] = input.runId;
	env[SUBAGENT_CHILD_AGENT_ENV] = input.agent;
	env[SUBAGENT_CHILD_INDEX_ENV] = String(input.childIndex);
	if (input.orchestratorTarget) {
		env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = input.orchestratorTarget;
	}
	if (input.intercomSessionName) {
		env[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = input.intercomSessionName;
	}

	return { argv, env, cwd, sessionFile };
}
