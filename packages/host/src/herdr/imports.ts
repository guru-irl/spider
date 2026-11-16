// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
export function rewriteImportPrefix(source: string, from: string, to: string): { source: string; references: string[] } {
  let output = '', last = 0;
  const references: string[] = [];
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
      const match = /^(?:from\b\s*|import\b\s*(?:\(\s*)?)(['"])([^'"]+)\1/.exec(source.slice(i));
      if (match) {
        if (match[2].startsWith(from)) {
          const start = i + match[0].indexOf(match[2]);
          const replacement = to + match[2].slice(from.length);
          output += source.slice(last, start) + replacement;
          last = start + match[2].length; references.push(replacement);
        }
        i += match[0].length; continue;
      }
    }
    i++;
  }
  return { source: output + source.slice(last), references };
}
