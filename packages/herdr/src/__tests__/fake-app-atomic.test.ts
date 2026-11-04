// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createClientFixture } from './testutil.js';
import { invokeCli } from '../client/cli-transport.js';

test('scenario publication keeps the previous app document readable until replacement', async () => {
  const f = await createClientFixture();
  const document = join(f.root, 'app.json'), entered = join(f.root, 'writing'), release = join(f.root, 'continue');
  const preload = join(f.root, 'partial-write.mjs');
  let writing: Promise<unknown> | undefined;
  try {
    await writeFile(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const write = fs.writeFileSync;
fs.writeFileSync = (path, data, ...args) => {
  if (String(path).includes('app.json') && String(data).includes('publication-test')) {
    const bytes = Buffer.from(data), middle = Math.floor(bytes.length / 2), fd = fs.openSync(path, 'w');
    fs.writeSync(fd, bytes.subarray(0, middle)); write(${JSON.stringify(entered)}, 'ready');
    while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    fs.writeSync(fd, bytes.subarray(middle)); fs.closeSync(fd); return;
  }
  return write(path, data, ...args);
};
syncBuiltinESMExports();`);
    await writeFile(join(f.root, 'scenario.json'), JSON.stringify({ appSteps: [{ argvPrefix: ['status'], writes: { [document]: JSON.stringify({ spaces: [], marker: 'publication-test' }) } }] }));
    writing = invokeCli(f.appBinary, ['status'], { ...f.localEnv, NODE_OPTIONS: `--import=${preload}` });
    await expect.poll(() => access(entered).then(() => true, () => false)).toBe(true);
    const terminal = await invokeCli(f.hcBinary, ['get', 't1'], f.localEnv);
    expect(terminal).toMatchObject({ address: 't1', cols: 320, rows: 80 });
    expect(JSON.parse(await readFile(document, 'utf8'))).toEqual({ spaces: [] });
    await writeFile(release, 'continue'); await writing;
    expect(JSON.parse(await readFile(document, 'utf8'))).toEqual({ spaces: [], marker: 'publication-test' });
  } finally {
    await writeFile(release, 'continue'); await writing?.catch(() => {}); await f.close();
  }
});
