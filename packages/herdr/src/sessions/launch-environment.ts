// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { constants } from 'node:fs';
import { access, open } from 'node:fs/promises';
import type { SessionContext } from '@earendil-works/pi-coding-agent';
import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { HerdrError } from '../client/parse.js';

/** Sensitive local-only data. Never include this object in notices, feeds or transcripts. */
export type LaunchModel = NonNullable<SessionContext['model']>;
export interface RecordedLaunch {
  model?: LaunchModel;
  program: string;
  argv: readonly string[];
  cwd: string;
  variables: Readonly<Record<string, string>>;
}

export function recordedLaunch(value: unknown): RecordedLaunch {
  const r = value as RecordedLaunch | null;
  const text = (s: unknown): s is string => typeof s === 'string' && !s.includes('\0');
  if (!r || !text(r.program) || !isAbsolute(r.program) || !text(r.cwd) || !isAbsolute(r.cwd) ||
      !Array.isArray(r.argv) || !r.argv.every(text) || !r.variables || typeof r.variables !== 'object' || Array.isArray(r.variables) ||
      Object.entries(r.variables).some(([name, v]) => !name || name.includes('=') || !text(name) || !text(v)) ||
      r.model !== undefined && (!r.model || !text(r.model.provider) || !r.model.provider || !text(r.model.modelId) || !r.model.modelId)) {
    throw new HerdrError('launch-record-invalid', 'Private launch data is invalid');
  }
  return { program: r.program, argv: [...r.argv], cwd: r.cwd, variables: { ...r.variables }, ...(r.model ? { model: { provider: r.model.provider, modelId: r.model.modelId } } : {}) };
}

export function captureLaunch(program: string, argv: readonly string[], cwd: string, env: Readonly<NodeJS.ProcessEnv>): RecordedLaunch {
  return recordedLaunch({ program: resolve(program), argv, cwd, variables: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)) });
}

const CURRENT_VARIABLES = new Set([
  'TERM_SESSION_ID', 'SHLVL', 'PWD', 'OLDPWD', '_', 'SSH_AUTH_SOCK', 'TMPDIR', 'SECURITYSESSIONID', 'LaunchInstanceID',
  'TERM', 'COLORTERM', 'PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL',
  'PI_INTERCOM_SESSION_ID', 'SPIDER_TOOL_NAME', 'SPIDER_PARAMETERS',
  'TERMINFO', 'TERMINFO_DIRS', 'SSH_AGENT_PID', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY',
  'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY',
  'TMUX', 'TMUX_PANE', 'STY', 'WINDOW', 'WINDOWID', 'ITERM_SESSION_ID', 'WT_SESSION', 'WEZTERM_PANE',
]);
/** Keep process and terminal identities current, but replay configuration, including credentials and stable IDs. */
export function currentLaunchVariable(name: string): boolean {
  return CURRENT_VARIABLES.has(name) || /^(?:HC_|HERDR_|XPC_|__CF|TERM_PROGRAM|PI_SPIDER_|PI_SUBAGENT_|SPIDER_HERDR_|SPIDER_VIEWER_)/.test(name);
}
export function replayLaunchVariables(current: Readonly<NodeJS.ProcessEnv>, launch: RecordedLaunch): NodeJS.ProcessEnv {
  const variables = Object.entries(launch.variables).filter(([name]) => !currentLaunchVariable(name));
  return { ...current, ...Object.fromEntries(variables) };
}

// Pi 1.2 CLI help and docs/cli.md. Value-taking flags must consume their value even when omitted.
const OMIT_VALUE = new Set(['--session', '--session-id', '--fork', '--provider', '--model', '--thinking', '--name', '-n']);
const OMIT_SWITCH = new Set(['--continue', '-c', '--resume', '-r', '--no-session']);
const VALUE = new Set([
  ...OMIT_VALUE, '--mode', '--export', '--api-key', '--models', '--system-prompt', '--append-system-prompt', '--session-dir',
  '--tools', '-t', '--exclude-tools', '-xt', '--extension', '-e', '--skill', '--prompt-template', '--theme', '--use-theme', '--tui-mode',
]);
export const launchFlagTakesValue = (flag: string): boolean => VALUE.has(flag);
const SWITCH = new Set([
  '--no-tools', '-nt', '--no-builtin-tools', '-nbt', '--no-extensions', '-ne', '--no-mcp', '--no-skills', '-ns',
  '--no-prompt-templates', '-np', '--no-themes', '--no-context-files', '-nc', '--verbose', '--approve', '-a', '--no-approve', '-na', '--offline',
]);
const NONINTERACTIVE = new Set(['--print', '-p', '--export', '--list-models', '--help', '-h', '--version', '-v']);
// Pi's utils/paths isLocalPath: these are package sources, not relative files.
export function isLocalLaunchSource(value: string): boolean {
  return !/^(?:npm:|git:|github:|http:|https:|ssh:|builtin:)/.test(value.trim());
}
export function resolveLaunchSource(value: string, cwd: string, home: string = homedir()): string {
  if (!isLocalLaunchSource(value) || value.startsWith('file:') || isAbsolute(value)) return value;
  if (value === '~') return home;
  return value.startsWith('~/') ? resolve(home, value.slice(2)) : resolve(cwd, value);
}
const PATH_FLAGS = new Set(['--extension', '-e', '--skill', '--prompt-template', '--theme', '--session-dir']);
const safePathText = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');

