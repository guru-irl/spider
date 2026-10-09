import { test, expect } from 'vitest';
import { setup, pi, user, assistant, summaryCalls } from './harness.js';
// Test-only deep import: pi does not root-export prepareCompaction.
const { prepareCompaction } = await import(new URL('../../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js', import.meta.url).href);

// Break: child cut or history extraction diverges from pi, or parent recency becomes sorted/forward.
test('seeded histories preserve child boundaries and parent newest-touch file order', async () => {
  let seed = 23;
  const next = () => { seed = Math.imul(seed, 1664525) + 1013904223 >>> 0; return seed; };
  for (let i = 0; i < 80; i++) {
    const f = setup(true); const sm = pi.SessionManager.inMemory(f.ctx.cwd);
    sm.appendMessage(user('HISTORY ' + 'h'.repeat(2000)));
    const paths: string[] = [];
    const count = 4 + next() % 10;
    for (let j = 0; j < count; j++) {
      const path = `file-${next() % 12}.ts`; paths.push(path);
      sm.appendMessage({ ...assistant(''), content: [{ type: 'toolCall', id: `c${j}`, name: 'read', arguments: { path } }], stopReason: 'toolUse' });
      sm.appendMessage({ role: 'toolResult', toolCallId: `c${j}`, toolName: 'read', content: [{ type: 'text', text: 'x'.repeat(160) }], isError: false, timestamp: j });
      if (j < count - 1 && next() % 2) sm.appendMessage(user('intervening input'));
    }
    f.ctx.sessionManager = sm;
    const prep = prepareCompaction(sm.getBranch(), { enabled: false, reserveTokens: 1000, keepRecentTokens: 20 });
    expect(prep).toBeDefined();
    const child = await f.handlers.get('turn_end')({ outcome: 'completed', entries: [], toolResults: [{}] }, f.ctx);
    expect(child?.entries.at(-1)?.firstKeptEntryId).toBe(prep.firstKeptEntryId);
    expect(summaryCalls.at(-1).currentMessages).toEqual([...prep.messagesToSummarize, ...prep.turnPrefixMessages]);
    expect(f.requests).toHaveLength(1);
    const parent = setup();
    parent.event.preparation = prep; parent.event.branchEntries = sm.getBranch();
    const r = (await parent.run()).compaction;
    // The last tool turn is retained. All earlier read paths follow reverse touch order.
    const expected = [...new Set(paths.slice(0, -1).reverse())];
    expect(r.details.readFiles).toEqual(expected);
    expect(r.details.modifiedFiles).toEqual([]);
  }
});
