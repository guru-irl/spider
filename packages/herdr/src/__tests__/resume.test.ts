// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Owner, SessionId, Generation, TerminalIdentity } from '../contracts.js';
import { createTerminalRegistry } from '../sessions/registry.js';
import { createProcessPresence } from '../sessions/presence.js';
import { createSessionLeases } from '../sessions/lease.js';
import { buildResumeBlock, offerResume, resumeOfferShell, type ResumeHookOptions } from '../sessions/resume.js';
let root: string; let file: string; let terminal: TerminalIdentity; let owner: Owner; let options: ResumeHookOptions;
beforeEach(async () => {
  await mkdir(resolve('.spider/scratch/h'), { recursive: true }); root = await mkdtemp(resolve('.spider/scratch/h/g2-')); file = join(root, "session 'quoted'.jsonl");
  terminal = { coreId: 'core', terminalId: 't1', address: 't1', socket: join(root, 'socket'), sessionNamespace: 'g2' } as TerminalIdentity;
  owner = { sessionId: 's1' as SessionId, generation: 'g1' as Generation, terminal, sessionFile: file, cwd: root, name: "session 'quoted' $(false)" };
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: 's1', cwd: root }) + '\n');
  await createTerminalRegistry(root).record({ owner, recordedAt: 10, coreStartedAt: 1, environment: { agentDirectory: join(root, 'agent'), extensionArguments: [] } });
  options = { nodePath: process.execPath, cliPath: join(root, "cli 'quoted'.mjs"), configPath: join(root, 'config.json'), hookPath: fileURLToPath(new URL('../../assets/shell/resume.sh', import.meta.url)) };
});
afterEach(async () => rm(root, { recursive: true, force: true }));
function ports(start = 20) { return { registry: createTerminalRegistry(root), processInventory: { presence: createProcessPresence(root), leases: createSessionLeases(root), processes: async () => [], probe: async () => ({ kind: 'absent' as const }) }, coreStartedAt: async () => start }; }
async function shell(body: string, hc = true, interactive = true, binary = '/bin/bash') {
  return new Promise<{ out: string; code: number | null }>((resolveRun, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, TMPDIR: root }; delete env.HC_TERMINAL_ID; delete env.HC_TERMINAL_SOCKET;
    if (hc) { env.HC_TERMINAL_ID = 't1'; env.HC_TERMINAL_SOCKET = terminal.socket; }
    const child = spawn(binary, [...(binary === '/bin/zsh' ? ['-f'] : ['--noprofile', '--norc']), ...(interactive ? ['-i'] : []), '-c', body], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; child.stdout.on('data', b => out += b); child.on('error', reject); child.on('close', code => resolveRun({ out, code }));
  });
}
async function fakeCli() {
  const source = resumeOfferShell({ sessionFile: file, sessionId: owner.sessionId, cwd: root, name: owner.name, argv: ['pi', '--session', file], environment: { agentDirectory: join(root, 'agent'), extensionArguments: [] }, terminal }, options);
  await writeFile(options.cliPath, `import {appendFileSync} from 'node:fs';\nconst a=process.argv.slice(2); if(a[0]==='resume-offer') process.stdout.write(${JSON.stringify(source)}); else appendFileSync(${JSON.stringify(join(root, 'launches.jsonl'))},JSON.stringify({cwd:process.cwd(),argv:a})+'\\n');`);
  await writeFile(join(root, 'launches.jsonl'), '');
}
it('a restored shell offers the exact session without auto-running it', async () => {
  await fakeCli(); const block = buildResumeBlock(options); const offered = await shell(block);
  expect(offered.out).toContain('spider_resume'); expect(await readFile(join(root, 'launches.jsonl'), 'utf8')).toBe('');
  const launched = await shell(block + '\nspider_resume'); expect(launched.code).toBe(0);
  const call = JSON.parse((await readFile(join(root, 'launches.jsonl'), 'utf8')).trim());
  expect(call.cwd).toBe(owner.cwd); expect(call.argv).toEqual(['resume', '--config', options.configPath, '--file', file, '--session-id', 's1', '--cwd', root]);
  expect(await offerResume(terminal, ports())).toMatchObject({ argv: ['pi', '--session', file], cwd: root, name: owner.name });
});
it('noninteractive and non-HC shells do not offer, and declining leaves a shell', async () => {
  await fakeCli(); const block = buildResumeBlock(options);
  expect((await shell(block, false)).out).toBe(''); expect((await shell(block, true, false)).out).toBe('');
  expect((await shell(block + '\nprintf "still a shell"')).out).toContain('still a shell'); expect(await readFile(join(root, 'launches.jsonl'), 'utf8')).toBe('');
});
it('two hook installs leave one marked block and one offer', async () => {
  await fakeCli(); const once = buildResumeBlock({ ...options, existingRc: '# retained\n' }); const twice = buildResumeBlock({ ...options, existingRc: once });
  expect(twice).toBe(once); const output = (await shell(twice)).out; expect(output.match(/spider_resume/g)).toHaveLength(1);
});
it('refuses missing, changed, live and foreign sessions and an unproved restart', async () => {
  expect(await offerResume({ ...terminal, coreId: 'other' as TerminalIdentity['coreId'] }, ports())).toBeNull();
  expect(await offerResume(terminal, ports(10))).toBeNull();
  const live = ports(); await live.processInventory.presence.record({ pid: 100, startIdentity: 'start', sessionFile: file, sessionName: 'live', kind: 'top-level', hcAddress: null });
  expect(await offerResume(terminal, { ...live, processInventory: { ...live.processInventory, probe: async () => ({ kind: 'live', startIdentity: 'start' }) } })).toBeNull();
  await writeFile(file, JSON.stringify({ type: 'session', id: 'changed', cwd: root }) + '\n'); expect(await offerResume(terminal, ports())).toBeNull();
  await rm(file); expect(await offerResume(terminal, ports())).toBeNull();
});

it('an out-of-order resume block is a conflict, not permission to rewrite the rc file', () => {
  expect(() => buildResumeBlock({ ...options, existingRc: '# spider:resume:end\n# retained\n# spider:resume:start\n' })).toThrowError(expect.objectContaining({ code: 'resume-hook-conflict' }));
});

it.skipIf(!existsSync('/bin/zsh'))('zsh executes the same hook and keeps quoted paths literal', async () => {
  await fakeCli(); const output = await shell(buildResumeBlock(options) + '\nspider_resume', true, true, '/bin/zsh');
  expect(output.code).toBe(0); expect(output.out).toContain('spider_resume');
  const call = JSON.parse((await readFile(join(root, 'launches.jsonl'), 'utf8')).trim());
  expect(call.argv).toEqual(['resume', '--config', options.configPath, '--file', file, '--session-id', 's1', '--cwd', root]);
});

it('a recorded absolute extension argument refuses a resume offer with its session name', async () => {
  const foreign = join(root, 'foreign-extension.js');
  await createTerminalRegistry(root).record({ owner, recordedAt: 10, coreStartedAt: 1, environment: { agentDirectory: join(root, 'agent'), extensionArguments: ['--extension', foreign] } });
  await expect(offerResume(terminal, ports())).rejects.toMatchObject({ code: 'session-explicit-extensions', message: expect.stringContaining(owner.name!) });
});
