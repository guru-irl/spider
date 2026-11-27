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

function bundleMap(root, compiled, payload, starts) {
  const base = pathToFileURL(dirname(compiled) + sep);
  const sourceRoot = payload.sourceRoot ? new URL(payload.sourceRoot.replace(/\/?$/, '/'), base) : base;
  const sources = payload.sources.map(source => {
    const url = new URL(source, sourceRoot);
    return url.protocol === 'file:' ? repoPath(root, fileURLToPath(url)) : null;
  });
  const map = new SourceMap({ ...payload, sourceRoot: '', sources: sources.map(source => source ?? '') });
  return {
    sources: sorted(new Set(sources.filter(Boolean))),
    at(offset) {
      const line = lineAt(starts, offset);
      return this.atPosition(line + 1, offset - starts[line]);
    },
    atPosition(line, col) {
      const entry = map.findEntry(line - 1, col);
      if (entry.generatedLine === line - 1 && entry.originalSource) {
        return [entry.originalSource, entry.originalLine + 1, entry.originalColumn];
      }
    },
  };
}

function bundleMaps(root, mapsDir) {
  const byHash = new Map();
  for (const entry of readdirSync(mapsDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.[cm]?js\.map$/.test(entry.name)) continue;
    const archivePath = join(entry.parentPath, entry.name);
    const compiled = join(root, 'dist', relative(mapsDir, archivePath).slice(0, -4));
    const bytes = readFileSync(compiled);
    byHash.set(sha256(bytes), bundleMap(root, compiled, read(archivePath), lineStarts(bytes.toString('utf8'))));
  }
  if (!byHash.size) throw new Error('no bundle maps found');
  return byHash;
}

