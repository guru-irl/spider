// SPDX-License-Identifier: MIT
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolationProblems } from './check-isolation.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8'));

export function shardProblems({ reportedFiles, records, stats }) {
  const problems = isolationProblems(records);
  if (!reportedFiles.length) problems.push('Vitest reported no test files');
  if (stats.hookErrors) problems.push(`${stats.hookErrors} recorder hook errors`);
  if (stats.malformedSnapshots) problems.push(`${stats.malformedSnapshots} malformed snapshots`);
  const groups = ['checkout', 'temporary', 'other'].map(group => stats.unresolvedGroups?.[group]);
  if (!Number.isSafeInteger(stats.unresolvedBundles) || stats.unresolvedBundles < 0 ||
      groups.some(count => !Number.isSafeInteger(count) || count < 0) ||
      groups.reduce((sum, count) => sum + count, 0) !== stats.unresolvedBundles) {
    problems.push('Invalid unresolved bundle observation counts');
  }
  const reported = new Set(reportedFiles);
  for (const file of reported) {
    if (!Object.hasOwn(records, file)) problems.push(`Missing record for ${file}`);
  }
  for (const [file, record] of Object.entries(records)) {
    if (!reported.has(file)) problems.push(`Record without a Vitest result: ${file}`);
    if (!Array.isArray(record.unresolved) || record.unresolved.some(path => typeof path !== 'string' || !path)) {
      problems.push(`Invalid unresolved bundle list for ${file}`);
    }
    if (typeof record.ranBundle !== 'boolean' || (record.unresolved?.length && !record.ranBundle) ||
        typeof record.incomplete !== 'boolean') {
      problems.push(`Invalid bundle or recording completeness flags for ${file}`);
    }
    const { processes, cpuMs, knownCpuMs, unknownCpu, missingCpu } = record;
    if (!Number.isSafeInteger(processes) || processes < 1 || !Number.isSafeInteger(unknownCpu) ||
        unknownCpu < 0 || unknownCpu > processes || !Number.isSafeInteger(missingCpu) || missingCpu < 0 ||
        missingCpu > unknownCpu || !Number.isFinite(knownCpuMs) || knownCpuMs < 0 ||
        (unknownCpu ? cpuMs !== null : cpuMs !== knownCpuMs)) {
      problems.push(`Invalid process or CPU measurement for ${file}`);
    }
  }
  return problems;
}

export function buildSelectionMap({ shards, expectedFiles, commit, runId, createdAt }) {
  const inventory = new Set(expectedFiles);
  const reported = new Set();
  const records = new Map();
  const sources = new Set();
  const failed = new Set();
  const problems = [];
  let hookErrors = 0;
  const unresolvedGroups = { checkout: 0, temporary: 0, other: 0 };
  for (const shard of shards) {
    problems.push(...shardProblems(shard));
    hookErrors += shard.stats.hookErrors;
    for (const group of Object.keys(unresolvedGroups)) unresolvedGroups[group] += shard.stats.unresolvedGroups?.[group] ?? 0;
    for (const file of shard.reportedFiles) {
      if (reported.has(file)) problems.push(`Reported by multiple shards: ${file}`);
      if (!inventory.has(file)) problems.push(`Not in Vitest inventory: ${file}`);
      reported.add(file);
    }
    for (const [file, record] of Object.entries(shard.records)) {
      records.set(file, record);
      for (const path of record.reads) sources.add(path);
      if (record.result === 'failed') failed.add(file);
    }
    for (const file of shard.failedFiles ?? []) failed.add(file);
  }
  if (!inventory.size) problems.push('Empty Vitest inventory');
  for (const file of inventory) {
    if (!reported.has(file)) problems.push(`Discovered but not reported by Vitest: ${file}`);
  }

  const files = [...sources].sort();
  let map = null;
  if (!problems.length) {
    const index = new Map(files.map((file, i) => [file, i]));
    const tests = Object.fromEntries([...records.keys()].sort().map(file => {
      const { reads, unresolved, ranBundle, incomplete, ms, result, processes, cpuMs, knownCpuMs, unknownCpu, missingCpu } = records.get(file);
      return [file, { reads: [...new Set(reads)].map(path => index.get(path)).sort((a, b) => a - b),
        unresolved, ranBundle, incomplete, ms, result, processes, cpuMs, knownCpuMs, unknownCpu, missingCpu }];
    }));
    map = { version: 2, commit, runId, createdAt, files, tests };
  }
  return { map, problems, recordedFiles: records.size, reportedFiles: reported.size,
    sourceFiles: files.length, hookErrors, unresolvedGroups, failedFiles: [...failed].sort() };
}

function publish(output, inventoryFile, shardFiles) {
  const { GITHUB_SHA: commit, GITHUB_RUN_ID: runId, GITHUB_STEP_SUMMARY: summaryFile } = process.env;
  if (!commit || !runId || !output || !inventoryFile || !shardFiles.length) {
    throw new Error('Usage: GITHUB_SHA=SHA GITHUB_RUN_ID=ID node scripts/selection/map.mjs OUTPUT INVENTORY SHARDS...');
  }
  const readProblems = [];
  const tryRead = file => {
    try { return read(file); }
    catch (error) { readProblems.push(`Cannot read ${file}: ${error.message}`); }
  };
  const expectedFiles = tryRead(inventoryFile) ?? [];
  const shards = shardFiles.map(tryRead).filter(Boolean);
  const { map, problems, recordedFiles, reportedFiles, sourceFiles, hookErrors, unresolvedGroups, failedFiles } =
    buildSelectionMap({ shards, expectedFiles, commit, runId, createdAt: new Date().toISOString() });
  problems.unshift(...readProblems);
  const json = problems.length ? null : JSON.stringify(map) + '\n';
  const summary = [
    '## Selection map', '',
    `- Test files recorded: ${recordedFiles} of ${expectedFiles.length} discovered (${reportedFiles} reported by Vitest)`,
    `- Source files: ${sourceFiles}`,
    `- Map size: ${json ? `${Buffer.byteLength(json)} bytes` : 'not published'}`,
    `- Hook errors: ${hookErrors}`,
    `- Unresolved bundle observations: ${unresolvedGroups.checkout} checkout, ${unresolvedGroups.temporary} temporary, ${unresolvedGroups.other} other`,
    `- Failed test files: ${failedFiles.length}`, '',
    ...failedFiles.map(file => `- \`${file}\``), '',
    ...problems.map(problem => `- ${problem}`), '',
  ].join('\n');
  console.log(summary);
  if (summaryFile) appendFileSync(summaryFile, summary);
  if (problems.length) process.exitCode = 1;
  else writeFileSync(output, json);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, inventoryFile, ...shardFiles] = process.argv.slice(2);
  if (output === '--check-shard') {
    const problems = shardProblems(read(inventoryFile));
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exitCode = 1;
    }
  } else publish(output, inventoryFile, shardFiles);
}
