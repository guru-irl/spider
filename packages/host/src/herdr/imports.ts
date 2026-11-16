// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { HerdrError } from '@spider/herdr/client/parse';

interface ImportReference { start: number; end: number; specifier: string }
const whitespace = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*`;

function fullLineComment(source: string, index: number): boolean {
  const start = source.lastIndexOf('\n', index - 1) + 1;
  return source.slice(start, index).trimStart().startsWith('//');
}
function unsafe(file: string, specifier: string): never {
  throw new HerdrError('picker-import-unresolved', `Cannot verify import in ${file}: ${specifier}`);
}

/** Scan normally, then independently look for relative imports the scan skipped. */
function imports(source: string, file: string): ImportReference[] {
  const found: ImportReference[] = [];
  for (let i = 0; i < source.length;) {
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i + 2); i = end < 0 ? source.length : end; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (source[i] === '"' || source[i] === "'" || source[i] === '`') {
      const quote = source[i++];
      while (i < source.length) { if (source[i] === '\\') i += 2; else if (source[i++] === quote) break; }
      continue;
    }
    const previous = i ? source[i - 1] : '';
    if (!/[\w$]/.test(previous)) {
      const match = /^(?:from\b\s*|import\b\s*(?:\(\s*)?)(['"])((?:\\.|(?!\1)[^\\\r\n])*)\1/.exec(source.slice(i));
      if (match) {
        const start = i + match[0].lastIndexOf(match[2]);
        found.push({ start, end: start + match[2].length, specifier: match[2] });
        i += match[0].length; continue;
      }
    }
    i++;
  }
  // This deliberately also matches suspicious text in strings or comments. A false
  // positive refuses installation rather than silently accepting an unchecked import.
  const candidates = new RegExp(String.raw`\b(?:from|import)\b${whitespace}(?:\(${whitespace})?(['"])((?:\\.|(?!\1)[^\\\r\n])*)\1`, 'gd');
  for (const match of source.matchAll(candidates)) {
    if (fullLineComment(source, match.index)) continue;
    const specifier = match[2], start = match.indices![2]![0];
    if (specifier.includes('\\') || specifier.startsWith('.') && !found.some(item => item.start === start)) unsafe(file, specifier);
  }
  const dynamic = new RegExp(String.raw`\bimport\b${whitespace}\(${whitespace}`, 'g');
  for (const match of source.matchAll(dynamic)) {
    if (fullLineComment(source, match.index)) continue;
    const rest = source.slice(match.index + match[0].length);
    const literal = /^(['"])((?:\\.|(?!\1)[^\\\r\n])*)\1/.exec(rest);
    if (!literal) unsafe(file, 'dynamic import');
    const tail = rest.slice(literal[0].length), gap = new RegExp(`^${whitespace}`).exec(tail)![0];
    if (tail[gap.length] !== ')') unsafe(file, literal[2]);
  }
  return found;
}

export function relativeImports(source: string, file: string): string[] {
  return imports(source, file).map(item => item.specifier).filter(specifier => specifier.startsWith('.'));
}

export function rewriteImportPrefix(source: string, from: string, to: string, file = '<source>'): { source: string; references: string[] } {
  let output = '', last = 0;
  const references: string[] = [];
  for (const item of imports(source, file)) {
    if (!item.specifier.startsWith(from)) continue;
    const replacement = to + item.specifier.slice(from.length);
    output += source.slice(last, item.start) + replacement;
    last = item.end;
    references.push(replacement);
  }
  output += source.slice(last);
  if (from !== to && relativeImports(output, file).some(specifier => specifier.startsWith(from))) unsafe(file, from);
  return { source: output, references };
}
