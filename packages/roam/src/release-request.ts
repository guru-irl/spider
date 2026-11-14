import { createHash as releaseHash } from "node:crypto";

export const RELEASE_ENTRIES: readonly string[] = ["dist/extension.js", "dist/intercom/broker.mjs", "dist/roam/cli.mjs", "dist/roam/supervisor.mjs",
  "scripts/intercom-switchover.mjs", "scripts/extension-shim.mjs"];

export interface ReleaseArguments {
  operationId: string; machineId: string; home: string; globalRoot: string; npmPrefix: string; core: string; node: string;
  pi: string; cli: string; supervisor: string; sha256: string; piVersion: string;
}

/** The archive digest identifies bytes, independently of temporary chunk names. */
export function releaseRequestDigest(input: ReleaseArguments): string {
  const value = { version: 1, operationId: input.operationId, machineId: input.machineId, home: input.home, globalRoot: input.globalRoot,
    npmPrefix: input.npmPrefix, core: input.core, node: input.node, pi: input.pi, cli: input.cli, supervisor: input.supervisor,
    sha256: input.sha256, piVersion: input.piVersion };
  if (Object.values(value).some(item => typeof item !== "number" && (typeof item !== "string" || !item || /[\u0000-\u001f\u007f]/.test(item)))) {
    throw new Error("Invalid release arguments");
  }
  return releaseHash("sha256").update(JSON.stringify(value)).digest("hex");
}
