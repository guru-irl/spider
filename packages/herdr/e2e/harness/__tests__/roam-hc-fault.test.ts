// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

it('drops one successful exchange reply only after the actual command consumes its input', async () => {
  const scratch = resolve('.spider/scratch/e2'); await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, 'fault-'));
  const real = join(root, 'real-hc'), state = join(root, 'fault.json'), committed = join(root, 'committed');
  await writeFile(real, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';let input='';for await(const chunk of process.stdin) input+=chunk;appendFileSync(${JSON.stringify(committed)},input+'\\n');process.stdout.write('accepted');\n`, { mode: 0o700 });
  await writeFile(state, JSON.stringify({ down: [] }));
  const messageId = '00000000-0000-4000-8000-000000000123';
  await writeFile(`${state}.drop-box-1.invalid`, messageId);
  const program = fileURLToPath(new URL('../../fixtures/roam-hc-fault.mjs', import.meta.url));
  const run = (input: string) => new Promise<{ code: number | null; stdout: string }>((done, fail) => {
    const child = spawn(process.execPath, [program, 'exec', '--on', 'box-1.invalid', '--stdin', 'exchange'], { env: { ...process.env,
      SPIDER_E2E_FIXTURE_ROOT: root, SPIDER_E2E_HC_REAL: real, SPIDER_E2E_HC_FAULT: state }, stdio: 'pipe' });
    let stdout = ''; child.stdout.on('data', data => { stdout += data; }); child.on('error', fail);
    child.on('exit', code => done({ code, stdout })); child.stdin.end(input);
  });
  expect(await run('unrelated')).toEqual({ code: 0, stdout: 'accepted' });
  expect(await run(messageId)).toEqual({ code: 1, stdout: '' });
  expect(await readFile(committed, 'utf8')).toBe(`unrelated\n${messageId}\n`);
  expect(await run('second')).toEqual({ code: 0, stdout: 'accepted' });
  expect(await readFile(committed, 'utf8')).toBe(`unrelated\n${messageId}\nsecond\n`);
}, 5000);


it.each([
  { scope: 'exchange', command: 'setup-local', code: 0 },
  { scope: 'exchange', command: 'exchange', code: 1 },
  { scope: undefined, command: 'setup-local', code: 1 },
])('fences $command with fault scope $scope without hiding management availability', async ({ scope, command, code }) => {
  const scratch = resolve('.spider/scratch/e2'); await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, 'fault-scope-'));
  const real = join(root, 'real-hc'), state = join(root, 'fault.json');
  await writeFile(real, `#!${process.execPath}\nprocess.stdout.write('reached-owned-command');\n`, { mode: 0o700 });
  await writeFile(state, JSON.stringify({ down: ['box-1.invalid'], scope }));
  const program = fileURLToPath(new URL('../../fixtures/roam-hc-fault.mjs', import.meta.url));
  const result = await new Promise<{ code: number | null; stdout: string }>((done, fail) => {
    const child = spawn(process.execPath, [program, 'exec', '--on', 'box-1.invalid', '--', command], { env: { ...process.env,
      SPIDER_E2E_FIXTURE_ROOT: root, SPIDER_E2E_HC_REAL: real, SPIDER_E2E_HC_FAULT: state }, stdio: 'pipe' });
    let stdout = ''; child.stdout.on('data', data => { stdout += data; }); child.on('error', fail);
    child.on('exit', exit => done({ code: exit, stdout })); child.stdin.end();
  });
  expect(result).toEqual({ code, stdout: code === 0 ? 'reached-owned-command' : '' });
}, 5000);
