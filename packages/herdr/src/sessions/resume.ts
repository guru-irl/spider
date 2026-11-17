// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { constants } from 'node:fs';
import { open, readdir, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { TerminalIdentity, SessionId } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { terminalIdentityKey, privateDirectory, refuseExplicitExtensions, withProcessLock, type TerminalRegistry, type LaunchEnvironment } from './registry.js';
import { recordedSessionLiveness, type ProcessInventoryPorts } from './lease.js';
import { readSessionHeader } from './launcher.js';
export interface ResumeHookOptions { nodePath: string; cliPath: string; configPath: string; hookPath: string; existingRc?: string }
export interface ResumePorts { registry: TerminalRegistry; processInventory: ProcessInventoryPorts; coreStartedAt(identity: TerminalIdentity): Promise<number>; autoResumeRoot?: string }
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
export function resumeWatchShell(root: string, identity: TerminalIdentity): string {
  const directory = shellQuote(join(root, 'resume-starts', terminalIdentityKey(identity)));
  return `_spider_resume_seen=:
_spider_resume_snapshot() {
  if [ -n "\${ZSH_VERSION:-}" ]; then setopt localoptions nonomatch; fi
  local _spider_live _spider_name _spider_token
  for _spider_live in ${directory}/live-*; do
    [ -f "$_spider_live" ] || continue
    _spider_name="\${_spider_live##*/live-}"
    _spider_token="\${_spider_name%-*}"
    _spider_resume_seen="\${_spider_resume_seen}\${_spider_token}:"
  done
}
_spider_resume_watch() {
  if [ -n "\${ZSH_VERSION:-}" ]; then setopt localoptions nonomatch; fi
  local _spider_live _spider_name _spider_token _spider_pid
  for _spider_live in ${directory}/live-*; do
    [ -f "$_spider_live" ] || continue
    _spider_name="\${_spider_live##*/live-}"
    _spider_token="\${_spider_name%-*}"
    _spider_pid="\${_spider_name##*-}"
    case "$_spider_resume_seen" in *:"$_spider_token":*) continue ;; esac
    case "$_spider_pid" in ''|*[!0-9]*|0) continue ;; esac
    if builtin kill -0 "$_spider_pid" 2>/dev/null; then continue; fi
    if command mv -f "$_spider_live" "\${_spider_live%/*}/ended-$_spider_token" 2>/dev/null; then
      _spider_resume_seen="\${_spider_resume_seen}\${_spider_token}:"
    fi
  done
}
_spider_resume_snapshot
if [ -n "\${ZSH_VERSION:-}" ]; then
  precmd_functions+=(_spider_resume_watch)
else
  case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in
    'declare -a '*) PROMPT_COMMAND+=( _spider_resume_watch ) ;;
    *) PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND; }_spider_resume_watch" ;;
  esac
fi
`;
}
export function resumeOfferShell(offer: ResumeOffer, options: ResumeHookOptions, mode: 'offer' | 'auto' = 'offer'): string {
  const argv = [options.nodePath, options.cliPath, 'resume', '--config', options.configPath, '--file', offer.sessionFile, '--session-id', offer.sessionId, '--cwd', offer.cwd];
  const name = (offer.name ?? offer.sessionId).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
  const message = mode === 'auto' ? `Resuming ${name}…` : `Resume ${name}: run spider_resume (or keep this shell).`;
  const functionDefinition = `spider_resume() {\n  (cd -- ${shellQuote(offer.cwd)} && command ${argv.map(shellQuote).join(' ')})\n}\n`;
  if (mode === 'offer') return `printf '%s\\n' ${shellQuote(message)}\n${functionDefinition}`;
  return `${functionDefinition}_spider_auto_resume() {
  if [ -n "\${ZSH_VERSION:-}" ]; then
    precmd_functions=("\${(@)precmd_functions:#_spider_auto_resume}")
    unfunction _spider_auto_resume
  else
    case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in
      'declare -a '*)
        local _spider_command
        local -a _spider_remaining=()
        for _spider_command in "\${PROMPT_COMMAND[@]}"; do
          [ "$_spider_command" = _spider_auto_resume ] || _spider_remaining+=("$_spider_command")
        done
        PROMPT_COMMAND=("\${_spider_remaining[@]}") ;;
      *) PROMPT_COMMAND="\${PROMPT_COMMAND%_spider_auto_resume}"; PROMPT_COMMAND="\${PROMPT_COMMAND%; }" ;;
    esac
    unset -f _spider_auto_resume
  fi
  printf '%s\\n' ${shellQuote(message)}
  spider_resume || :
  if command -v _spider_resume_watch >/dev/null 2>&1; then _spider_resume_watch; fi
}
if [ -n "\${ZSH_VERSION:-}" ]; then
  precmd_functions+=(_spider_auto_resume)
else
  case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in
    'declare -a '*) PROMPT_COMMAND+=( _spider_auto_resume ) ;;
    *) PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND; }_spider_auto_resume" ;;
  esac
fi
`;
}
async function claimAutomaticResume(root: string, identity: TerminalIdentity, startedAt: number, current: () => Promise<boolean>, eligible: () => Promise<ResumeOffer | null>): Promise<ResumeOffer | null> {
  const key = terminalIdentityKey(identity);
  const directory = join(root, 'resume-starts', key);
  return withProcessLock(root, `resume-start:${key}`, async () => {
    if (!await current()) return null;
    await privateDirectory(directory);
    const syncDirectory = async (path: string) => {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    };
    await syncDirectory(root);
    await syncDirectory(join(root, 'resume-starts'));
    const names = await readdir(directory);
    const epoch = (name: string): number | null => {
      const match = /^(?:seen-)?(\d+(?:\.\d+)?)$/.exec(name);
      return match ? Number(match[1]) : null;
    };
    if (names.some(name => { const time = epoch(name); return time !== null && time > startedAt; })) return null;
    const createMarker = async (name: string): Promise<boolean> => {
      try {
        const marker = await open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await marker.sync(); } finally { await marker.close(); }
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    };
    // Persist the newer proof before removing any older claim.
    await createMarker(`seen-${startedAt}`);
    await syncDirectory(directory);
    for (const name of names) {
      const time = epoch(name);
      if (time !== null && time < startedAt) await unlink(join(directory, name)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
    await syncDirectory(directory);
    if (names.includes(String(startedAt))) return null;
    const offer = await eligible();
    if (!offer || !await createMarker(String(startedAt))) return null;
    await syncDirectory(directory);
    return offer;
  }, { reclaimReusedOwner: true });
}
export async function offerResume(identity: TerminalIdentity, ports: ResumePorts): Promise<ResumeOffer | null> {
  const mapping = await ports.registry.get(identity); if (!mapping || mapping.owner.sessionFile === null) return null;
  const ended = () => mapping.activityId ? ports.registry.ended(identity, mapping.activityId) : Promise.resolve(false);
  if (await ended()) return null;
  const file = mapping.owner.sessionFile;
  const restartedAt = await ports.coreStartedAt(identity);
  if (!Number.isFinite(restartedAt) || restartedAt <= 0 || restartedAt <= mapping.recordedAt || restartedAt <= mapping.coreStartedAt) return null;
  refuseExplicitExtensions(mapping.owner.name ?? mapping.owner.sessionId, mapping.environment.extensionArguments);
  const eligible = async (): Promise<ResumeOffer | null> => {
    if (await ended()) return null;
    if ((await recordedSessionLiveness(file, ports.processInventory, mapping.owner.sessionId)).kind !== 'free') return null;
    let header; try { header = await readSessionHeader(file); } catch { return null; }
    if (header.id !== mapping.owner.sessionId) return null;
    return { terminal: identity, sessionFile: file, sessionId: header.id, cwd: mapping.owner.cwd, name: mapping.owner.name, argv: ['pi', '--session', file], environment: mapping.environment };
  };
  return ports.autoResumeRoot ? claimAutomaticResume(ports.autoResumeRoot, identity, restartedAt, async () => JSON.stringify(await ports.registry.get(identity)) === JSON.stringify(mapping), eligible) : eligible();
}
