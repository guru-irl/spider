// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const keys = readdirSync('dist', { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && /\.[cm]?js$/.test(entry.name))
  .map(entry => {
    const bytes = readFileSync(join(entry.parentPath, entry.name));
    return `${bytes.length}:${createHash('sha256').update(bytes).digest('hex')}`;
  });
console.log([...new Set(keys)].sort().join(','));
