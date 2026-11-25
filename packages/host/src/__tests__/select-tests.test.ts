import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

describe('change-scoped test manifests', () => {
  it('unions the Vite graph with source-text guards and records stable provenance', async () => {
    const { selectTests } = await api();
    const f = fixture(); f.put('packages/roam/src/store.ts', 'export const value = 2;'); const head = f.commit();
    const manifest = await selectTests({ ...f, head, resolveRelated: async () => [a] });
    expect(manifest.mode).toBe('scoped');
    expect(manifest.files).toEqual([guard, a].sort());
    expect(manifest.reasons[a]).toContain('import graph');
    expect(manifest.reasons[guard].some((s: string) => s.includes('source-text'))).toBe(true);
    expect(manifest.baseSha).toBe(f.base);
    expect(manifest.testedSha).toBe(head);
    expect(manifest.timingHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.selectionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(['package-lock.json', '.github/workflows/ci.yml', 'scripts/select-tests.mjs', 'vitest.setup.ts', 'packages/db-core/src/testutil.ts', 'unknown.resource'])(
    'runs the full inventory for %s without trusting a graph', async file => {
      const { selectTests } = await api(); const f = fixture(); f.put(file); const head = f.commit();
      const manifest = await selectTests({ ...f, head, resolveRelated: async () => { throw new Error('must not need graph'); } });
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
    const { selectTests } = await api(); const f = fixture(); f.put('docs/guide/example.md', 'changed'); const head = f.commit();
    const manifest = await selectTests({ ...f, head, resolveRelated: async () => [] });
    const file = resolve('scripts/run-selected-tests.mjs');
    const { existsSync } = await import('node:fs');
    expect(existsSync(file), 'the manifest runner must exist').toBe(true);
    const { executionPlan } = await import(/* @vite-ignore */ file);
    const plan = executionPlan(manifest, { root: f.root, shard: '1/2' });
    expect(plan.files).toEqual([guard, c]); expect(plan.maxWorkers).toBe(3);
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

  it.each(['scripts/test-resources.json', 'scripts/measure-test-selection.mjs'])('requires selector compatibility audits when selection policy changes: %s', async file => {
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
    expect(optionalSuites(['unknown.file'], true)).toEqual({ chrome: true, acceptance: true, stories: true });
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
