import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// A dropped graph result, resource edge, or invalid-input fallback must change the manifest.
const roots: string[] = [];
const a = 'packages/roam/src/a.test.ts';
const b = 'packages/herdr/src/__tests__/feed-reader-server.test.ts';
const c = 'packages/host/src/__tests__/pi-config-examples.test.ts';
const guard = 'packages/host/src/__tests__/config-reader-guard.test.ts';
function fixture() {
  const root = mkdtempSync(resolve('.spider/scratch/selector-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test Author');
  git('config', 'user.email', 'test@example.invalid');
  function put(file: string, value = '// fixture\n') {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), value);
  }
  for (const file of [a, b, c, guard, 'packages/roam/src/store.ts', 'packages/herdr/assets/templates/role.md', 'docs/guide/example.md']) put(file);
  for (const file of ['scripts/test-shard-budget.mjs', 'scripts/test-shards.ts', 'scripts/roam-entries.json']) put(file, readFileSync(file, 'utf8'));
  function commit() { git('add', '.'); git('commit', '-qm', 'test: fixture'); return git('rev-parse', 'HEAD'); }
  const base = commit();
  return { root, git, put, commit, base };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function api() {
  const file = resolve('scripts/select-tests.mjs');
  // This assertion gives a useful red result before the implementation exists.
  const { existsSync } = await import('node:fs');
  expect(existsSync(file), 'the selector CLI must exist').toBe(true);
  return import(/* @vite-ignore */ file);
}

// Slow-test deferral reads the timing table beside the selector. Cases that
// depend on which files are slow install a private selector, runner and
// table in the fixture, so refreshing scripts/test-durations.json can't
// change what they select. The returned base commit contains those files.
async function selectorWith(f: ReturnType<typeof fixture>, durations: Record<string, number>) {
  for (const file of ['scripts/select-tests.mjs', 'scripts/run-selected-tests.mjs', 'scripts/test-resources.json']) f.put(file, readFileSync(file, 'utf8'));
  f.put('scripts/test-durations.json', JSON.stringify(durations));
  const base = f.commit();
  const selector = await import(/* @vite-ignore */ join(f.root, 'scripts/select-tests.mjs'));
  const runner = await import(/* @vite-ignore */ join(f.root, 'scripts/run-selected-tests.mjs'));
  return { selectTests: selector.selectTests, executionPlan: runner.executionPlan, base };
}

