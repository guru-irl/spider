import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { ensureFeedWriter, feedWriterLiveness } from '../feed/writer.js';
import type { SessionId, Generation } from '../contracts.js';

const owner = { sessionId: 'writer-fixture' as SessionId, generation: 'writer-generation' as Generation };
let root = '', child: ChildProcess | undefined;
async function stop() { if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; } }
afterEach(async () => { await stop(); child = undefined; if (root) await rm(root, { recursive: true, force: true }); root = ''; });
async function fixture() { const scratch = resolve('.spider/scratch/tmp'); await mkdir(scratch, { recursive: true }); root = await mkdtemp(join(scratch, 'writer-state-')); return join(root, 'feed-writers', owner.sessionId + '.json'); }

it('reports a matching live writer without changing its record', async () => {
  const path = await fixture(); await ensureFeedWriter(root, owner);
  const before = await readFile(path), mtime = (await stat(path)).mtimeMs;
  expect(await feedWriterLiveness(root, owner.sessionId)).toEqual({ kind: 'alive' });
  expect(await readFile(path)).toEqual(before);
  expect((await stat(path)).mtimeMs).toBe(mtime);
});

it('reports confirmed dead only after its real writer process exits', async () => {
  const path = await fixture(), source = join(root, 'writer.ts');
  await writeFile(source, `import { ensureFeedWriter } from ${JSON.stringify(resolve('packages/herdr/src/feed/writer.ts'))};
await ensureFeedWriter(process.argv[2], JSON.parse(process.argv[3])); console.log('ready'); setInterval(()=>{},1000);\n`);
  await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, build: { ssr: source, outDir: root, emptyOutDir: false,
    rollupOptions: { external: id => id.startsWith('node:'), output: { entryFileNames: 'writer.mjs' } } } });
  child = spawn(process.execPath, [join(root, 'writer.mjs'), root, JSON.stringify(owner)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => { child!.stdout!.once('data', () => resolve()); child!.once('error', reject); child!.once('exit', code => reject(new Error(`writer exited ${code}`))); });
  const before = await readFile(path); await stop();
  expect(await feedWriterLiveness(root, owner.sessionId)).toEqual({ kind: 'dead' });
  expect(await readFile(path)).toEqual(before);
});

it.each(['missing', 'unreadable', 'malformed', 'identity mismatch'])('reports %s ownership as unknown, never ended', async kind => {
  const path = await fixture();
  if (kind !== 'missing') {
    await ensureFeedWriter(root, owner);
    if (kind === 'unreadable') await chmod(path, 0);
    else if (kind === 'malformed') await writeFile(path, '{');
    else { const value = JSON.parse(await readFile(path, 'utf8')); value.startIdentity = 'not-the-live-process'; await writeFile(path, JSON.stringify(value)); }
  }
  const before = kind === 'missing' ? null : (await stat(path)).mtimeMs;
  await expect(feedWriterLiveness(root, owner.sessionId)).resolves.toEqual({ kind: 'unknown' });
  expect(kind === 'missing' ? await stat(path).catch(() => null) : (await stat(path)).mtimeMs).toBe(before);
});
