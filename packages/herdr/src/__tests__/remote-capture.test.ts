import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { collectRemoteChunks, createFileLogSink } from '../remote/transfer.js';
import { sha256 } from '../remote/runtime.js';
import type { HcClient } from '../contracts.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('collects receipt evidence without requiring output decoding', async () => {
  const base = resolve('.spider/scratch/remote-capture'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-')); roots.push(root);
  const text = Buffer.from('Saved output.\n');
  const index = Buffer.from(JSON.stringify({ version: 1, jobId: 'job', nonce: 'nonce', head: null,
    chunks: [{ file: 'chunk-00000000.json', stream: 'stdout', offset: 0, bytes: text.length, sha256: sha256(text) }] }));
  const receipt = Buffer.from(JSON.stringify({ version: 1, jobId: 'job', nonce: 'nonce', requestSha256: sha256('request'),
    indexSha256: sha256(index), stdoutBytes: text.length, stderrBytes: 0, finishedAt: 1, outcome: 'exited', exitCode: 0, signal: null }));
  const files = new Map([
    ['index.json', index], ['receipt.json', receipt], ['receipt.json.sha256', Buffer.from(sha256(receipt))],
    ['chunk-00000000.json', Buffer.from(JSON.stringify({ stream: 'stdout', offset: 0, data: text.toString('base64') }))],
  ]);
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected external operation'); };
  const hc: HcClient = { identity: unsupported, caller: unsupported, machines: unsupported, run: unsupported, get: unsupported,
    read: unsupported, kill: unsupported, rm: unsupported, setLabels: unsupported, fileWrite: unsupported,
    events: () => { throw new Error('Unexpected event stream'); }, fileRead: async (_on, path) => {
      const bytes = files.get(path.split('/').pop()!); if (!bytes) throw new Error('Unknown fixture file'); return bytes;
    } };
  const location = { on: 'remote.invalid' as never, directory: '/fixture', jobId: 'job', nonce: 'nonce', requestSha256: sha256('request') };
  const sink = await createFileLogSink(root);
  const metadata = await collectRemoteChunks(hc, location, { ...sink, read: async () => { throw new Error('Output decoding unavailable'); } }, { capture: false });
  expect(metadata).toMatchObject({ complete: true, stdout: '', stderr: '', stdoutBytes: text.length, receipt: { exitCode: 0 } });
  expect(await readFile(join(root, 'stdout.log'))).toEqual(text);
  expect(JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8'))).toMatchObject({ exitCode: 0, stdoutBytes: text.length });
  expect(await collectRemoteChunks(hc, location, sink)).toMatchObject({ complete: true, stdout: text.toString(), stderr: '' });
  files.set('chunk-00000000.json', Buffer.from(JSON.stringify({ stream: 'stdout', offset: 0, data: Buffer.from('Corrupt output').toString('base64') })));
  const other = await createFileLogSink(join(root, 'other'));
  await expect(collectRemoteChunks(hc, location, other, { capture: false })).rejects.toMatchObject({ code: 'remote-chunk-digest-mismatch' });
});
