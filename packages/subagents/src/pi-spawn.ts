import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";

export function findPiPackageRootFromEntry(entryPoint: string): string | undefined {
	let dir = path.dirname(entryPoint);
	while (true) {
		const packageJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
			return pkg.name === PI_CODING_AGENT_PACKAGE ? dir : undefined;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function resolvePiPackageRoot(): string | undefined {
	try {
		return process.argv[1] ? findPiPackageRootFromEntry(fs.realpathSync(process.argv[1])) : undefined;
	} catch {
		return undefined;
	}
}

export interface PiSpawnDeps {
	execPath?: string;
	argv1?: string;
	env?: NodeJS.ProcessEnv;
	isSea?: () => boolean;
}

interface PiSpawnCommand {
	command: string;
	args: string[];
	piEntry?: string;
}

export function resolvePiCliScript(deps: PiSpawnDeps = {}): string | undefined {
	try {
		const entry = deps.argv1 ?? process.argv[1];
		if (!entry) return undefined;
		const realEntry = fs.realpathSync(entry);
		return findPiPackageRootFromEntry(realEntry) ? realEntry : undefined;
	} catch {
		return undefined;
	}
}

export const resolveWindowsPiCliScript: typeof resolvePiCliScript = resolvePiCliScript;

function isNodeSea(): boolean {
	try {
		const sea = createRequire(import.meta.url)("node:sea") as { isSea?: () => boolean };
		return sea.isSea?.() ?? false;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ERR_UNKNOWN_BUILTIN_MODULE" && code !== "MODULE_NOT_FOUND";
	}
}

export function getPiSpawnCommand(args: string[], deps: PiSpawnDeps = {}): PiSpawnCommand {
	const env = deps.env ?? process.env;
	const piBinary = env[PI_SUBAGENT_PI_BINARY_ENV]?.trim();
	if (piBinary) return { command: piBinary, args };

	if (process.release.name === "node" && !process.versions.bun && !process.versions.electron && !(deps.isSea ?? isNodeSea)()) {
		const piEntry = resolvePiCliScript(deps);
		if (piEntry) return { command: deps.execPath ?? process.execPath, args: [piEntry, ...args], piEntry };
	}
	return { command: "pi", args };
}
