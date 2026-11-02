// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

/** Extract hc's root `socket` string, leaving other config fields to hc. */
export function configSocket(source: string): string | undefined {
  const input = source.replaceAll('\r\n', '\n');
  let at = 0; let socket: string | undefined;
  const invalid = (): never => { throw new SyntaxError('Invalid socket configuration'); };
  const horizontal = () => { while (input[at] === ' ' || input[at] === '\t') at++; };
  const comment = () => { while (at < input.length && input[at] !== '\n') at++; };
  function string(): string {
    const quote = input[at];
    if (quote !== '"' && quote !== "'") return invalid();
    const multiline = input.startsWith(quote.repeat(3), at);
    at += multiline ? 3 : 1;
    if (multiline && input[at] === '\n') at++;
    let result = '';
    while (at < input.length) {
      if (input[at] === quote) {
        if (!multiline) { at++; return result; }
        if (input.startsWith(quote.repeat(3), at)) {
          at += 3;
          // TOML permits one or two quotes immediately before the closing three.
          for (let extra = 0; extra < 2 && input[at] === quote; extra++, at++) result += quote;
          return result;
        }
      }
      const char = input[at++];
      if ((!multiline && char === '\n') || (char.charCodeAt(0) < 32 && char !== '\t' && char !== '\n')) return invalid();
      if (quote === '"' && char === '\\') {
        if (multiline && /^[ \t]*\n/.test(input.slice(at))) { while (/\s/.test(input[at] ?? '') && at < input.length) at++; continue; }
        const escape = input[at++];
        const escapes: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
        if (escape === 'u' || escape === 'U') {
          const digits = escape === 'u' ? 4 : 8;
          const hex = input.slice(at, at + digits);
          if (!new RegExp(`^[0-9a-fA-F]{${digits}}$`).test(hex)) return invalid();
          at += digits; const point = Number.parseInt(hex, 16);
          if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return invalid();
          result += String.fromCodePoint(point);
        } else if (escape in escapes) result += escapes[escape];
        else return invalid();
      } else result += char;
    }
    return invalid();
  }
  function skipValue(): void {
    const nesting: string[] = [];
    while (at < input.length) {
      const char = input[at];
      if (char === '"' || char === "'") { string(); continue; }
      if (char === '#') { comment(); continue; }
      if (char === '\n' && nesting.length === 0) { at++; return; }
      if (char === '[' || char === '{') nesting.push(char);
      else if (char === ']' || char === '}') {
        if (nesting.pop() !== (char === ']' ? '[' : '{')) return invalid();
      }
      at++;
    }
    if (nesting.length) invalid();
  }
  function key(): string {
    horizontal();
    if (input[at] === '"' || input[at] === "'") return string();
    const match = /^[A-Za-z0-9_-]+/.exec(input.slice(at));
    if (!match) return invalid();
    at += match[0].length; return match[0];
  }
  while (at < input.length) {
    horizontal();
    if (input[at] === '#') { comment(); continue; }
    if (input[at] === '\n') { at++; continue; }
    if (at === input.length || input[at] === '[') break;
    const keys = [key()]; horizontal();
    while (input[at] === '.') { at++; keys.push(key()); horizontal(); }
    if (input[at++] !== '=') return invalid();
    horizontal();
    if (keys.length === 1 && keys[0] === 'socket') {
      if (socket !== undefined) return invalid();
      socket = string(); horizontal();
      if (at < input.length && input[at] !== '#' && input[at] !== '\n') return invalid();
      if (!socket || socket.includes('\0')) return invalid();
    }
    skipValue();
  }
  return socket;
}
