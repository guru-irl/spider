import { test, expect, vi } from 'vitest';
import { writeFileSync, utimesSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setup, summaryCalls } from './harness.js';

// Break: managed summaries run by default, or partial live updates are ignored.
test('null summary model leaves pi in charge, while settings are read on each attempt', async () => {
  const f = setup(); delete f.config['compaction.summaryModel'];
  expect(await f.run()).toBeUndefined(); expect(summaryCalls).toHaveLength(0);
  f.config['compaction.summaryModel'] = 'fixture-provider/summary-model';
  f.config['compaction.summaryThinking'] = 'max';
  f.config['compaction.fileListCap'] = 1;
  f.config['compaction.minSummaryOutputTokens'] = 1600;
  f.event.preparation.settings.reserveTokens = 0;
  const result = await f.run();
  expect(f.requests[0].options.reasoning).toBe('max');
  expect(f.requests[0].options.maxTokens).toBe(1600);
  expect(result.compaction.details.readFiles).toEqual(['a.ts']);
  expect(result.compaction.details.modifiedFiles).toEqual(['edited.ts']);
  expect(summaryCalls[0].customInstructions).toBe('Preserve the boundary conditions');
  expect(f.notices).toEqual([]);
  f.config['compaction.summaryModel'] = null;
  expect(await f.run()).toBeUndefined(); expect(f.requests).toHaveLength(1);
});

// Break: empty caps or zero file limit accidentally erase content instead of disabling limits.
test('zero file cap disables limits without dropping measurements or user text', async () => {
  const f = setup(); f.config['compaction.fileListCap'] = 0;
  f.config['compaction.minSummaryOutputTokens'] = 0;
  f.event.customInstructions = '  User text\r\n'; f.event.preparation.settings.reserveTokens = 1000;
  f.event.preparation.fileOps.read = new Set(Array.from({ length: 65 }, (_, i) => `file-${i}.ts`));
  const r = (await f.run()).compaction;
  expect(summaryCalls[0].customInstructions).toBe('  User text\r\n');
  expect(r.details.readFiles).toHaveLength(65); expect(r.details.summarySectionTokens['File Lists']).toBeGreaterThan(0);
  expect(r.details.summaryTotalTokens).toBe(r.summary.length / 4); expect(f.notices).toEqual([]);
  expect(f.requests[0].options.maxTokens).toBe(800);
});

// Break: invalid JSON shape/percent enables a threshold, caching ignores mtime or overrides do not win.
test('threshold parsing caches by mtime, uses valid overrides and fails closed', async () => {
  const f = setup(); const end = f.handlers.get('agent_end');
  expect(typeof end).toBe('function');
  let calls = 0; f.ctx.compact = (options: any) => { calls++; options.onComplete({ details: {} }); };
  const model = f.ctx.model;
  let mtime = 100000;
  const save = (raw: string) => { writeFileSync(f.modelsPath, raw); utimesSync(f.modelsPath, ++mtime, mtime); };
  save(JSON.stringify({ providers: { [model.provider]: { models: [{ id: model.id, compactAtPercent: 90 }], modelOverrides: { [model.id]: { compactAtPercent: 60 } } } } }));
  await end({}, f.ctx); expect(calls).toBe(1);
  writeFileSync(f.modelsPath, '{}'); utimesSync(f.modelsPath, mtime, mtime);
  await end({}, f.ctx); expect(calls).toBe(2);
  f.ctx.getContextUsage = () => ({ tokens: 900000, percent: 125 });
  for (const pct of [0, -1, 100, 120, null, '60']) {
    save(JSON.stringify({ providers: { [model.provider]: { models: [{ id: model.id, compactAtPercent: pct }] } } }));
    await end({}, f.ctx); expect(calls).toBe(2);
  }
  save(JSON.stringify({ providers: { [model.provider]: { models: [{ id: model.id, compactAtPercent: 60 }] } } }));
  await end({}, f.ctx); expect(calls).toBe(3);
  for (const raw of ['{', '{"providers":{"p":{"models":{}}}}']) {
    save(raw); await end({}, f.ctx); await end({}, f.ctx); expect(calls).toBe(3);
  }
  expect(f.notices.filter((n: any) => /could not parse/.test(n.text))).toHaveLength(1);
  save(JSON.stringify({ providers: { [model.provider]: { models: [{ id: model.id, compactAtPercent: 60 }] } } }));
  await end({}, f.ctx); expect(calls).toBe(4);
  f.ctx.getContextUsage = () => ({ percent: null, tokens: null });
  await end({}, f.ctx); expect(calls).toBe(4);
});

