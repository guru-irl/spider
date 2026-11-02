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

type Expansion = { end: number; commands: string[] };
type HereDelimiter = { value: string; strip: boolean };
function expansionHereDelimiter(code: string, start: number): { here: HereDelimiter; end: number } {
  let i = start + 2, strip = false, quote = '', value = '', active = false;
  if (code[i] === '-') { strip = true; i++; }
  while (code[i] === ' ' || code[i] === '\t') i++;
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === '\\' && quote !== "'") {
      if (++i >= code.length) throw new HerdrError('ssh-parse-failed', 'Incomplete here-document delimiter');
      value += code[i]; active = true; continue;
    }
    if (quote) { if (c === quote) quote = ''; else value += c; active = true; continue; }
    if (c === "'" || c === '"') { quote = c; active = true; continue; }
    if (/\s/.test(c) || ';|&<>()'.includes(c)) break;
    value += c; active = true;
  }
  if (!active || quote) throw new HerdrError('ssh-parse-failed', 'Invalid here-document delimiter');
  return { here: { value, strip }, end: i };
}
function expansion(code: string, start: number, allowArithmeticCommand = false): Expansion | undefined {
  if (code[start] === '`') {
    let body = '';
    for (let i = start + 1; i < code.length; i++) {
      if (code[i] === '`') return { end: i + 1, commands: [body] };
      if (code[i] === '\\' && '$`\\\n'.includes(code[i + 1] ?? '')) {
        if (code[++i] !== '\n') body += code[i];
      } else body += code[i];
    }
    throw new HerdrError('ssh-parse-failed', 'Unterminated command substitution');
  }
  const arithmeticCommand = allowArithmeticCommand && code[start] === '(' && code[start + 1] === '(';
  if (!arithmeticCommand && (code[start] !== '$' || code[start + 1] !== '(')) return undefined;
  const arithmetic = arithmeticCommand || code[start + 2] === '(';
  let depth = arithmetic ? 2 : 1, quote = '';
  const nested: string[] = [], documents: HereDelimiter[] = [];
  for (let i = start + (arithmeticCommand ? 2 : arithmetic ? 3 : 2); i < code.length; i++) {
    const c = code[i];
    if (c === '\\' && quote !== "'") { i++; continue; }
    if (quote === "'") { if (c === "'") quote = ''; continue; }
    if (c === '"') { quote = quote === '"' ? '' : '"'; continue; }
    if (!quote && c === "'") { quote = c; continue; }
    if ((c === '$' && code[i + 1] === '(') || c === '`') {
      const child = expansion(code, i)!;
      if (arithmetic) nested.push(...child.commands);
      i = child.end - 1; continue;
    }
    if (quote) continue;
    if (!arithmetic && c === '(' && code[i + 1] === '(') {
      const child = expansion(code, i, true)!; i = child.end - 1; continue;
    }
    if (!arithmetic && c === '<' && code[i + 1] === '<' && code[i + 2] === '<') { i += 2; continue; }
    if (!arithmetic && c === '<' && code[i + 1] === '<') {
      const found = expansionHereDelimiter(code, i); documents.push(found.here); i = found.end - 1; continue;
    }
    if (!arithmetic && c === '#' && (i === start + 2 || /[\s;|&()]/.test(code[i - 1]))) {
      const newline = code.indexOf('\n', i); if (newline < 0) break; i = newline - 1; continue;
    }
    if (!arithmetic && c === '\n' && documents.length) {
      for (const here of documents) {
        let found = false;
        while (++i < code.length) {
          const newline = code.indexOf('\n', i), end = newline < 0 ? code.length : newline;
          const line = code.slice(i, end); i = end;
          if ((here.strip ? line.replace(/^\t+/, '') : line) === here.value) { found = true; break; }
        }
        if (!found) throw new HerdrError('ssh-parse-failed', 'Unterminated here-document');
      }
      documents.length = 0; continue;
    }
    if (c === '(') depth++;
    if (c === ')' && --depth === 0) {
      return { end: i + 1, commands: arithmetic ? nested : [code.slice(start + 2, i)] };
    }
  }
  throw new HerdrError('ssh-parse-failed', 'Unterminated command substitution');
}
function hereSubstitutions(body: string): string[] {
  const substitutions: string[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && '$`\\\n'.includes(body[i + 1] ?? '')) { i++; continue; }
    const found = expansion(body, i);
    if (found) { substitutions.push(...found.commands); i = found.end - 1; }
  }
  return substitutions;
}

export interface ShellCommand extends Array<string> { hereSubstitution?: boolean }

