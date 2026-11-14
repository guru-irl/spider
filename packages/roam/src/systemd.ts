import { posix } from "node:path";

function path(value: string): string {
  if (typeof value !== "string" || !posix.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("An absolute service path is required");
  }
  return value;
}

function quote(value: string, executable: boolean): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  return `"${executable ? escaped.replace(/\$/g, "$$$$") : escaped}"`;
}

/** Render the supervisor only. Installation and service calls belong to injected ports. */
export function renderSupervisorUnit(input: { node: string; supervisor: string; coreUnit: string; globalRoot: string; agentDir?: string; pi?: string }): string {
  const node = path(input.node), supervisor = path(input.supervisor), root = path(input.globalRoot);
  const pi = input.pi === undefined ? null : path(input.pi);
  const agentDir = input.agentDir === undefined ? null : path(input.agentDir);
  if (typeof input.coreUnit !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.service$/.test(input.coreUnit)) {
    throw new Error("An existing core service unit is required");
  }
  return `[Unit]
Description=Spider roaming supervisor
After=${input.coreUnit}
Requires=${input.coreUnit}
PartOf=${input.coreUnit}

[Service]
Type=simple
ExecStart=${quote(node, true)} ${quote(supervisor, true)}
Environment=${quote(`SPIDER_GLOBAL_ROOT=${root}`, false)}
${pi === null ? "" : `Environment=${quote(`SPIDER_ROAM_PI=${pi}`, false)}\n`}${agentDir === null ? "" : `Environment=${quote(`PI_CODING_AGENT_DIR=${agentDir}`, false)}\n`}Restart=on-failure
UMask=0077

[Install]
WantedBy=default.target
`;
}
