import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function api() {
  return import(/* @vite-ignore */ `${process.cwd()}/scripts/test-shard-budget.mjs`);
}

describe('PR test budget', () => {
  it('fills by proximity before path or duration and lists every deferred file', async () => {
    const { cutToBudget, selectionSummary } = await api();
    const result = cutToBudget({
      files: ['a-importer', 'b-neighbor', 'z-direct', 'y-changed', 'c-small'],
      priorities: { 'y-changed': 0, 'z-direct': 0, 'b-neighbor': 1, 'a-importer': 2, 'c-small': 2 },
      durations: { 'a-importer': 6, 'b-neighbor': 6, 'z-direct': 6, 'y-changed': 6, 'c-small': 4 },
      machines: 2, workerCount: 1, limitMs: 10,
    });
    expect(result.files).toEqual(['c-small', 'y-changed', 'z-direct']);
    expect(result.deferred.map((entry: { file: string }) => entry.file)).toEqual(['a-importer', 'b-neighbor']);
    expect(result.budget.predictedMaxMs).toBe(10);
    expect(result.budget.shards.map((shard: { predictedMs: number }) => shard.predictedMs)).toEqual([10, 6]);
    const summary = selectionSummary({ ...result, optional: { chrome: true, acceptance: true, stories: true } });
    for (const file of ['a-importer', 'b-neighbor']) expect(summary).toContain(`\`${file}\``);
    expect(summary).not.toContain('`y-changed`');
    expect(summary).toMatch(/full run.*Chrome/);
    expect(summary).toMatch(/full run.*acceptance/);
    expect(summary).toMatch(/full run.*headless story/);
  });

  it('keeps same-directory tests ahead of importers and continues after an oversized file', async () => {
    const { cutToBudget } = await api();
    const result = cutToBudget({ files: ['a-importer', 'z-neighbor', 'oversized'],
      priorities: { oversized: 0, 'z-neighbor': 1, 'a-importer': 2 },
      durations: { 'a-importer': 10, 'z-neighbor': 10, oversized: 11 },
      machines: 1, workerCount: 1, limitMs: 10 });
    expect(result.files).toEqual(['z-neighbor']);
    expect(result.deferred.map((entry: { file: string }) => entry.file)).toEqual(['a-importer', 'oversized']);
    expect(result.deferred.every((entry: { rule: string }) => /budget/.test(entry.rule))).toBe(true);
  });

  it('reserves required files before filling the remaining budget', async () => {
    const { cutToBudget } = await api();
    const result = cutToBudget({ files: ['a-priority', 'z-required', 'b-small'], requiredFiles: ['z-required'],
      priorities: { 'a-priority': 0, 'b-small': 2, 'z-required': 2 },
      durations: { 'a-priority': 6, 'z-required': 7, 'b-small': 3 },
      machines: 1, workerCount: 1, limitMs: 10 });
    expect(result.files).toEqual(['b-small', 'z-required']);
    expect(result.deferred.map((entry: { file: string }) => entry.file)).toEqual(['a-priority']);
    expect(result.budget).toMatchObject({ predictedMaxMs: 10, aggregateMs: 10, requiredOverBudget: false });
  });

  it('reports when required files alone exceed the budget', async () => {
    const { cutToBudget, selectionSummary } = await api();
    const result = cutToBudget({ files: ['required', 'other'], requiredFiles: ['required'],
      durations: { required: 11, other: 1 }, machines: 1, workerCount: 1, limitMs: 10 });
    expect(result.files).toEqual(['required']);
    expect(result.deferred.map((entry: { file: string }) => entry.file)).toEqual(['other']);
    expect(result.budget).toMatchObject({ predictedMaxMs: 11, aggregateMs: 11, requiredOverBudget: true });
    expect(selectionSummary({ ...result, optional: {} })).toMatch(/required files alone exceed the.*budget/i);
  });

  it('allows the CLI limit to be exceeded only for a required-over-budget manifest', async () => {
    const root = mkdtempSync(resolve('.spider/scratch/budget-cli-'));
    try {
      const put = (file: string, value: string) => {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), value);
      };
      for (const file of ['scripts/select-tests.mjs', 'scripts/test-shard-budget.mjs', 'scripts/test-shards.ts', 'scripts/test-resources.json', 'scripts/roam-entries.json']) {
        put(file, readFileSync(file, 'utf8'));
      }
      const test = 'packages/roam/src/example.test.ts';
      put(test, 'export {};');
      put('scripts/test-durations.json', JSON.stringify({ [test]: 11 }));
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
      git('init', '-q'); git('config', 'user.name', 'Test Author'); git('config', 'user.email', 'test@example.invalid');
      git('add', '.'); git('commit', '-qm', 'test: fixture');
      const { selectTests } = await import(/* @vite-ignore */ join(root, 'scripts/select-tests.mjs'));
      const manifest = await selectTests({ root, base: 'missing' });
      const file = join(root, 'selection.json');
      for (const requiredOverBudget of [true, false, undefined]) {
        manifest.budget = { importMs: 0, requiredOverBudget };
        const { selectionHash: _hash, selectionMs: _time, ...payload } = manifest;
        manifest.selectionHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        writeFileSync(file, JSON.stringify(manifest));
        const run = spawnSync(process.execPath, [join(root, 'scripts/test-shard-budget.mjs'), '--manifest', file, '--limit-ms', '10'], { cwd: root, encoding: 'utf8' });
        expect(run.stderr).toBe('');
        expect(JSON.parse(run.stdout).predictedMaxMs).toBe(11);
        expect(run.status).toBe(requiredOverBudget === true ? 0 : 1);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reserves import time on the same workers instead of treating imports as free', async () => {
    const { cutToBudget } = await api();
    const result = cutToBudget({ files: ['a', 'b', 'c'], durations: { a: 4, b: 4, c: 4 },
      machines: 1, workerCount: 2, limitMs: 10, importMs: 2 });
    expect(result.files).toEqual(['a', 'b']);
    expect(result.deferred.map((entry: { file: string }) => entry.file)).toEqual(['c']);
    expect(result.budget).toMatchObject({ predictedMaxMs: 6, aggregateMs: 8, importMs: 2 });
    for (const importMs of [-1, NaN, Infinity]) expect(() => cutToBudget({ files: [], durations: {}, importMs })).toThrow(/import/);
  });

  it('uses the timing median for unknown files, permits empty selections, and is deterministic', async () => {
    const { cutToBudget } = await api();
    const options = { files: ['unknown', 'known'], durations: { known: 8, other: 12 }, machines: 1, workerCount: 1, limitMs: 9 };
    const result = cutToBudget(options);
    expect(result.files).toEqual(['known']);
    expect(result.deferred).toMatchObject([{ file: 'unknown', durationMs: 10 }]);
    expect(cutToBudget({ ...options, files: [...options.files].reverse() })).toEqual(result);
    expect(cutToBudget({ ...options, files: [] })).toMatchObject({ files: [], deferred: [], budget: { predictedMaxMs: 0 } });
    for (const limitMs of [0, -1, NaN, Infinity]) expect(() => cutToBudget({ ...options, limitMs })).toThrow(/budget/);
  });
});
