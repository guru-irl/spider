import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
export async function buildIntercom(outDir = resolve('dist/intercom')) {
  const target = resolve(outDir), parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, '.intercom-build-'));
  try {
    await build({ configFile: fileURLToPath(new URL('../vite.intercom.config.mjs', import.meta.url)), build: { outDir: staging } });
    const broker = join(staging, 'broker.mjs');
    chmodSync(broker, 0o700);
    mkdirSync(target, { recursive: true });
    renameSync(broker, join(target, 'broker.mjs'));
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildIntercom();
