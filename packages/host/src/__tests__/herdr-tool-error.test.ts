// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { paths } from '@spider/db-core';
import * as mountModule from '../herdr/mount.js';
import { RemoteRuntimeError } from '../../../herdr/src/remote/runtime.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';

const previousRoot = paths.globalRoot;
afterEach(() => { paths.globalRoot = previousRoot; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

test('remote errors preserve actionable details while removing secrets and terminal controls', async () => {
  await mkdir(resolve('.spider/scratch'), { recursive: true });
  const root = await mkdtemp(resolve('.spider/scratch/tool-error-'));
  execFileSync('git', ['init', '-q', root]);
  paths.globalRoot = join(root, 'global'); await mkdir(paths.globalRoot);
  vi.stubEnv('SPIDER_GLOBAL_ROOT', paths.globalRoot); vi.stubEnv('PI_SUBAGENT_CHILD', '1');
  let failure: unknown = new RemoteRuntimeError('runtime-not-installed', 'Remote runtime on planner.invalid is missing; rerun spider herdr setup');
  const remote = { execute: async () => { throw failure; } };
  vi.spyOn(mountModule, 'mountHerdr').mockReturnValue({ enabled: () => true, owner: () => ({} as never),
    findKillJobs: async () => [],
    killJob: async () => { throw new Error('No command is selected.'); },
    execution: () => ({ owner: {} as never, remote, environmentPolicy: env => env }), guard: async () => undefined, dispose: async () => {} });
  const tools: { name: string; execute: (...args: any[]) => Promise<unknown> }[] = [];
  const hooks = new Map<string, Function[]>();
  const pi = { registerTool: (tool: typeof tools[number]) => tools.push(tool), registerCommand() {}, sendMessage() {},
    on: (name: string, handler: Function) => { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; } };
  const ctx = { cwd: root, mode: 'rpc', hasUI: false, sessionManager: { getSessionId: () => 'planner', getSessionFile: () => undefined } };
  try {
    const { default: extension } = await import('../extension.js'); extension(pi as never);
    const tool = tools.find(value => value.name === 'spider')!;
    await expect(tool.execute('call', { action: 'exec', on: 'planner.invalid', language: 'shell', code: 'true' }, undefined, undefined, ctx))
      .rejects.toMatchObject({ code: 'runtime-not-installed', message: "Spider couldn't start the remote command because Herdr isn't set up on that machine. Your session and local commands still work. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine. Details: Remote runtime on planner.invalid is missing; rerun spider herdr setup" });
    failure = new HerdrError('machine-unconfigured', 'Destination is not configured: "missing.invalid". Configured machines: alpha.invalid; beta.invalid');
    await expect(tool.execute('call', { action: 'exec', on: 'missing.invalid', language: 'shell', code: 'true' }, undefined, undefined, ctx))
      .rejects.toMatchObject({ code: 'machine-unconfigured', message: expect.stringContaining('Details: Destination is not configured: "missing.invalid". Configured machines: alpha.invalid; beta.invalid') });
    const secret = ['ghp_', 'fixture123456789012345'].join('');
    failure = new HerdrError('remote-copy-failed', `Copy failed: destination exists. ${secret} \u001b[31mred\u001b[0m`);
    const copyError = await tool.execute('call', { action: 'exec', on: 'planner.invalid', language: 'shell', code: 'true' }, undefined, undefined, ctx).catch(error => error) as Error;
    expect(copyError.message).toContain('Details: Copy failed: destination exists. [REDACTED:github_personal_token] red');
    expect(copyError.message).not.toContain(secret);
    expect(copyError.message).not.toContain('\u001b');
    failure = new HerdrError('future-failure', 'diagnostic detail');
    await expect(tool.execute('call', { action: 'exec', on: 'planner.invalid', language: 'shell', code: 'true' }, undefined, undefined, ctx))
      .rejects.toMatchObject({ code: 'future-failure', message: "Spider's Herdr features hit a problem in this session. Everything else in spider still works. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine (future-failure). Details: diagnostic detail" });
    failure = new Error('ordinary command failure');
    await expect(tool.execute('call', { action: 'exec', on: 'planner.invalid', language: 'shell', code: 'true' }, undefined, undefined, ctx)).rejects.toBe(failure);
  } finally {
    for (const hook of hooks.get('session_shutdown') ?? []) await hook({ reason: 'quit' }, ctx);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
