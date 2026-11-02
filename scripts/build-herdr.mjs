// SPDX-License-Identifier: MIT
import { build } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildHerdrEntries() {
  for (const mode of ['cli', 'viewer', 'remote-runtime']) {
    await build({ configFile: fileURLToPath(new URL('../vite.herdr.config.mjs', import.meta.url)), mode });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildHerdrEntries();
}
