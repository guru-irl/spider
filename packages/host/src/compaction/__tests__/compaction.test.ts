import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setup, summaryCalls, pi, USAGE, user, assistant, sessionModel } from './harness.js';
// Break: wrong model/reason dispatch or session thinking leaks into the summary request.
for (const reason of ['manual', 'threshold', 'overflow']) test(`parent ${reason} uses configured model high in exactly one summary call`, async () => {
  const f = setup(); f.event.reason = reason; f.event.willRetry = reason === 'overflow';
  const result = await f.run();
  assert.ok(result.compaction);
  assert.equal(summaryCalls.length, 1); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].model.id, 'summary-model'); assert.equal(f.requests[0].model.provider, 'fixture-provider');
  assert.equal(f.requests[0].options.reasoning, 'high'); assert.equal(summaryCalls[0].thinkingLevel, 'high');
  assert.equal(f.ctx.model, sessionModel);
});
// Break: split prefix omitted or sent through a second summary request.
test('history and split prefix are passed together without mutating preparation', async () => {
  const f = setup(); await f.run();
  assert.equal(summaryCalls.length, 1);
  assert.deepEqual(summaryCalls[0].currentMessages, [user('COMPLETE HISTORY'), user('SPLIT TURN PREFIX')]);
  assert.deepEqual(f.event.preparation.messagesToSummarize, [user('COMPLETE HISTORY')]);
  assert.deepEqual(f.event.preparation.turnPrefixMessages, [user('SPLIT TURN PREFIX')]);
  const prompt = f.requests[0].context.messages.find((m: any) => m.role === 'user').content[0].text;
  assert.ok(prompt.includes('COMPLETE HISTORY')); assert.ok(prompt.includes('SPLIT TURN PREFIX'));
});
// Break: event signal/instructions/previous summary/reserve replaced with session/default values.
test('event signal previous summary custom instructions and reserve reach real generator', async () => {
  const f = setup(); f.ctx.signal = new AbortController().signal; await f.run();
  assert.equal(summaryCalls[0].signal, f.controller.signal); assert.equal(f.requests[0].options.signal, f.controller.signal);
  assert.equal(summaryCalls[0].previousSummary, '## Goal\nPREVIOUS SUMMARY');
  assert.equal(summaryCalls[0].customInstructions, 'Preserve the boundary conditions');
  assert.equal(summaryCalls[0].reserveTokens, 400000); assert.equal(f.requests[0].options.maxTokens, 128000);
  const prompt = f.requests[0].context.messages.find((m: any) => m.role === 'user').content[0].text;
  assert.ok(prompt.includes('<previous-summary>\n## Goal\nPREVIOUS SUMMARY\n</previous-summary>'));
  assert.ok(prompt.includes('Additional focus: Preserve the boundary conditions'));
});
// Break: usage lost, metadata/boundary changed, file operations omitted or not deduplicated.
test('result preserves usage boundary tokens source and sorted file details with summarizer metadata', async () => {
  const f = setup(); const r = (await f.run()).compaction;
  assert.deepEqual(r.usage, USAGE); assert.equal(r.firstKeptEntryId, 'kept-42'); assert.equal(r.tokensBefore, 600000);
  const { summarySectionTokens, summaryTotalTokens, ...r1Details } = r.details;
  assert.deepEqual(r1Details, { readFiles: ['a.ts', 'z.ts'], modifiedFiles: ['edited.ts', 'shared.ts', 'written.ts'], source: 'spider-compaction', summaryModel: 'fixture-provider/summary-model', summaryThinking: 'high' });
  assert.equal(r.summary, '## Goal\nPreserve the task\n## Next Steps\nContinue\n\n<read-files>\na.ts\nz.ts\n</read-files>\n\n<modified-files>\nedited.ts\nshared.ts\nwritten.ts\n</modified-files>');
});
// Break: missing model/availability falls through without an actionable warning, or starts a call.
for (const kind of ['missing', 'unavailable']) test(`${kind} configured model falls back with reason and no request`, async () => {
  const f = setup(); if (kind === 'missing') f.registry.find = () => undefined; else f.registry.getAvailable = () => [sessionModel];
  assert.equal(await f.run(), undefined); assert.equal(summaryCalls.length, 0); assert.equal(f.requests.length, 0);
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].kind, 'warning');
  assert.match(f.notices[0].text, /fixture-provider\/summary-model/);
  assert.match(f.notices[0].text, kind === 'missing' ? /not found/i : /not available/i);
});
// Break: failures/refusals/invalid or truncated text persisted, or warning does not name reason.
for (const [kind, configure, reason] of [
  ['failure', (f: any) => { f.registry.streamSimple = () => { throw new Error('backend unavailable'); }; }, /backend unavailable/],
  ['empty', (f: any) => { f.response.content = [{ type: 'text', text: '  ' }]; }, /no text/],
  ['unstructured', (f: any) => { f.response.content = [{ type: 'text', text: 'plain response without headings' }]; }, /structured/],
  ['refusal', (f: any) => { f.response.rawStopReason = 'refusal'; }, /refusal/],
  ['length', (f: any) => { f.response.stopReason = 'length'; }, /token cap/],
] as const) test(`${kind} summary falls back and warns with reason`, async () => {
  const f = setup(); configure(f);
  assert.equal(await f.run(), undefined); assert.equal(summaryCalls.length, 1);
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].kind, 'warning');
  assert.match(f.notices[0].text, /fixture-provider\/summary-model/); assert.match(f.notices[0].text, reason);
});
// Break: return undefined or throw on abort (pi runner swallows throws and invokes default summary).
for (const kind of ['before', 'during-error', 'late-success', 'response-aborted']) test(`${kind} abort cancels without fallback or warning`, async () => {
  const f = setup();
  if (kind === 'before') f.controller.abort();
  if (kind === 'during-error') f.registry.streamSimple = () => ({ result: async () => { f.controller.abort(); throw new Error('stream closed'); } });
  if (kind === 'late-success') f.registry.streamSimple = () => ({ result: async () => { f.controller.abort(); return f.response; } });
  if (kind === 'response-aborted') f.response.stopReason = 'aborted';
  assert.deepEqual(await f.run(), { cancel: true }); assert.deepEqual(f.notices, []);
  if (kind === 'before') assert.equal(summaryCalls.length, 0); else assert.equal(summaryCalls.length, 1);
});
// Break: completion lies about summarizer or gate/callback handling changes.
test('parent threshold callback names successful summarizer and preserves fallback notice and gate', async () => {
  const f = setup(); const calls: any[] = []; f.ctx.compact = (options: any) => calls.push(options);
  const end = f.handlers.get('agent_end'); assert.equal(typeof end, 'function');
  await end({}, f.ctx); await end({}, f.ctx); assert.equal(calls.length, 1);
  const result = (await f.run()).compaction; calls[0].onComplete(result);
  assert.match(f.notices.at(-1).text, /summary by summary-model/);
  await end({}, f.ctx); assert.equal(calls.length, 2);
  f.registry.getAvailable = () => []; await f.run(); calls[1].onComplete({ details: {}, summary: 'fallback' });
  assert.equal(f.notices.at(-1).text, 'Compaction complete (session-model)');
  await end({}, f.ctx); calls[2].onError(new Error('failed'));
  assert.equal(f.notices.at(-1).text, 'Compaction failed: failed');
});
// Break: no-UI fallback becomes silent or attempts UI calls instead of warning.
test('headless parent fallback reports reason to stderr without UI', async () => {
  const f = setup(); f.ctx.hasUI = false; f.registry.getAvailable = () => [];
  const oldWrite = process.stderr.write; let log = ''; process.stderr.write = (c: any) => { log += c; return true; };
  try { assert.equal(await f.run(), undefined); } finally { process.stderr.write = oldWrite; }
  assert.match(log, /fixture-provider\/summary-model/); assert.match(log, /not available/);
  assert.match(log, /using default compaction/); assert.deepEqual(f.notices, []);
});
// Break: helper refactor routes child through configured model/high or changes its drafts/back-off.
test('child retains session model thinking usage file details thresholds and back-off', async () => {
  const f = setup(true); assert.ok(f.handlers.has('turn_end')); assert.ok(!f.handlers.has('agent_end')); assert.ok(!f.handlers.has('session_before_compact'));
  const sm = pi.SessionManager.inMemory(f.ctx.cwd);
  sm.appendMessage(user('HISTORY ' + 'h'.repeat(2000)));
  sm.appendMessage({ ...assistant(''), content: [{ type: 'toolCall', id: 'old-call', name: 'read', arguments: { path: 'history.ts' } }], stopReason: 'toolUse' });
  sm.appendMessage({ role: 'toolResult', toolCallId: 'old-call', toolName: 'read', content: [{ type: 'text', text: 'done' }], isError: false, timestamp: 3 });
  const kept = sm.appendMessage({ ...assistant(''), content: [{ type: 'toolCall', id: 'new-call', name: 'write', arguments: { path: 'kept.ts' } }], stopReason: 'toolUse' });
  sm.appendMessage({ role: 'toolResult', toolCallId: 'new-call', toolName: 'write', content: [{ type: 'text', text: 'k'.repeat(160) }], isError: false, timestamp: 4 });
  f.ctx.sessionManager = sm; f.ctx.hasUI = false;
  f.ctx.signal = new AbortController().signal;
  f.registry.find = () => { throw new Error('child must not resolve configured model'); };
  const turn = { outcome: 'completed', entries: [], toolResults: [{}] }, handler = f.handlers.get('turn_end');
  const r = await handler(turn, f.ctx);
  assert.equal(summaryCalls.length, 1); assert.equal(f.requests[0].model, sessionModel); assert.equal(f.requests[0].options.reasoning, 'low');
  assert.equal(summaryCalls[0].signal, f.ctx.signal); assert.equal(r.entries.at(-1).firstKeptEntryId, kept);
  assert.deepEqual(r.entries.at(-1).usage, USAGE);
  assert.deepEqual(r.entries.at(-1).details, { readFiles: ['history.ts'], modifiedFiles: [], source: 'spider-compaction' });
  const oldWrite = process.stderr.write; let log = ''; process.stderr.write = (c: any) => { log += c; return true; };
  try {
    f.response.content = [{ type: 'text', text: 'invalid' }];
    assert.equal(await handler(turn, f.ctx), undefined);
    assert.equal(await handler(turn, f.ctx), undefined); assert.equal(summaryCalls.length, 2);
    assert.match(log, /structured/); assert.match(log, /back-off/);
    f.ctx.getContextUsage = () => ({ tokens: 600020, percent: 60 });
    f.response.content = [{ type: 'text', text: '## Goal\nRecovered' }];
    assert.ok(await handler(turn, f.ctx)); assert.equal(summaryCalls.length, 3);
  } finally { process.stderr.write = oldWrite; }
});
