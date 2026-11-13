import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const compiler = vi.hoisted(() => ({ run: async (_options: any) => {} }));
vi.mock('vite', () => ({ build: (options: any) => compiler.run(options) }));
import { buildIntercom } from '../../../../scripts/build-intercom.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const scratch = resolve('.spider/scratch/intercom-build'); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'case-')); roots.push(root);
  const out = join(root, 'dist/intercom'); mkdirSync(out, { recursive: true });
  const broker = join(out, 'broker.mjs'); writeFileSync(broker, 'previous broker');
  return { root, out, broker };
}

it('keeps the existing broker while a new build is incomplete', async () => {
  const f = fixture();
  let begin!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  compiler.run = async options => {
    const output = options.build.outDir;
    rmSync(output, { recursive: true, force: true }); mkdirSync(output, { recursive: true });
    begin(); await gate;
    writeFileSync(join(output, 'broker.mjs'), 'new broker');
  };
  const building = buildIntercom(f.out);
  try { await started; expect(readFileSync(f.broker, 'utf8')).toBe('previous broker'); }
  finally { release(); await building; }
  expect(readFileSync(f.broker, 'utf8')).toBe('new broker');
  if (process.platform !== 'win32') expect(statSync(f.broker).mode & 0o777).toBe(0o700);
  expect(readdirSync(join(f.root, 'dist'))).toEqual(['intercom']);
}, 5000);

it('leaves the previous broker intact if a build fails', async () => {
  const f = fixture();
  compiler.run = async options => {
    rmSync(options.build.outDir, { recursive: true, force: true });
    throw new Error('fixture build failed');
  };
  await expect(buildIntercom(f.out)).rejects.toThrow('fixture build failed');
  expect(existsSync(f.broker)).toBe(true);
  expect(readFileSync(f.broker, 'utf8')).toBe('previous broker');
  expect(readdirSync(join(f.root, 'dist'))).toEqual(['intercom']);
}, 5000);
