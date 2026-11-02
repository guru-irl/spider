// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { isAbsolute } from 'node:path';
import type { TerminalIdentity, SessionId } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { refuseExplicitExtensions, type TerminalRegistry, type LaunchEnvironment } from './registry.js';
import { recordedSessionLiveness, type ProcessInventoryPorts } from './lease.js';
import { readSessionHeader } from './launcher.js';
export interface ResumeHookOptions { nodePath: string; cliPath: string; configPath: string; hookPath: string; existingRc?: string }
export interface ResumePorts { registry: TerminalRegistry; processInventory: ProcessInventoryPorts; coreStartedAt(identity: TerminalIdentity): Promise<number> }
export interface ResumeOffer { terminal: TerminalIdentity; sessionFile: string; sessionId: SessionId; cwd: string; name: string | null; argv: readonly string[]; environment: LaunchEnvironment }
export function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
const START = '# spider:resume:start'; const END = '# spider:resume:end';
export function buildResumeBlock(options: ResumeHookOptions): string {
  if (![options.nodePath, options.cliPath, options.configPath, options.hookPath].every(isAbsolute)) throw new HerdrError('resume-hook-invalid', 'Resume hook requires absolute installed paths');
  const block = `${START}\nif [ -r ${shellQuote(options.hookPath)} ] && [ -x ${shellQuote(options.nodePath)} ] && [ -r ${shellQuote(options.cliPath)} ]; then\n  . ${[options.hookPath, options.nodePath, options.cliPath, options.configPath].map(shellQuote).join(' ')}\nfi\n${END}\n`;
  const existing = options.existingRc ?? ''; const starts = existing.split(START).length - 1; const ends = existing.split(END).length - 1;
  if (starts > 1 || starts !== ends || starts === 1 && existing.indexOf(END) < existing.indexOf(START)) throw new HerdrError('resume-hook-conflict', 'Resume block markers are ambiguous');
  if (!starts) return existing + (existing && !existing.endsWith('\n') ? '\n' : '') + block;
  const before = existing.slice(0, existing.indexOf(START)); const after = existing.slice(existing.indexOf(END) + END.length).replace(/^\n/, ''); return before + block + after;
}
export function resumeOfferShell(offer: ResumeOffer, options: ResumeHookOptions): string {
  const argv = [options.nodePath, options.cliPath, 'resume', '--config', options.configPath, '--file', offer.sessionFile, '--session-id', offer.sessionId, '--cwd', offer.cwd];
  const name = (offer.name ?? offer.sessionId).replace(/[\x00-\x1f\x7f]/g, ' ');
  return `printf '%s\\n' ${shellQuote(`Resume ${name}: run spider_resume (or keep this shell).`)}\nspider_resume() {\n  (cd -- ${shellQuote(offer.cwd)} && command ${argv.map(shellQuote).join(' ')})\n}\n`;
}
export async function offerResume(identity: TerminalIdentity, ports: ResumePorts): Promise<ResumeOffer | null> {
  const mapping = await ports.registry.get(identity); if (!mapping || mapping.owner.sessionFile === null) return null;
  refuseExplicitExtensions(mapping.owner.name ?? mapping.owner.sessionId, mapping.environment.extensionArguments);
  const restartedAt = await ports.coreStartedAt(identity);
  if (!Number.isFinite(restartedAt) || restartedAt <= mapping.recordedAt || restartedAt <= mapping.coreStartedAt) return null;
  if ((await recordedSessionLiveness(mapping.owner.sessionFile, ports.processInventory, mapping.owner.sessionId)).kind !== 'free') return null;
  let header; try { header = await readSessionHeader(mapping.owner.sessionFile); } catch { return null; }
  if (header.id !== mapping.owner.sessionId) return null;
  return { terminal: identity, sessionFile: mapping.owner.sessionFile, sessionId: header.id, cwd: mapping.owner.cwd, name: mapping.owner.name, argv: ['pi', '--session', mapping.owner.sessionFile], environment: mapping.environment };
}
