// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildViteFixture as build } from '../../../../scripts/test-fixture-build.js';

type BundledFile = { name: string; bytes: Buffer };

export function createBundledFixture(name: string, source: string): (root: string) => Promise<string> {
  let bundle: Promise<readonly BundledFile[]> | undefined;
  return async root => {
    bundle ??= (async () => {
      const entry = join(root, `${name}.ts`);
      await writeFile(entry, source);
      const result = await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, build: {
        ssr: entry, outDir: root, emptyOutDir: false, write: false,
        rollupOptions: { external: id => id.startsWith('node:'), output: { entryFileNames: `${name}.mjs` } },
      } });
      const files = (Array.isArray(result) ? result : [result]).flatMap(output => {
        if (!('output' in output)) throw new Error('Writer build returned no output');
        return output.output.map(file => ({ name: file.fileName, bytes: Buffer.from(file.type === 'chunk' ? file.code : file.source) }));
      });
      if (!files.some(file => file.name === `${name}.mjs`)) throw new Error('Writer build returned no entry');
      return files;
    })();
    for (const file of await bundle) {
      const destination = join(root, file.name);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.bytes);
    }
    return join(root, `${name}.mjs`);
  };
}
