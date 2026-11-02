import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export function piAgentDir() {
  return process.env.PI_CODING_AGENT_DIR ? getAgentDir() : join(homedir(), '.pi', 'agent');
}
