import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const testedSha = 'a'.repeat(40), baseSha = 'b'.repeat(40), headSha = 'c'.repeat(40);
const file = 'packages/roam/src/store.test.ts';
async function api() {
  const path = resolve('scripts/replay-test-selection.mjs');
  expect(existsSync(path), 'the historical replay script must exist').toBe(true);
  return import(/* @vite-ignore */ path);
}
const run = { id: 123, head_sha: headSha, pull_requests: [{ base: { sha: baseSha } }] };
const checkout = `test shard\tcheckout\t2026-01-01T00:00:00Z [command]/usr/bin/git log -1 --format=%H\ntest shard\tcheckout\t2026-01-01T00:00:00Z ${testedSha}\n`;

describe('historical selector recall', () => {
  it('uses the tested merge SHA and includes failed suites with no assertions', async () => {
    const { observeRun } = await api();
    const observation = observeRun({ run, logs: checkout, mergeCommit: { sha: testedSha, parents: [{ sha: baseSha }, { sha: headSha }] }, jobs: [{ name: 'test shard 1/12', conclusion: 'failure' }], reports: [{ testResults: [
      { name: `/home/runner/work/project/project/${file}`, status: 'failed', assertionResults: [] },
      { name: 'packages/host/src/example.test.ts', status: 'passed', assertionResults: [] },
    ] }] });
    expect(observation.testedSha).toBe(testedSha); expect(observation.headSha).toBe(headSha);
    expect(observation.baseSha).toBe(baseSha); expect(observation.failedFiles).toEqual([file]);
    expect(observation.inconclusive).toEqual([]);
  });

  it('recovers a closed PR base only from a verified two-parent tested merge', async () => {
    const { observeRun } = await api();
    const input = { run: { ...run, pull_requests: [] }, logs: checkout, jobs: [], reports: [{ testResults: [{ name: file, status: 'failed' }] }] };
    const observation = observeRun({ ...input, mergeCommit: { sha: testedSha, parents: [{ sha: baseSha }, { sha: headSha }] } });
    expect(observation.baseSha).toBe(baseSha); expect(observation.inconclusive).toEqual([]);
    expect(observeRun({ ...input, mergeCommit: { sha: testedSha, parents: [{ sha: baseSha }] } }).baseSha).toBeNull();
  });

  it('prefers the verified tested merge parent over a PR base that moved later', async () => {
    const { observeRun } = await api();
    const observation = observeRun({ run: { ...run, pull_requests: [{ base: { sha: 'd'.repeat(40) } }] }, logs: checkout,
      mergeCommit: { sha: testedSha, parents: [{ sha: baseSha }, { sha: headSha }] },
      reports: [{ testResults: [{ name: file, status: 'failed' }] }] });
    expect(observation.baseSha).toBe(baseSha); expect(observation.inconclusive).toEqual([]);
  });

  it('does not accept a mutable PR API base without a verified tested merge', async () => {
    const { observeRun } = await api();
    const observation = observeRun({ run, logs: checkout, reports: [{ testResults: [{ name: file, status: 'failed' }] }] });
    expect(observation.baseSha).toBeNull();
    expect(observation.inconclusive.some((reason: string) => reason.includes('base'))).toBe(true);
  });

  it('does not turn optional-suite installation failures into observed browser test failures', async () => {
    const { observeRun } = await api();
    const input = { run, logs: checkout, mergeCommit: { sha: testedSha, parents: [{ sha: baseSha }, { sha: headSha }] } };
    const setup = observeRun({ ...input, jobs: [{ name: 'chrome states gallery', conclusion: 'failure', steps: [{ name: 'Install', conclusion: 'failure' }] }] });
    expect(setup.externalFailures).toEqual([]);
    expect(setup.inconclusive.some((reason: string) => reason.includes('optional') || reason.includes('infrastructure'))).toBe(true);
    const test = observeRun({ ...input, jobs: [{ name: 'chrome states gallery', conclusion: 'failure', steps: [{ name: 'Installed Chrome smoke', conclusion: 'failure' }] }] });
    expect(test.externalFailures).toEqual(['chrome']); expect(test.inconclusive).toEqual([]);
  });

  it('retains failed files from logs when a failed shard has no artifact', async () => {
    const { observeRun } = await api();
    const observation = observeRun({ run, logs: checkout + `test shard\tTest shard\t2026-01-01Z \u001b[31m FAIL \u001b[0m ${file} > broken\n`, jobs: [{ name: 'test shard 1/12', conclusion: 'failure' }], reports: [] });
    expect(observation.failedFiles).toEqual([file]);
    expect(observation.inconclusive.some((reason: string) => reason.includes('report'))).toBe(true);
  });

  it('does not count missing evidence or conflicting checkout SHAs as perfect recall', async () => {
    const { observeRun, compareReplay } = await api();
    const observation = observeRun({ run, logs: '', jobs: [{ name: 'test shard 1/12', conclusion: 'failure' }], reports: [] });
    expect(compareReplay(observation, { testedSha, baseSha, files: [] }).status).toBe('inconclusive');
    const conflict = observeRun({ run, logs: checkout + checkout.replaceAll(testedSha, headSha), jobs: [], reports: [] });
    expect(conflict.testedSha).toBeNull();
    expect(conflict.inconclusive.some((reason: string) => reason.includes('checkout'))).toBe(true);
  });

  it('reports a known omitted failing file as a miss, including alongside incomplete evidence', async () => {
    const { compareReplay } = await api();
    const observation = { testedSha, baseSha, failedFiles: [file], externalFailures: [], inconclusive: [] };
    expect(compareReplay(observation, { testedSha, baseSha, files: [], optional: {} })).toMatchObject({ status: 'miss', missedFiles: [file] });
    expect(compareReplay({ ...observation, inconclusive: ['missing another shard report'] }, { testedSha, baseSha, files: [], optional: {} }).status).toBe('miss');
    expect(compareReplay(observation, { testedSha, baseSha, files: [file], optional: {} }).status).toBe('covered');
  });

  it('requires evidence from each failed shard, not merely a report from another shard', async () => {
    const { observeRun } = await api();
    const observation = observeRun({ run, logs: checkout, jobs: [{ name: 'test shard 2/12', conclusion: 'failure' }], reports: [{ testResults: [] }], reportShards: [1] });
    expect(observation.inconclusive.some((reason: string) => reason.includes('shard 2'))).toBe(true);
  });

  it('records an invalid historical revision without throwing away the replay report', async () => {
    const { replayRuns } = await api();
    const directory = mkdtempSync(resolve('.spider/scratch/replay-invalid-'));
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    try {
      const results = replayRuns([{ runId: 123, testedSha: 'invalid', baseSha, failedFiles: [file], externalFailures: [], inconclusive: [] }], { directory });
      expect(results).toHaveLength(1); expect(results[0].status).toBe('inconclusive');
    } finally { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('checks optional gate routing instead of treating excluded browser failures as covered', async () => {
    const { compareReplay } = await api();
    const observation = { testedSha, baseSha, failedFiles: [], externalFailures: ['chrome'], inconclusive: [] };
    expect(compareReplay(observation, { testedSha, baseSha, files: [], optional: { chrome: false } })).toMatchObject({ status: 'miss', missedGates: ['chrome'] });
    expect(compareReplay(observation, { testedSha, baseSha, files: [], optional: { chrome: true } }).status).toBe('covered');
    expect(compareReplay(observation, { testedSha: headSha, baseSha, files: [], optional: { chrome: true } }).status).toBe('inconclusive');
  });
});
