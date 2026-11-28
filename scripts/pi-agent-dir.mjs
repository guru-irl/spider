import { homedir } from 'node:os';
import { join } from 'node:path';
// Fail early if pi cannot be resolved, without evaluating its SDK.
import.meta.resolve('@earendil-works/pi-coding-agent');

export async function piAgentDir() {
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (!dir) return join(homedir(), '.pi', 'agent');
  if (process.platform !== 'win32' && dir.startsWith('/')) return dir;
  const { getAgentDir } = await import('@earendil-works/pi-coding-agent');
  return getAgentDir();
}
