// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../../.github/workflows/pr.yml', import.meta.url), 'utf8'));
const tests = ['packages/example/src/a.test.ts', 'packages/example/src/b.test.ts'];
const selectionPath = '.spider/scratch/test-results/test-selection.json';
const artifactDir = '.spider/scratch/selections';
const good = { result: 'success' };

function fixture(t) {
  const scratch = resolve('.spider/scratch');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pr-workflow-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  for (const dir of ['bin', 'runner', 'node_modules', artifactDir, dirname(selectionPath), '.spider/scratch/tmp']) {
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
  for (const file of ['select', 'run', 'aggregate', 'manifest', 'fixture-bundles', 'github']) {
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
  const summary = join(root, 'summary');
  const run = (job, name, extra = {}) => {
    const { run } = workflow.jobs[job].steps.find(step => step.name === name);
    return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', run.replaceAll('${{ matrix.group }}', '1')], {
      cwd: root, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: join(root, 'runner'),
        PATH: `${join(root, 'bin')}:${process.env.PATH}`, BASE_SHA: base, SELECTION_BOOTSTRAP_SHA: base,
        GITHUB_REPOSITORY: 'example/spider', GITHUB_RUN_ID: '99', GITHUB_STEP_SUMMARY: summary, ...extra },
    });
  };
  const select = extra => run('tests', 'Select affected tests', extra);
  const aggregate = (compile, tests, extra) => run('checks', 'Require identical PR selections', {
    HEAD_SHA: git('rev-parse', 'HEAD'), NEEDS_JSON: JSON.stringify({ compile, tests }), ...extra,
  });
  const selection = () => JSON.parse(readFileSync(join(root, selectionPath), 'utf8'));
  return { put, commit, base, legacy, select, aggregate, selection, summary, run };
}

test('PR aggregate rejects a failing group even when the head aggregate always succeeds', t => {
  const { put, commit, selection, select, aggregate, base, legacy } = fixture(t);
  put('scripts/selection/aggregate.mjs', 'console.log("Head aggregate always passes");');
  put('scripts/selection/manifest.mjs', 'export const requireAgreement = () => "always agree";');
  put(tests[1], 'export {};');
  commit();
  for (const BASE_SHA of [base, legacy]) {
    const selected = select({ BASE_SHA });
    assert.equal(selected.status, 0, selected.stderr);
    const manifest = selection();
    put(`${artifactDir}/test-selection.json`, JSON.stringify(manifest));
    for (let group = 1; group <= 4; group++) {
      put(`${artifactDir}/hash-${group}.json`, JSON.stringify({ group, selectionHash: manifest.selectionHash }));
    }
    const failed = aggregate(good, { result: 'failure' }, { BASE_SHA });
    assert.notEqual(failed.status, 0, failed.stdout);
    assert.match(failed.stderr, /Compile and every test runner must succeed/);
    const passed = aggregate(good, good, { BASE_SHA });
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /All 4 runners completed selection/);
    put(`${artifactDir}/hash-1.json`, JSON.stringify({ group: 1, selectionHash: 'wrong' }));
    assert.match(aggregate(good, good, { BASE_SHA }).stderr, /different selections/);
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
