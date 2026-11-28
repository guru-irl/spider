// SPDX-License-Identifier: MIT
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

export const fixtureMaps = Boolean(process.env.SPIDER_SELECTION_DIR);
export const recordMaps = process.env.SPIDER_BUILD_SOURCEMAP === '1' || fixtureMaps;
export const sourcemap = recordMaps ? 'hidden' : false;

// Keep the runtime and npm tarball layouts identical to a normal build.
// `bucket` is relative to dist even for entries built in a staging directory.
export function archiveMaps(bucket = '') {
  if (fixtureMaps) return archiveFixtureMaps();
  if (!recordMaps || !process.env.SPIDER_SELECTION_MAPS) return [];
  const dest = resolve(process.env.SPIDER_SELECTION_MAPS, bucket);
  return [{
    name: 'selection-archive-sourcemaps',
    writeBundle({ dir }, bundle) {
      for (const name of Object.keys(bundle).filter(name => name.endsWith('.map'))) {
        const path = join(dest, name);
        mkdirSync(dirname(path), { recursive: true });
        renameSync(join(dir, name), path);
      }
    },
  }];
}

export function registerFixtureMap(compiled, text, payload) {
  if (!fixtureMaps) return;
  const dest = resolve(process.env.SPIDER_SELECTION_DIR, 'fixture-maps');
  const hash = createHash('sha256').update(text).digest('hex');
  mkdirSync(dest, { recursive: true });
  const tmp = join(dest, `${hash}-${randomUUID()}.tmp`);
  const { sourcesContent: _, ...map } = payload;
  writeFileSync(tmp, JSON.stringify({ compiled, map }), { mode: 0o600 });
  renameSync(tmp, join(dest, `${hash}.json`));
}

export function archiveFixtureMaps() {
  if (!fixtureMaps) return [];
  return [{
    name: 'selection-register-fixture-maps',
    writeBundle({ dir }, bundle) {
      for (const name of Object.keys(bundle).filter(name => name.endsWith('.map'))) {
        const path = join(dir, name);
        const compiled = path.slice(0, -4);
        registerFixtureMap(compiled, readFileSync(compiled, 'utf8'), JSON.parse(readFileSync(path, 'utf8')));
        unlinkSync(path);
      }
    },
  }];
}
