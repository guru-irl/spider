// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Disposable, Owner, ExecutionEnvironmentPolicy } from '../contracts.js';
import { ordinaryExecutionEnvironment } from './shim.js';
import type { SshPolicy } from './policy.js';
import { shellCommands, commandName } from './parse.js';
export interface RoutingPorts {
  policy: SshPolicy; environmentPolicy: ExecutionEnvironmentPolicy; currentOwner(ctx: ExtensionContext): Owner | null;
  createBashTool: typeof import('@earendil-works/pi-coding-agent').createBashTool;
  createLocalBashOperations: typeof import('@earendil-works/pi-coding-agent').createLocalBashOperations;
  readShellFile(path: string, on?: string): Promise<string>;
  enabled(): boolean; reportDisabled?(reason: string): void; start?(): Promise<void>; stop?(): void | Promise<void>;
}
export type HerdrToolGuard = (event: { toolName: string; input: Record<string, unknown> }) => Promise<{ block: true; reason: string } | undefined>;
const shell = (language: unknown) => ['shell', 'bash', 'sh', 'zsh'].includes(String(language).toLowerCase());
function setsProgramBypass(code: string): boolean {
  const assignment = /\b(?:SPIDER_HERDR_SSH_BYPASS|process\.env\.SPIDER_HERDR_SSH_BYPASS|(?:os\.)?environ\s*\[\s*['"]SPIDER_HERDR_SSH_BYPASS['"]\s*\]|process\.env\s*\[\s*['"]SPIDER_HERDR_SSH_BYPASS['"]\s*\]|ENV\s*\[\s*['"]SPIDER_HERDR_SSH_BYPASS['"]\s*\])\s*=(?!=)/;
  // Scan in source order: a quoted example or comment is consumed before its contents can match.
  const inert = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\//;
  const tokens = new RegExp(`${inert.source}|(${assignment.source})`, 'gi');
  return [...code.matchAll(tokens)].some(match => match[1] !== undefined);
}
function setsShellBypass(code: string): boolean {
  const wordsSet = (words: string[]): boolean => {
    let index = 0;
    while (/^[A-Za-z_]\w*=/.test(words[index] ?? '')) {
      if (/^SPIDER_HERDR_SSH_BYPASS=/i.test(words[index++])) return true;
    }
    const name = commandName(words[index++]), rest = words.slice(index);
    if (['export', 'readonly', 'declare', 'typeset'].includes(name)) {
      const printing = rest.some(word => /^-[^-]*p/.test(word));
      return rest.some(word => printing ? /^SPIDER_HERDR_SSH_BYPASS=/i.test(word) : /^SPIDER_HERDR_SSH_BYPASS(?:=|$)/i.test(word));
    }
    if (['env', 'command', 'exec', 'sudo', 'then', 'do', 'if', 'elif', 'while', 'until', '!'].includes(name)) {
      const operands = name === 'env' ? ['-u', '--unset', '-C', '--chdir'] : name === 'sudo' ? ['-u', '-g', '-h', '-p'] : name === 'exec' ? ['-a'] : [];
      while (rest[0]?.startsWith('-')) { const flag = rest.shift()!; if (operands.includes(flag)) rest.shift(); if (flag === '--') break; }
      return wordsSet(rest);
    }
    if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(name)) {
      const option = rest.findIndex(word => /^-[^-]*c/.test(word));
      return option >= 0 && rest[option + 1] !== undefined && setsShellBypass(rest[option + 1]);
    }
    if (/^(?:python[\d.]*|node|ruby|perl)$/.test(name)) {
      const option = rest.findIndex(word => ['-c', '-e', '--eval'].includes(word));
      return option >= 0 && rest[option + 1] !== undefined && setsProgramBypass(rest[option + 1]);
    }
    return false;
  };
  return shellCommands(code, false).some(wordsSet);
}
const setsBypass = (code: string, language: unknown) => /SPIDER_HERDR_SSH_BYPASS/i.test(code) && (shell(language) ? setsShellBypass(code) : setsProgramBypass(code));
export async function guardHerdrToolCall(event: { toolName: string; input: Record<string, unknown> }, ports: RoutingPorts): Promise<{ block: true; reason: string } | undefined> {
  if (!ports.enabled()) return;
  const input = event.input;
  if (event.toolName !== 'bash' && !['spider', 'functions.spider'].includes(event.toolName)) return;
  const block = (reason: string) => ({ block: true as const, reason });
  try {
    const bypassRefusal = () => block('SPIDER_HERDR_SSH_BYPASS may only be set by the audited admin route');
    const codes: string[] = [];
    if (event.toolName === 'bash') {
      const code = String(input.command ?? ''); if (setsBypass(code, 'shell')) return bypassRefusal(); codes.push(code);
    } else if (input.action === 'exec') {
      const code = String(input.code ?? ''); if (setsBypass(code, input.language)) return bypassRefusal(); if (shell(input.language)) codes.push(code);
    }
    else if (input.action === 'exec_file') {
      if (typeof input.path !== 'string') return block('SSH parser failed: exec_file requires a path');
      let code: string;
      try { code = await ports.readShellFile(input.path, typeof input.on === 'string' ? input.on : undefined); }
      catch (error) { return block(`exec_file read failed for ${JSON.stringify(input.path)}${typeof input.on === 'string' ? ` on ${input.on}` : ''}: ${error instanceof Error ? error.message : String(error)}`); }
      if (setsBypass(code, input.language)) return bypassRefusal();
      if (shell(input.language)) codes.push(code);
    } else if (input.action === 'batch') {
      if (!Array.isArray(input.commands)) return block('SSH parser failed: batch commands must be an array');
      for (const entry of input.commands) {
        if (!entry || typeof entry !== 'object') return block('SSH parser failed: invalid batch entry');
        const code = String(entry.code ?? ''); if (setsBypass(code, entry.language)) return bypassRefusal();
        if (shell(entry.language)) codes.push(code);
      }
    }
    for (const code of codes) { const result = await ports.policy.checkShell(code); if (result.kind === 'refuse') return block(result.reason); }
  } catch { return block('SSH parser failed; use spider exec with on:<machine>'); }
}
export function registerHerdrRouting(pi: ExtensionAPI, ports: RoutingPorts): Disposable {
  let disposed = false;
  const environment: ExecutionEnvironmentPolicy = env => process.env.PI_SUBAGENT_CHILD === '1' && !ports.enabled() ? ordinaryExecutionEnvironment(env) : ports.environmentPolicy(env);
  const bash = ports.createBashTool(process.cwd(), { spawnHook: context => ({ ...context, env: { ...environment(context.env) } }) });
  pi.registerTool({ ...bash, async execute(id, params, signal, onUpdate, ctx) {
    // Resolve cwd from this call rather than the extension's loading directory.
    const local = ports.createBashTool(ctx.cwd, { spawnHook: context => ({ ...context, env: { ...environment(context.env) } }) });
    return local.execute(id, params, signal, onUpdate);
  } });
  const unsubscribe = [
    pi.on('user_bash', async event => {
      const refusal = await guardHerdrToolCall({ toolName: 'bash', input: { command: event.command } }, ports);
      if (refusal) return { result: { output: refusal.reason, exitCode: 126, cancelled: false, truncated: false } };
      const local = ports.createLocalBashOperations();
      return { operations: { exec: (command, cwd, options) => local.exec(command, cwd, { ...options, env: { ...environment(options.env ?? process.env) } }) } };
    }),
    pi.on('session_start', async () => { if (!disposed && ports.enabled()) await ports.start?.(); }),
    pi.on('session_shutdown', async () => { await ports.stop?.(); }),
  ];
  return { async dispose() { if (disposed) return; disposed = true; for (const off of unsubscribe) off(); await ports.stop?.(); } };
}
