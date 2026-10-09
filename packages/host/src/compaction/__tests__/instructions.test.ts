import { test, expect } from 'vitest';
import { setup, summaryCalls } from './harness.js';
// Break: spider adds cap or file-list guidance instead of passing only user text.
for (const previous of [false, true]) for (const withUser of [false, true]) {
  test(`passes only user instructions for ${previous ? 'update' : 'initial'} ${withUser ? 'with text' : 'without text'}`, async () => {
    const f = setup(); const text = '  Keep exact paths\r\nDo NOT normalize.\n\n';
    f.event.customInstructions = withUser ? text : undefined;
    f.event.preparation.previousSummary = previous ? '## Goal\nOLD' : undefined;
    expect((await f.run()).compaction).toBeDefined();
    expect(summaryCalls).toHaveLength(1); expect(f.requests).toHaveLength(1);
    expect(summaryCalls[0].customInstructions).toBe(withUser ? text : undefined);
    expect(summaryCalls[0].previousSummary).toBe(f.event.preparation.previousSummary);
    const prompt = f.requests[0].context.messages.find((m: any) => m.role === 'user').content[0].text;
    expect(prompt).not.toContain('Bounded checkpoint'); expect(prompt).not.toContain('authoritative file lists');
    if (withUser) expect(prompt).toContain('Additional focus: ' + text);
  });
}
