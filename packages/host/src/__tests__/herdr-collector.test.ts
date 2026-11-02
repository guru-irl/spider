// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { join } from 'node:path';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { createHostHerdrPorts } from '../herdr/ports.js';
import type { HcClient, HerdrConfig, JobRecord, PreparedProgram } from '../../../herdr/src/contracts.js';

it('an index published before the receipt keeps a silent background command incomplete', async () => {
  const h = await createHerdrHarness('fake'); await h.start();
  const files = new Map<string, Buffer>();
  const hc: HcClient = { ...h.hc, fileWrite: async (_on, path, bytes) => { files.set(path, bytes); }, fileRead: async (_on, path) => { const bytes = files.get(path); if (!bytes) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'invalid_params' }); return bytes; } };
  const config = { machines: [{ name: 'remote.invalid', nodePath: process.execPath }] } as unknown as HerdrConfig;
  const ports = createHostHerdrPorts({ hc, config, runtimeBytes: Buffer.alloc(0), runtimePath: () => join(h.root, 'runtime.mjs') });
  try {
    const directory = join(h.root, 'remote.invalid/program');
    const job: JobRecord = { version: 1, id: 'job-one' as never, owner: h.owner!, machine: 'remote.invalid' as never, kind: 'exec', phase: { kind: 'preparing' }, viewer: null, localDirectory: join(h.root, 'logs/job-one'), remoteDirectory: directory, detached: false, noticeMode: 'tool', notice: 'pending' };
    const program: PreparedProgram = { directory, argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], files: [], cwd: null, env: {} };
    const launch = await ports.outputCollector.prepare(program, job);
    expect(await ports.logReader(job.id).collect()).toMatchObject({ complete: false, receipt: null });
    files.set(join(directory, 'index.json'), Buffer.from(JSON.stringify({ version: 1, jobId: 'job-one', nonce: launch.nonce, head: null, chunks: [] })));
    expect(await ports.logReader(job.id).collect()).toMatchObject({ complete: false, receipt: null, stdout: '', stderr: '' });
    files.set(join(directory, 'index.json'), Buffer.from('{malformed'));
    await expect(ports.logReader(job.id).collect()).rejects.toThrow();
    files.delete(join(directory, 'index.json'));
    await expect(ports.logReader(job.id).collect()).rejects.toMatchObject({ code: 'remote-index-disappeared' });
  } finally { ports.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
}, 15000);
