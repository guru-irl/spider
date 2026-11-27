// SPDX-License-Identifier: MIT
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { github } from './github.mjs';
import { rootTest, safePath, sorted, validateSelection } from './manifest.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8'));

export function failureRows(reports) {
  const failures = new Map();
  for (const report of reports) {
    if (!Array.isArray(report.testResults) || !report.testResults.length) throw new Error('Empty Vitest report');
    for (const row of report.testResults) {
      const file = row.name?.match(/(?:^|\/)(packages\/[^/]+\/src\/.+)$/)?.[1];
      if (!safePath(file) || !rootTest.test(file) || typeof row.status !== 'string') throw new Error('Unrecognized test in Vitest report');
      const assertions = row.assertionResults?.filter(test => test.status === 'failed') ?? [];
      if (row.status !== 'failed' && !assertions.length) continue;
      const problems = failures.get(file) ?? [];
      failures.set(file, problems.concat(assertions.length ? assertions.map(test => ({ test: test.fullName, messages: test.failureMessages ?? [] }))
        : [{ test: null, messages: [row.message ?? 'test suite failed before reporting a failed case'] }]));
    }
  }
  return failures;
}

export function auditFailures(failures, selection, known) {
  const misses = [], flakes = [];
  for (const file of sorted(failures.keys())) {
    if (Object.hasOwn(selection.selected, file)) continue;
    const documented = failures.get(file).every(failure => known.some(flake => flake.file === file && flake.test === failure.test
      && flake.message && flake.evidence && failure.messages.length && failure.messages.every(message => message.includes(flake.message))));
    (documented ? flakes : misses).push(file);
  }
  return { misses, flakes };
}

export async function mergedSelection(api, commit) {
  const prs = (await api.pages(`commits/${commit}/pulls?per_page=100`)).flat();
  const pr = prs.find(row => row.merge_commit_sha === commit && row.base.ref === 'main' && row.merged_at);
  if (!pr) return { unavailable: 'this main revision is not a PR merge commit' };
  const pages = await api.pages(`actions/workflows/pr.yml/runs?event=pull_request&status=success&head_sha=${pr.head.sha}&per_page=100`);
  for (const run of pages.flatMap(page => page.workflow_runs)) {
    if (run.head_sha !== pr.head.sha || run.head_repository?.full_name !== pr.head.repo?.full_name
        || !(Date.parse(run.updated_at) <= Date.parse(pr.merged_at))) continue;
    try {
      const artifact = await api.artifact(run.id, 'test-selection', 'test-selection.json');
      if (artifact && !artifact.expired) return { pr, runId: run.id, selection: validateSelection(artifact.read(), pr.head.sha) };
    } catch { /* Older successful runs of the same head may still have the artifact. */ }
  }
  return { unavailable: `no usable test-selection artifact for merged PR #${pr.number} at ${pr.head.sha}` };
}

export function summarizeAudit({ selection, misses, flakes, pr, runId, map, failures = new Map() }) {
  const lines = ['## Selection audit', '', `PR #${pr.number}, PR workflow run ${runId}.`,
    `Misses: ${misses.length}. Documented flaky files outside selection: ${flakes.length}.`, ''];
  for (const file of flakes) lines.push(`- Documented flake: \`${file}\``);
  if (misses.length) {
    lines.push('### Changed files', '', ...selection.changedFiles.map(({ status, file }) => `- ${status} \`${file}\``), '');
    for (const file of misses) {
      const record = map?.tests?.[file];
      const decoded = record ? { ...record, reads: record.reads.map(index => map.files[index]) } : null;
      lines.push(`### Miss: \`${file}\``, '', ...failures.get(file)?.map(row => `- Failed case: ${JSON.stringify(row.test)}`) ?? [], '',
        decoded ? `Record from map run ${selection.mapRunId}:` : 'No record available from the PR map.');
      if (decoded) lines.push('', '```json', JSON.stringify(decoded, null, 2), '```');
      lines.push('');
    }
  }
  return lines.join('\n') + '\n';
}

async function main(directory) {
  const { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: commit, GITHUB_REPOSITORY: repo, GITHUB_STEP_SUMMARY: summary } = process.env;
  const publish = text => { console.log(text); if (summary) appendFileSync(summary, `${text}\n`); };
  if (event !== 'push' || ref !== 'refs/heads/main') {
    publish('Selection audit runs only on pushes to main.');
    return;
  }
  const reports = [];
  for (let shard = 1; shard <= 6; shard++) {
    try { reports.push(read(resolve(directory, `shard-${shard}.json`))); }
    catch { throw new Error(`Selection audit inconclusive: no readable report for main shard ${shard}/6`); }
  }
  const failures = failureRows(reports);
  if (!failures.size) { publish('Selection audit: no failing root test files.'); return; }
  const api = github(repo);
  const evidence = await mergedSelection(api, commit);
  if (!evidence.selection) {
    publish(`Selection audit inconclusive: ${evidence.unavailable}. Failing files: ${sorted(failures.keys()).join(', ')}.`);
    return;
  }
  const { selection } = evidence;
  const known = read(new URL('./known-flakes.json', import.meta.url));
  const result = auditFailures(failures, selection, known);
  let map;
  if (result.misses.length && selection.mapRunId) {
    try {
      const artifact = await api.artifact(selection.mapRunId, 'selection-map', 'selection-map.json');
      const data = artifact && !artifact.expired ? artifact.read() : null;
      if (data?.commit === selection.mapCommit && data.runId === selection.mapRunId) map = data;
    } catch (error) { console.error(`Selection map unavailable for audit: ${error.message}`); }
  }
  publish(summarizeAudit({ ...evidence, ...result, map, failures }));
  if (result.misses.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[2]);
