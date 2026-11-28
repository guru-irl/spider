// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const digestBytes = bytes => createHash('sha256').update(bytes).digest('hex');

export function bundleDigest(root, path) {
  try {
    const file = resolve(realpathSync(root), path);
    // Relative runtime imports resolve from the real location, not the link.
    return realpathSync(file) === file ? digestBytes(readFileSync(file)) : null;
  } catch { return null; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const keys = readdirSync('dist', { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.[cm]?js$/.test(entry.name))
    .map(entry => {
      const bytes = readFileSync(join(entry.parentPath, entry.name));
      return `${bytes.length}:${digestBytes(bytes)}`;
    });
  console.log([...new Set(keys)].sort().join(','));
}
