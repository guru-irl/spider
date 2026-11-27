// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function inside(root, file) {
  const name = relative(root, file);
  return name && !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`) ? name.split(sep).join('/') : null;
}

function unresolvedPath(root, tmpRoot, url) {
  const file = url.startsWith('file:') ? fileURLToPath(url) : url.split(/[?#]/, 1)[0];
  const temporary = inside(tmpRoot, file);
  if (temporary) return { group: 'temporary', path: `<tmp>/${temporary}` };
  const checkout = inside(root, file);
  if (checkout) {
    const parts = checkout.split('/');
    const scratch = parts.findIndex((part, i) => part === '.spider' && parts[i + 1] === 'scratch');
    if (scratch !== -1) return { group: 'temporary', path: `<tmp>/${parts.slice(scratch + 2).join('/')}` };
    return { group: 'checkout', path: checkout };
  }
  return { group: 'other', path: file.split(sep).join('/') };
}

function repoPath(root, file) {
  const name = relative(root, file);
  return name && !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`) && !name.startsWith(`.spider${sep}`)
    && !name.split(sep).includes('node_modules') ? name.split(sep).join('/') : null;
}

function bundleSources(root, compiled, map) {
  const base = pathToFileURL(dirname(compiled) + sep);
  const sourceRoot = map.sourceRoot ? new URL(map.sourceRoot.replace(/\/?$/, '/'), base) : base;
  return map.sources.flatMap(source => {
    if (!source) return [];
    const url = new URL(source, sourceRoot);
    const path = url.protocol === 'file:' && repoPath(root, fileURLToPath(url));
    return path ? [path] : [];
  });
}

function bundleMaps(root, mapsDir) {
  const byHash = new Map();
  for (const entry of readdirSync(mapsDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.[cm]?js\.map$/.test(entry.name)) continue;
    const archivePath = join(entry.parentPath, entry.name);
    const compiled = join(root, 'dist', relative(mapsDir, archivePath).slice(0, -4));
    byHash.set(sha256(readFileSync(compiled)), bundleSources(root, compiled, read(archivePath)));
  }
  if (!byHash.size) throw new Error('No bundle maps found');
  return byHash;
}

function fileResult(report) {
  if (report.status === 'failed' || report.status === 'skipped') return report.status;
  if (report.status !== 'passed') throw new Error(`Unknown Vitest result for ${report.name}: ${report.status}`);
  // Vitest's JSON reporter calls a suite "passed" even if all its cases skipped.
  return report.assertionResults?.length && report.assertionResults.every(test => ['skipped', 'todo'].includes(test.status))
    ? 'skipped' : 'passed';
}

export function reduce({ root = process.cwd(), tmpRoot = tmpdir(), rawDir, mapsDir, reportFile }) {
  const maps = bundleMaps(root, mapsDir);
  const fixtures = new Map();
  const outcomes = new Map();
  for (const row of read(reportFile).testResults) {
    const file = repoPath(root, row.name);
    if (!file || outcomes.has(file)) throw new Error(`Invalid or duplicate Vitest report path: ${row.name}`);
    outcomes.set(file, row);
  }
  const groups = new Map();
  const errors = join(rawDir, 'hook-errors.ndjson');
  const stats = {
    hookErrors: existsSync(errors) ? readFileSync(errors, 'utf8').trim().split('\n').filter(Boolean).length : 0,
    malformedSnapshots: 0,
    unresolvedBundles: 0,
    unresolvedGroups: { checkout: 0, temporary: 0, other: 0 },
  };
  for (const name of readdirSync(rawDir).filter(name => /^\d+-[a-f0-9-]+\.json$/.test(name))) {
    let proc;
    try { proc = read(join(rawDir, name)); }
    catch { stats.malformedSnapshots++; continue; }
    if (!outcomes.has(proc.test)) continue;
    const entry = groups.get(proc.test) ?? { reads: new Set(), unresolved: new Set(), workerPids: new Set() };
    groups.set(proc.test, entry);
    if (proc.worker) entry.workerPids.add(proc.pid);
    for (const script of proc.scripts) {
      if (script.kind === 'bundle' || script.kind === 'fixture') {
        if (script.sha256 && !maps.has(script.sha256) && !fixtures.has(script.sha256)) {
          const archive = join(rawDir, 'fixture-maps', `${script.sha256}.json`);
          const fixture = existsSync(archive) ? read(archive) : null;
          fixtures.set(script.sha256, fixture ? bundleSources(root, fixture.compiled, fixture.map) : null);
        }
        const sources = maps.get(script.sha256) ?? fixtures.get(script.sha256);
        if (sources) {
          for (const source of sources) entry.reads.add(source);
        } else {
          const unresolved = unresolvedPath(root, tmpRoot, script.url);
          entry.unresolved.add(unresolved.path);
          stats.unresolvedBundles++;
          stats.unresolvedGroups[unresolved.group]++;
        }
      } else {
        const file = script.url.startsWith('file:') ? fileURLToPath(script.url) : script.url.split(/[?#]/, 1)[0];
        const source = repoPath(root, file);
        if (source) entry.reads.add(source);
      }
    }
  }
  const reportedFiles = [...outcomes.keys()].sort();
  const failedFiles = [];
  const records = {};
  for (const file of reportedFiles) {
    const report = outcomes.get(file);
    const result = fileResult(report);
    if (result === 'failed') failedFiles.push(file);
    const entry = groups.get(file);
    if (!entry) continue;
    const ms = report.endTime - report.startTime;
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid Vitest duration for ${file}`);
    records[file] = { reads: [...entry.reads].sort(), unresolved: [...entry.unresolved].sort(), workerPids: [...entry.workerPids], ms, result };
  }
  return { reportedFiles, failedFiles, records, stats };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [rawDir, mapsDir, reportFile, output] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node scripts/selection/reduce.mjs RAW MAPS VITEST_JSON OUTPUT');
  const shard = reduce({ rawDir, mapsDir, reportFile });
  writeFileSync(output, JSON.stringify(shard) + '\n');
  console.log(`Recorded ${Object.keys(shard.records).length} of ${shard.reportedFiles.length} reported test files; ${shard.stats.hookErrors} hook errors`);
}
