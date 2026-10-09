import assert from 'node:assert/strict';
import { test, beforeEach } from 'vitest';
import { setup, summaryCalls, pi, user, assistant } from './harness.js';

beforeEach(() => { summaryCalls.length = 0; });

// Break: omit/lower the parent floor, apply it only to manual compaction, or mutate preparation settings.
for (const reason of ['manual', 'threshold', 'overflow']) {
  test(`${reason} default reserve requests 64000 output tokens without changing preparation`, async () => {
    const f = setup();
    f.event.reason = reason;
    f.event.willRetry = reason === 'overflow';
    f.event.preparation.settings = Object.freeze({ enabled: false, reserveTokens: 16384, keepRecentTokens: 20000 });
    const before = structuredClone(f.event.preparation);
    const result = await f.run();
    assert.ok(result?.compaction, 'parent floor must not trigger fallback');
    assert.equal(f.requests.length, 1);
    assert.equal(summaryCalls.length, 1);
    assert.equal(f.requests[0].options.maxTokens, 64000);
    assert.equal(summaryCalls[0].reserveTokens, 80000);
    assert.equal(f.requests[0].model.id, 'summary-model');
    assert.equal(f.requests[0].options.reasoning, 'high');
    assert.equal(result.compaction.firstKeptEntryId, before.firstKeptEntryId);
    assert.equal(result.compaction.tokensBefore, before.tokensBefore);
    assert.deepEqual(f.event.preparation, before, 'summary budget must not change thresholds or boundaries');
    assert.deepEqual(f.notices, []);
  });
}

// Break: replace max with min, always use the floor, or bypass the generator's model output cap.
for (const { reserve, maxTokens, wantReserve, wantLimit } of [
  { reserve: 0, maxTokens: 128000, wantReserve: 80000, wantLimit: 64000 },
  { reserve: 80000, maxTokens: 128000, wantReserve: 80000, wantLimit: 64000 },
  { reserve: 100000, maxTokens: 128000, wantReserve: 100000, wantLimit: 80000 },
  { reserve: 160000, maxTokens: 128000, wantReserve: 160000, wantLimit: 128000 },
  { reserve: 160000, maxTokens: 96000, wantReserve: 160000, wantLimit: 96000 },
  { reserve: 16384, maxTokens: 32000, wantReserve: 80000, wantLimit: 32000 },
]) {
  test(`reserve ${reserve} and model max ${maxTokens} request ${wantLimit} output tokens`, async () => {
    const f = setup();
    f.event.preparation.settings = Object.freeze({ enabled: true, reserveTokens: reserve, keepRecentTokens: 20000 });
    const model = { ...f.registry.find('fixture-provider', 'summary-model'), maxTokens };
    f.registry.find = () => model;
    f.registry.getAvailable = () => [model];
    assert.ok((await f.run())?.compaction);
    assert.equal(summaryCalls.length, 1);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].options.maxTokens, wantLimit);
    assert.equal(summaryCalls[0].reserveTokens, wantReserve);
    assert.equal(f.event.preparation.settings.reserveTokens, reserve);
    assert.deepEqual(f.notices, []);
  });
}

// Break: move the parent-only floor into the shared helper or child call.
test('child still requests 800 output tokens from its 1000 reserve', async () => {
  const f = setup(true);
  const sm = pi.SessionManager.inMemory(f.ctx.cwd);
  sm.appendMessage(user('HISTORY ' + 'h'.repeat(2000)));
  sm.appendMessage(assistant('Old answer'));
  const kept = sm.appendMessage({ ...assistant(''), content: [{ type: 'toolCall', id: 'keep', name: 'read', arguments: { path: 'kept.ts' } }], stopReason: 'toolUse' });
  sm.appendMessage({ role: 'toolResult', toolCallId: 'keep', toolName: 'read', content: [{ type: 'text', text: 'k'.repeat(160) }], isError: false, timestamp: 3 });
  f.ctx.sessionManager = sm;
  const result = await f.handlers.get('turn_end')({ outcome: 'completed', entries: [], toolResults: [{}] }, f.ctx);
  assert.ok(result?.entries.at(-1));
  assert.equal(result.entries.at(-1).firstKeptEntryId, kept);
  assert.equal(summaryCalls.length, 1);
  assert.equal(summaryCalls[0].reserveTokens, 1000);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.maxTokens, 800);
  assert.equal(f.requests[0].model.id, 'session-model');
  assert.equal(f.requests[0].options.reasoning, 'low');
});
