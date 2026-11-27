// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, matchesGlob, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testInventory } from '../select-tests.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sorted = files => [...new Set(files)].sort();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rootTest = /^packages\/[^/]+\/src\/.+\.test\.ts$/;
const packageCode = /^packages\/[^/]+\/src\/.+\.[cm]?[jt]sx?$/;
const code = /\.[cm]?[jt]sx?$/;
const matches = (file, patterns) => patterns.reduce((included, pattern) => {
  const excluded = pattern.startsWith('!');
  return matchesGlob(file, excluded ? pattern.slice(1) : pattern) ? !excluded : included;
}, false);
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export function selectForReplay({ inventory, records, rules, manifest, verifiedInventory = false }) {
  const archived = [...manifest.files, ...manifest.deferred.map(entry => entry.file)];
  const wasFull = (manifest.budget?.candidateMode ?? manifest.mode) === 'full';
  const tests = wasFull && archived.length ? sorted(archived) : verifiedInventory ? inventory : sorted([...inventory, ...archived]);
  const hits = manifest.changedPaths.map(file => [file, rules.filter(rule => matches(file, rule.inputs))]);
  const policyFallback = hits.flatMap(([, matching]) => matching).find(rule => rule.full)?.id;
  const unknown = hits.find(([file, matching]) => !packageCode.test(file) && !matching.length)?.[0];
  const full = policyFallback ?? (wasFull ? manifest.fallback || 'archived full selection' : unknown ? `unclassified changed path: ${unknown}` : null);
  if (full) return { full, lower: tests, upper: tests };
  if (!records) return { full, lower: null, upper: null };
  const common = new Set(), sources = new Set(), patternsByRule = new Map();
  for (const [file, matching] of hits) {
    if (code.test(file)) sources.add(file);
    if (rootTest.test(file) && tests.includes(file)) common.add(file);
    for (const rule of matching) {
      if (rule.id === 'source-text' && (rootTest.test(file) || file.includes('/__tests__/'))) continue;
      const owners = patternsByRule.get(rule) ?? new Set();
      owners.add(rule.tests.some(pattern => pattern.includes('$package')) ? file.match(/^packages\/([^/]+)\//)?.[1] : undefined);
      patternsByRule.set(rule, owners);
      for (const source of rule.related) sources.add(source);
    }
  }
  for (const [rule, owners] of patternsByRule) {
    const patterns = [...owners].map(owner => rule.tests.filter(pattern => owner || !pattern.includes('$package')).map(pattern => pattern.replaceAll('$package', owner)));
    for (const test of tests) if (patterns.some(group => matches(test, group))) common.add(test);
  }
  const lower = new Set(common), upper = new Set(common);
  for (const test of tests) {
    const record = records[test];
    if (record?.executed.some(file => sources.has(file))) { lower.add(test); upper.add(test); }
    else if (record?.loaded.some(file => sources.has(file))) upper.add(test);
  }
  return { full, lower: sorted(lower), upper: sorted(upper) };
}

const RUNNERS = 4, WORKERS = 3, SETUP = 60_000, BUDGET = 180_000;

export function estimate(files, durations, fallbackMs) {
  if (!files) return null;
  const items = files.map(file => ({ file, durationMs: durations[file] ?? fallbackMs }))
    .sort((a, b) => b.durationMs - a.durationMs || a.file.localeCompare(b.file));
  const slots = Array(RUNNERS * WORKERS).fill(0);
  let totalMs = 0;
  for (const { durationMs } of items) {
    const slot = slots.indexOf(Math.min(...slots));
    slots[slot] += durationMs;
    totalMs += durationMs;
  }
  // Use integer hundredths of a millisecond to avoid rounding an overrun down.
  const adjusted = SETUP * 100 + Math.max(...slots) * 135;
  return { files, totalMs, wallMs: adjusted / 100, fits: adjusted <= BUDGET * 100,
    over90s: items.filter(entry => entry.durationMs > 90_000), estimated: files.filter(file => durations[file] == null) };
}

function tsv(file) {
  const [header, ...lines] = readFileSync(file, 'utf8').trimEnd().split('\n');
  const columns = header.split('\t');
  return lines.map(line => {
    const values = line.split('\t');
    return Object.fromEntries(columns.map((name, i) => [name, values[i] ?? '']));
  });
}

function historicalRoster(root, head, manifest) {
  const archived = sorted([...manifest.files, ...manifest.deferred.map(entry => entry.file)]);
  if (digest(archived) === manifest.inventoryHash) return { files: archived, evidence: 'archived inventory' };
  try {
    const base = manifest.baseSha ?? manifest.requestedBase;
    const ancestor = git(root, 'merge-base', base, head).trim();
    const files = new Set(git(root, 'ls-tree', '-rz', '--name-only', base, '--', 'packages').split('\0').filter(file => rootTest.test(file)));
    const changes = git(root, 'diff', '--name-status', '-z', '--no-renames', '--diff-filter=AD', ancestor, head, '--', 'packages').split('\0');
    for (let i = 0; i + 1 < changes.length; i += 2) {
      const [status, file] = [changes[i], changes[i + 1]];
      if (!rootTest.test(file)) continue;
      if (status === 'A') files.add(file);
      if (status === 'D') files.delete(file);
    }
    const inventory = sorted(files);
    if (digest(inventory) === manifest.inventoryHash) return { files: inventory, evidence: 'reconstructed inventory' };
  } catch { /* Missing refs can leave only the archived candidate files. */ }
  return { files: null, evidence: 'unverified inventory' };
}

const findReports = (dir, predicate) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && predicate(entry.name)).map(entry => join(entry.parentPath, entry.name)).sort();

function allRecords(dir) {
  const paths = findReports(dir, name => name === 'records.json');
  if (paths.length !== 6) throw new Error(`expected six recording shard files, found ${paths.length}`);
  const records = {}, stats = {}, hookErrors = {}, failures = {}, reported = new Set();
  for (const path of paths) {
    const artifact = read(path);
    if (artifact.version !== 1) throw new Error(`unsupported recording schema: ${path}`);
    for (const [file, value] of Object.entries(artifact.records)) {
      if (Object.hasOwn(records, file)) throw new Error(`multiple shards recorded ${file}`);
      records[file] = value;
    }
    for (const file of artifact.reportedFiles) {
      if (reported.has(file)) throw new Error(`multiple Vitest reports include ${file}`);
      reported.add(file);
    }
    Object.assign(failures, artifact.failureDetails);
    for (const [where, count] of Object.entries(artifact.stats.hookErrors)) hookErrors[where] = (hookErrors[where] ?? 0) + count;
    for (const [key, count] of Object.entries(artifact.stats)) {
      if (typeof count === 'number' || typeof count === 'boolean') stats[key] = (stats[key] ?? 0) + Number(count);
    }
  }
  return { records, stats, hookErrors, failures, reported };
}

function baselineResult(dir) {
  if (!dir) return {};
  const reports = findReports(dir, name => /^shard-\d+\.json$/.test(name));
  if (reports.length !== 12) throw new Error(`expected twelve normal CI shard files, found ${reports.length}`);
  return Object.fromEntries(reports.flatMap(file => read(file).testResults.map(result => {
    const name = result.name.match(/(?:^|\/)(packages\/.*)$/)?.[1];
    return [name, { status: result.status, ms: result.endTime - result.startTime }];
  })).filter(([file]) => file));
}

function recordingQuality(data, inventory, consumers, durations, baseline) {
  if (!data) return null;
  const { records, stats, failures, hookErrors, reported } = data;
  const recorded = inventory.filter(file => records[file]);
  const eligible = consumers.filter(file => inventory.includes(file));
  const mapped = eligible.filter(file => records[file]?.bundleLoaded.length);
  return {
    inventory: inventory.length, recorded: recorded.length, reported: inventory.filter(file => reported.has(file)).length,
    missing: inventory.filter(file => !records[file]), workerRecords: recorded.filter(file => records[file].workerPids.length === 1).length,
    unexpected: Object.keys(records).filter(file => !inventory.includes(file)), stats, hookErrors,
    bundle: { listed: consumers.length, runnable: eligible.length, helpers: consumers.filter(file => !inventory.includes(file)),
      mapped: mapped.length, executed: eligible.filter(file => records[file]?.bundleExecuted.length).length,
      subprocess: eligible.filter(file => records[file]?.childBundleExecuted.length).length,
      unmapped: eligible.filter(file => !records[file]?.bundleLoaded.length).map(file => ({ file,
        unresolved: records[file]?.unresolvedBundles ?? [], transformed: records[file]?.transformedBundles ?? [] })) },
    failures: Object.entries(failures).map(([file, value]) => ({ file, ...value, baseline: baseline[file]?.status ?? 'unknown' })),
    slowest: inventory.filter(file => durations[file] != null).sort((a, b) => durations[b] - durations[a] || a.localeCompare(b)).slice(0, 30)
      .map(file => ({ file, baselineTableMs: durations[file], cpuMs: records[file]?.cpuMs ?? null,
        wallMs: records[file]?.wallMs ?? null, processes: records[file]?.processCount ?? null,
        finalProcesses: records[file]?.finalCount ?? null, result: records[file]?.result ?? 'missing' })),
    pairedFileTimes: recorded.filter(file => records[file].result === 'passed' && baseline[file]?.status === 'passed' && records[file].vitestMs > 0 && baseline[file].ms > 0)
      .map(file => ({ file, recordedMs: records[file].vitestMs, baselineMs: baseline[file].ms })),
  };
}

export function replay({ root = process.cwd(), recordingDir, archiveDir, baselineDir }) {
  const policy = read(join(root, 'scripts/test-resources.json'));
  const durations = read(join(root, 'scripts/test-durations.json'));
  const durationsSorted = Object.values(durations).sort((a, b) => a - b);
  const fallbackMs = durationsSorted[Math.floor(durationsSorted.length / 2)];
  const inventory = testInventory(root);
  const data = recordingDir ? allRecords(recordingDir) : null;
  const quality = recordingQuality(data, inventory, policy.bundles.consumers, durations, baselineResult(baselineDir));
  const runs = tsv(join(archiveDir, 'candidates.tsv')).map(row => {
    const manifest = read(join(archiveDir, 'runs', row.prRun, 'test-selection-1', 'selection-1.json'));
    const { selectionHash, selectionMs: _elapsed, ...payload } = manifest;
    if (selectionHash !== digest(payload)) throw new Error(`manifest checksum mismatch: ${row.prRun}`);
    const roster = historicalRoster(root, row.head, manifest);
    const { full, lower, upper } = selectForReplay({ inventory: roster.files ?? inventory, records: data?.records,
      rules: policy.rules, manifest, verifiedInventory: Boolean(roster.files) });
    return { run: row.prRun, head: row.head, branch: row.branch, testedSha: manifest.testedSha, changedPaths: manifest.changedPaths,
      full, inventoryEvidence: roster.evidence, inventorySize: (roster.files ?? inventory).length,
      historicalFilesWithNoRecord: data && roster.files ? roster.files.filter(file => !data.records[file]).length : null,
      lower: estimate(lower, durations, fallbackMs), upper: estimate(upper, durations, fallbackMs) };
  });
  const byRun = new Map(runs.map(run => [run.run, run]));
  const failures = tsv(join(archiveDir, 'failures.tsv')).map(row => {
    const run = byRun.get(row.prRun);
    if (run && run.head !== row.head) throw new Error(`failure head differs from manifest: ${row.prRun}`);
    const flake = /^(?:1|true|yes|flake|flaky)$/i.test(row.flake ?? row.classification ?? '') || /^flake:/i.test(row.detail);
    const status = bound => flake ? 'explicit flake' : row.kind !== 'test-file' ? 'outside Vitest'
      : !run ? 'no manifest' : !run[bound] ? 'no recording' : run[bound].files.includes(row.item) ? 'selected' : 'missed';
    return { ...row, lower: status('lower'), upper: status('upper') };
  });
  const boundSummary = bound => {
    const measured = runs.filter(run => run[bound]);
    const blockers = new Map();
    for (const run of measured) for (const entry of run[bound].over90s) {
      blockers.set(entry.file, { ...entry, heads: (blockers.get(entry.file)?.heads ?? 0) + 1 });
    }
    return { estimatedHeads: measured.length, fits: measured.filter(run => run[bound].fits).length,
      overBudget: measured.filter(run => !run[bound].fits).length,
      blockers: [...blockers.values()].sort((a, b) => b.heads - a.heads || b.durationMs - a.durationMs) };
  };
  return { quality, parameters: { runners: RUNNERS, workersPerRunner: WORKERS, slowdown: 1.35, setupMs: SETUP, budgetMs: BUDGET, fallbackMs },
    summary: { heads: runs.length, full: runs.filter(run => run.full).length, lower: boundSummary('lower'), upper: boundSummary('upper') },
    runs, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [recordingDir, archiveDir, output, baselineDir] = process.argv.slice(2);
  if (!output) throw new Error('usage: node scripts/tia/replay.mjs RECORDINGS_OR_- ESCAPES_DIR OUTPUT_JSON [NORMAL_REPORTS_DIR]');
  const result = replay({ recordingDir: recordingDir === '-' ? null : recordingDir, archiveDir, baselineDir });
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  const { heads, full, lower, upper } = result.summary;
  if (result.quality) console.log(`TIA: ${result.quality.recorded}/${result.quality.inventory} records, ${result.quality.bundle.mapped}/${result.quality.bundle.runnable} runnable bundle consumers mapped`);
  else console.log('TIA: no recording artifacts; only full-fallback heads have estimates');
  console.log(`TIA: ${heads} heads (${full} full), ${lower.fits}/${lower.estimatedHeads} lower and ${upper.fits}/${upper.estimatedHeads} upper estimates fit 180 s`);
}
