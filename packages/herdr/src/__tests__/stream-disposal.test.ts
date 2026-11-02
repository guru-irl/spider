// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it, vi } from 'vitest';
import { writeFile, readFile, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createHcEventStream } from '../client/events.js';
import { runRemoteObserver } from '../jobs/observer.js';
import { createHerdrHarness } from './testutil.js';

const exec = promisify(execFile);
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function fixture() {
  const h = await createHerdrHarness('fake'); await h.start();
  const pidFile = join(h.root, 'stream.pid'), termFile = join(h.root, 'stream.term');
  const program = join(h.root, 'stream.mjs'), binary = join(h.root, 'stream-hc');
  const title = 'herdr-stream-' + randomUUID();
  await writeFile(program, `import { writeFileSync, appendFileSync } from 'node:fs';
process.title=${JSON.stringify(title)};
process.on('SIGTERM',()=>appendFileSync(${JSON.stringify(termFile)},'TERM\\n'));
writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
if(process.argv.includes('events'))console.log(JSON.stringify({type:'snapshot',seq:0,terminals:[]}));
setInterval(()=>{},1000);
`);
  await writeFile(binary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(program)} "$@"\n`); await chmod(binary, 0o700);
  return { h, binary, termFile, async pid() { let pid = 0; await vi.waitFor(async () => { pid = Number(await readFile(pidFile, 'utf8')); expect(pid).toBeGreaterThan(0); }, { timeout: 3000 }); return pid; }, async close() {
    const pid = await readFile(pidFile, 'utf8').then(Number, () => 0);
    if (pid && alive(pid)) {
      const command = (await exec('ps', ['-p', String(pid), '-o', 'command='])).stdout;
      if (!command.includes(title)) throw new Error('Refusing to kill a PID that is not this stream fixture');
      process.kill(pid, 'SIGKILL');
    }
    await h.close(); expect(await h.remainingOwnedResources()).toEqual([]);
  } };
}

it('event stream disposal escalates TERM to KILL and concurrent disposals both await child exit', async () => {
  const f = await fixture(), stream = createHcEventStream({ binary: f.binary, env: f.h.localEnv });
  let first: Promise<void> | undefined, second: Promise<void> | undefined;
  try {
    await stream.ready; const pid = await f.pid(); let firstDone = false, secondDone = false;
    first = Promise.resolve(stream.dispose()).then(() => { firstDone = true; });
    second = Promise.resolve(stream.dispose()).then(() => { secondDone = true; });
    await vi.waitFor(async () => expect(await readFile(f.termFile, 'utf8')).toBe('TERM\n'));
    expect(alive(pid)).toBe(true); expect(firstDone).toBe(false); expect(secondDone).toBe(false);
    await vi.waitFor(() => { expect(firstDone).toBe(true); expect(secondDone).toBe(true); }, { timeout: 2500 });
    expect(alive(pid)).toBe(false);
  } finally { await f.close(); await first; await second; await stream.dispose(); }
}, 10000);

it('observer abort escalates TERM to KILL and rejects only after its attach child exits', async () => {
  const f = await fixture(), abort = new AbortController(); let seen: { code?: string } | undefined;
  const pending = runRemoteObserver({ hcBinary: f.binary, address: 'remote.invalid/t1' as never, nonce: 'fixture', exitFile: join(f.h.root, 'removed.json'), env: f.h.localEnv, signal: abort.signal }).catch(error => { seen = error; });
  try {
    const pid = await f.pid(); abort.abort();
    await vi.waitFor(async () => expect(await readFile(f.termFile, 'utf8')).toBe('TERM\n'));
    expect(alive(pid)).toBe(true); expect(seen).toBeUndefined();
    await vi.waitFor(() => expect(seen?.code).toBe('aborted'), { timeout: 2500 });
    expect(alive(pid)).toBe(false);
  } finally { abort.abort(); await f.close(); await pending; }
}, 10000);
