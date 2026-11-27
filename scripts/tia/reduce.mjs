// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = set => [...set].sort();
const repoPath = (root, file) => {
  const name = relative(root, file);
  return name && !isAbsolute(name) && !name.startsWith(`..${sep}`) && !name.startsWith(`.spider${sep}`)
    && !name.split(sep).includes('node_modules') ? name.split(sep).join('/') : null;
};
const scriptPath = url => url.startsWith('file:') ? fileURLToPath(url) : url.split(/[?#]/, 1)[0];

function lineStarts(text) {
  const starts = [0];
  for (const match of text.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) starts.push(match.index + match[0].length);
  return starts;
}

function lineAt(starts, offset) {
  let low = 0, high = starts.length;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid;
  }
  return low;
}

function bundleMaps(root, mapsDir) {
  const byHash = new Map();
  for (const entry of readdirSync(mapsDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.[cm]?js\.map$/.test(entry.name)) continue;
    const archivePath = join(entry.parentPath, entry.name);
    const compiled = join(root, 'dist', relative(mapsDir, archivePath).slice(0, -4));
    const bytes = readFileSync(compiled);
    const payload = read(archivePath);
    const base = pathToFileURL(dirname(compiled) + sep);
    const sourceRoot = payload.sourceRoot ? new URL(payload.sourceRoot.replace(/\/?$/, '/'), base) : base;
    const sources = payload.sources.map(source => {
      const url = new URL(source, sourceRoot);
      return url.protocol === 'file:' ? repoPath(root, fileURLToPath(url)) : null;
    });
    // Use real source coordinates but store repo paths without a machine prefix.
    const map = new SourceMap({ ...payload, sourceRoot: '', sources: sources.map(source => source ?? '') });
    const starts = lineStarts(bytes.toString('utf8'));
    byHash.set(sha256(bytes), {
      sources: sorted(new Set(sources.filter(Boolean))),
      at(offset) {
        const line = lineAt(starts, offset);
        const entry = map.findEntry(line, offset - starts[line]);
        if (entry.generatedLine === line && entry.originalSource) return [entry.originalSource, entry.originalLine + 1];
      },
    });
  }
  if (!byHash.size) throw new Error('no bundle maps found');
  return byHash;
}

export function reduce({ root = process.cwd(), rawDir, mapsDir, reportFile }) {
  const maps = bundleMaps(root, mapsDir);
  const report = existsSync(reportFile) ? read(reportFile) : null;
  const outcomes = new Map(report?.testResults?.map(result => [repoPath(root, result.name), result]) ?? []);
  const groups = new Map();
  const stats = { mappedBundles: maps.size, hookErrors: {}, rawBytes: 0, processes: 0, finalProcesses: 0, unattributedProcesses: 0,
    malformedSnapshots: 0, unresolvedBundles: 0, transformedBundles: 0, unmappedOffsets: 0,
    resultReportMissing: !report, reportedFiles: outcomes.size };
  const errors = join(rawDir, 'hook-errors.ndjson');
  if (existsSync(errors)) {
    for (const line of readFileSync(errors, 'utf8').trim().split('\n').filter(Boolean)) {
      let where;
      try { ({ where } = JSON.parse(line)); } catch { where = 'invalid error log'; }
      stats.hookErrors[where] = (stats.hookErrors[where] ?? 0) + 1;
    }
  }
  const fileLines = new Map();
  const failureDetails = Object.fromEntries([...outcomes].filter(([, result]) => result.status === 'failed').map(([file, result]) => [file,
    { failedTests: (result.assertionResults ?? []).filter(test => test.status === 'failed').map(test => test.fullName ?? test.title),
      message: String(result.message ?? '').slice(0, 1000) }]));
  for (const name of readdirSync(rawDir).filter(name => /^\d+-[a-f0-9-]+\.json$/.test(name))) {
    const file = join(rawDir, name);
    stats.rawBytes += statSync(file).size;
    let proc;
    try { proc = read(file); } catch { stats.malformedSnapshots++; continue; }
    stats.processes++;
    if (proc.ended) stats.finalProcesses++;
    if (!proc.test) { stats.unattributedProcesses++; continue; }
    const entry = groups.get(proc.test) ?? {
      loaded: new Set(), executed: new Set(), bundleLoaded: new Set(), bundleExecuted: new Set(), childBundleExecuted: new Set(),
      functionLines: new Map(), unresolvedBundles: new Set(), transformedBundles: new Set(),
      processCount: 0, finalCount: 0, cpuMs: 0, workerPids: [], workerWallMs: 0,
      earliest: Infinity, latest: 0,
    };
    groups.set(proc.test, entry);
    entry.earliest = Math.min(entry.earliest, proc.started);
    entry.latest = Math.max(entry.latest, proc.started + proc.wallMs);
    if (proc.worker) {
      entry.workerPids.push(proc.pid);
      entry.workerWallMs = Math.max(entry.workerWallMs, proc.wallMs);
    }
    entry.processCount++;
    if (proc.ended) entry.finalCount++;
    entry.cpuMs += (proc.cpuUsage.user + proc.cpuUsage.system) / 1000;
    const addLine = (source, line) => {
      const lines = entry.functionLines.get(source) ?? new Set();
      lines.add(line);
      entry.functionLines.set(source, lines);
    };
    for (const script of proc.scripts) {
      if (script.kind === 'bundle') {
        const bundle = maps.get(script.sha256);
        if (!bundle) {
          stats.unresolvedBundles++;
          entry.unresolvedBundles.add(basename(scriptPath(script.url)));
          continue;
        }
        for (const source of bundle.sources) {
          entry.loaded.add(source);
          entry.bundleLoaded.add(source);
        }
        if (!script.exact) {
          stats.transformedBundles++;
          entry.transformedBundles.add(basename(scriptPath(script.url)));
          continue;
        }
        for (const offset of script.offsets) {
          const mapped = bundle.at(offset);
          if (!mapped) { stats.unmappedOffsets++; continue; }
          const [source, line] = mapped;
          entry.executed.add(source);
          entry.bundleExecuted.add(source);
          if (!proc.worker) entry.childBundleExecuted.add(source);
          addLine(source, line);
        }
        continue;
      }
      const disk = scriptPath(script.url);
      const source = repoPath(root, disk);
      if (!source) continue;
      entry.loaded.add(source);
      if (script.offsets.length) entry.executed.add(source);
      if (script.exact && script.offsets.length) {
        if (!fileLines.has(source)) {
          const bytes = existsSync(disk) ? readFileSync(disk) : null;
          fileLines.set(source, bytes && sha256(bytes) === script.sha256 ? lineStarts(bytes.toString('utf8')) : null);
        }
        const starts = fileLines.get(source);
        if (starts) for (const offset of script.offsets) addLine(source, lineAt(starts, offset) + 1);
      }
    }
  }
  const records = {};
  for (const [file, entry] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const result = outcomes.get(file);
    records[file] = {
      executed: sorted(entry.executed), loaded: sorted(entry.loaded), bundleExecuted: sorted(entry.bundleExecuted),
      bundleLoaded: sorted(entry.bundleLoaded), childBundleExecuted: sorted(entry.childBundleExecuted),
      unresolvedBundles: sorted(entry.unresolvedBundles), transformedBundles: sorted(entry.transformedBundles),
      functionLines: Object.fromEntries(sorted(entry.functionLines.keys()).map(source => [source, [...entry.functionLines.get(source)].sort((a, b) => a - b)])),
      processCount: entry.processCount, finalCount: entry.finalCount, cpuMs: Math.round(entry.cpuMs),
      workerPids: entry.workerPids, wallMs: entry.workerWallMs || entry.latest - entry.earliest,
      vitestMs: result ? result.endTime - result.startTime : null, result: result?.status ?? 'unknown',
    };
  }
  return { version: 1, stats, failureDetails, reportedFiles: [...outcomes.keys()].filter(Boolean).sort(), records };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [rawDir, mapsDir, reportFile, output] = process.argv.slice(2);
  if (!output) throw new Error('usage: node scripts/tia/reduce.mjs RAW MAPS VITEST_JSON OUTPUT');
  const start = performance.now();
  const result = reduce({ rawDir, mapsDir, reportFile });
  writeFileSync(output, JSON.stringify(result) + '\n');
  console.log(`TIA: reduced ${result.stats.processes} processes to ${Object.keys(result.records).length} test records in ${Math.round(performance.now() - start)} ms`);
}
