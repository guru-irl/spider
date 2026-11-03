// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import * as clients from '../../../herdr/src/client/hc.js';
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
    const message = stage === 'monitor' ? /Herdr remote execution is unavailable.*Herdr job monitor failed.*Event record exceeded its byte limit/ : /Herdr remote execution is unavailable.*Herdr activation failed.*Cannot verify the Herdr terminal process ancestry/;
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