describe('change-scoped test manifests', () => {
  it('ranks changed tests and direct static imports before neighbors and transitive importers', async () => {
    const { testPriorities } = await api(); const f = fixture();
    const source = 'packages/roam/src/feature/value.ts';
    const changed = 'packages/roam/src/checks/changed.test.ts';
    const direct = 'packages/roam/src/checks/direct.test.ts';
    const typeOnly = 'packages/roam/src/checks/types.test.ts';
    const nearby = 'packages/roam/src/feature/nearby.test.ts';
    const child = 'packages/roam/src/feature/__tests__/child.test.ts';
    const transitive = 'packages/roam/src/checks/transitive.test.ts';
    const dynamic = 'packages/roam/src/checks/dynamic.test.ts';
    f.put(source, 'export const value = 1; export type Value = number;');
    f.put(changed);
    f.put(direct, 'import { value } from "../feature/value.js"; void value;');
    f.put(typeOnly, 'import type { Value } from "../feature/value.js"; export type V = Value;');
    f.put(nearby); f.put(child);
    f.put('packages/roam/src/checks/helper.ts', 'export { value } from "../feature/value.js";');
    f.put(transitive, 'import { value } from "./helper.js"; void value;');
    f.put(dynamic, 'const load = () => import("../feature/value.js");');
    expect(await testPriorities({ root: f.root, files: [changed, direct, typeOnly, nearby, child, transitive, dynamic], changedPaths: [source, changed] })).toEqual({
      [changed]: 0, [direct]: 0, [typeOnly]: 0, [nearby]: 1, [child]: 1, [transitive]: 2, [dynamic]: 2,
    });
  });

  it('cuts full-inventory candidates to the PR budget and checksums all deferred files', async () => {
    const { selectTests, validateManifest } = await api(); const f = fixture();
    f.put('unknown.resource');
    const head = f.commit();
    // These fixture paths use the real timing table; the guard exceeds 1 ms.
    const manifest = await selectTests({ ...f, head, budgetMs: 1 });
    expect(manifest.mode).toBe('scoped');
    expect(manifest.fallback).toMatch(/unclassified/);
    expect(manifest.budget).toMatchObject({ candidateMode: 'full', limitMs: 1, machines: 2, workerCount: 3 });
    expect(manifest.budget.predictedMaxMs).toBeLessThanOrEqual(1);
    expect([...manifest.files, ...manifest.deferred.map((entry: { file: string }) => entry.file)].sort()).toEqual([a, b, c, guard].sort());
    expect(manifest.deferred.map((entry: { file: string }) => entry.file)).toContain(guard);
    expect(validateManifest(manifest, { root: f.root })).toEqual(manifest.files);
    const tampered = structuredClone(manifest); tampered.deferred.pop();
    expect(() => validateManifest(tampered, { root: f.root })).toThrow(/checksum/);
  });

  it('defers only distant recorded slow tests and records why they wait for the full run', async () => {
    // Catches removing deferral, widening proximity to transitive imports, or
    // treating a changed test as a changed production-source directory.
    const f = fixture();
    const changed = 'packages/roam/src/feature/value.ts';
    const paths = {
      fast: 'packages/roam/src/checks/fast.test.ts',
      boundary: 'packages/roam/src/checks/boundary.test.ts',
      unknown: 'packages/roam/src/checks/unknown.test.ts',
      direct: 'packages/roam/src/checks/direct.test.ts',
      types: 'packages/roam/src/checks/types.test.ts',
      transitive: 'packages/roam/src/checks/transitive.test.ts',
      dynamic: 'packages/roam/src/checks/dynamic.test.ts',
      nearby: 'packages/roam/src/feature/nearby.test.ts',
      changed: 'packages/roam/src/other/changed.test.ts',
      neighborOfTest: 'packages/roam/src/other/neighbor.test.ts',
      distant: 'packages/roam/src/checks/distant.test.ts',
    };
    for (const file of Object.values(paths)) f.put(file, 'export {};');
    f.put(changed, 'export const value = 1; export type Value = number;');
    f.put(paths.direct, 'import { value } from "../feature/value.js"; void value;');
    f.put(paths.types, 'import type { Value } from "../feature/value.js"; export type V = Value;');
    f.put('packages/roam/src/checks/helper.ts', 'export { value } from "../feature/value.js";');
    f.put(paths.transitive, 'import { value } from "./helper.js"; void value;');
    f.put(paths.dynamic, 'const load = () => import("../feature/value.js");');
    f.put('scripts/select-tests.mjs', readFileSync('scripts/select-tests.mjs', 'utf8'));
    f.put('scripts/test-resources.json', readFileSync('scripts/test-resources.json', 'utf8'));
    f.put('scripts/test-durations.json', JSON.stringify({
      ...Object.fromEntries(Object.values(paths).filter(file => file !== paths.unknown).map(file => [file, 5001])),
      [paths.fast]: 1, [paths.boundary]: 5000,
    }));
    const base = f.commit();
    f.put(changed, 'export const value = 2; export type Value = number;');
    f.put(paths.changed, 'export const changed = true;');
    const selector = await import(/* @vite-ignore */ join(f.root, 'scripts/select-tests.mjs'));
    const manifest = await selector.selectTests({ ...f, base, head: f.commit(), resolveRelated: async () => Object.values(paths) });
    expect(manifest.mode).toBe('scoped');
    expect(manifest.files).toEqual([guard, paths.fast, paths.boundary, paths.unknown, paths.direct, paths.types, paths.nearby, paths.changed].sort());
    expect(manifest.deferred).toEqual([paths.distant, paths.dynamic, paths.neighborOfTest, paths.transitive].sort().map(file => ({
      file, durationMs: 5001, rule: 'slow test is unchanged, has no direct static import of a changed module, and shares no directory with changed source',
      reasons: ['import graph'],
    })));
    expect(Object.keys(manifest.reasons).sort()).toEqual(manifest.files);
    expect(selector.validateManifest(manifest, { root: f.root })).toEqual(manifest.files);
    const tampered = structuredClone(manifest); tampered.deferred.pop();
    expect(() => selector.validateManifest(tampered, { root: f.root })).toThrow(/checksum/);
  });

  it('writes the budgeted CLI manifest and every deferred file to the step summary', () => {
    const f = fixture();
    f.put('scripts/select-tests.mjs', readFileSync('scripts/select-tests.mjs', 'utf8'));
    f.put('scripts/test-resources.json', readFileSync('scripts/test-resources.json', 'utf8'));
    f.put('scripts/test-durations.json', JSON.stringify({ [a]: 75_001, [b]: 100, [c]: 100, [guard]: 100 }));
    const base = f.commit(); f.put('unknown.resource'); const head = f.commit();
    const output = join(f.root, 'selection.json'), summary = join(f.root, 'summary.md'), actions = join(f.root, 'outputs');
    execFileSync(process.execPath, [join(f.root, 'scripts/select-tests.mjs'), '--base', base, '--head', head, '--budget-ms', '75000', '--output', output], {
      cwd: f.root, env: { ...process.env, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: actions }, stdio: 'pipe',
    });
    const manifest = JSON.parse(readFileSync(output, 'utf8'));
    expect(manifest.mode).toBe('scoped');
    expect(manifest.files).toEqual([b, c, guard].sort());
    expect(manifest.deferred).toMatchObject([{ file: a, durationMs: 75_001 }]);
    expect(manifest.budget).toMatchObject({ limitMs: 75_000, importMs: 700, candidateMode: 'full' });
    expect(readFileSync(summary, 'utf8')).toContain(`\`${a}\``);
    expect(readFileSync(summary, 'utf8')).toMatch(/full run.*Chrome/);
    expect(readFileSync(summary, 'utf8')).toMatch(/full run.*acceptance/);
    expect(readFileSync(actions, 'utf8')).toContain('mode=scoped\n');
    expect(readFileSync(actions, 'utf8')).toContain('chrome=true\n');
    expect(readFileSync(actions, 'utf8')).toContain('acceptance=true\n');
  });

  it('retains a slow rule test while deferring a slow graph-only test', async () => {
    const f = fixture();
    const compiler = 'packages/roam/src/__tests__/provision-core-pin.test.ts';
    f.put(compiler, 'export {};');
    const { selectTests, base } = await selectorWith(f, { [compiler]: 10_816, [b]: 10_816, [guard]: 30_437 });
    f.put('packages/roam/src/store.ts', 'export const value = 2;');
    const manifest = await selectTests({ ...f, base, head: f.commit(), resolveRelated: async () => [b] });
    expect(manifest.mode).toBe('scoped');
    expect(manifest.files).toEqual([compiler, guard].sort());
    expect(manifest.reasons[compiler]).toContain('runtime-compiler-smoke: Retain the provisioning runtime-compiler sentinel on production edits, including subprocess startup failures outside the import graph.');
    expect(manifest.reasons[guard].some((reason: string) => reason.startsWith('source-text:'))).toBe(true);
    expect(manifest.deferred.map((entry: { file: string }) => entry.file)).toEqual([b]);
    expect(manifest.deferred[0].reasons).toEqual(['import graph']);
  });

  it('keeps rule tests over the PR budget and defers graph-only tests', async () => {
    const f = fixture();
    const compiler = 'packages/roam/src/__tests__/provision-core-pin.test.ts';
    f.put(compiler, 'export {};');
    const { selectTests, base } = await selectorWith(f, { [compiler]: 10_816, [b]: 100, [guard]: 100 });
    f.put('packages/roam/src/store.ts', 'export const value = 2;');
    const manifest = await selectTests({ ...f, base, head: f.commit(), budgetMs: 1_000, resolveRelated: async () => [b] });
    expect(manifest.mode).toBe('scoped');
    expect(manifest.files).toEqual([compiler, guard].sort());
    expect(manifest.deferred.map((entry: { file: string }) => entry.file)).toEqual([b]);
    expect(manifest.budget).toMatchObject({ limitMs: 1_000, predictedMaxMs: 11_516, requiredOverBudget: true });
  });

  it('retains matching rule tests even when an earlier change forces full fallback', async () => {
    const f = fixture();
    const compiler = 'packages/roam/src/__tests__/provision-core-pin.test.ts';
    f.put(compiler, 'export {};');
    const { selectTests, base } = await selectorWith(f, { [compiler]: 10_816, [guard]: 100 });
    f.put('.github/workflows/ci.yml', 'changed');
    f.put('packages/roam/src/store.ts', 'export const value = 2;');
    const manifest = await selectTests({ ...f, base, head: f.commit(), budgetMs: 1_000 });
    expect(manifest.budget.candidateMode).toBe('full');
    expect(manifest.files).toEqual([compiler, guard].sort());
    expect(manifest.budget.requiredOverBudget).toBe(true);
    expect(manifest.deferred.map((entry: { file: string }) => entry.file).sort()).toEqual([a, b, c].sort());
  });

  it('unions the Vite graph with source-text guards and records stable provenance', async () => {
    await api(); const f = fixture(); const { selectTests, base } = await selectorWith(f, { [guard]: 30_437 });
    f.put('packages/roam/src/store.ts', 'export const value = 2;'); const head = f.commit();
    const manifest = await selectTests({ ...f, base, head, resolveRelated: async () => [a] });
    expect(manifest.mode).toBe('scoped');
    expect(manifest.files).toEqual([a, guard].sort());
    expect(manifest.reasons[a]).toContain('import graph');
    expect(manifest.deferred.map((entry: { file: string }) => entry.file)).toEqual([]);
    expect(manifest.reasons[guard].some((s: string) => s.includes('source-text'))).toBe(true);
    expect(manifest.baseSha).toBe(base);
    expect(manifest.testedSha).toBe(head);
    expect(manifest.timingHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.selectionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(['package-lock.json', '.github/workflows/ci.yml', 'scripts/select-tests.mjs', 'vitest.setup.ts', 'packages/roam/src/vite.config.ts', 'packages/db-core/src/testutil.ts', 'unknown.resource'])(
    'runs the full inventory for %s without trusting a graph', async file => {
      const { selectTests } = await api(); const f = fixture(); f.put(file); const head = f.commit();
      const manifest = await selectTests({ ...f, head, resolveRelated: async () => [] });
      expect(manifest.mode).toBe('full'); expect(manifest.files).toEqual([a, b, c, guard].sort());
    });

  it('falls back on a graph error, invalid graph path, or missing merge base', async () => {
    const { selectTests } = await api(); const f = fixture(); f.put('packages/roam/src/store.ts', 'changed'); const head = f.commit();
    for (const resolveRelated of [async () => { throw new Error('resolver failure'); }, async () => ['../outside.test.ts']]) {
      const manifest = await selectTests({ ...f, head, resolveRelated });
      expect(manifest.mode).toBe('full'); expect(manifest.files).toHaveLength(4);
    }
    const missing = await selectTests({ ...f, base: 'f'.repeat(40), head, resolveRelated: async () => [] });
    expect(missing.mode).toBe('full'); expect(missing.files).toHaveLength(4);
    expect(missing.fallback).toMatch(/base|revision/i);
  });

  it('keeps new test files even when the import graph is empty', async () => {
    const { selectTests } = await api(); const f = fixture(); const added = 'packages/roam/src/new.test.ts'; f.put(added); const head = f.commit();
    const result = await selectTests({ ...f, head, resolveRelated: async () => [] });
    expect(result.files).toContain(added); expect(result.reasons[added]).toContain('changed test');
  });

  it('retains both rename names through a delete/add diff and falls back on deletions', async () => {
    const { selectTests } = await api(); const f = fixture(); f.git('mv', 'packages/roam/src/store.ts', 'packages/roam/src/moved.ts'); const head = f.commit();
    const result = await selectTests({ ...f, head, resolveRelated: async () => [] });
    expect(result.changedPaths).toEqual(['packages/roam/src/moved.ts', 'packages/roam/src/store.ts']);
    expect(result.mode).toBe('full'); expect(result.fallback).toMatch(/delet/);
  });

  it('maps Markdown and raw templates to filesystem consumers without asking Vite to parse Markdown', async () => {
    const { selectTests } = await api(); const f = fixture(); f.put('docs/guide/example.md', '# New example'); const head = f.commit();
    const docs = await selectTests({ ...f, head, resolveRelated: async () => [] });
    expect(docs.mode).toBe('scoped'); expect(docs.files).toContain(c);
    f.put('packages/herdr/assets/templates/role.md', 'new template');
    const assets = await selectTests({ ...f, head: f.commit(), resolveRelated: async () => [] });
    expect(assets.files).toContain(b);
  });

  it('keeps the runtime compiler smoke on production source changes outside its import graph', async () => {
    await api(); const f = fixture(); const { selectTests } = await selectorWith(f, {});
    const compiler = 'packages/roam/src/__tests__/provision-core-pin.test.ts';
    f.put(compiler, 'export {};'); const base = f.commit();
    f.put('packages/roam/src/value.ts', 'export const value = 2;');
    const result = await selectTests({ ...f, base, head: f.commit(), resolveRelated: async () => [] });
    expect(result.mode).toBe('scoped'); expect(result.files).toContain(compiler);
  });

  it('maps every bundle entry to its runtime consumers when Vite marks the entry affected', async () => {
    const { selectTests } = await api(); const f = fixture(); f.put('packages/roam/src/store.ts', 'changed'); const head = f.commit();
    const manifest = await selectTests({ ...f, head, resolveRelated: async (_seeds: string[], entries: string[]) => {
      if (entries.length) return ['packages/herdr/src/bin/feed-reader.ts'];
      return [b];
    } });
    expect(manifest.files).toContain(b);
    expect(manifest.reasons[b].some((s: string) => s.includes('bundle'))).toBe(true);
  });

  it('falls back for a dirty tracked checkout and rejects source drift after selection', async () => {
    const { selectTests, validateManifest } = await api(); const f = fixture();
    const clean = await selectTests({ ...f, head: f.base });
    f.put('packages/roam/src/store.ts', 'uncommitted source');
    expect((await selectTests({ ...f, head: f.base })).mode).toBe('full');
    expect(() => validateManifest(clean, { root: f.root })).toThrow(/checkout|tracked/);
  });

  it('rejects stale manifests rather than executing an empty or altered file list', async () => {
    const { selectTests, validateManifest } = await api(); const f = fixture(); f.put('docs/guide/example.md', 'changed'); const head = f.commit();
    const manifest = await selectTests({ ...f, head, resolveRelated: async () => [] });
    expect(validateManifest(manifest, { root: f.root, testedSha: head })).toEqual(manifest.files);
    expect(() => validateManifest({ ...manifest, files: [] }, { root: f.root, testedSha: head })).toThrow();
    expect(() => validateManifest(manifest, { root: f.root, testedSha: f.base })).toThrow(/revision|SHA/i);
  });

  it('rejects internally consistent manifests from another policy or timing table', async () => {
    const { selectTests, validateManifest } = await api(); const f = fixture();
    const manifest = await selectTests({ ...f, head: f.base });
    for (const field of ['policyHash', 'timingHash', 'selectorHash']) {
      const stale = { ...manifest, [field]: 'f'.repeat(64) };
      const { selectionHash: _hash, selectionMs: _time, ...payload } = stale;
      stale.selectionHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      expect(() => validateManifest(stale, { root: f.root })).toThrow(/policy|timing|selector/);
    }
  });

  it('prepares exact manifest files before two-way sharding and never reapplies changed filtering', async () => {
    await api(); const file = resolve('scripts/run-selected-tests.mjs');
    const { existsSync } = await import('node:fs');
    expect(existsSync(file), 'the manifest runner must exist').toBe(true);
    const f = fixture(); const { selectTests, executionPlan, base } = await selectorWith(f, { [guard]: 30_437 });
    f.put('docs/guide/example.md', 'changed'); const head = f.commit();
    const manifest = await selectTests({ ...f, base, head, resolveRelated: async () => [] });
    const plan = executionPlan(manifest, { root: f.root, shard: '1/2' });
    expect(plan.files).toEqual([c, guard].sort()); expect(plan.maxWorkers).toBe(3);
    expect(manifest.deferred.map((entry: { file: string }) => entry.file)).toEqual([]);
    expect(plan.shard).toBe('1/2'); expect(plan).not.toHaveProperty('changed');
    expect(executionPlan(manifest, { root: f.root, shard: '1/2', shadow: true }).files).toEqual([a, b, c, guard].sort());
    expect(() => executionPlan(manifest, { root: f.root, shard: '0/2' })).toThrow();
  });

  it('lists and models the selected inventory on two machines with three workers', async () => {
    const { selectTests } = await api(); const f = fixture();
    const manifest = await selectTests({ ...f, base: 'missing', head: f.base });
    const filename = join(f.root, 'selection.json'); writeFileSync(filename, JSON.stringify(manifest));
    const list = (shard: string) => JSON.parse(execFileSync(process.execPath, [resolve('scripts/list-test-shards.mjs'), shard, '--manifest', filename], { cwd: f.root, encoding: 'utf8' }));
    const partitions = [list('1/2'), list('2/2')];
    expect(partitions.flat().sort()).toEqual([a, b, c, guard].sort());
    expect(new Set(partitions.flat()).size).toBe(4);
    const budget = JSON.parse(execFileSync(process.execPath, [resolve('scripts/test-shard-budget.mjs'), '--manifest', filename], { cwd: f.root, encoding: 'utf8' }));
    expect(budget.fileCount).toBe(4); expect(budget.shards).toHaveLength(2);
    expect(budget.shards.every((shard: { workersMs: number[] }) => shard.workersMs.length === 3)).toBe(true);
    expect(budget).toHaveProperty('withoutSlowFiles');
  });

  it.each(['{', '{"version":1,"rules":null}'])('selects the full inventory when the policy cannot load: %s', async contents => {
    const f = fixture();
    const file = join(f.root, 'scripts/select-tests.mjs');
    f.put('scripts/select-tests.mjs', readFileSync('scripts/select-tests.mjs', 'utf8'));
    f.put('scripts/test-resources.json', contents); f.put('scripts/test-durations.json', '{}');
    const head = f.commit();
    const imported = import(/* @vite-ignore */ file);
    await expect(imported).resolves.toHaveProperty('selectTests');
    const result = await (await imported).selectTests({ ...f, head });
    expect(result.mode).toBe('full'); expect(result.files).toEqual([a, b, c, guard].sort());
    expect(result.fallback).toMatch(/policy/);
    expect(result.optional).toEqual({ chrome: true, acceptance: true, stories: true });
  });

  it('exposes installed package commands and the ordinary Vitest environment to test subprocesses', async () => {
    const f = fixture(); const pi = join(f.root, 'node_modules/.bin/pi');
    mkdirSync(dirname(pi), { recursive: true }); writeFileSync(pi, 'fixture executable; never launched');
    const { chmodSync } = await import('node:fs'); chmodSync(pi, 0o755);
    const runner = await import(/* @vite-ignore */ resolve('scripts/run-selected-tests.mjs'));
    const input = { PATH: '' };
    const env = runner.executionEnvironment ? runner.executionEnvironment(f.root, input) : input;
    const { resolveParticipantPi } = await import('@spider/roam/launcher');
    expect(resolveParticipantPi(env)).toBe(pi);
    expect(env).toMatchObject({ TEST: 'true', VITEST: 'true', NODE_ENV: 'test' });
    expect(input).toEqual({ PATH: '' });
    expect(runner.executionEnvironment(f.root, { NODE_ENV: 'custom' }).NODE_ENV).toBe('custom');
  });

  it('measures a separate cohort without measured slow files while retaining unknown timings', async () => {
    const { selectTests } = await api(); const f = fixture();
    const manifest = await selectTests({ ...f, base: 'missing', head: f.base });
    const file = resolve('scripts/measure-test-selection.mjs');
    const { existsSync } = await import('node:fs');
    expect(existsSync(file), 'the CI measurement script must exist').toBe(true);
    const { measurementPlan } = await import(/* @vite-ignore */ file);
    const plan = measurementPlan(manifest, { root: f.root, shard: '1/2', durations: { [a]: 6000, [b]: 5000, [guard]: 1 } });
    expect(plan.files).toEqual([b, guard, c].sort());
    expect(plan.excludedSlowFiles).toEqual([a]); expect(plan.unmeasuredFiles).toEqual([c]);
    expect(plan.sourceSelectionHash).toBe(manifest.selectionHash);
    expect(manifest.files).toHaveLength(4);
  });

  it.each(['scripts/test-resources.json', 'scripts/measure-test-selection.mjs', 'scripts/roam-entries.json'])('requires selector compatibility audits when selection policy changes: %s', async file => {
    const { selectTests } = await api(); const f = fixture(); f.put(file, '{}');
    const result = await selectTests({ ...f, head: f.commit() });
    expect(result.selectionAudit).toBe(true);
    expect((await selectTests({ ...f, head: f.git('rev-parse', 'HEAD'), base: f.git('rev-parse', 'HEAD') })).selectionAudit).toBe(false);
  });

  it('routes optional suites conservatively while skipping unrelated document changes', async () => {
    const { optionalSuites } = await api();
    expect(optionalSuites(['docs/architecture/example.md'])).toEqual({ chrome: false, acceptance: false, stories: false });
    expect(optionalSuites(['docs/guide/herdr.md'])).toEqual({ chrome: false, acceptance: true, stories: true });
    expect(optionalSuites(['packages/host/src/usage/web/app.ts'])).toEqual({ chrome: true, acceptance: true, stories: true });
    expect(optionalSuites(['packages/roam/src/cli.ts']).chrome).toBe(true);
    expect(optionalSuites(['packages/intercom/src/protocol.ts']).chrome).toBe(true);
    expect(optionalSuites(['packages/host/src/roam/readiness.ts']).chrome).toBe(true);
    expect(optionalSuites(['unknown.file'], true)).toEqual({ chrome: true, acceptance: true, stories: true });
  });

  it('selects bundle consumers when the soak entry is affected', async () => {
    const { selectTests } = await api(); const f = fixture();
    const soak = 'packages/roam/src/relocate/relay-soak.ts';
    f.put(soak, 'export const evidence = true;');
    const manifest = await selectTests({ ...f, head: f.commit(),
      resolveRelated: async (seeds: string[]) => seeds.includes(soak) ? [soak] : [],
    });
    expect(manifest.mode).toBe('scoped');
    expect(manifest.reasons[b]).toContain('bundle consumer');
  });

  it('keeps new literal bundle readers in the explicit consumer inventory', async () => {
    const { globSync } = await import('node:fs');
    const policy = JSON.parse(readFileSync('scripts/test-resources.json', 'utf8'));
    const omitted = globSync('packages/*/src/**/*.{ts,mjs}').filter(file =>
      (file.includes('/__tests__/') || file.includes('test'))
      && /dist\/|test-bundle/.test(readFileSync(file, 'utf8'))
      && !policy.bundles.consumers.includes(file));
    // The guard itself describes the inventory; it does not load a bundle.
    expect(omitted.filter(file => !file.endsWith('/select-tests.test.ts'))).toEqual([]);
  });

  it('falls back instead of passing empty when a changed helper has no classified consumer', async () => {
    const { selectTests } = await api(); const f = fixture();
    f.put('packages/roam/src/__tests__/computed-helper.ts', 'export const value = 2;');
    const result = await selectTests({ ...f, head: f.commit(), resolveRelated: async () => [] });
    expect(result.mode).toBe('full'); expect(result.files).toHaveLength(4);
    expect(result.fallback).toMatch(/consumer/);
  });

  it('makes an empty selection explicit only for a valid no-change comparison', async () => {
    const { selectTests } = await api(); const f = fixture();
    const result = await selectTests({ ...f, head: f.base, resolveRelated: async () => [] });
    expect(result.mode).toBe('scoped'); expect(result.files).toEqual([]); expect(result.changedPaths).toEqual([]);
  });
});
