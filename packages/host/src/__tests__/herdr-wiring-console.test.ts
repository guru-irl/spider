import { afterEach, expect, it, vi } from 'vitest';
import { mountedFixture } from './herdr-wiring-fixture.js';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it.each(['new', 'resume', 'fork'] as const)('mounted consoles close the previous agent at %s but survive reload', async reason => {
  const f = await mountedFixture();
  try {
    const console = await f.h.hc.run({ argv: [f.h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: 'remote.invalid' as never,
      labels: { 'spider.kind': 'remote-console', 'spider.session': f.h.owner!.sessionId, 'spider.machine': 'remote.invalid', 'spider.owner-core': f.owner!.terminal.coreId, 'spider.owner-terminal': f.owner!.terminal.terminalId }, noNotify: true, background: true, outliveParent: true });
    await f.emit('session_shutdown', { reason: 'reload' }); expect((await f.h.hc.get(console.address)).state).toBe('live');
    await f.emit('session_start', { reason: 'reload' }); expect((await f.h.hc.get(console.address)).state).toBe('live');
    await f.emit('session_shutdown', { reason });
    Reflect.set(f.ctx.sessionManager, 'getSessionId', () => 'replaced-' + reason);
    await f.emit('session_start', { reason });
    await expect(f.h.hc.get(console.address)).rejects.toMatchObject({ code: 'not_found' });
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);

it('startup reaps consoles of a crashed recorded process even when its terminal stays live', async () => {
  const f = await mountedFixture();
  try {
    const parent = await f.h.hc.run({ argv: [f.h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, labels: { 'spider.kind': 'session' }, noNotify: true, background: true, outliveParent: true });
    const labels = { 'spider.kind': 'remote-console', 'spider.session': 'abandoned-session', 'spider.machine': 'remote.invalid', 'spider.owner-core': f.owner!.terminal.coreId, 'spider.owner-terminal': parent.address };
    const console = await f.h.hc.run({ argv: [f.h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: 'remote.invalid' as never, labels, noNotify: true, background: true, outliveParent: true });
    const unrecorded = await f.h.hc.run({ argv: [f.h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: 'remote.invalid' as never,
      labels: { ...labels, 'spider.session': 'unrecorded-live-session' }, noNotify: true, background: true, outliveParent: true });
    await f.presence.record({ pid: 2147483647, startIdentity: 'crashed-process', sessionId: 'abandoned-session' as never, sessionFile: null, sessionName: null, hcAddress: parent.address, kind: 'top-level' });
    await f.emit('session_shutdown', { reason: 'reload' }); await f.emit('session_start', { reason: 'reload' });
    expect((await f.h.hc.get(console.address)).state).toBe('live');
    await f.emit('session_start', { reason: 'startup' });
    await expect(f.h.hc.get(console.address)).rejects.toMatchObject({ code: 'not_found' });
    expect((await f.h.hc.get(parent.address)).state).toBe('live');
    expect((await f.h.hc.get(unrecorded.address)).state).toBe('live');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);

it.each([false, true])('mounted console cleanup is quit-only and top-level-only, child=%s', async child => {
  const f = await mountedFixture('fake', 'tui', true, child);
  try {
    const handle = await f.h.hc.run({ argv: [f.h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: 'remote.invalid' as never,
      labels: { 'spider.kind': 'remote-console', 'spider.session': f.h.owner!.sessionId, 'spider.machine': 'remote.invalid' }, noNotify: true, background: true, outliveParent: true });
    await f.emit('session_shutdown', { reason: 'reload' }); expect((await f.h.hc.get(handle.address)).state).toBe('live');
    await f.emit('session_start', { reason: 'reload' });
    await f.emit('session_shutdown', { reason: 'quit' });
    if (child) expect((await f.h.hc.get(handle.address)).state).toBe('live');
    else await expect(f.h.hc.get(handle.address)).rejects.toMatchObject({ code: 'not_found' });
  } finally { await f.close(); }
}, 30000);