export function reduce({ root = process.cwd(), rawDir, mapsDir, reportFile }) {
  const maps = bundleMaps(root, mapsDir);
  const fixtures = new Map();
  const report = existsSync(reportFile) ? read(reportFile) : null;
  const outcomes = new Map(report?.testResults?.map(result => [repoPath(root, result.name), result]) ?? []);
  const groups = new Map();
  const stats = { mappedBundles: maps.size, hookErrors: {}, rawBytes: 0, processes: 0, finalProcesses: 0, unattributedProcesses: 0,
    malformedSnapshots: 0, unresolvedBundles: 0, transformedBundles: 0, unmappedOffsets: 0, transformedSourcePositions: 0, unmappedSourceOffsets: 0,
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
      fixtureBundleExecuted: new Set(), shippedBundleExecuted: new Set(),
      functionPositions: new Map(), unplacedExecution: new Set(), unresolvedBundles: new Set(), transformedBundles: new Set(),
      processCount: 0, finalCount: 0, threadCount: 0, finalThreadCount: 0, cpuMs: 0, workerPids: [], workerWallMs: 0,
      earliest: Infinity, latest: 0,
    };
    groups.set(proc.test, entry);
    entry.earliest = Math.min(entry.earliest, proc.started);
    entry.latest = Math.max(entry.latest, proc.started + proc.wallMs);
    if (proc.worker) {
      entry.workerPids.push(proc.pid);
      entry.workerWallMs = Math.max(entry.workerWallMs, proc.wallMs);
    }
    if (!proc.threadId) {
      entry.processCount++;
      if (proc.ended) entry.finalCount++;
    } else {
      entry.threadCount++;
      if (proc.ended) entry.finalThreadCount++;
    }
    entry.cpuMs += (proc.cpuUsage.user + proc.cpuUsage.system) / 1000;
    const addPosition = (source, line, col) => {
      const positions = entry.functionPositions.get(source) ?? new Map();
      positions.set(`${line}:${col}`, [line, col]);
      entry.functionPositions.set(source, positions);
    };
    for (const script of proc.scripts) {
      if (script.kind === 'bundle' || script.kind === 'fixture') {
        if (script.sha256 && !maps.has(script.sha256) && !fixtures.has(script.sha256)) {
          const archive = join(rawDir, 'fixture-maps', `${script.sha256}.json`);
          const fixture = existsSync(archive) ? read(archive) : null;
          fixtures.set(script.sha256, fixture ? bundleMap(root, fixture.compiled, fixture.map, fixture.starts) : null);
        }
        const bundle = maps.get(script.sha256) ?? fixtures.get(script.sha256);
        if (!bundle) {
          stats.unresolvedBundles++;
          entry.unresolvedBundles.add(basename(scriptPath(script.url)));
          continue;
        }
        for (const source of bundle.sources) {
          entry.loaded.add(source);
          entry.bundleLoaded.add(source);
        }
        if (!script.exact && !script.positions?.length && script.offsets.length) {
          stats.transformedBundles++;
          entry.transformedBundles.add(basename(scriptPath(script.url)));
        }
        const positions = script.exact ? script.offsets.map(offset => bundle.at(offset))
          : (script.positions ?? []).map(pos => bundle.atPosition(...pos));
        if (!script.exact) stats.unmappedOffsets += script.offsets.length - positions.length;
        for (const mapped of positions) {
          if (!mapped) { stats.unmappedOffsets++; continue; }
          const [source, line, col] = mapped;
          entry.executed.add(source);
          entry.bundleExecuted.add(source);
          (maps.has(script.sha256) ? entry.shippedBundleExecuted : entry.fixtureBundleExecuted).add(source);
          if (!proc.worker) entry.childBundleExecuted.add(source);
          addPosition(source, line, col);
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
        if (starts) {
          for (const offset of script.offsets) {
            const line = lineAt(starts, offset);
            addPosition(source, line + 1, offset - starts[line]);
          }
        } else entry.unplacedExecution.add(source);
      } else if (!script.exact && script.offsets.length) {
        for (const position of script.positions ?? []) addPosition(source, ...position);
        stats.transformedSourcePositions += script.positions?.length ?? 0;
        const missed = script.offsets.length - (script.positions?.length ?? 0);
        stats.unmappedSourceOffsets += missed;
        // Generated export getters and mock wrappers introduce unmapped
        // offsets alongside real functions. A file with no mapped evidence
        // at all is an explicit function-identity gap.
        if (!script.positions?.length) entry.unplacedExecution.add(source);
      }
    }
  }
  const records = {};
  for (const [file, entry] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const result = outcomes.get(file);
    const functionPositions = Object.fromEntries(sorted(entry.functionPositions.keys()).map(source =>
      [source, [...entry.functionPositions.get(source).values()].sort(([al, ac], [bl, bc]) => al - bl || ac - bc)]));
    records[file] = {
      executed: sorted(entry.executed), loaded: sorted(entry.loaded), bundleExecuted: sorted(entry.bundleExecuted),
      fixtureBundleExecuted: sorted(entry.fixtureBundleExecuted), shippedBundleExecuted: sorted(entry.shippedBundleExecuted),
      bundleLoaded: sorted(entry.bundleLoaded), childBundleExecuted: sorted(entry.childBundleExecuted),
      unresolvedBundles: sorted(entry.unresolvedBundles), transformedBundles: sorted(entry.transformedBundles),
      functionPositions, unplacedExecution: sorted(entry.unplacedExecution),
      functionLines: Object.fromEntries(Object.entries(functionPositions).map(([source, pos]) => [source, [...new Set(pos.map(([line]) => line))]])),
      processCount: entry.processCount, finalCount: entry.finalCount,
      threadCount: entry.threadCount, finalThreadCount: entry.finalThreadCount, cpuMs: Math.round(entry.cpuMs),
      workerPids: entry.workerPids, wallMs: entry.workerWallMs || entry.latest - entry.earliest,
      vitestMs: result ? result.endTime - result.startTime : null, result: result?.status ?? 'unknown',
    };
  }
  return { version: 1, stats: { ...stats, mappedFixtures: [...fixtures.values()].filter(Boolean).length }, failureDetails, reportedFiles: [...outcomes.keys()].filter(Boolean).sort(), records };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [rawDir, mapsDir, reportFile, output] = process.argv.slice(2);
  if (!output) throw new Error('usage: node scripts/tia/reduce.mjs RAW MAPS VITEST_JSON OUTPUT');
  const start = performance.now();
  const result = reduce({ rawDir, mapsDir, reportFile });
  writeFileSync(output, JSON.stringify(result) + '\n');
  console.log(`TIA: reduced ${result.stats.processes} processes to ${Object.keys(result.records).length} test records in ${Math.round(performance.now() - start)} ms`);
}
