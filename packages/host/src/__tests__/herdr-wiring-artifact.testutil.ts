import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let artifacts: Promise<ReadonlyMap<string, string | Uint8Array>> | undefined;

async function buildArtifacts(): Promise<ReadonlyMap<string, string | Uint8Array>> {
  const { buildViteFixture: build } = await import('../../../../scripts/test-fixture-build.js');
  const built = await build({
    define: { 'import.meta.spiderHerdrRuntimeEntry': 'false', 'import.meta.spiderPaneEndpointEntry': 'false' },
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: [/^@spider\//] },
    build: {
      ssr: true, write: false, minify: false,
      rollupOptions: {
        input: {
          cli: fileURLToPath(new URL('../../../herdr/src/bin/cli.ts', import.meta.url)),
          'viewer-main': fileURLToPath(new URL('../../../herdr/src/bin/viewer.ts', import.meta.url)),
        },
        external: [/^@earendil-works\//, 'better-sqlite3', 'sqlite-vec'],
        output: { entryFileNames: '[name].mjs' },
      },
    },
  });
  const files = new Map<string, string | Uint8Array>();
  for (const result of Array.isArray(built) ? built : [built]) {
    if (!('output' in result)) throw new Error('Herdr wiring build returned no output');
    for (const file of result.output) files.set(file.fileName, file.type === 'chunk' ? file.code : file.source);
  }
  if (!files.has('cli.mjs') || !files.has('viewer-main.mjs')) throw new Error('Herdr wiring build is missing an entry');
  return files;
}

/** Each fixture still runs its own copies of the real CLI and viewer. */
export async function writeWiringArtifacts(directory: string): Promise<void> {
  const files = await (artifacts ??= buildArtifacts().catch(error => { artifacts = undefined; throw error; }));
  await Promise.all([...files].map(async ([name, bytes]) => {
    const path = join(directory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }));
}
