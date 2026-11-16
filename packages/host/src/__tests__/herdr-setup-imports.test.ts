// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { rewriteImportPrefix } from '../herdr/imports.js';

test.each([
  `const quote = /['"]/;\nimport { x } from '../shared/x.js';`,
  "const value = `outer ${`inner`} tail`;\nconst x = import('../shared/x.js');",
  "const x = import /* comment */ ('../shared/x.js');",
  String.raw`const x = import('\x2e\x2e/shared/x.js');`,
])('rewrites every relative import or refuses an unsafe source', source => {
  try {
    const result = rewriteImportPrefix(source, '../shared/', './shared/');
    expect(result.source).not.toContain('../shared/');
    expect(result.source).not.toContain('\\x2e');
    expect(result.references).toEqual(['./shared/x.js']);
  } catch (error) {
    expect(error).toMatchObject({ code: 'picker-import-unresolved' });
  }
});

test('refuses a dynamic import whose path is assembled at runtime', () => {
  expect(() => rewriteImportPrefix("const name = 'other'; import('./valid.js' + name);", '../shared/', './shared/', 'main.js')).toThrowError(expect.objectContaining({ code: 'picker-import-unresolved', message: expect.stringContaining('main.js') }));
});

test('rewrites normal imports and leaves unrelated quoted text alone', () => {
  const result = rewriteImportPrefix(`const text = "unrelated";\nimport { x } from '../shared/x.js';`, '../shared/', './shared/');
  expect(result.source).toContain("from './shared/x.js'");
  expect(result.references).toEqual(['./shared/x.js']);
});
