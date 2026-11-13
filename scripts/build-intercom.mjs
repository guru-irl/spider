import { chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
export async function buildIntercom(outDir = resolve('dist/intercom')) {
  await build({ configFile: fileURLToPath(new URL('../vite.intercom.config.mjs', import.meta.url)), build: { outDir } });
  chmodSync(join(outDir, 'broker.mjs'), 0o700);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildIntercom();
