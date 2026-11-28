import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HerdrHarness } from '../../../herdr/src/__tests__/isolated.js';

export const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

interface RecordedHc {
  binary: string;
  calls(): Promise<{ argv: string[] }[]>;
}

export async function writeRecordedHc(h: Pick<HerdrHarness, 'root' | 'mode' | 'hcBinary'>, name: string, coreAvailable = true): Promise<RecordedHc> {
  const binary = join(h.root, name), log = join(h.root, `${name}.jsonl`), logger = join(h.root, `${name}.mjs`);
  await writeFile(log, '');
  const record = `import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv }) + '\\n');
`;
  let script: string;
  if (h.mode === 'fake') {
    // Import the same CLI the fake hc wrapper would exec, in this process.
    const fake = new URL('../../../herdr/src/__tests__/fake-hc.mjs', import.meta.url);
    await writeFile(logger, record + `
if (!${coreAvailable} && argv[0] === 'server' && argv[1] === 'status') {
  console.error(JSON.stringify({ error: { kind: 'unavailable', message: 'Fixture core is offline' } }));
  process.exit(2);
}
await import(${JSON.stringify(fake.href)});
`);
    script = `exec ${shellQuote(process.execPath)} ${shellQuote(logger)} "$@"`;
  } else {
    await writeFile(logger, record);
    const offline = 'if [ "$1" = server ] && [ "$2" = status ]; then printf \'%s\\n\' \'{"error":{"kind":"unavailable","message":"Fixture core is offline"}}\' >&2; exit 2; fi\n';
    script = `${shellQuote(process.execPath)} ${shellQuote(logger)} "$@"\n${coreAvailable ? '' : offline}exec ${shellQuote(h.hcBinary)} "$@"`;
  }
  await writeFile(binary, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  return {
    binary,
    calls: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { argv: string[] }),
  };
}
