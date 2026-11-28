import { resolve } from 'node:path';
import { buildViteFixture as build } from '../../../../scripts/test-fixture-build.js';

let artifact: Promise<Buffer> | undefined;
/** Build once per test module graph without writing or replacing packaged files. */
export function buildRuntimeArtifact(): Promise<Buffer> {
  return artifact ??= (async () => {
    const built = await build({ configFile: resolve('vite.herdr.config.mjs'), mode: 'remote-runtime', logLevel: 'error',
      build: { write: false, emptyOutDir: false } });
    for (const output of Array.isArray(built) ? built : [built]) {
      if (!('output' in output)) throw new Error('Runtime artifact build returned no output');
      const entry = output.output.find(chunk => chunk.type === 'chunk' && chunk.isEntry);
      if (entry?.type === 'chunk') return Buffer.from(entry.code);
    }
    throw new Error('Runtime artifact build returned no entry');
  })();
}
