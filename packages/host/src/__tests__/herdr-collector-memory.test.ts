import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { queryObjects } from 'node:v8';
import { createHostHerdrPorts, type HostHerdrPorts } from '../herdr/ports.js';
import { parseHerdrConfig } from '../../../herdr/src/config.js';
import { sha256 } from '../../../herdr/src/remote/runtime.js';
import type { HcClient, JobRecord } from '../../../herdr/src/contracts.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

let ports: HostHerdrPorts | undefined, root: string | undefined;
afterEach(async () => { vi.restoreAllMocks(); ports?.dispose(); ports = undefined; if (root) await fs.rm(root, { recursive: true, force: true }); root = undefined; });
async function fixture() {
  const base = resolve('.spider/scratch/collector-memory'); await fs.mkdir(base, { recursive: true });
  root = await fs.mkdtemp(join(base, 'case-'));
  const request = Buffer.from(JSON.stringify({ version: 1, jobId: 'job', nonce: 'nonce' }));
  const files = new Map<string, Buffer>([['request.json', request]]);
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected external operation'); };
  const hc: HcClient = { identity: unsupported, caller: unsupported, machines: unsupported, run: unsupported, get: unsupported,
    read: unsupported, kill: unsupported, rm: unsupported, setLabels: unsupported, fileWrite: unsupported,
    events: () => { throw new Error('Unexpected event stream'); }, fileRead: async (_on, path) => {
      const bytes = files.get(path.split('/').pop()!); if (bytes) return bytes;
      throw Object.assign(new Error('Not published'), { code: 'ENOENT' });
    } };
  const config = parseHerdrConfig({ app: { binary: join(root, 'app'), home: root }, core: { binary: join(root, 'hc'), config: join(root, 'core.toml') },
    agentDirectory: root, globalRoot: root, shellRc: join(root, 'shellrc'), spaces: [], machines: [] });
  ports = createHostHerdrPorts({ hc, config, runtimeBytes: Buffer.alloc(0), runtimePath: () => join(root!, 'runtime.mjs') });
  const job: JobRecord = { version: 1, id: 'job' as never, owner: { sessionId: 'session' as never, generation: 'generation' as never,
    terminal: { coreId: 'core' as never, socket: join(root, 'socket'), sessionNamespace: 'fixture', terminalId: 'terminal' as never, address: 'address' as never },
    cwd: root, sessionFile: null, name: null }, machine: 'remote.invalid' as never, kind: 'exec', phase: { kind: 'preparing' },
    viewer: null, localDirectory: join(root, 'logs'), remoteDirectory: '/fixture', detached: false, noticeMode: 'tool', notice: 'pending' };
  return { job, files, request, ports };
}

it('releases the previous result after a job collection settles', async () => {
  const { job, ports } = await fixture();
  await ports.outputCollector.collect(job);
  class CollectedResult {}
  await (async () => {
    const result = await ports.logReader(job.id).collect();
    expect(result.complete).toBe(false);
    Object.setPrototypeOf(result, CollectedResult.prototype);
  })();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(queryObjects(CollectedResult)).toBe(0);
  expect(await ports.logReader(job.id).collect()).toMatchObject({ complete: false, stdout: '', stderr: '' });
});

it('checks completion with bounded log reads even when full capture is unavailable', async () => {
  const { job, files, request, ports } = await fixture();
  const text = 'Saved output.\n'.repeat(8192);
  await fs.mkdir(job.localDirectory);
  for (const stream of ['stdout', 'stderr']) {
    await fs.writeFile(join(job.localDirectory, stream + '.log'), stream === 'stdout' ? text : '');
    await fs.writeFile(join(job.localDirectory, stream + '.offset'), JSON.stringify({ version: 1, offset: stream === 'stdout' ? Buffer.byteLength(text) : 0 }));
  }
  const index = Buffer.from(JSON.stringify({ version: 1, jobId: 'job', nonce: 'nonce', head: null, chunks: [] }));
  const receipt = Buffer.from(JSON.stringify({ version: 1, jobId: 'job', nonce: 'nonce', requestSha256: sha256(request), indexSha256: sha256(index),
    stdoutBytes: Buffer.byteLength(text), stderrBytes: 0, finishedAt: 1, outcome: 'exited', exitCode: 0, signal: null }));
  files.set('index.json', index); files.set('receipt.json', receipt); files.set('receipt.json.sha256', Buffer.from(sha256(receipt)));
  const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const limited = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const file = await open(...args);
    return new Proxy(file, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key === 'read') return (...values: unknown[]) => {
        if (Buffer.isBuffer(values[0]) && values[0].length > 16 * 1024) throw new Error('Full capture unavailable');
        return Reflect.apply(value, target, values);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  });
  expect(await ports.outputCollector.collect(job)).toMatchObject({ complete: true, receipt: { finish: { exitCode: 0 } } });
  await expect(ports.logReader(job.id).collect()).rejects.toThrow('Full capture unavailable');
  limited.mockRestore();
  expect(await ports.logReader(job.id).collect()).toMatchObject({ complete: true, stdout: text, stderr: '' });
});
