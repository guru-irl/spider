// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../../.github/workflows/pr.yml', import.meta.url), 'utf8'));
const tests = ['packages/example/src/a.test.ts', 'packages/example/src/b.test.ts'];
const selectionPath = '.spider/scratch/test-results/test-selection.json';
const good = { result: 'success' };

function fixture(t) {
  const scratch = resolve('.spider/scratch');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pr-workflow-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  for (const dir of ['bin', 'runner', 'node_modules', dirname(selectionPath), '.spider/scratch/tmp']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  const put = (file, text, mode) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text, { mode });
  };
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
  const commit = () => {
    git('add', '--', 'scripts', 'packages');
    git('commit', '-qm', 'Fixture change');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  for (const file of ['test-shards.ts', 'test-resources.json', 'roam-entries.json']) {
    put(`scripts/${file}`, readFileSync(new URL(`../${file}`, import.meta.url)));
  }
  put('scripts/test-durations.json', JSON.stringify({ [tests[0]]: 120 }));
  put(tests[0], 'export {};');
  const legacy = commit();
  for (const file of ['select', 'run', 'manifest', 'fixture-bundles', 'github']) {
    put(`scripts/selection/${file}.mjs`, readFileSync(new URL(`./${file}.mjs`, import.meta.url)));
  }
  const base = commit();

  put('bin/gh', `#!/bin/sh
case "$2" in
  */actions/runs/99) echo '{"created_at":"2026-11-27T13:00:00Z"}' ;;
  */actions/workflows/selection-map.yml/runs*) echo '[{"workflow_runs":[]}]' ;;
  *) echo "Unexpected API request: $*" >&2; exit 64 ;;
esac
`, 0o700);
  symlinkSync(resolve('node_modules/vitest'), join(root, 'node_modules/vitest'), 'dir');
  const summary = join(root, 'summary');
  const output = join(root, 'runner-output');
  const run = (job, name, extra = {}, group = 1) => {
    const { run } = workflow.jobs[job].steps.find(step => step.name === name);
    return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', run.replaceAll('${{ matrix.group }}', String(group))], {
      cwd: root, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: join(root, 'runner'),
        PATH: `${join(root, 'bin')}:${process.env.PATH}`, BASE_SHA: base, SELECTION_BOOTSTRAP_SHA: base,
        GITHUB_REPOSITORY: 'example/spider', GITHUB_RUN_ID: '99', GITHUB_STEP_SUMMARY: summary,
        GITHUB_OUTPUT: output, ...extra },
    });
  };
  const select = extra => run('select', 'Select affected tests', extra);
  const selection = () => JSON.parse(readFileSync(join(root, selectionPath), 'utf8'));
  const published = () => {
    const lines = readFileSync(output, 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 1, 'one manifest for the entire matrix');
    assert.match(lines[0], /^manifest=[A-Za-z0-9+/]+=*$/);
    return lines[0].slice('manifest='.length);
  };
  const restore = (job, manifest) => run(job, 'Restore shared test selection', { SELECTION: manifest });
  return { put, commit, base, legacy, select, selection, summary, run, published, restore, root };
}

test('all PR shards and the audit receive one selection without transferring test artifacts', t => {
  const { put, commit, select, selection, published, restore, run, root, legacy } = fixture(t);
  const paths = [...tests, 'packages/example/src/c.test.ts', 'packages/example/src/d.test.ts'];
  for (const file of paths) put(file, 'import { it } from "vitest"; it("passes", () => {});');
  commit();
  assert.ok(workflow.jobs.select, 'the PR must compute one selection before starting the matrix');
  const result = select({ BASE_SHA: legacy });
  assert.equal(result.status, 0, result.stderr);
  const shared = published();
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(shared, 'base64'))), selection());
  assert.deepEqual(selection().groups, paths.map(file => [file]));

  const matrix = workflow.jobs.tests;
  assert.deepEqual(matrix.needs, ['select']);
  assert.deepEqual(matrix.strategy.matrix.group, [1, 2, 3, 4]);
  assert.equal(workflow.jobs.select.outputs.manifest, '${{ steps.selection.outputs.manifest }}');
  assert.equal(workflow.jobs.select.steps.find(step => step.id === 'selection').name, 'Select affected tests');
  for (const job of ['tests', 'save-selection']) {
    assert.equal(workflow.jobs[job].steps.find(step => step.name === 'Restore shared test selection').env.SELECTION,
      '${{ needs.select.outputs.manifest }}');
    assert.notEqual(restore(job, '').status, 0, 'missing output must not run tests');
  }
  for (const group of matrix.strategy.matrix.group) {
    put(selectionPath, '{}'); // No local selection from the producer may survive.
    const restored = restore('tests', shared);
    assert.equal(restored.status, 0, restored.stderr);
    const tested = run('tests', 'Test selected group', {}, group);
    assert.equal(tested.status, 0, tested.stdout + tested.stderr);
    const report = JSON.parse(readFileSync(join(root, dirname(selectionPath), `group-${group}.json`), 'utf8'));
    assert.deepEqual(report.testResults.map(row => row.name.slice(root.length + 1)), [paths[group - 1]]);
  }
  put(selectionPath, '{}');
  assert.equal(restore('save-selection', shared).status, 0);
  assert.deepEqual(selection().groups, paths.map(file => [file]));
  const uploads = Object.entries(workflow.jobs).flatMap(([job, { steps }]) => steps
    .filter(step => step.uses?.startsWith('actions/upload-artifact@'))
    .map(step => [job, step.with.name, step.with.path]));
  assert.deepEqual(uploads, [['save-selection', 'test-selection', selectionPath]]);
  assert.ok(Object.values(workflow.jobs).every(job => !Object.hasOwn(job, 'continue-on-error') &&
    job.steps.every(step => !Object.hasOwn(step, 'continue-on-error') && !step.uses?.startsWith('actions/download-artifact@'))));
});

