// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import type { Owner, SessionId, Generation, TerminalIdentity } from '../contracts.js';
import { createTerminalRegistry } from '../sessions/registry.js';
import { createProcessPresence } from '../sessions/presence.js';
import { createSessionLeases, type ProcessInventoryPorts } from '../sessions/lease.js';
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
async function claims(path: string) { return (await readdir(path)).filter(name => /^\d/.test(name)); }
async function shell(body: string, hc: boolean | 'id' | 'socket' = true, interactive = true, binary = '/bin/bash') {
  return new Promise<{ out: string; code: number | null }>((resolveRun, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, TMPDIR: root }; delete env.HC_TERMINAL_ID; delete env.HC_TERMINAL_SOCKET;
    if (hc === true || hc === 'id') env.HC_TERMINAL_ID = 't1';
    if (hc === true || hc === 'socket') env.HC_TERMINAL_SOCKET = terminal.socket;
    const child = spawn(binary, [...(binary === '/bin/zsh' ? ['-f'] : ['--noprofile', '--norc']), ...(interactive ? ['-i'] : []), '-c', body], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; child.stdout.on('data', b => out += b); child.on('error', reject); child.on('close', code => resolveRun({ out, code }));
  });
}
const firstPrompt = (binary = '/bin/bash') => binary.endsWith('zsh') ? '\nfor _hook in "${precmd_functions[@]}"; do "$_hook"; done\n' : '\neval "$PROMPT_COMMAND"\n';
async function fakeCli(mode: 'offer' | 'auto' = 'offer') {
  const source = resumeOfferShell({ sessionFile: file, sessionId: owner.sessionId, cwd: root, name: owner.name, argv: ['pi', '--session', file], environment: { agentDirectory: join(root, 'agent'), extensionArguments: [] }, terminal }, options, mode);
  await writeFile(options.cliPath, `import {appendFileSync} from 'node:fs';\nconst a=process.argv.slice(2); if(a[0]==='resume-offer') process.stdout.write(${JSON.stringify(source)}); else appendFileSync(${JSON.stringify(join(root, 'launches.jsonl'))},JSON.stringify({cwd:process.cwd(),argv:a,postRc:process.env.POST_RC})+'\\n');`);
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
it.each(['/bin/bash', '/bin/zsh'])('auto starts at the first %s prompt after the rc file and runs once', async binary => {
  if (!existsSync(binary)) return;
  await fakeCli('auto');
  const rc = join(root, binary.endsWith('zsh') ? '.zshrc' : 'bashrc');
  const existingHook = binary.endsWith('zsh') ? "precmd() { printf 'existing hook\\n'; }\n" : "PROMPT_COMMAND=\"printf 'existing hook\\\\n'\"\n";
  await writeFile(rc, existingHook + buildResumeBlock(options) + "\nexport POST_RC=loaded\nprintf 'rc tail\\n'\nPS1=''\n");
  const env = { ...process.env, HOME: root, ZDOTDIR: root, HC_TERMINAL_ID: 't1', HC_TERMINAL_SOCKET: terminal.socket };
  const result = await new Promise<{ out: string; err: string; code: number | null }>((resolveRun, reject) => {
    const child = spawn(binary, binary.endsWith('zsh') ? ['-i'] : ['--noprofile', '--rcfile', rc, '-i'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', chunk => out += chunk); child.stderr.on('data', chunk => err += chunk);
    child.on('error', reject); child.on('close', code => resolveRun({ out, err, code }));
    child.stdin.end("printf 'first command\\n'\nprintf 'second command\\n'\nexit\n");
  });
  expect(result.code, result.err).toBe(0);
  expect(result.out.indexOf('rc tail')).toBeLessThan(result.out.indexOf('Resuming '));
  expect(result.out.indexOf('Resuming ')).toBeLessThan(result.out.indexOf('first command'));
  expect(result.out.match(/existing hook/g)?.length).toBeGreaterThanOrEqual(2);
  const lines = (await readFile(join(root, 'launches.jsonl'), 'utf8')).trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toMatchObject({ cwd: root, postRc: 'loaded' });
});

it('auto resumes the exact session once and returns to the shell', async () => {
  await fakeCli('auto');
  const result = await shell(buildResumeBlock(options) + firstPrompt() + '\nprintf "shell returned\\n"');
  expect(result.code).toBe(0);
  expect(result.out).toBe(`Resuming ${owner.name}…\nshell returned\n`);
  const lines = (await readFile(join(root, 'launches.jsonl'), 'utf8')).trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toEqual({ cwd: root, argv: ['resume', '--config', options.configPath, '--file', file, '--session-id', 's1', '--cwd', root] });
});

it('noninteractive and non-HC shells do not offer, and declining leaves a shell', async () => {
  await fakeCli(); const block = buildResumeBlock(options);
  expect((await shell(block, false)).out).toBe(''); expect((await shell(block, true, false)).out).toBe('');
  expect((await shell(block + '\nprintf "still a shell"')).out).toContain('still a shell'); expect(await readFile(join(root, 'launches.jsonl'), 'utf8')).toBe('');
});
it('the real hook starts only one automatic resume across concurrent and later shells', async () => {
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@spider/db-core': fileURLToPath(new URL('../../../db-core/src/command-env.ts', import.meta.url)) } }, build: { ssr: fileURLToPath(new URL('./fixtures/auto-resume-shell-cli.ts', import.meta.url)), outDir: root, emptyOutDir: false, rollupOptions: { output: { entryFileNames: 'shell-cli.mjs' } } } });
  const block = buildResumeBlock({ ...options, cliPath: join(root, 'shell-cli.mjs') });
  const first = shell(block + firstPrompt() + '\nprintf "shell returned\\n"');
  const second = shell(block + firstPrompt() + '\nprintf "shell returned\\n"');
  let ready = false;
  for (let i = 0; i < 1000; i++) { if ((await readdir(root)).filter(name => name.startsWith('ready-')).length === 2) { ready = true; break; } await delay(10); }
  expect(ready).toBe(true);
  await writeFile(join(root, 'go'), '');
  const results = await Promise.all([first, second]);
  expect(results.map(result => result.out).filter(out => out.includes('Resuming '))).toHaveLength(1);
  expect(results.every(result => result.out.includes('shell returned'))).toBe(true);
  expect((await shell(block + '\nprintf "later shell\\n"')).out).toBe('later shell\n');
  const launches = (await readFile(join(root, 'automatic-launches'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(launches).toEqual([{ cwd: root, args: ['resume', '--config', join(root, 'config.json'), '--file', file, '--session-id', 's1', '--cwd', root] }]);
}, 30000);

it('a crash after the automatic claim does not start pi on a later shell', async () => {
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@spider/db-core': fileURLToPath(new URL('../../../db-core/src/command-env.ts', import.meta.url)) } }, build: { ssr: fileURLToPath(new URL('./fixtures/auto-resume-shell-cli.ts', import.meta.url)), outDir: root, emptyOutDir: false, rollupOptions: { output: { entryFileNames: 'shell-cli.mjs' } } } });
  await writeFile(join(root, 'go'), '');
  const block = buildResumeBlock({ ...options, cliPath: join(root, 'shell-cli.mjs') });
  expect((await shell('export RESUME_TEST_CRASH=1\n' + block + firstPrompt() + '\nprintf "shell returned\\n"')).out).toBe('shell returned\n');
  expect((await shell(block + '\nprintf "later shell\\n"')).out).toBe('later shell\n');
  expect(existsSync(join(root, 'automatic-launches'))).toBe(false);
}, 30000);

it('auto leaves noninteractive and non-Herdr shells untouched', async () => {
  await fakeCli('auto'); const block = buildResumeBlock(options);
  expect((await shell(block, false)).out).toBe('');
  expect((await shell(block, true, false)).out).toBe('');
  expect(await readFile(join(root, 'launches.jsonl'), 'utf8')).toBe('');
});

it.each(['id', 'socket'] as const)('a shell with only the Herdr %s variable does not offer or launch', async hc => {
  for (const mode of ['offer', 'auto'] as const) {
    await fakeCli(mode);
    expect((await shell(buildResumeBlock(options) + firstPrompt(), hc)).out).toBe('');
    expect(await readFile(join(root, 'launches.jsonl'), 'utf8')).toBe('');
  }
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

it('claims automatic resume once per terminal and proved core start, pruning older claims', async () => {
  const auto = (start: number) => ({ ...ports(start), autoResumeRoot: root });
  expect(await offerResume(terminal, auto(20))).not.toBeNull();
  expect(await offerResume(terminal, auto(20))).toBeNull();
  const directory = join(root, 'resume-starts');
  const [terminalDirectory] = await readdir(directory);
  const path = join(directory, terminalDirectory);
  expect(await claims(path)).toEqual(['20']);
  expect((await stat(join(path, '20'))).mode & 0o777).toBe(0o600);
  await writeFile(join(path, '15'), '', { mode: 0o600 });
  expect(await offerResume(terminal, auto(20))).toBeNull();
  expect(await claims(path)).toEqual(['20']);
  expect(await offerResume(terminal, auto(30))).not.toBeNull();
  expect(await claims(path)).toEqual(['30']);
  expect(new Set(await readdir(path))).toEqual(new Set(['seen-30', '30']));
  expect(await offerResume(terminal, auto(30))).toBeNull();
  expect(await offerResume(terminal, auto(20))).toBeNull();
});

it('simultaneous automatic claims are exclusive per terminal, not per session', async () => {
  const auto = { ...ports(), autoResumeRoot: root };
  const other = { ...terminal, terminalId: 't2', address: 't2' } as TerminalIdentity;
  await createTerminalRegistry(root).record({ owner: { ...owner, terminal: other }, recordedAt: 10, coreStartedAt: 1, environment: { agentDirectory: join(root, 'agent'), extensionArguments: [] } });
  const claims = await Promise.all([offerResume(terminal, auto), offerResume(terminal, auto)]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await offerResume(other, auto)).not.toBeNull();
});

it.each(['foreign terminal', 'no session file', 'unproved restart', 'same core epoch', 'invalid epoch', 'live holder', 'uncertain holder', 'missing file', 'invalid header', 'changed id', 'explicit extensions'] as const)('auto refuses %s before claiming', async condition => {
  const registry = createTerminalRegistry(root);
  let identity = terminal, start = 20;
  let inventory: ProcessInventoryPorts = ports().processInventory;
  if (condition === 'foreign terminal') identity = { ...terminal, coreId: 'other' as TerminalIdentity['coreId'] };
  if (condition === 'no session file') await registry.record({ owner: { ...owner, sessionFile: null }, recordedAt: 10, coreStartedAt: 1, environment: { agentDirectory: join(root, 'agent'), extensionArguments: [] } });
  if (condition === 'unproved restart') start = 10;
  if (condition === 'same core epoch') await registry.record({ owner, recordedAt: 10, coreStartedAt: 20, environment: { agentDirectory: join(root, 'agent'), extensionArguments: [] } });
  if (condition === 'invalid epoch') start = NaN;
  if (condition === 'live holder' || condition === 'uncertain holder') {
    await inventory.presence.record({ pid: 100, startIdentity: 'start', sessionFile: file, sessionName: 'live', kind: 'top-level', hcAddress: null });
    inventory = { ...inventory, probe: async () => condition === 'live holder' ? { kind: 'live' as const, startIdentity: 'start' } : { kind: 'unknown' as const } };
  }
  if (condition === 'missing file') await rm(file);
  if (condition === 'invalid header') await writeFile(file, 'invalid\n');
  if (condition === 'changed id') await writeFile(file, JSON.stringify({ type: 'session', id: 'other', cwd: root }) + '\n');
  if (condition === 'explicit extensions') await registry.record({ owner, recordedAt: 10, coreStartedAt: 1, environment: { agentDirectory: join(root, 'agent'), extensionArguments: ['--extension', join(root, 'extension.js')] } });
  const result = offerResume(identity, { registry, processInventory: inventory, coreStartedAt: async () => start, autoResumeRoot: root });
  if (condition === 'explicit extensions') await expect(result).rejects.toMatchObject({ code: 'session-explicit-extensions' });
  else expect(await result).toBeNull();
  const markerRoot = join(root, 'resume-starts');
  if (existsSync(markerRoot)) for (const directory of await readdir(markerRoot)) expect(await claims(join(markerRoot, directory))).toEqual([]);
});

it('prunes an older marker after a proved restart even when the session is held', async () => {
  const auto = (start: number) => ({ ...ports(start), autoResumeRoot: root });
  expect(await offerResume(terminal, auto(20))).not.toBeNull();
  const directory = join(root, 'resume-starts');
  const path = join(directory, (await readdir(directory))[0]);
  const next = auto(30);
  await next.processInventory.presence.record({ pid: 100, startIdentity: 'start', sessionFile: file, sessionName: 'live', kind: 'top-level', hcAddress: null });
  const live: ProcessInventoryPorts = { ...next.processInventory, probe: async () => ({ kind: 'live', startIdentity: 'start' }) };
  expect(await offerResume(terminal, { ...next, processInventory: live })).toBeNull();
  expect(await claims(path)).toEqual([]);
  expect(await readdir(path)).toEqual(['seen-30']);
  expect(await offerResume(terminal, auto(20))).toBeNull();
});

it('does not consume an automatic claim when the session is refused', async () => {
  const auto = { ...ports(), autoResumeRoot: root };
  await writeFile(file, JSON.stringify({ type: 'session', id: 'wrong', cwd: root }) + '\n');
  expect(await offerResume(terminal, auto)).toBeNull();
  await writeFile(file, JSON.stringify({ type: 'session', id: 's1', cwd: root }) + '\n');
  expect(await offerResume(terminal, auto)).not.toBeNull();
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

it.skipIf(!existsSync('/bin/zsh'))('zsh auto resumes and returns to the shell', async () => {
  await fakeCli('auto');
  const result = await shell(buildResumeBlock(options) + firstPrompt('/bin/zsh') + '\nprintf "shell returned\\n"', true, true, '/bin/zsh');
  expect(result.code).toBe(0);
  expect(result.out).toBe(`Resuming ${owner.name}…\nshell returned\n`);
  const call = JSON.parse((await readFile(join(root, 'launches.jsonl'), 'utf8')).trim());
  expect(call.argv).toEqual(['resume', '--config', options.configPath, '--file', file, '--session-id', 's1', '--cwd', root]);
});

it('explicit extensions stay silent when no core restart is proved', async () => {
  await createTerminalRegistry(root).record({ owner, recordedAt: 10, coreStartedAt: 1, environment: { agentDirectory: join(root, 'agent'), extensionArguments: ['--extension', join(root, 'extension.js')] } });
  expect(await offerResume(terminal, ports(10))).toBeNull();
  expect(await offerResume(terminal, { ...ports(10), autoResumeRoot: root })).toBeNull();
});

it('a recorded absolute extension argument refuses a resume offer with its session name', async () => {
  const foreign = join(root, 'foreign-extension.js');
  await createTerminalRegistry(root).record({ owner, recordedAt: 10, coreStartedAt: 1, environment: { agentDirectory: join(root, 'agent'), extensionArguments: ['--extension', foreign] } });
  await expect(offerResume(terminal, ports())).rejects.toMatchObject({ code: 'session-explicit-extensions', message: expect.stringContaining(owner.name!) });
});
