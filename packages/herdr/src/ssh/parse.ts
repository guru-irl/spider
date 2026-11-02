// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { HerdrError } from '../client/parse.js';
export interface SshDestination { host: string; source: 'destination' | 'hostname' | 'jump' | 'proxy' | 'forward'; ambiguous?: boolean }

export function normalizeSshHost(value: string): string {
  let host = value.trim().toLowerCase();
  if (host.startsWith('ssh://')) {
    try { host = new URL(host).hostname; } catch { return ''; }
  }
  host = host.slice(host.lastIndexOf('@') + 1);
  if (host.startsWith('[')) { const end = host.indexOf(']'); return end < 0 ? '' : host.slice(1, end); }
  if ((host.match(/:/g) || []).length === 1) host = host.replace(/:\d+$/, '');
  return host.replace(/\.$/, '');
}
function destination(value: string, source: SshDestination['source']): SshDestination {
  const host = normalizeSshHost(value);
  return { host, source, ...(!host || /[\s$`*?%\\]/.test(host) || host.startsWith('-') || host.includes('/') ? { ambiguous: true } : {}) };
}
const OPERANDS = new Set('B b c D E e F I i J L l m O o P p Q R S W w'.split(' '));
const FLAGS = new Set('4 6 A a C f G g K k M N n q s T t V v X x Y y'.split(' '));
export function parseSshDestinations(argv: readonly string[], requireDestination = true): SshDestination[] {
  const routes: SshDestination[] = []; let operand: string | undefined;
  const uncertain = () => routes.push({ host: '', source: 'destination', ambiguous: true });
  const jumps = (value: string) => { if (value.toLowerCase() !== 'none') for (const jump of value.split(',')) routes.push(destination(jump, 'jump')); };
  const option = (value: string) => {
    const match = /^([^=\s]+)[=\s]+(.*)$/.exec(value.trim()); if (!match) { uncertain(); return; }
    const key = match[1].toLowerCase(), setting = match[2].trim();
    if (key === 'hostname') routes.push(destination(setting, 'hostname'));
    if (key === 'proxyjump') jumps(setting);
    if (key === 'proxycommand' && setting.toLowerCase() !== 'none') {
      try {
        const commands = shellCommands(setting); let found = false;
        for (const command of commands) if (commandName(command[0]) === 'ssh') {
          found = true; routes.push(...parseSshDestinations(command.slice(1)).map(r => ({ ...r, source: 'proxy' as const })));
        }
        if (!found) uncertain();
      } catch { uncertain(); }
    }
    // Match endpoints explicitly supplied by options; never consult ssh -G or config.
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { operand = argv[++i]; break; }
    if (!arg.startsWith('-') || arg === '-') { operand = arg; break; }
    if (arg.startsWith('--')) { uncertain(); continue; }
    for (let pos = 1; pos < arg.length; pos++) {
      const flag = arg[pos];
      if (OPERANDS.has(flag)) {
        const value = arg.slice(pos + 1) || argv[++i];
        if (value === undefined) { uncertain(); break; }
        if (flag === 'J') jumps(value);
        else if (flag === 'o') option(value);
        else if (flag === 'W') routes.push(destination(value, 'forward'));
        // Alternate configuration can hide a managed endpoint, so fail closed.
        else if (flag === 'F') uncertain();
        break;
      }
      if (!FLAGS.has(flag)) uncertain();
    }
  }
  if (operand === undefined) { if (requireDestination) uncertain(); } else routes.push(destination(operand, 'destination'));
  return routes;
}
export function commandName(value = ''): string { return value.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase().replace(/\.exe$/, '') || ''; }

/** A conservative lexer, not a shell evaluator. Expansions stay literal and ambiguous. */
export function shellCommands(code: string, unwrapWrappers = true): string[][] {
  if (code.length > 1024 * 1024 || code.includes('\0')) throw new HerdrError('ssh-parse-failed', 'Unsupported shell input');
  const commands: string[][] = []; let argv: string[] = [], word = '', quote = '', active = false, redirection = false;
  const flush = () => { if (active && !redirection) argv.push(word); word = ''; active = false; redirection = false; };
  const end = () => { flush(); if (argv.length) commands.push(unwrapWrappers ? unwrap(argv) : argv); argv = []; };
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '\\' && quote !== "'") { if (i + 1 >= code.length) throw new HerdrError('ssh-parse-failed', 'Incomplete escape'); const next = code[++i]; if (next !== '\n') { word += next; active = true; } continue; }
    if (quote) { if (c === quote) quote = ''; else word += c; active = true; continue; }
    if (c === '"' || c === "'") { quote = c; active = true; continue; }
    if (c === '#' && !active) { while (i < code.length && code[i] !== '\n') i++; end(); continue; }
    if (';|&\n(){}'.includes(c)) { end(); continue; }
    if (/\s/.test(c)) { if (active) flush(); continue; }
    if ('<>'.includes(c)) {
      if (code[i + 1] === '<') throw new HerdrError('ssh-parse-failed', 'Unsupported here-document or here-string');
      // A descriptor directly before the operator is not an argv operand.
      if (active && /^\d+$/.test(word)) { word = ''; active = false; } else flush();
      redirection = true;
      while ('<>'.includes(code[i + 1] || '\0')) i++;
      if (code[i + 1] === '&') i++;
      continue;
    }
    word += c; active = true;
  }
  if (quote) throw new HerdrError('ssh-parse-failed', 'Unterminated shell quote'); end(); return commands;
}
function unwrap(input: string[]): string[] {
  let argv = input;
  while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(argv[0] || '')) argv = argv.slice(1);
  while (['command', 'exec', 'env', 'sudo', 'then', 'do', 'if', 'elif', 'while', 'until', '!'].includes(commandName(argv[0]))) {
    const wrapper = commandName(argv[0]); argv = argv.slice(1);
    const operands = wrapper === 'env' ? ['-u', '--unset', '-C', '--chdir'] : wrapper === 'sudo' ? ['-u', '-g', '-h', '-p', '-C', '-T', '-R', '-D', '-r', '-t', '--user', '--group', '--host', '--prompt', '--chdir'] : wrapper === 'exec' ? ['-a'] : [];
    while (argv[0]?.startsWith('-') || /^[A-Za-z_][A-Za-z_0-9]*=/.test(argv[0] || '')) {
      const option = argv[0]; argv = argv.slice(1);
      if (option === '--') break;
      if (wrapper === 'env' && (option.startsWith('-S') || option.startsWith('--split-string'))) throw new HerdrError('ssh-parse-failed', 'Unsupported env split-string command');
      if (operands.includes(option)) {
        if (!argv.length) throw new HerdrError('ssh-parse-failed', 'Incomplete command wrapper option');
        argv = argv.slice(1);
      }
    }
    while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(argv[0] || '')) argv = argv.slice(1);
  }
  return argv;
}
