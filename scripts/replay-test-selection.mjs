#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process';
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const unique = values => [...new Set(values)].sort();
const rootTest = /^packages\/[^/]+\/src\/.+\.test\.ts$/;
const normalized = name => {
  const path = String(name).replaceAll('\\', '/');
  const file = path.startsWith('packages/') ? path : path.slice(path.indexOf('/packages/') + 1);
  return rootTest.test(file) && !file.split('/').includes('..') ? file : null;
};
const command = (executable, args, options = {}) => execFileSync(executable, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });

export function observeRun({ run, jobs = [], reports = [], reportShards, mergeCommit, logs = '' }) {
  const plain = logs.replace(/\u001b\[[0-9;]*m/g, '');
  const checkouts = unique([...plain.matchAll(/git log -1 --format=%H[^\n]*\n[^\n]*?\b([a-f0-9]{40})\b/g)].map(match => match[1]));
  const testedSha = checkouts.length === 1 ? checkouts[0] : null;
  const verifiedMerge = mergeCommit?.sha === testedSha && mergeCommit.parents?.length === 2 && mergeCommit.parents[1].sha === run.head_sha;
  const baseSha = run.pull_requests?.[0]?.base?.sha ?? (verifiedMerge ? mergeCommit.parents[0].sha : null);
  const failedFiles = [];
  for (const report of reports) for (const result of report.testResults ?? []) {
    if (result.status === 'failed' || result.assertionResults?.some(assertion => assertion.status === 'failed')) {
      const file = normalized(result.name);
      if (file) failedFiles.push(file);
    }
  }
  for (const match of plain.matchAll(/\bFAIL\s+(packages\/[^\s]+\.test\.ts)\b/g)) {
    const file = normalized(match[1]);
    if (file) failedFiles.push(file);
  }
  const failedJobs = jobs.filter(job => job.conclusion === 'failure');
  const externalFailures = unique(failedJobs.flatMap(job => /^chrome\b/i.test(job.name) ? ['chrome'] : /herdr acceptance/i.test(job.name) ? ['acceptance'] : /headless story/i.test(job.name) ? ['stories'] : []));
  const inconclusive = [];
  if (checkouts.length !== 1) inconclusive.push('missing or conflicting tested checkout SHA');
  if (!baseSha) inconclusive.push('missing historical base SHA');
  if (failedJobs.some(job => /^(?:test shard|PR tests)/i.test(job.name)) && !reports.length) inconclusive.push('failed test jobs have no JSON reports');
  if (reportShards) for (const job of failedJobs) {
    const shard = /^(?:test shard|PR tests) (\d+)\//i.exec(job.name)?.[1];
    if (shard && !reportShards.includes(Number(shard))) inconclusive.push(`failed shard ${shard} has no JSON report`);
  }
  if (!failedFiles.length && !externalFailures.length) inconclusive.push('no observed failing root test or optional gate; build or infrastructure failure');
  return {
    runId: run.id, url: run.html_url, headSha: run.head_sha,
    testedSha, baseSha,
    failedFiles: unique(failedFiles), externalFailures, inconclusive,
    failedJobs: failedJobs.map(job => job.name), reportCount: reports.length,
  };
}

export function compareReplay(observation, manifest) {
  const result = { ...observation, missedFiles: [], missedGates: [] };
  if (!manifest || manifest.testedSha !== observation.testedSha || manifest.baseSha !== observation.baseSha) {
    return { ...result, status: 'inconclusive', inconclusive: [...observation.inconclusive, 'selection revision does not match the observed red checkout and base'] };
  }
  result.missedFiles = observation.failedFiles.filter(file => !manifest.files.includes(file));
  result.missedGates = observation.externalFailures.filter(gate => !manifest.optional?.[gate]);
  result.status = result.missedFiles.length || result.missedGates.length ? 'miss' : observation.inconclusive.length ? 'inconclusive' : 'covered';
  result.selectedFiles = manifest.files.length;
  result.mode = manifest.mode;
  result.fallback = manifest.fallback;
  result.selectionMs = manifest.selectionMs;
  return result;
}

export function collectRuns({ count = 15, directory, repository = 'guru-irl/spider' }) {
  mkdirSync(directory, { recursive: true });
  const runs = JSON.parse(command('gh', ['run', 'list', '--repo', repository, '--workflow', 'ci.yml', '--event', 'pull_request', '--status', 'failure', '--limit', String(count), '--json', 'databaseId,headSha']));
  const observations = [];
  for (const item of runs) {
    const runDirectory = join(directory, String(item.databaseId));
    mkdirSync(runDirectory, { recursive: true });
    const cached = (filename, args) => {
      const file = join(runDirectory, filename);
      if (!existsSync(file)) writeFileSync(file, command('gh', args));
      return readFileSync(file, 'utf8');
    };
    try {
      const run = JSON.parse(cached('run.json', ['api', `repos/${repository}/actions/runs/${item.databaseId}`]));
      const { jobs } = JSON.parse(cached('jobs.json', ['run', 'view', String(item.databaseId), '--repo', repository, '--json', 'jobs']));
      let logs = '', downloadError;
      try { logs = cached('failed.log', ['run', 'view', String(item.databaseId), '--repo', repository, '--log-failed']); }
      catch { downloadError = 'failed job logs unavailable'; }
      const artifactDirectory = join(runDirectory, 'artifacts');
      if (!existsSync(join(runDirectory, 'downloaded'))) {
        try {
          command('gh', ['run', 'download', String(item.databaseId), '--repo', repository, '--pattern', 'test-results-*', '--dir', artifactDirectory]);
          writeFileSync(join(runDirectory, 'downloaded'), 'complete\n');
        } catch { downloadError = 'some test-result artifacts unavailable'; }
      }
      const reports = [], reportShards = [];
      if (existsSync(artifactDirectory)) for (const file of globSync('**/*.json', { cwd: artifactDirectory })) {
        try {
          const report = JSON.parse(readFileSync(join(artifactDirectory, file), 'utf8'));
          if (Array.isArray(report.testResults)) {
            reports.push(report);
            const shard = /shard-(\d+)\.json$/.exec(file)?.[1];
            if (shard) reportShards.push(Number(shard));
          }
        }
        catch { downloadError = 'invalid test-result artifact'; }
      }
      let observation = observeRun({ run, jobs, reports, reportShards, logs });
      if (!observation.baseSha && observation.testedSha) {
        try {
          const mergeCommit = JSON.parse(cached('merge-commit.json', ['api', `repos/${repository}/git/commits/${observation.testedSha}`]));
          observation = observeRun({ run, jobs, reports, reportShards, logs, mergeCommit });
        } catch { /* Missing immutable metadata remains inconclusive. */ }
      }
      if (downloadError) observation.inconclusive.push(downloadError);
      observations.push(observation);
      console.log(`Collected ${item.databaseId}: ${observation.failedFiles.length} failing files, ${reports.length} reports, ${observation.inconclusive.length} evidence gaps`);
    } catch (error) {
      observations.push({ runId: item.databaseId, headSha: item.headSha, testedSha: null, baseSha: null, failedFiles: [], externalFailures: [], inconclusive: [`run evidence unavailable: ${error.message.split('\n')[0]}`] });
    }
    writeFileSync(join(directory, 'corpus.json'), JSON.stringify(observations, null, 2) + '\n');
  }
  return observations;
}

// Run only on a disposable Linux CI runner. Each historical graph gets a fresh
// process and its own checkout. Hard-linked dependencies retain relative workspace
// links; no install scripts, test modules, workers or global setup are run here.
export function replayRuns(observations, { root = process.cwd(), directory } = {}) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('historical graph replay is CI-only; --collect is safe locally');
  const selector = fileURLToPath(new URL('./select-tests.mjs', import.meta.url));
  mkdirSync(directory, { recursive: true });
  const results = [];
  for (let observation of observations) {
    const runDirectory = join(directory, String(observation.runId));
    mkdirSync(runDirectory, { recursive: true });
    let manifest;
    if (observation.testedSha && observation.baseSha) {
      let checkout;
      try {
        for (const sha of [observation.testedSha, observation.baseSha]) {
          if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('invalid historical revision');
          try { command('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root }); }
          catch { command('git', ['fetch', '--quiet', 'origin', sha], { cwd: root }); }
        }
        checkout = mkdtempSync(join(directory, 'tree-'));
        command('git', ['worktree', 'add', '--quiet', '--detach', checkout, observation.testedSha], { cwd: root });
        command('cp', ['-al', join(root, 'node_modules'), join(checkout, 'node_modules')]);
        const filename = join(runDirectory, 'selection.json');
        const output = command(process.execPath, [selector, '--base', observation.baseSha, '--head', observation.testedSha, '--output', filename], { cwd: checkout, timeout: 180_000 });
        writeFileSync(join(runDirectory, 'selection.log'), output);
        manifest = JSON.parse(readFileSync(filename, 'utf8'));
      } catch (error) {
        observation = { ...observation, inconclusive: [...observation.inconclusive, `historical selection failed: ${error.message.split('\n')[0]}`] };
      } finally {
        if (checkout) {
          try { command('git', ['worktree', 'remove', '--force', checkout], { cwd: root }); }
          catch { /* Leave an owned disposable checkout for runner teardown. */ }
        }
      }
    }
    const result = compareReplay(observation, manifest);
    results.push(result);
    writeFileSync(join(directory, 'replay.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(`Replay ${observation.runId}: ${result.status}, ${result.missedFiles.length} missed files, ${result.missedGates.length} missed gates, ${result.selectionMs ?? '?'} ms`);
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const directory = resolve(option('--output', '.spider/scratch/selection-replay'));
  let observations;
  if (args.includes('--corpus')) observations = JSON.parse(readFileSync(option('--corpus'), 'utf8'));
  else observations = collectRuns({ count: Number(option('--recent', 15)), directory, repository: option('--repo', 'guru-irl/spider') });
  if (args.includes('--collect')) return;
  const results = replayRuns(observations, { directory });
  const counts = Object.fromEntries(['covered', 'miss', 'inconclusive'].map(status => [status, results.filter(result => result.status === status).length]));
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ runs: results.length, ...counts }, null, 2) + '\n');
  console.log(JSON.stringify(counts));
  if (counts.miss || counts.inconclusive || results.length < 15) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
