// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import * as clients from '../../../herdr/src/client/hc.js';
import * as presence from '../../../herdr/src/sessions/presence.js';
import * as liveness from '../../../herdr/src/client/liveness.js';
import * as monitors from '../../../herdr/src/jobs/monitor.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';
import { runExec } from '../../../context/src/actions/exec.js';
import { mountedFixture } from './herdr-wiring-fixture.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each(['session', 'subagent'].flatMap(scope => ['activation', 'monitor'].map(stage => ({ scope, stage }))))('$scope exec names its $stage failure instead of losing the cause in stderr', async ({ scope, stage }) => {
  vi.stubEnv('PI_SUBAGENT_RUN_ID', 'cause-run'); vi.stubEnv('PI_SPIDER_TOP_SESSION_ID', 'cause-session');
  const f = await mountedFixture('fake', 'rpc', false, scope === 'subagent', true, true);
  try {
    const cause = stage === 'monitor' ? new HerdrError('reply-too-large', 'Event record exceeded its byte limit') : new HerdrError('caller-probe-unavailable', 'Cannot verify the Herdr terminal process ancestry');
    const message = stage === 'monitor' ? /Remote execution is unavailable.*job monitor failed because the terminal list exceeded its byte limit/ : /Remote execution is unavailable.*activation failed because the connection could not be established/;
    let fault: { mockRestore(): void };
    if (stage === 'monitor') {
      const create = monitors.createJobMonitor;
      fault = vi.spyOn(monitors, 'createJobMonitor').mockImplementation(options => ({ ...create(options), activate: async () => { throw cause; } }));
    } else {
      const create = clients.createHcClient;
      fault = vi.spyOn(clients, 'createHcClient').mockImplementation(options => ({ ...create(options), caller: async () => { throw cause; } }));
    }
    await f.emit('session_start', { reason: 'reload' });
    await expect(runExec({ on: 'remote.invalid', language: 'shell', code: 'printf forbidden' }, { cwd: f.h.root, ...f.mount.execution() })).rejects.toMatchObject({ code: 'herdr-unavailable', message: expect.stringMatching(message) });
    expect(await f.mount.guard({ toolName: 'spider', input: { action: 'exec', on: 'remote.invalid' } })).toMatchObject({ block: true, reason: expect.stringMatching(message) });
    const local = await runExec({ language: 'javascript', code: "console.log('local still works')" }, { cwd: f.h.root, ...f.mount.execution() });
    expect(local.details.stdout).toBe('local still works\n');
    fault.mockRestore(); await f.emit('session_start', { reason: 'reload' });
    expect(f.mount.execution().remote).toBeDefined();
    expect(await f.mount.guard({ toolName: 'spider', input: { action: 'exec', on: 'remote.invalid' } })).toBeUndefined();
  } finally { await f.close(); }
}, 45000);

it.each(['session', 'subagent'])('%s exec says Herdr is off when disabled by choice', async scope => {
  vi.stubEnv('PI_SUBAGENT_RUN_ID', 'disabled-run'); vi.stubEnv('PI_SPIDER_TOP_SESSION_ID', 'disabled-session');
  const f = await mountedFixture('fake', 'rpc', false, scope === 'subagent', true, true, false);
  try {
    await expect(runExec({ on: 'remote.invalid', language: 'shell', code: 'printf forbidden' }, { cwd: f.h.root, ...f.mount.execution() })).rejects.toMatchObject({ code: 'herdr-unavailable', message: expect.stringContaining('Herdr is off in this session') });
    expect(await f.mount.guard({ toolName: 'spider', input: { action: 'exec', on: 'remote.invalid' } })).toMatchObject({ block: true, reason: expect.stringContaining('Herdr is off in this session') });
  } finally { await f.close(); }
}, 45000);

it('a disabled child does not record presence failures as activation failures', async () => {
  vi.stubEnv('PI_SUBAGENT_RUN_ID', 'disabled-run'); vi.stubEnv('PI_SPIDER_TOP_SESSION_ID', 'disabled-session');
  const create = presence.createProcessPresence;
  vi.spyOn(presence, 'createProcessPresence').mockImplementation(root => ({ ...create(root), record: async () => { throw new Error('private-presence-path'); } }));
  const f = await mountedFixture('fake', 'rpc', false, true, true, true, false);
  try {
    expect(f.mount.execution().remoteUnavailableReason).toContain('Herdr is off in this session');
    expect(f.mount.execution().remoteUnavailableReason).not.toContain('private-presence-path');
    expect(await f.mount.guard({ toolName: 'spider', input: { action: 'exec', on: 'remote.invalid' } })).toMatchObject({ reason: expect.stringContaining('Herdr is off in this session') });
  } finally { await f.close(); }
}, 45000);

it('a stopped core takes priority over an earlier monitor failure in the session guard', async () => {
  const f = await mountedFixture('fake', 'rpc', false, false, true, true);
  try {
    const create = monitors.createJobMonitor;
    vi.spyOn(monitors, 'createJobMonitor').mockImplementation(options => ({ ...create(options), activate: async () => { throw new HerdrError('invalid-reply', 'private'); } }));
    await f.emit('session_start', { reason: 'reload' });
    vi.spyOn(liveness, 'isCoreAvailable').mockResolvedValue(false);
    expect(await f.mount.guard({ toolName: 'spider', input: { action: 'exec', on: 'remote.invalid' } })).toMatchObject({ reason: expect.stringContaining('Herdr stopped responding') });
  } finally { await f.close(); }
}, 45000);