// Break: either discovery source allows duplicate parent or child compaction.
for (const child of [false, true]) for (const ext of ['per-model-compaction.ts', 'per-model-compaction.js']) {
  test(`legacy ${ext} prevents ${child ? 'child' : 'parent'} compaction and warns once`, async () => {
    const f = setup(child); mkdirSync(join(f.agentDir, 'extensions'), { recursive: true });
    const legacy = join(f.agentDir, 'extensions', ext); writeFileSync(legacy, '// fixture');
    try {
      const start = f.handlers.get('session_start'); expect(typeof start).toBe('function');
      await start({}, f.ctx); await start({}, f.ctx);
      if (child) expect(await f.handlers.get('turn_end')({ outcome: 'completed', entries: [], toolResults: [{}] }, f.ctx)).toBeUndefined();
      else { expect(await f.run()).toBeUndefined(); let calls = 0; f.ctx.compact = () => calls++; await f.handlers.get('agent_end')({}, f.ctx); expect(calls).toBe(0); }
      expect(summaryCalls).toHaveLength(0);
      expect(f.notices.filter((n: any) => /legacy/.test(n.text))).toHaveLength(1);
      expect(f.notices[0].text).toContain(ext); expect(f.notices[0].text).toContain('subagents.extensions'); expect(f.notices[0].text).toContain('restart');
    } finally { rmSync(legacy); }
  });
}
test('legacy configured child extension blocks compaction even if file is absent', async () => {
  const f = setup(); f.config['subagents.extensions'] = [join(f.agentDir, 'missing/per-model-compaction.ts')];
  expect(await f.run()).toBeUndefined(); expect(f.notices[0].text).toContain('per-model-compaction.ts');
  expect(summaryCalls).toHaveLength(0);
});

test('legacy basenames only: similar filenames do not block compaction', async () => {
  const f = setup(); f.config['subagents.extensions'] = [join(f.agentDir, 'not-per-model-compaction.ts')];
  expect((await f.run()).compaction.details.source).toBe('spider-compaction');
});

// Break: a new checkpoint can no longer recover migrated legacy lists.
for (const source of ['per-model-compaction', 'spider-compaction']) test(`recovers previous ${source} capped lists`, async () => {
  const f = setup(); f.event.branchEntries = [{ type: 'compaction', fromHook: true, details: { source, readFiles: ['old.ts'], modifiedFiles: ['old-edit.ts'] } }];
  const r = (await f.run()).compaction;
  expect(r.details.readFiles).toEqual(['old.ts']); expect(r.details.modifiedFiles).toEqual(['old-edit.ts']);
});

// Break: default file cap is still 50, or read and modified limits are combined.
test('default keeps 500 paths independently per list', async () => {
  const f = setup(); const p = f.event.preparation;
  p.fileOps.read = new Set(Array.from({ length: 510 }, (_, i) => `read-${String(i).padStart(3, '0')}.ts`));
  p.fileOps.edited = new Set(Array.from({ length: 510 }, (_, i) => `edit-${String(i).padStart(3, '0')}.ts`));
  p.fileOps.written.clear();
  const r = (await f.run()).compaction;
  expect(r.details.readFiles).toHaveLength(500); expect(r.details.modifiedFiles).toHaveLength(500);
  expect(r.details.readFiles[499]).toBe('read-499.ts'); expect(r.details.modifiedFiles[499]).toBe('edit-499.ts');
  expect(r.summary).toContain('read-499.ts'); expect(r.summary).not.toContain('read-500.ts');
});
