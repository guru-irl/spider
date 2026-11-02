import { afterEach, expect, it, vi } from 'vitest';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { cleanup, fixture, type SetupFixture } from './herdr-setup-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const runs = async (f: SetupFixture) => {
  const calls: { argv: string[] }[] = f.h.mode === 'hc'
    ? (await readFile(join(f.h.root, 'observed-core-calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    : await f.h.calls();
  return calls.filter(call => call.argv[0] === 'run');
};
async function observeCore(f: SetupFixture): Promise<void> {
  const log = join(f.h.root, 'observed-core-calls.jsonl'), script = join(f.h.root, 'observe-core.mjs'), binary = join(f.h.root, 'observed-core');
  await writeFile(log, '');
  await writeFile(script, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv:process.argv.slice(2)}) + '\\n');\n`);
  await writeFile(binary, `#!/bin/sh\n'${process.execPath}' '${script}' "$@" || exit $?\nexec '${f.h.hcBinary}' "$@"\n`); await chmod(binary, 0o700);
  const config = JSON.parse(await readFile(f.request.configPath, 'utf8')); config.core.binary = binary;
  await writeFile(f.request.configPath, JSON.stringify(config)); f.request = await f.ports.request(f.request.configPath);
}
async function replay(f: SetupFixture) {
  const before = (await runs(f)).length, path = join(f.request.journalRoot, 'journal.json'), journal = await readFile(path);
  let output = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  let result;
  try { result = await setupHerdr(f.request, await f.ports.setupParts(f.request)); } finally { stdout.mockRestore(); }
  const added = (await runs(f)).slice(before);
  expect(added).toHaveLength(f.request.config.machines.length);
  for (const call of added) { expect(call.argv).toContain('--probe'); expect(call.argv).not.toContain('--version'); }
  expect(result.writes).toEqual([]);
  expect(await readFile(path)).toEqual(journal);
  expect(output).not.toContain('verified earlier');
}

for (const mode of ['fake', 'hc'] as const) it.skipIf(mode === 'hc' && process.env.SPIDER_HERDR_E2E !== '1')(`unchanged setup launches one live root probe per machine (${mode})`, async () => {
  const f = await fixture(mode); if (mode === 'hc') await observeCore(f);
  await setupHerdr(f.request, await f.ports.setupParts(f.request));
  expect((await runs(f)).length).toBeGreaterThan(0);
  await replay(f);
}, 60000);

it.each(['runtime', 'node path', 'root', 'machine', 'missing entry', 'corrupt entry', 'invalid result'])('a changed %s is checked live instead of trusting recorded evidence', async change => {
  const f = await fixture(); await setupHerdr(f.request, await f.ports.setupParts(f.request)); await replay(f);
  const config = JSON.parse(await readFile(f.request.configPath, 'utf8'));
  if (change === 'runtime') {
    const runtime = join(f.root, 'dist/herdr/remote-runtime.mjs');
    await writeFile(runtime, (await readFile(runtime, 'utf8')) + '\n// new runtime bytes\n');
  } else if (change === 'node path') {
    const node = join(f.h.root, 'other-node');
    await writeFile(node, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`); await chmod(node, 0o700);
    config.machines[0].nodePath = node;
  } else if (change === 'root') config.machines[0].runtime.directory = join(f.h.directories.remote, 'other-root');
  else if (change === 'machine') {
    await f.h.cli(['machine', 'add', '--via', join(f.h.root, 'via'), '--name', 'next.invalid', '--session', 'r', '--json']);
    cleanup.push(async () => { if ((await f.h.hc.machines()).some(machine => machine.name === 'next.invalid')) await f.h.cli(['machine', 'rm', 'next.invalid', '--json']); });
    config.machines[0].name = 'next.invalid';
  } else {
    const path = join(f.request.journalRoot, 'journal.json'), journal = JSON.parse(await readFile(path, 'utf8'));
    if (change === 'missing entry') delete journal.runtimeRootProbes;
    else if (change === 'corrupt entry') journal.runtimeRootProbes = [{ broken: true }];
    else journal.runtimeRootProbes[0].result.mode = 0o755;
    await writeFile(path, JSON.stringify(journal));
  }
  await writeFile(f.request.configPath, JSON.stringify(config));
  f.request = await f.ports.request(f.request.configPath);
  const before = (await runs(f)).length;
  await setupHerdr(f.request, await f.ports.setupParts(f.request));
  expect((await runs(f)).slice(before).some(call => call.argv.includes('--probe'))).toBe(true);
  await replay(f);
}, 60000);

it('a failed earlier root probe is never reused as passing evidence', async () => {
  const f = await fixture();
  await f.h.scenario({ steps: [{ argvIncludes: ['--probe'], stderr: 'earlier probe failed', exitCode: 1 }] });
  await expect(setupHerdr(f.request, await f.ports.setupParts(f.request))).rejects.toMatchObject({ code: 'runtime-bootstrap-failed' });
  await f.h.scenario({});
  const before = (await runs(f)).length;
  await setupHerdr(f.request, await f.ports.setupParts(f.request));
  expect((await runs(f)).slice(before).some(call => call.argv.includes('--probe'))).toBe(true);
  await replay(f);
}, 60000);
