import { afterEach, expect, it, vi } from 'vitest';
import { mountedFixture } from './herdr-wiring-fixture.js';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('kills a subagent through the owning session and leaves a foreign run alone', async () => {
  const f = await mountedFixture();
  try {
    const own = f.store.create({ sessionId: f.owner!.sessionId, agent: 'worker', name: 'own', task: 'test' });
    const foreign = f.store.create({ sessionId: 'other', agent: 'worker', name: 'foreign', task: 'test' });
    f.store.start(own.id); f.store.start(foreign.id);
    expect(await f.ipc!.request({ op: 'killRun', runId: own.id as never, generation: f.owner!.generation })).toEqual({ ok: true, op: 'killRun' });
    expect(f.store.get(own.id)?.status).toBe('cancelled');
    expect(await f.ipc!.request({ op: 'killRun', runId: foreign.id as never, generation: f.owner!.generation })).toMatchObject({ ok: false, code: 'not-found' });
    expect(f.store.get(foreign.id)?.status).toBe('running');
  } finally { await f.close(); }
}, 30000);

it('closes the live viewer after its subagent is killed', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, true);
  try {
    const own = f.store.create({ sessionId: f.owner!.sessionId, agent: 'worker', name: 'own', task: 'test' });
    f.store.start(own.id);
    const opened = await f.ipc!.openRun(own.id as never);
    expect(opened).toMatchObject({ ok: true, op: 'openRun' });
    if (!opened.ok || opened.op !== 'openRun') throw new Error('Viewer did not open');
    expect((await f.h.hc.get(opened.viewer)).state).toBe('live');
    expect(await f.ipc!.request({ op: 'killRun', runId: own.id as never, generation: f.owner!.generation })).toEqual({ ok: true, op: 'killRun' });
    await vi.waitFor(async () => {
      const viewer = await f.h.hc.get(opened.viewer).catch(() => null);
      expect(viewer === null || viewer.state === 'finished').toBe(true);
    }, { timeout: 5000 });
  } finally { await f.close(); }
}, 45000);
