import { delimiter, dirname, isAbsolute } from "node:path";

const systemPaths = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const absolute = (value: string): boolean => isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);

export function toolPath(value: string | undefined, node: string): string {
  // Ignore empty and relative entries: a relocated checkout is not a source
  // of executables. The node in the unit stays available to pi's shebang.
  return [...new Set([dirname(node), ...(value ?? "").split(delimiter), ...systemPaths].filter(absolute))].join(delimiter);
}

export function piLaunchArgv(pi: string, file: string, env: Readonly<NodeJS.ProcessEnv>): string[] {
  // `hc run` sends an empty env map. `env` execs pi in the same PID and
  // preserves the terminal context inserted by the core. Never serialize
  // the service's full environment, provider keys, leases, or handoffs.
  const values = ["PATH", "PI_CODING_AGENT_DIR", "SPIDER_GLOBAL_ROOT", "PI_SUBAGENT_CHILD"].map(name => {
    const value = env[name];
    if (!value) throw new Error(`Missing ${name} for v0 pi launch`);
    return `${name}=${value}`;
  });
  if (env.SSH_AUTH_SOCK && absolute(env.SSH_AUTH_SOCK)) values.push(`SSH_AUTH_SOCK=${env.SSH_AUTH_SOCK}`);
  return ["/usr/bin/env", ...values, pi, "--session", file];
}
