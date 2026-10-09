import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

const LEGACY_NAMES = ['per-model-compaction.ts', 'per-model-compaction.js'];
export function legacyCompactionPath(values: Record<string, unknown>, agentDir: string = getAgentDir()): string | undefined {
  for (const name of LEGACY_NAMES) {
    const file = join(agentDir, 'extensions', name);
    if (existsSync(file)) return file;
  }
  const extensions = values['subagents.extensions'];
  return Array.isArray(extensions) ? extensions.find((file): file is string =>
    typeof file === 'string' && LEGACY_NAMES.includes(basename(file)),
  ) : undefined;
}
export function legacyCompactionWarning(file: string): string {
  return `spider-compaction: inactive while legacy extension ${file} is present; remove it and the subagents.extensions entry, then restart`;
}
