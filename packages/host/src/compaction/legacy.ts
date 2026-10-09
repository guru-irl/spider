import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

const LEGACY_NAMES = ['per-model-compaction.ts', 'per-model-compaction.js'];
export interface LegacyCompactionMatch {
  file: string;
  source: 'installed' | 'listed';
  missing: boolean;
}
export function legacyCompactionPath(values: Record<string, unknown>, agentDir: string = getAgentDir()): LegacyCompactionMatch | undefined {
  for (const name of [...LEGACY_NAMES, 'per-model-compaction/index.ts', 'per-model-compaction/index.js']) {
    const file = join(agentDir, 'extensions', name);
    if (existsSync(file)) return { file, source: 'installed', missing: false };
  }
  const extensions = values['subagents.extensions'];
  const file = Array.isArray(extensions) ? extensions.find((file): file is string =>
    typeof file === 'string' && LEGACY_NAMES.includes(basename(file)),
  ) : undefined;
  return file ? { file, source: 'listed', missing: !existsSync(file) } : undefined;
}
export function legacyCompactionWarning(match: LegacyCompactionMatch): string {
  return match.source === 'installed'
    ? `spider-compaction: inactive while legacy extension ${match.file} is installed in ${dirname(match.file)}; remove it, then restart or /reload`
    : `spider-compaction: inactive while legacy extension ${match.file} is listed in subagents.extensions${match.missing ? ' (missing file)' : ''}; remove that subagents.extensions entry, then restart or /reload`;
}