test('the required PR check accepts success and rejects any failed, cancelled or skipped job', t => {
  const { run } = fixture(t);
  assert.deepEqual(workflow.jobs.checks.needs, ['compile', 'select', 'tests']);
  const required = Object.fromEntries(workflow.jobs.checks.needs.map(job => [job, good]));
  const check = needs => run('checks', 'Require selection, compile and tests to pass', { NEEDS_JSON: JSON.stringify(needs) });
  assert.equal(check(required).status, 0);
  for (const job of Object.keys(required)) for (const result of ['failure', 'cancelled', 'skipped']) {
    assert.notEqual(check({ ...required, [job]: { result } }).status, 0, `${job}: ${result}`);
  }
});

test('PR runner rejects an invalid selection even when the head runner and manifest accept it', t => {
  const { put, commit, run, base, legacy } = fixture(t);
  put('scripts/selection/run.mjs', 'console.log("Head runner always passes");');
  put('scripts/selection/manifest.mjs', 'export const validateSelection = () => ({ groups: [[], [], [], []] });');
  commit();
  put(selectionPath, '{}');
  for (const BASE_SHA of [base, legacy]) {
    const result = run('tests', 'Test selected group', { BASE_SHA });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /Selection belongs to a different checkout/);
  }
});

for (const [label, body] of [
  ['before writing', `import './missing-dependency.mjs';`],
  ['after writing a scoped manifest', `
    import { execFileSync } from 'node:child_process';
    import { appendFileSync, writeFileSync } from 'node:fs';
    import { selectionHash } from './manifest.mjs';
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const scoped = { version: 1, head, mode: 'scoped', fallback: null, mapRunId: '44', mapCommit: process.argv[2],
      changedFiles: [], selected: { '${tests[0]}': ['fixture'] }, groups: [['${tests[0]}'], [], [], []] };
    writeFileSync(process.argv[3], JSON.stringify({ ...scoped, selectionHash: selectionHash(scoped) }));
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, 'Unfinished scoped selection\\n');
    process.exit(17);
  `],
]) {
  test(`PR uses the full head inventory if the base selector fails ${label}`, t => {
    const { put, commit, selection, select, summary } = fixture(t);
    put('scripts/selection/select.mjs', body);
    const broken = commit();
    put('scripts/selection/select.mjs', `console.log('HEAD SELECTOR RAN'); process.exit(9);`);
    put('scripts/test-shards.ts', `throw new Error('HEAD PARTITIONER RAN');`);
    put(tests[1], 'export {};');
    commit();
    const result = select({ BASE_SHA: broken });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /HEAD (?:SELECTOR|PARTITIONER) RAN/);
    const manifest = selection();
    assert.equal(manifest.mode, 'full');
    assert.equal(manifest.mapRunId, null);
    assert.deepEqual(Object.keys(manifest.selected), tests);
    assert.deepEqual(manifest.groups, [[tests[0]], [tests[1]], [], []]);
    const notes = readFileSync(summary, 'utf8');
    assert.match(notes, /Selection: 2 of 2 files \(base selector failed\)/);
    assert.doesNotMatch(notes, /Unfinished scoped selection/);
  });
}