export function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
async function sessionModel(file: string): Promise<LaunchModel | null> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) throw new Error('Not a regular session file');
    const { parseSessionEntries } = await import('@earendil-works/pi-coding-agent');
    const entries = parseSessionEntries(await handle.readFile('utf8')).filter(entry => entry.type !== 'session');
    const byId = new Map(entries.map(entry => [entry.id, entry] as const)), seen = new Set<string>();
    const identity = (provider: unknown, modelId: unknown): LaunchModel => {
      if (typeof provider !== 'string' || !provider || typeof modelId !== 'string' || !modelId || /[\x00-\x1f\x7f-\x9f]/.test(provider + modelId)) throw new Error('Invalid model identity');
      return { provider, modelId };
    };
    let entry = entries.at(-1), response: LaunchModel | null = null;
    while (entry) {
      if (seen.has(entry.id)) throw new Error('Invalid session branch');
      seen.add(entry.id);
      // A router's assistant messages name physical models, not the user's explicit model selection.
      if (entry.type === 'model_change') return identity(entry.provider, entry.modelId);
      if (!response && entry.type === 'message' && entry.message.role === 'assistant') response = identity(entry.message.provider, entry.message.model);
      entry = entry.parentId ? byId.get(entry.parentId) : undefined;
    }
    return response;
  } catch { throw new HerdrError('session-model-invalid', 'Cannot read the session model for API-key replay'); }
  finally { await handle?.close(); }
}
export async function replayLaunchArgv(launch: RecordedLaunch, sessionFile: string): Promise<string[]> {
  const args: string[] = [], missing: string[] = [];
  let launchedProvider: string | undefined, hasApiKey = false;
  for (let i = 0; i < launch.argv.length; i++) {
    const position = i + 1;
    const argument = launch.argv[i];
    if (argument === '--') break;
    if (!argument.startsWith('-')) continue; // Positional prompts and @file attachments are never sent again.
    const equals = argument.indexOf('=');
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    if (NONINTERACTIVE.has(flag)) throw new HerdrError('session-not-interactive', 'Only interactive pi sessions can resume in a terminal');
    if (OMIT_SWITCH.has(flag)) continue;
    if (SWITCH.has(flag)) { args.push(argument); continue; }
    let value = equals < 0 ? undefined : argument.slice(equals + 1);
    if (VALUE.has(flag)) {
      value ??= launch.argv[++i];
      if (value === undefined) throw new HerdrError('launch-record-invalid', 'A recorded launch flag has no value');
      if (flag === '--provider') launchedProvider = value;
      if (OMIT_VALUE.has(flag)) continue;
      if (flag === '--mode') {
        if (value !== 'text') throw new HerdrError('session-not-interactive', 'Only interactive pi sessions can resume in a terminal');
        continue;
      }
      if (PATH_FLAGS.has(flag)) value = resolveLaunchSource(value, launch.cwd, launch.variables.HOME ?? homedir());
      if ((flag === '--extension' || flag === '-e') && isLocalLaunchSource(value)) {
        try { await access(value.startsWith('file:') ? fileURLToPath(value) : value); }
        catch { missing.push(`${flag} at argument ${position}`); }
      }
      if (flag === '--api-key') hasApiKey = true;
      args.push(flag, value);
    } else if (flag.startsWith('--')) {
      // Preserve equals syntax: a separated @value would become an attachment in pi's extension-flag parser.
      if (equals >= 0) { args.push(argument); continue; }
      if (launch.argv[i + 1] !== undefined && !/^[-@]/.test(launch.argv[i + 1])) value = launch.argv[++i];
      args.push(flag, ...(value === undefined ? [] : [value]));
    } else {
      throw new HerdrError('launch-record-invalid', 'An unsupported short launch flag was recorded');
    }
  }
  if (missing.length) throw new HerdrError('session-extensions-missing', `Missing explicit extensions: ${missing.join(', ')}`);
  let program = launch.program;
  try { await access(program, constants.X_OK); } catch { program = 'pi'; }
  if (hasApiKey) {
    const originalProvider = launch.model?.provider ?? launchedProvider;
    const model = await sessionModel(sessionFile) ?? launch.model;
    if (!model || !originalProvider || model.provider.toLowerCase() !== originalProvider.toLowerCase()) {
      // Other argv values can also contain secrets. Show only the arguments needed to select the session and key provider.
      const manualArgs = [program, '--session', sessionFile];
      manualArgs.push('--model', model ? `${model.provider}/${model.modelId}` : '<PROVIDER/MODEL>');
      manualArgs.push('--api-key', '<API_KEY>');
      const command = `cd -- ${shellQuote(launch.cwd)} && ${manualArgs.map(shellQuote).join(' ')}`;
      const reason = originalProvider && model ? `The API key was launched for provider ${originalProvider}, but this session now uses ${model.provider}.` : 'The original launch model or API-key provider cannot be determined.';
      throw new HerdrError(originalProvider && model ? 'session-key-provider-changed' : 'session-key-provider-unknown', safePathText(`${reason} Supply a key for the selected provider to resume manually: ${command}`));
    }
    args.push('--model', `${model.provider}/${model.modelId}`);
  }
  return [program, ...args, '--session', sessionFile];
}
