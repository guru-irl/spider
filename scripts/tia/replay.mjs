// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, matchesGlob, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'] });

const viteBuild = file => /^vite(?:[.-].*)?\.config\./.test(basename(file));
const buildScript = file => /^scripts\/build-[^/]+\.mjs$/.test(file);
const markdown = /\.(?:md|mdx|markdown)$/i;

export function selectForReplay({ inventory, records, rules, manifest, verifiedInventory = false,
  mode = 'current', deletedPaths = [], textReaders, staticImporters }) {
  const archived = [...manifest.files, ...manifest.deferred.map(entry => entry.file)];
  const wasFull = (manifest.budget?.candidateMode ?? manifest.mode) === 'full';
  const tests = wasFull && archived.length ? sorted(archived) : verifiedInventory ? inventory : sorted([...inventory, ...archived]);
  const hits = manifest.changedPaths.map(file => [file, rules.filter(rule => matches(file, rule.inputs))]);
  const policyFallback = hits.flatMap(([, matching]) => matching).find(rule => rule.full)?.id;
  const unknown = hits.find(([file, matching]) => !packageCode.test(file) && !matching.length)?.[0];
  const precise = mode === 'precise';
  const toolchainPaths = hits.filter(([file, matching]) => !viteBuild(file) && matching.some(rule => rule.id === 'toolchain')).map(([file]) => file);
  const full = precise ? (toolchainPaths.length ? 'toolchain' : wasFull && !hits.length ? manifest.fallback || 'no changed paths' : null)
    : policyFallback ?? (wasFull ? manifest.fallback || 'archived full selection' : unknown ? `unclassified changed path: ${unknown}` : null);
  if (full) return { full, toolchainPaths, lower: tests, upper: tests };
  if (!records) return { full, toolchainPaths, lower: null, upper: null };
  const common = new Set(), sources = new Set(), patternsByRule = new Map();
  const textPaths = new Set(), e2ePaths = new Set(), executedPaths = new Set();
  const deleted = new Set(deletedPaths.filter(file => manifest.changedPaths.includes(file)));
  const docs = rules.find(rule => rule.id === 'documentation');
  const inventoryGuard = rules.find(rule => rule.id === 'test-inventory');
  let built = false;
  for (const [file, matching] of hits) {
    let resources = matching;
    if (precise) {
      if (deleted.has(file)) continue;
      if (viteBuild(file) || buildScript(file) || matching.some(rule => rule.id === 'build-install')) {
        built = true;
        continue;
      }
      if (matching.some(rule => rule.id === 'test-policy')) {
        if (inventoryGuard) resources = [inventoryGuard];
        textPaths.add(file);
      } else if (file.startsWith('scripts/')) {
        textPaths.add(file);
        executedPaths.add(file);
        continue;
      } else if ((file.startsWith('docs/') || markdown.test(file)) || !code.test(file) && !file.startsWith('packages/herdr/e2e/')) {
        textPaths.add(file);
        if (docs && !matching.includes(docs)) resources = [...matching, docs];
      } else if (file.startsWith('packages/herdr/e2e/')) {
        e2ePaths.add(file);
        executedPaths.add(file);
        continue;
      } else {
        sources.add(file);
      }
    } else if (code.test(file)) sources.add(file);
    if (rootTest.test(file) && tests.includes(file)) common.add(file);
    for (const rule of resources) {
      if (rule.full) continue;
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
  if (textPaths.size) for (const test of textReaders(...textPaths)) common.add(test);
  if (e2ePaths.size) for (const test of staticImporters(...e2ePaths)) common.add(test);
  const lower = new Set(), upper = new Set();
  for (const test of tests) {
    const record = records[test];
    if (common.has(test) || (built && (record?.bundleLoaded?.length || record?.bundleExecuted?.length))
      || record?.executed.some(file => sources.has(file) || executedPaths.has(file) || deleted.has(file))
      || record?.loaded.some(file => deleted.has(file))) { lower.add(test); upper.add(test); }
    else if (record?.loaded.some(file => sources.has(file))) upper.add(test);
  }
  return { full, toolchainPaths, lower: sorted(lower), upper: sorted(upper) };
}

const RUNNERS = 4, WORKERS = 3, SETUP = 60_000, BUDGET = 180_000;

function packedWall(items) {
  const slots = Array(RUNNERS * WORKERS).fill(0);
  for (const { durationMs } of items) slots[slots.indexOf(Math.min(...slots))] += durationMs;
  // Use integer hundredths of a millisecond to avoid rounding an overrun down.
  return SETUP * 100 + Math.max(...slots) * 135;
}

export function estimate(files, durations, fallbackMs) {
  if (!files) return null;
  const items = files.map(file => ({ file, durationMs: durations[file] ?? fallbackMs }))
    .sort((a, b) => b.durationMs - a.durationMs || a.file.localeCompare(b.file));
  const adjusted = packedWall(items);
  const fits = adjusted <= BUDGET * 100;
  const overSingleFileLimit = items.filter(entry => SETUP * 100 + entry.durationMs * 135 > BUDGET * 100);
  const withoutLongFiles = overSingleFileLimit.length ? packedWall(items.slice(overSingleFileLimit.length)) : adjusted;
  return { files, totalMs: items.reduce((total, entry) => total + entry.durationMs, 0), wallMs: adjusted / 100, fits,
    over90s: items.filter(entry => entry.durationMs > 90_000), overSingleFileLimit,
    wallWithoutLongFilesMs: withoutLongFiles / 100, longFilesOnly: !fits && withoutLongFiles <= BUDGET * 100,
    estimated: files.filter(file => durations[file] == null) };
}

function tsv(file) {
  const [header, ...lines] = readFileSync(file, 'utf8').trimEnd().split('\n');
  const columns = header.split('\t');
  return lines.map(line => {
    const values = line.split('\t');
    return Object.fromEntries(columns.map((name, i) => [name, values[i] ?? '']));
  });
}

function gitChanges(root, base, head, ...pathspecs) {
  const fields = git(root, 'diff', '--name-status', '-z', '--no-renames', base, head, '--', ...pathspecs).split('\0');
  const changes = new Map();
  for (let i = 0; i + 1 < fields.length; i += 2) changes.set(fields[i + 1], fields[i]);
  return changes;
}

function historicalRoster(root, head, manifest) {
  const archived = sorted([...manifest.files, ...manifest.deferred.map(entry => entry.file)]);
  if (digest(archived) === manifest.inventoryHash) return { files: archived, evidence: 'archived inventory' };
  const listTests = rev => git(root, 'ls-tree', '-rz', '--name-only', rev, '--', 'packages').split('\0').filter(file => rootTest.test(file));
  try {
    const inventory = sorted(listTests(manifest.testedSha));
    if (digest(inventory) === manifest.inventoryHash) return { files: inventory, evidence: 'tested merge revision' };
  } catch { /* Older archives may not have their GitHub merge commits locally. */ }
  try {
    const base = manifest.baseSha ?? manifest.requestedBase;
    const ancestor = git(root, 'merge-base', base, head).trim();
    const files = new Set(listTests(base));
    for (const [file, status] of gitChanges(root, ancestor, head, 'packages')) {
      if (!rootTest.test(file)) continue;
      if (status === 'A') files.add(file);
      if (status === 'D') files.delete(file);
    }
    const inventory = sorted([...files, ...archived]);
    if (digest(inventory) === manifest.inventoryHash) return { files: inventory, evidence: 'reconstructed inventory' };
  } catch { /* Missing refs can leave only the archived candidate files. */ }
  return { files: null, evidence: 'unverified inventory' };
}

const testsPathspec = ':(glob)packages/*/src/**/*.test.ts';

function grepPaths(root, rev, needles, pathspecs) {
  try {
    return git(root, 'grep', '--threads=1', '-l', '-z', '-F', ...sorted(needles).flatMap(needle => ['-e', needle]), rev, '--', ...pathspecs)
      .split('\0').filter(Boolean).map(match => match.slice(rev.length + 1));
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

function readBlobs(root, ids) {
  if (!ids.length) return [];
  const output = execFileSync('git', ['cat-file', '--batch'], { cwd: root, maxBuffer: 64 * 1024 * 1024,
    input: ids.join('\n') + '\n' });
  let offset = 0;
  return ids.map(id => {
    const newline = output.indexOf(10, offset);
    const header = /^\w+ blob (\d+)$/.exec(output.toString('ascii', offset, newline));
    if (!header) throw new Error(`expected a blob for ${id}`);
    const end = newline + 1 + Number(header[1]);
    const text = output.toString('utf8', newline + 1, end);
    offset = end + 1;
    return text;
  });
}

function staticImports(file, text) {
  const imports = new Set();
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  function visit(node) {
    const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
      : ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) ? node.moduleReference.expression
      : ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' ? node.arguments[0] : null;
    if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
      imports.add(specifier.text.split(/[?#]/, 1)[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...imports];
}

const extensionless = file => file.replace(code, '');
function importNames(file) {
  const stem = extensionless(file);
  if (stem === file) return [file];
  const names = [file, stem];
  const jsExtension = new Map([['.ts', '.js'], ['.tsx', '.js'], ['.mts', '.mjs'], ['.cts', '.cjs']]).get(file.slice(stem.length));
  if (jsExtension) names.push(stem + jsExtension);
  if (basename(stem) === 'index') names.push(posix.dirname(stem));
  return names;
}

function staticImporters(root, rev, paths, importsByBlob) {
  const sources = git(root, 'ls-tree', '-rz', rev, '--', 'packages', 'scripts').split('\0').flatMap(entry => {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(entry);
    return match && code.test(match[2]) ? [{ id: match[1], file: match[2] }] : [];
  });
  const newBlobs = new Map(sources.filter(({ id }) => !importsByBlob.has(id)).map(({ id, file }) => [id, file]));
  const ids = [...newBlobs.keys()];
  const text = readBlobs(root, ids);
  for (let i = 0; i < ids.length; i++) importsByBlob.set(ids[i], staticImports(newBlobs.get(ids[i]), text[i]));
  const readers = new Map();
  for (const { id, file } of sources) {
    for (const specifier of importsByBlob.get(id)) {
      const target = posix.join(posix.dirname(file), specifier);
      if (!readers.has(target)) readers.set(target, []);
      readers.get(target).push(file);
    }
  }
  const reached = new Set(paths);
  for (const file of reached) {
    for (const name of importNames(file)) {
      for (const reader of readers.get(name) ?? []) reached.add(reader);
    }
  }
  return [...reached].filter(file => rootTest.test(file));
}

export function historicalInputs(root, manifest, importsByBlob = new Map()) {
  const tip = manifest.testedSha;
  const base = manifest.baseSha ?? manifest.requestedBase;
  const grep = (needles, pathspecs) => grepPaths(root, tip, needles, pathspecs);
  let changes;
  try { changes = gitChanges(root, base, tip); }
  catch (error) { throw new Error(`precise replay needs both revisions: ${base} and ${tip}`, { cause: error }); }
  if (digest(sorted(changes.keys())) !== digest(manifest.changedPaths)) throw new Error(`changed paths differ at ${tip}`);
  return {
    deletedPaths: manifest.changedPaths.filter(file => changes.get(file) === 'D'),
    sourceEvidence: 'tested merge revision',
    textReaders: (...paths) => grep(paths.flatMap(file => [file, basename(file)]), [testsPathspec]),
    staticImporters: (...paths) => staticImporters(root, tip, paths, importsByBlob),
  };
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
  const executed = eligible.filter(file => records[file]?.bundleExecuted.length);
  return {
    inventory: inventory.length, recorded: recorded.length, reported: inventory.filter(file => reported.has(file)).length,
    missing: inventory.filter(file => !records[file]), workerRecords: recorded.filter(file => records[file].workerPids.length === 1).length,
    unexpected: Object.keys(records).filter(file => !inventory.includes(file)), stats, hookErrors,
    bundle: { listed: consumers.length, runnable: eligible.length, helpers: consumers.filter(file => !inventory.includes(file)),
      mapped: mapped.length, executed: executed.length,
      subprocess: eligible.filter(file => records[file]?.childBundleExecuted.length).length,
      unmapped: eligible.filter(file => !records[file]?.bundleLoaded.length),
      withoutExecuted: eligible.filter(file => !records[file]?.bundleExecuted.length).map(file => ({ file,
        loaded: records[file]?.bundleLoaded.length ?? 0,
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

// The archive's FINDINGS.md and the measurement brief classify these rows.
// move-ports on run 45985350738 shows STACK_TRACE_ERROR in its Vitest JSON.
const knownFlakes = new Set([
  '46028211188/Headless story R12',
  '45987354370/herdr-pane-runtime-state.test.ts',
  '45985263802/move-ports.test.ts', '45985263802/move.test.ts',
  '45970284806/herdr-pane-runtime-state.test.ts',
  '45955267121/move.test.ts',
  '45947410701/provision-adapter.test.ts', '45947410701/move.test.ts', '45947410701/roam-move-checkout.test.ts',
  '45944403026/provision-adapter.test.ts',
  '45929020174/workspace-import.test.ts', '45929020174/move.test.ts',
]);

export function replay({ root = process.cwd(), recordingDir, archiveDir, baselineDir, mode = 'current' }) {
  const policy = read(join(root, 'scripts/test-resources.json'));
  const durations = read(join(root, 'scripts/test-durations.json'));
  const durationsSorted = Object.values(durations).sort((a, b) => a - b);
  const fallbackMs = durationsSorted[Math.floor(durationsSorted.length / 2)];
  const inventory = testInventory(root);
  const data = recordingDir ? allRecords(recordingDir) : null;
  const quality = recordingQuality(data, inventory, policy.bundles.consumers, durations, baselineResult(baselineDir));
  if (mode === 'quality') return quality;
  const importsByBlob = new Map();
  const runs = tsv(join(archiveDir, 'candidates.tsv')).map(row => {
    const manifest = read(join(archiveDir, 'runs', row.prRun, 'test-selection-1', 'selection-1.json'));
    const { selectionHash, selectionMs: _elapsed, ...payload } = manifest;
    if (selectionHash !== digest(payload)) throw new Error(`manifest checksum mismatch: ${row.prRun}`);
    const roster = historicalRoster(root, row.head, manifest);
    if (mode === 'precise' && !roster.files) throw new Error(`unverified historical inventory: ${row.prRun}`);
    const inputs = mode === 'precise' ? historicalInputs(root, manifest, importsByBlob) : {};
    const { full, toolchainPaths, lower, upper } = selectForReplay({ inventory: roster.files ?? inventory, records: data?.records,
      rules: policy.rules, manifest, verifiedInventory: Boolean(roster.files), mode, ...inputs });
    return { run: row.prRun, head: row.head, branch: row.branch, testedSha: manifest.testedSha, changedPaths: manifest.changedPaths,
      full, toolchainPaths, deletedPaths: inputs.deletedPaths, sourceEvidence: inputs.sourceEvidence,
      archivedOptionalSuites: manifest.optional,
      inventoryEvidence: roster.evidence, inventorySize: (roster.files ?? inventory).length,
      historicalFilesWithNoRecord: data && roster.files ? roster.files.filter(file => !data.records[file]).length : null,
      lower: estimate(lower, durations, fallbackMs), upper: estimate(upper, durations, fallbackMs) };
  });
  const byRun = new Map(runs.map(run => [run.run, run]));
  const failures = tsv(join(archiveDir, 'failures.tsv')).map(row => {
    const run = byRun.get(row.prRun);
    if (run && run.head !== row.head) throw new Error(`failure head differs from manifest: ${row.prRun}`);
    const flake = knownFlakes.has(`${row.prRun}/${basename(row.item).trim()}`)
      || /^(?:1|true|yes|flake|flaky)$/i.test(row.flake ?? row.classification ?? '') || /^flake:/i.test(row.detail);
    const status = bound => row.kind !== 'test-file' ? 'outside Vitest'
      : !run ? 'no manifest' : !run[bound] ? 'no recording' : run[bound].files.includes(row.item) ? 'selected' : 'missed';
    return { ...row, isFlake: flake, lower: status('lower'), upper: status('upper') };
  });
  const boundSummary = bound => {
    const measured = runs.filter(run => run[bound]);
    const blockers = new Map();
    for (const run of measured) for (const entry of run[bound].overSingleFileLimit) {
      blockers.set(entry.file, { ...entry, heads: (blockers.get(entry.file)?.heads ?? 0) + 1 });
    }
    return { estimatedHeads: measured.length, fits: measured.filter(run => run[bound].fits).length,
      overBudget: measured.filter(run => !run[bound].fits).length,
      longFilesOnly: measured.filter(run => run[bound].longFilesOnly).map(run => run.head),
      blockers: [...blockers.values()].sort((a, b) => b.heads - a.heads || b.durationMs - a.durationMs) };
  };
  return { mode, quality, parameters: { runners: RUNNERS, workersPerRunner: WORKERS, slowdown: 1.35, setupMs: SETUP, budgetMs: BUDGET, fallbackMs },
    summary: { heads: runs.length, full: runs.filter(run => run.full).length, lower: boundSummary('lower'), upper: boundSummary('upper') },
    runs, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const mode = args[0] === '--precise' ? (args.shift(), 'precise') : 'current';
  const [recordingDir, archiveDir, output, baselineDir] = args;
  if (!output) throw new Error('usage: node scripts/tia/replay.mjs [--precise] RECORDINGS_OR_- ESCAPES_DIR OUTPUT_JSON [NORMAL_REPORTS_DIR]');
  const result = replay({ mode, recordingDir: recordingDir === '-' ? null : recordingDir, archiveDir, baselineDir });
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  const { heads, full, lower, upper } = result.summary;
  if (result.quality) console.log(`TIA: ${result.quality.recorded}/${result.quality.inventory} records, ${result.quality.bundle.executed}/${result.quality.bundle.runnable} runnable bundle consumers have mapped execution`);
  else console.log('TIA: no recording artifacts; only full-fallback heads have estimates');
  console.log(`TIA: ${heads} heads (${full} full), ${lower.fits}/${lower.estimatedHeads} lower and ${upper.fits}/${upper.estimatedHeads} upper estimates fit 180 s`);
}
