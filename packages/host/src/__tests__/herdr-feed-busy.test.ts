import { afterEach, expect, it, vi } from 'vitest';
import * as writer from '../../../herdr/src/feed/writer.js';
import * as publisher from '../../../herdr/src/feed/publisher.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';
import { mountedFixture } from './herdr-wiring-fixture.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const warnings = (notices: unknown[]) => notices.filter((notice): notice is string => typeof notice === 'string');
async function idleFixture() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const timers = vi.spyOn(globalThis, 'setInterval');
  const f = await mountedFixture('fake');
  const heartbeat = timers.mock.calls.filter(call => call[1] === 2000).at(-1)![0] as () => void;
  return { ...f, async tick(milliseconds: number) {
    // Deliver an idle heartbeat without also starting a content refresh at the same instant.
    vi.setSystemTime(Date.now() + milliseconds); heartbeat();
    await Promise.resolve(); await Promise.resolve();
  } };
}
it('does not warn when a heartbeat lock is briefly busy', async () => {
  const f = await idleFixture();
  try {
    const heartbeat = vi.spyOn(publisher, 'publishSessionHeartbeat').mockRejectedValue(new HerdrError('lock-occupied', 'The operation lock is busy'));
    await f.tick(2000);
    expect(heartbeat).toHaveBeenCalled();
    expect(warnings(f.notices)).toEqual([]);
    heartbeat.mockRestore();
    await f.tick(2000);
    expect(warnings(f.notices)).toEqual([]);
  } finally { await f.close(); }
});
it('reports one notice when feed locks stay busy beyond the disconnect interval', async () => {
  const f = await idleFixture();
  try {
    const busy = new HerdrError('lock-occupied', 'The operation lock is busy');
    const feed = vi.spyOn(publisher, 'publishSessionFeed').mockRejectedValue(busy);
    const heartbeat = vi.spyOn(publisher, 'publishSessionHeartbeat').mockRejectedValue(busy);
    await f.tick(2000);
    expect(warnings(f.notices)).toEqual([]);
    Reflect.set(f.pi, 'getSessionName', () => 'Renamed');
    await f.emit('session_info_changed');
    expect(feed).toHaveBeenCalled();
    expect(warnings(f.notices)).toEqual([]);
    await f.tick(18_000);
    expect(warnings(f.notices)).toEqual([]);
    await f.tick(4000);
    expect(warnings(f.notices)).toHaveLength(1);
    await f.tick(80_000);
    expect(warnings(f.notices)).toHaveLength(1);
    expect(heartbeat).toHaveBeenCalled();
    feed.mockRestore(); heartbeat.mockRestore();
  } finally { await f.close(); }
});
it('still warns about feed ownership failures instead of treating them as contention', async () => {
  const f = await idleFixture();
  try {
    const heartbeat = vi.spyOn(publisher, 'publishSessionHeartbeat').mockRejectedValue(new HerdrError('feed-writer-occupied', 'Feed ownership is uncertain'));
    await f.tick(2000);
    expect(heartbeat).toHaveBeenCalled();
    expect(warnings(f.notices)).toHaveLength(1);
    expect(warnings(f.notices)[0]).toContain('feed-writer-occupied');
    heartbeat.mockRestore();
  } finally { await f.close(); }
});

it('skips redundant heartbeat locks while a content publication is pending', async () => {
  const f = await idleFixture();
  let release!: () => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const original = writer.withFeedWriterLock;
  let entered = false, change: Promise<unknown> | undefined;
  const lock = vi.spyOn(writer, 'withFeedWriterLock').mockImplementationOnce((root, session, operation) => original(root, session, async () => { entered = true; await gate; return operation(); }));
  try {
    Reflect.set(f.pi, 'getSessionName', () => 'Renamed');
    change = f.emit('session_info_changed');
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5000 });
    await f.tick(2000);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(warnings(f.notices)).toEqual([]);
  } finally { release(); await change; lock.mockRestore(); await f.close(); }
});

it('does not count a skipped heartbeat as recovery from an ongoing feed stall', async () => {
  const f = await idleFixture();
  const busy = new HerdrError('lock-occupied', 'The operation lock is busy');
  let release!: () => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  let entered = false, change: Promise<unknown> | undefined;
  const original = writer.withFeedWriterLock;
  try {
    const heartbeat = vi.spyOn(publisher, 'publishSessionHeartbeat').mockRejectedValueOnce(busy);
    await f.tick(0); heartbeat.mockRestore();
    const lock = vi.spyOn(writer, 'withFeedWriterLock').mockImplementationOnce((root, session) => original(root, session, async () => { entered = true; await gate; throw busy; }));
    Reflect.set(f.pi, 'getSessionName', () => 'Renamed'); change = f.emit('session_info_changed');
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5000 });
    await f.tick(22_000);
    expect(warnings(f.notices)).toEqual([]);
    release(); await change;
    expect(warnings(f.notices)).toHaveLength(1);
    lock.mockRestore();
  } finally { release(); await change; await f.close(); }
});