/** A conservative lexer, not a shell evaluator. Expansions stay literal and ambiguous. */
export function shellCommands(code: string, unwrapWrappers = true, hereDataIsCode = false, nesting = 0): ShellCommand[] {
  if (code.length > 1024 * 1024 || code.includes('\0') || nesting > 64) throw new HerdrError('ssh-parse-failed', 'Unsupported shell input');
  type Here = { owner: number; value: string; strip: boolean; quoted: boolean };
  const commands: ShellCommand[] = [], pipes = new Set<number>();
  const substitutions: { owner: number; expression: string; code: string }[] = [];
  let argv: string[] = [], word = '', quote = '', active = false;
  let redirect: 'file' | 'here' | 'string' | undefined, strip = false, delimiterQuoted = false;
  let documents: Here[] = [], strings: Here[] = [];
  const flush = () => {
    if (active) {
      if (redirect === 'here') documents.push({ owner: commands.length, value: word, strip, quoted: delimiterQuoted });
      else if (redirect === 'string') strings.push({ owner: commands.length, value: word, strip: false, quoted: false });
      else if (!redirect) argv.push(word);
    } else if (redirect && redirect !== 'file') throw new HerdrError('ssh-parse-failed', `Missing ${redirect === 'here' ? 'here-document delimiter' : 'here-string operand'}`);
    word = ''; active = false; redirect = undefined; strip = false; delimiterQuoted = false;
  };
  const end = () => { if (active || redirect) flush(); if (argv.length) commands.push(unwrapWrappers ? unwrap(argv) : argv); argv = []; };
  const feedsShell = (owner: number) => {
    for (let n = owner; n < commands.length; n++) {
      if (['sh', 'bash', 'zsh', 'dash', 'ksh', '.', 'source'].includes(commandName(unwrap(commands[n])[0]))) return true;
      if (!pipes.has(n)) break;
    }
    return false;
  };
  const inspectStrings = () => {
    for (const here of strings) if (feedsShell(here.owner)) commands.push(...shellCommands(here.value, unwrapWrappers, false, nesting + 1));
    strings = [];
  };
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '\\' && quote !== "'") { if (i + 1 >= code.length) throw new HerdrError('ssh-parse-failed', 'Incomplete escape'); const next = code[++i]; if (next !== '\n') { if (redirect === 'here') delimiterQuoted = true; word += next; active = true; } continue; }
    if (quote !== "'" && redirect !== 'here') {
      const found = expansion(code, i, !quote);
      if (found) {
        const expression = code.slice(i, found.end);
        for (const child of found.commands) substitutions.push({ owner: commands.length, expression, code: child });
        word += expression; active = true; i = found.end - 1; continue;
      }
    }
    if (quote) { if (c === quote) quote = ''; else word += c; active = true; continue; }
    if (c === '"' || c === "'") { if (redirect === 'here') delimiterQuoted = true; quote = c; active = true; continue; }
    if (c === '#' && !active) { while (i < code.length && code[i] !== '\n') i++; i--; continue; }
    if (c === '\n') {
      end(); inspectStrings();
      for (const here of documents) {
        let body = '', found = false;
        while (++i < code.length) {
          const start = i, newline = code.indexOf('\n', i);
          const finish = newline < 0 ? code.length : newline;
          const line = code.slice(start, finish), compare = here.strip ? line.replace(/^\t+/, '') : line;
          i = finish;
          if (compare === here.value) { found = true; break; }
          body += (here.strip ? line.replace(/^\t+/, '') : line) + (newline < 0 ? '' : '\n');
        }
        if (!found) throw new HerdrError('ssh-parse-failed', `Unterminated here-document ${JSON.stringify(here.value)}`);
        if (!here.quoted) for (const substitution of hereSubstitutions(body)) {
          for (const command of shellCommands(substitution, unwrapWrappers, false, nesting + 1)) {
            if (!command.hereSubstitution) Object.defineProperty(command, 'hereSubstitution', { value: true });
            commands.push(command);
          }
        }
        if (hereDataIsCode || feedsShell(here.owner)) commands.push(...shellCommands(body, unwrapWrappers, false, nesting + 1));
      }
      documents = []; continue;
    }
    if (';|&(){}'.includes(c)) { end(); if (c === '|' && code[i + 1] !== '|' && code[i - 1] !== '|') pipes.add(commands.length - 1); continue; }
    if (/\s/.test(c)) { if (active) flush(); continue; }
    if ('<>'.includes(c)) {
      // A descriptor directly before the operator is not an argv operand.
      if (active && /^\d+$/.test(word)) { word = ''; active = false; } else if (active || redirect) flush();
      if (c === '<' && code[i + 1] === '<') {
        i++;
        if (code[i + 1] === '<') { i++; redirect = 'string'; }
        else { redirect = 'here'; if (code[i + 1] === '-') { i++; strip = true; } }
      } else {
        redirect = 'file';
        while ('<>'.includes(code[i + 1] || '\0')) i++;
        if (code[i + 1] === '&') i++;
      }
      continue;
    }
    word += c; active = true;
  }
  if (quote) throw new HerdrError('ssh-parse-failed', 'Unterminated shell quote');
  end(); inspectStrings();
  if (documents.length) throw new HerdrError('ssh-parse-failed', `Unterminated here-document ${JSON.stringify(documents[0].value)}`);
  for (const substitution of substitutions) {
    const parent = unwrap(commands[substitution.owner] ?? []), name = commandName(parent[0]);
    const option = ['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(name) ? parent.findIndex(v => /^-[^-]*c/.test(v)) : -1;
    const outputIsCode = name === 'eval' || option >= 0 && (parent[option + 1] ?? '').includes(substitution.expression);
    commands.push(...shellCommands(substitution.code, unwrapWrappers, outputIsCode, nesting + 1));
  }
  return commands;
}

/** A parse failure is relevant only when it can hide a route or an administrative bypass. */
export function parseFailureToken(code: string): string | undefined {
  const transport = /\b(?:ssh|scp|sftp|rsync|GIT_SSH_COMMAND|GIT_SSH|RSYNC_RSH|SPIDER_HERDR_SSH_BYPASS)\b/i.exec(code);
  const git = /\bgit(?:\.exe)?\s+(?:(?:-c|-C|--git-dir|--work-tree|--namespace|--config-env)\s+(?:'[^']*'|"[^"]*"|[^\s;|&]+)\s+|-[^\s;|&]+\s+)*(?:fetch|pull|push|clone|ls-remote|fetch-pack|send-pack|remote\s+(?:show|update|prune|add\s+(?:-f|--fetch))|submodule\s+(?:update|sync)|archive\b[^\n;|&]*--remote)\b/i.exec(code);
  return git && (!transport || git.index < transport.index) ? 'git' : transport?.[0];
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
