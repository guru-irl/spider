import assert from 'node:assert/strict';
import { test, beforeEach } from 'vitest';
import { setup, summaryCalls, pi, assistant, user, ROOT } from './harness.js';
// Test-only deep import: pi does not root-export prepareCompaction.
const { prepareCompaction } = await import(new URL('../../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js', import.meta.url).href);
beforeEach(() => { summaryCalls.length = 0; });
const range = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}-${i}.ts`);
function calls(ops: string[][]) {
  return { ...assistant(''), content: ops.map(([name, path], i) => ({ type: 'toolCall', id: `call-${i}`, name, arguments: { path } })), stopReason: 'toolUse' };
}
function textLists(summary: string) {
  const list = (tag: string) => { const m = summary.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`, 'g')); assert.ok(!m || m.length === 1, `one ${tag} block`); return m ? m[0].split('\n').slice(1, -1) : []; };
  return { readFiles: list('read-files'), modifiedFiles: list('modified-files') };
}
function assertLists(r: any, expected: any) {
  assert.deepEqual({ readFiles: r.details.readFiles, modifiedFiles: r.details.modifiedFiles }, expected);
  assert.deepEqual(textLists(r.summary), expected);
}
// Break: cumulative preparation sets win over fresh calls or stored list order; sorting; nested/split ops lost.
test('file lists prioritize newest direct nested and split calls then stored order with dedupe and 50 each', async () => {
  const f = setup(); f.config['compaction.fileListCap'] = 50;
  const priorRead = ['shared-read.ts', ...range('prior-read', 80), 'promoted.ts'];
  const priorMod = ['shared-mod.ts', ...range('prior-mod', 80)];
  f.event.branchEntries = [{ type: 'compaction', id: 'c1', fromHook: true, summary: '## Goal\nOLD', details: { source: 'spider-compaction', readFiles: priorRead, modifiedFiles: priorMod } }];
  f.event.preparation.messagesToSummarize = [
    calls([['read', 'older-read.ts'], ['edit', 'older-mod.ts'], ['read', 'shared-read.ts']]),
    { role: 'toolResult', nestedCalls: { calls: [
      { name: 'read', arguments: { path: 'shared-read.ts' } },
      { name: 'write', arguments: { path: 'shared-mod.ts' } },
      { name: 'read', arguments: { path: 'newest-read.ts' } },
      { name: 'edit', arguments: { path: 'newest-mod.ts' } },
    ] }, content: [], toolCallId: 'nested', toolName: 'codemode', timestamp: 1, isError: false },
  ];
  f.event.preparation.turnPrefixMessages = [calls([['write', 'promoted.ts'], ['read', 'prefix.ts']])];
  f.event.preparation.fileOps.read.add('aggregate-poison.ts');
  const r = (await f.run()).compaction;
  assertLists(r, {
    readFiles: ['prefix.ts', 'newest-read.ts', 'shared-read.ts', 'older-read.ts', ...range('prior-read', 46)],
    modifiedFiles: ['promoted.ts', 'newest-mod.ts', 'shared-mod.ts', 'older-mod.ts', ...range('prior-mod', 46)],
  });
  assert.equal(summaryCalls.length, 1); assert.equal(f.requests.length, 1);
  assert.equal(priorRead.length, 82); assert.equal(priorMod.length, 81);
});
// Break: cap applied before dedup; rereads do not refresh recency; >50 new paths survive.
test('more than 50 current paths are capped after newest-occurrence dedupe in details and text', async () => {
  const f = setup(); f.config['compaction.fileListCap'] = 50; f.event.preparation.fileOps = { read: new Set(), written: new Set(), edited: new Set() };
  f.event.preparation.messagesToSummarize = range('current', 60).map((_, i) => calls([['read', `read-${i}.ts`], [i % 2 ? 'edit' : 'write', `mod-${i}.ts`]]));
  f.event.preparation.turnPrefixMessages = [calls([['read', 'read-0.ts'], ['read', 'read-59.ts'], ['edit', 'mod-0.ts'], ['write', 'mod-59.ts']])];
  const r = (await f.run()).compaction;
  assertLists(r, { readFiles: ['read-59.ts', 'read-0.ts', ...Array.from({ length: 48 }, (_, i) => `read-${58 - i}.ts`)], modifiedFiles: ['mod-59.ts', 'mod-0.ts', ...Array.from({ length: 48 }, (_, i) => `mod-${58 - i}.ts`)] });
});
// Break: own fromHook lists lost on update, or uncapped details resurrect discarded earlier paths.
test('two real consecutive compactions carry only capped stored lists and never regrow discarded paths', async () => {
  const f = setup(); f.config['compaction.fileListCap'] = 50; const sm = pi.SessionManager.inMemory(`${ROOT}/test/cwd`);
  const settings = { enabled: true, reserveTokens: 400000, keepRecentTokens: 20 };
  sm.appendMessage(user('START ' + 'x'.repeat(400)));
  for (let i = 0; i < 65; i++) sm.appendMessage(calls([['read', `read-${i}.ts`], ['write', `mod-${i}.ts`]]));
  sm.appendMessage(user('KEEP ' + 'x'.repeat(400)));
  f.event.branchEntries = sm.getBranch(); f.event.preparation = prepareCompaction(sm.getBranch(), settings);
  assert.ok(f.event.preparation);
  const first = (await f.run()).compaction;
  const firstRead = Array.from({ length: 50 }, (_, i) => `read-${64 - i}.ts`);
  const firstMod = Array.from({ length: 50 }, (_, i) => `mod-${64 - i}.ts`);
  assertLists(first, { readFiles: firstRead, modifiedFiles: firstMod });
  sm.appendCompaction(first.summary, first.firstKeptEntryId, first.tokensBefore, first.details, true, first.usage);
  sm.appendMessage(calls([['read', 'new-read.ts'], ['edit', 'new-mod.ts'], ['read', 'read-20.ts'], ['write', 'mod-20.ts']]));
  sm.appendMessage(user('KEEP2 ' + 'y'.repeat(400)));
  f.event.branchEntries = sm.getBranch(); f.event.preparation = prepareCompaction(sm.getBranch(), settings);
  assert.ok(f.event.preparation); assert.equal(f.event.preparation.previousSummary, first.summary);
  // pi ignores file details from hooks; the plugin must recover its own stored lists.
  assert.ok(!f.event.preparation.fileOps.read.has('read-64.ts'));
  const second = (await f.run()).compaction;
  assertLists(second, {
    readFiles: ['read-20.ts', 'new-read.ts', ...firstRead.filter(p => p !== 'read-20.ts').slice(0, 48)],
    modifiedFiles: ['mod-20.ts', 'new-mod.ts', ...firstMod.filter(p => p !== 'mod-20.ts').slice(0, 48)],
  });
  for (const path of ['read-0.ts', 'mod-0.ts']) assert.ok(!second.summary.includes('\n' + path + '\n'));
  assert.equal(summaryCalls.length, 2); assert.equal(f.requests.length, 2);
});
// Break: older compactions/foreign hook details reintroduced instead of only the latest eligible lists.
test('latest ordinary compaction stored order is used and foreign hook details stay excluded', async () => {
  const f = setup(); f.config['compaction.fileListCap'] = 50; f.event.preparation.messagesToSummarize = [calls([['read', 'new.ts']])]; f.event.preparation.turnPrefixMessages = [];
  f.event.branchEntries = [
    { type: 'compaction', details: { readFiles: ['ancient.ts'], modifiedFiles: [] } },
    { type: 'compaction', details: { readFiles: ['z-old.ts', 'a-old.ts', 'z-old.ts'], modifiedFiles: [] } },
  ];
  assertLists((await f.run()).compaction, { readFiles: ['new.ts', 'z-old.ts', 'a-old.ts'], modifiedFiles: [] });
  f.event.branchEntries.at(-1).fromHook = true;
  f.event.branchEntries.at(-1).details.source = 'foreign';
  f.event.preparation.fileOps = { read: new Set(['new.ts']), written: new Set(), edited: new Set() };
  assertLists((await f.run()).compaction, { readFiles: ['new.ts'], modifiedFiles: [] });
});
