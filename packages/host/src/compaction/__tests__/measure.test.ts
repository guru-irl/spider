import assert from 'node:assert/strict';
import { test, beforeEach } from 'vitest';
import { setup, summaryCalls } from './harness.js';
beforeEach(() => { summaryCalls.length = 0; });
const names = ['Goal', 'Constraints & Preferences', 'Done', 'In Progress', 'Blocked', 'Key Decisions', 'Next Steps', 'Critical Context', 'File Lists'];
const zeros = () => Object.fromEntries(names.map(n => [n, 0]));
function emptyFiles(f: any) { f.event.preparation.fileOps = { read: new Set(), written: new Set(), edited: new Set() }; }
// Break: sections omitted, double-counted, body/heading/file chars omitted, rounded, or summary text mutated.
test('all section headings and bodies plus file-list block are measured by chars over four without changing text', async () => {
  const f = setup();
  const parts = {
    'Goal': '## Goal\nabcd\n\n',
    'Constraints & Preferences': '## Constraints & Preferences\n- Rule\n\n',
    'Done': '### Done\n- [x] Done\n\n',
    'In Progress': '### In Progress\n- [ ] Work\n\n',
    'Blocked': '### Blocked\n(none)\n\n',
    'Key Decisions': '## Key Decisions\nDecision 42\n\n',
    'Next Steps': '## Next Steps\n1. Next\n\n',
    'Critical Context': '## Critical Context\n/absolute/path.ts\n',
  };
  const text = parts.Goal + parts['Constraints & Preferences'] + '## Progress\n' + parts.Done + parts['In Progress'] + parts.Blocked + parts['Key Decisions'] + parts['Next Steps'] + parts['Critical Context'];
  const suffix = '\n\n<read-files>\na.ts\nz.ts\n</read-files>\n\n<modified-files>\nedited.ts\nshared.ts\nwritten.ts\n</modified-files>';
  f.response.content = [{ type: 'text', text }];
  const r = (await f.run()).compaction;
  assert.equal(r.summary, text + suffix);
  assert.deepEqual(r.details.summarySectionTokens, { ...Object.fromEntries(Object.entries(parts).map(([n, s]) => [n, s.length / 4])), 'File Lists': suffix.length / 4 });
  assert.equal(r.details.summaryTotalTokens, (text + suffix).length / 4);
  assert.deepEqual(f.notices, []);
});
// Break: parser counts headings in code fences as sections or fails on CRLF/bold headings/repeated sections.
test('section measurements ignore fenced headings and handle bold CRLF and repeated section headings', async () => {
  const f = setup(); emptyFiles(f);
  const goal = '## **Goals**\r\nkeep\r\n```md\r\n## Critical Context\r\nnot a section\r\n```\r\n\r\n';
  const critical1 = '## Critical Context\r\na\r\n~~~markdown\r\n### Done\r\ncode\r\n~~~\r\n';
  const critical2 = '## Critical Context\r\nb';
  const text = goal + critical1 + critical2;
  f.response.content = [{ type: 'text', text }];
  const r = (await f.run()).compaction;
  assert.equal(r.summary, text);
  assert.deepEqual(r.details.summarySectionTokens, { ...zeros(), Goal: goal.length / 4, 'Critical Context': (critical1.length + critical2.length) / 4 });
  assert.equal(r.details.summaryTotalTokens, text.length / 4);
});
// Break: missing sections become NaN/undefined or individual-section overage causes a total warning.
test('missing sections measure zero and individual overages below total threshold never warn', async () => {
  const f = setup(); emptyFiles(f); const text = '## Goal\n' + 'x'.repeat(9000);
  f.response.content = [{ type: 'text', text }];
  const r = (await f.run()).compaction;
  assert.deepEqual(r.details.summarySectionTokens, { ...zeros(), Goal: 2252 });
  assert.equal(r.details.summaryTotalTokens, 2252); assert.deepEqual(f.notices, []);
});
// Break: measurements cause warnings, truncation or a second summary call.
for (const headless of [false, true]) test(`large summary only records measurements ${headless ? 'headless' : 'UI'}`, async () => {
  const f = setup(); emptyFiles(f); f.ctx.hasUI = !headless;
  const text = '## Goal\nsmall\n## Critical Context\n' + 'x'.repeat(68000);
  f.response.content = [{ type: 'text', text }];
  const oldWrite = process.stderr.write; let log = ''; process.stderr.write = (c: any) => { log += c; return true; };
  let r: any; try { r = (await f.run()).compaction; } finally { process.stderr.write = oldWrite; }
  assert.equal(r.summary, text); assert.equal(summaryCalls.length, 1); assert.equal(f.requests.length, 1);
  assert.equal(r.details.summaryTotalTokens, text.length / 4);
  assert.equal(r.details.summarySectionTokens['Critical Context'], ('## Critical Context\n' + 'x'.repeat(68000)).length / 4);
  assert.equal(log, ''); assert.deepEqual(f.notices, []);
});
// Break: appended lists omitted from the total or section data.
test('file-list chars contribute to total without a warning', async () => {
  const f = setup(); const text = '## Goal\n' + 'x'.repeat(67492);
  f.response.content = [{ type: 'text', text }];
  const r = (await f.run()).compaction;
  const suffix = '\n\n<read-files>\na.ts\nz.ts\n</read-files>\n\n<modified-files>\nedited.ts\nshared.ts\nwritten.ts\n</modified-files>';
  assert.ok(r.details.summarySectionTokens);
  assert.equal(r.details.summarySectionTokens['File Lists'], suffix.length / 4);
  assert.equal(r.details.summaryTotalTokens, 16875 + suffix.length / 4); assert.deepEqual(f.notices, []);
});
