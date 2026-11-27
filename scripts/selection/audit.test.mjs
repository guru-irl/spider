// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditFailures, failureRows, mergedSelection, summarizeAudit } from './audit.mjs';
import { selectionHash } from './manifest.mjs';

const a = 'packages/one/src/a.test.ts', b = 'packages/two/src/b.test.ts';
const head = 'a'.repeat(40), newest = 'b'.repeat(40), mapCommit = 'c'.repeat(40);
const shard = (...files) => ({ testResults: files });
const fail = (file, title, messages) => ({ name: `/home/runner/spider/${file}`, status: 'failed', assertionResults: [
  { fullName: title, status: 'failed', failureMessages: messages },
] });
const report = shard(fail(a, 'writes an index', ['wrong index']), fail(b, 'starts once', ['Error: Test timed out in 30000ms']));
const selection = { version: 1, head, selected: { [a]: ['changed test'] }, groups: [[a], [], [], []],
  changedFiles: [{ status: 'M', file: 'packages/one/src/index.ts' }], mapCommit, mapRunId: '44' };
const known = [{ file: b, test: 'starts once', message: 'Test timed out in 30000ms', evidence: '#123' }];

test('only excludes a documented flake when every failure in that file matches', () => {
  const failures = failureRows([report]);
  assert.deepEqual(auditFailures(failures, selection, known), { misses: [], flakes: [b] });
  const different = failureRows([report, shard(fail(b, 'starts twice', ['Expected one start']))]);
  assert.deepEqual(auditFailures(different, selection, known), { misses: [b], flakes: [] });
});

test('treats a failed file with no failed assertions (such as an import error) as a miss', () => {
  const failures = failureRows([shard({ name: `/home/runner/spider/${b}`, status: 'failed', assertionResults: [], message: 'missing dependency' })]);
  assert.deepEqual(auditFailures(failures, selection, known), { misses: [b], flakes: [] });
});

test('refuses reports that cannot identify their failed test', () => {
  assert.throws(() => failureRows([{ testResults: [{}] }]), /report/);
  assert.throws(() => failureRows([shard(fail('/tmp/not-a-root-test.ts', 'outside', []))]), /report/);
});

test('summarizes changed files, misses, and decoded records from the actual PR map', () => {
  const summary = summarizeAudit({ selection, misses: [b], flakes: [], pr: { number: 31 }, runId: 55,
    map: { files: ['packages/two/src/b.ts'], tests: { [b]: { reads: [0], unresolved: [], ms: 14, result: 'passed' } } } });
  for (const text of ['#31', '55', 'packages/one/src/index.ts', b, 'packages/two/src/b.ts', 'passed']) assert.ok(summary.includes(text));
});

const pr = { number: 31, merge_commit_sha: newest, merged_at: '2026-11-27T13:00:00Z', base: { ref: 'main' },
  head: { sha: head, repo: { full_name: 'example/fork' } } };
const run = (id, repo = 'example/fork') => ({ id, head_sha: head, head_repository: { full_name: repo }, updated_at: '2026-11-27T12:00:00Z' });
const upload = { ...selection, selectionHash: selectionHash(selection) };
const api = ({ prs = [pr], runs = [run(58, 'other/fork'), run(55), run(54)] } = {}) => ({
  pages: async path => path.includes('/pulls') ? [prs] : [{ workflow_runs: runs }],
  artifact: async id => id === 55 ? { expired: true } : id === 54 ? { read: () => upload } : null,
});

test('matches the exact merged PR and obtains the newest usable successful selection for its head', async () => {
  const result = await mergedSelection(api(), newest);
  assert.equal(result.runId, 54);
  assert.equal(result.pr.number, 31);
  assert.deepEqual(result.selection, upload);
});

test('does not silently attribute a direct push or an unavailable artifact to a previous PR', async () => {
  assert.match((await mergedSelection(api({ prs: [{ ...pr, merge_commit_sha: head }] }), newest)).unavailable, /merge commit/);
  assert.match((await mergedSelection(api({ runs: [run(55)] }), newest)).unavailable, /artifact/);
});
