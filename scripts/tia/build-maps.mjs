// SPDX-License-Identifier: MIT
import { mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const recordMaps = process.env.SPIDER_BUILD_SOURCEMAP === '1';
export const sourcemap = recordMaps ? 'hidden' : false;

// Keep the runtime and npm tarball layouts identical to a normal build.
// `bucket` is relative to dist even for entries built in a staging directory.
export function archiveMaps(bucket = '') {
  if (!recordMaps || !process.env.SPIDER_TIA_MAPS) return [];
  const dest = resolve(process.env.SPIDER_TIA_MAPS, bucket);
  return [{
    name: 'tia-archive-sourcemaps',
    writeBundle({ dir }, bundle) {
      for (const name of Object.keys(bundle).filter(name => name.endsWith('.map'))) {
        const path = join(dest, name);
        mkdirSync(dirname(path), { recursive: true });
        renameSync(join(dir, name), path);
      }
    },
  }];
}
