import { expect, test } from 'vitest';
import { setup } from './harness.js';

// A registry miss must leave a readable id, not a provider prefix or an exception.
test.each([true, false])('compaction notices use display names when known: registry=%s', async known => {
  const f = setup();
  const session = f.ctx.model;
  const originalFind = f.registry.find;
  f.registry.find = (provider: string, id: string) => known
    ? (id === session.id && provider === session.provider ? session : originalFind(provider, id))
    : undefined;
  f.ctx.compact = (options: any) => options.onComplete({ details: { summaryModel: 'fixture-provider/summary-model' } });
  await f.handlers.get('agent_end')({}, f.ctx);
  expect(f.notices.map((notice: any) => notice.text)).toEqual([
    `Auto-compacting ${known ? 'Session' : 'session-model'} at 60.0% (threshold 50%)`,
    `Compaction complete (summary by ${known ? 'Summary' : 'summary-model'})`,
  ]);
});

test('an unmanaged completion uses the session display name', async () => {
  const f = setup();
  const model = f.ctx.model;
  f.registry.find = () => model;
  f.ctx.compact = (options: any) => options.onComplete({ details: {} });
  await f.handlers.get('agent_end')({}, f.ctx);
  expect(f.notices.at(-1).text).toBe('Compaction complete (Session)');
});

test('managed-summary failure names the configured model', async () => {
  const f = setup();
  f.registry.getAvailable = () => [];
  await f.run();
  expect(f.notices[0].text).toContain('Summary summary failed');
});
