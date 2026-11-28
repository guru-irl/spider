// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readKernelTrace } from './kernel-trace.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function inside(root, file) {
  const name = relative(root, file);
  return name && !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`) ? name.split(sep).join('/') : null;
}

function modulePath(url) {
  // Vitest can encode a module's query as part of the URL pathname.
  return (url.startsWith('file:') ? fileURLToPath(url) : url).split(/[?#]/, 1)[0];
}

function unresolvedPath(root, tmpRoot, url) {
  const file = modulePath(url);
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
    const path = url.protocol === 'file:' && repoPath(root, modulePath(url.href));
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
  const trees = new Map();
  const checkout = resolve(root);
  let tracked;
  function trackedPaths() {
    return tracked ??= execFileSync('git', ['ls-files', '-z'], { cwd: checkout, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      .split('\0').filter(Boolean);
  }
  function treeInputs(name) {
    if (name === null) return [];
    if (!trees.has(name)) {
      // A copy source may be a file. A listing of the checkout root reads
      // the entire tracked tree. Do not match siblings with the same prefix.
      const prefix = name ? `${name}/` : '';
      trees.set(name, trackedPaths().filter(path => path === name || path.startsWith(prefix)));
    }
    return trees.get(name);
  }
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
  function unresolvedBundle(entry, url) {
    const unresolved = unresolvedPath(root, tmpRoot, url);
    entry.unresolved.add(unresolved.path);
    stats.unresolvedBundles++;
    stats.unresolvedGroups[unresolved.group]++;
  }
  const group = file => {
    if (!groups.has(file)) groups.set(file, { reads: new Set(), unresolved: new Set(), bundlePaths: new Set(),
      workerPids: new Set(), ranBundle: false,
      processes: new Map(), threads: new Set(), observedThreads: new Set(), readyThreads: new Map(), threadExits: new Set(),
      launches: new Set(), observedLaunches: new Set(), versionProbes: new Set(), probeExits: new Set() });
    return groups.get(file);
  };
  const launches = join(rawDir, 'launches.ndjson');
  if (existsSync(launches)) {
    for (const line of readFileSync(launches, 'utf8').split('\n').filter(Boolean)) {
      let launch;
      try { launch = JSON.parse(line); }
      catch { stats.malformedSnapshots++; continue; }
      if (!outcomes.has(launch.test)) continue;
      const entry = group(launch.test);
      if (launch.kind === 'process' && launch.launchId) entry.launches.add(launch.launchId);
      else if (launch.kind === 'process-intent' && launch.launchId && ['node', 'node-version'].includes(launch.argvClass)) {
        if (launch.argvClass === 'node-version') entry.versionProbes.add(launch.launchId);
      } else if (launch.kind === 'probe-exit' && launch.launchId) entry.probeExits.add(launch.launchId);
      else if (['thread', 'thread-exit'].includes(launch.kind) && launch.processId && launch.threadId > 0) {
        const thread = `${launch.processId}:${launch.threadId}`;
        if (launch.kind === 'thread') entry.threads.add(thread);
        else entry.threadExits.add(thread);
      } else stats.malformedSnapshots++;
    }
  }
  const rawFiles = readdirSync(rawDir);
  const journals = new Set(rawFiles.filter(name => /^\d+-[a-f0-9-]+\.ndjson$/.test(name)));
  for (const name of rawFiles.filter(name => /^\d+-[a-f0-9-]+\.json$/.test(name))) {
    const journal = name.replace(/\.json$/, '.ndjson');
    const input = journals.delete(journal) ? readFileSync(join(rawDir, journal), 'utf8') : '';
    let proc;
    try { proc = read(join(rawDir, name)); }
    catch { stats.malformedSnapshots++; continue; }
    if (!outcomes.has(proc.test)) continue;
    const entry = group(proc.test);
    if (proc.worker) entry.workerPids.add(proc.pid);
    const processId = proc.processId ?? `pid:${proc.pid}`;
    const process = entry.processes.get(processId) ?? { cpuMs: null, ended: false };
    if (Number.isFinite(proc.cpuMs) && proc.cpuMs >= 0) process.cpuMs = Math.max(process.cpuMs ?? 0, proc.cpuMs);
    if ((proc.threadId ?? 0) === 0) {
      process.pid = proc.pid;
      process.ended ||= proc.ended === true;
      process.captureReady ||= proc.captureReady === true;
    }
    entry.processes.set(processId, process);
    if (proc.launchId) entry.observedLaunches.add(proc.launchId);
    if (proc.threadId > 0) {
      const thread = `${processId}:${proc.threadId}`;
      entry.threads.add(thread);
      if (proc.ended) entry.observedThreads.add(thread);
      if (proc.captureReady) entry.readyThreads.set(thread, proc.pid);
    }
    for (const line of input.split('\n').filter(Boolean)) {
      let script;
      try { script = JSON.parse(line); }
      catch { stats.malformedSnapshots++; continue; }
      if (script?.kind === 'build') { entry.ranBundle = true; continue; }
      if (!['source', 'bundle', 'fixture', 'tree'].includes(script?.kind) || typeof script.url !== 'string' || !script.url) {
        stats.malformedSnapshots++;
        continue;
      }
      if (script.kind === 'bundle' || script.kind === 'fixture') {
        entry.ranBundle = true;
        entry.bundlePaths.add(modulePath(script.url));
        if (script.sha256 && !maps.has(script.sha256) && !fixtures.has(script.sha256)) {
          const archive = join(rawDir, 'fixture-maps', `${script.sha256}.json`);
          const fixture = existsSync(archive) ? read(archive) : null;
          fixtures.set(script.sha256, fixture ? bundleSources(root, fixture.compiled, fixture.map) : null);
        }
        const sources = maps.get(script.sha256) ?? fixtures.get(script.sha256);
        if (sources) {
          for (const source of sources) entry.reads.add(source);
        } else unresolvedBundle(entry, script.url);
      } else if (script.kind === 'tree') {
        const file = fileURLToPath(script.url);
        for (const source of treeInputs(file === checkout ? '' : repoPath(root, file))) entry.reads.add(source);
      } else {
        const source = repoPath(root, modulePath(script.url));
        if (source) entry.reads.add(source);
      }
    }
  }
  // A journal without its startup checkpoint cannot be attributed to a test.
  stats.malformedSnapshots += journals.size;
  const traceFile = `${resolve(rawDir)}.linux-trace`;
  const traceMode = join(rawDir, 'kernel-mode');
  let trace;
  if (existsSync(traceMode)) {
    const mode = readFileSync(traceMode, 'utf8').trim();
    const statusPath = join(rawDir, 'kernel-status');
    const status = mode === 'linux-strace-v3' && existsSync(statusPath) && readFileSync(statusPath, 'utf8').trim();
    if (mode !== 'linux-strace-v2' && mode !== 'linux-strace-v3') trace = { error: 'unknown Linux trace format' };
    else if (!existsSync(traceFile)) trace = { error: 'expected Linux trace missing' };
    else if (mode === 'linux-strace-v3' && (!status || !/^[01]$/.test(status))) trace = { error: 'no successful tracer completion' };
    else {
      const owners = new Map();
      for (const [file, entry] of groups) for (const pid of entry.workerPids) {
        if (owners.has(pid)) trace = { error: 'ambiguous Vitest fork owner' };
        owners.set(pid, file);
      }
      const ringFile = `${resolve(rawDir)}.io-uring`;
      trace ??= readKernelTrace(traceFile, { root: checkout, tracked: trackedPaths(), owners,
        ringFile: existsSync(ringFile) ? ringFile : undefined, tracerStatus: status ? Number(status) : undefined });
    }
    stats.kernelTrace = trace.error ?? 'observed';
    if (trace.lifecycle) stats.kernelLifecycle = trace.lifecycle;
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
    const missingLaunches = [...entry.launches].filter(id => !entry.observedLaunches.has(id));
    const processValues = [...entry.processes.values()];
    const processes = processValues.length + entry.threads.size + missingLaunches.length;
    const knownCpuMs = Math.round(processValues.reduce((sum, proc) => sum + (proc.cpuMs ?? 0), 0) * 1000) / 1000;
    const missingCpu = missingLaunches.length + processValues.filter(proc => proc.cpuMs === null).length;
    const unfinishedProcesses = processValues.filter(proc => proc.cpuMs === null || !proc.ended);
    const unknownCpu = missingLaunches.length + unfinishedProcesses.length;
    const native = trace?.byTest?.get(file);
    if (native) {
      for (const read of native.reads) entry.reads.add(read);
      for (const tree of native.trees) for (const read of treeInputs(tree)) entry.reads.add(read);
      for (const name of native.artifacts) {
        entry.ranBundle = true;
        const path = resolve(checkout, name);
        if (!entry.bundlePaths.has(path)) unresolvedBundle(entry, path);
      }
      const starts = new Map();
      for (const proc of processValues) if (proc.captureReady) starts.set(proc.pid, (starts.get(proc.pid) ?? 0) + 1);
      for (const [pid, count] of native.nodeStarts) {
        if ((starts.get(pid) ?? 0) < count) native.gaps.add('Node started without recorder evidence');
      }
    }
    const kernelGaps = native ? [...native.gaps].sort() : trace ? [trace.error ?? 'unobserved Vitest fork'] : [];
    const confirmedExit = pid => !kernelGaps.length && native?.exited.has(pid);
    const missingStartup = missingLaunches.filter(id => !entry.versionProbes.has(id) || !entry.probeExits.has(id)).length;
    const missingFinal = unfinishedProcesses.filter(proc => !proc.captureReady || !confirmedExit(proc.pid)).length;
    const unfinishedThreads = [...entry.threads].filter(thread => !entry.observedThreads.has(thread));
    const missingThreads = unfinishedThreads.filter(thread => !entry.threadExits.has(thread) ||
      !confirmedExit(entry.readyThreads.get(thread))).length;
    const incomplete = missingStartup > 0 || missingFinal > 0 || missingThreads > 0 || kernelGaps.length > 0;
    const capture = { missingStartup, missingFinal, missingThreads, kernelGaps,
      versionProbes: missingLaunches.length - missingStartup, tracedExits: unfinishedProcesses.length - missingFinal,
      tracedThreads: unfinishedThreads.length - missingThreads };
    if (native?.pathCounts.size) capture.kernelPaths = Object.fromEntries([...native.pathCounts].sort());
    records[file] = { reads: [...entry.reads].sort(), unresolved: [...entry.unresolved].sort(), workerPids: [...entry.workerPids],
      ranBundle: entry.ranBundle, incomplete, capture, ms, result, processes, cpuMs: unknownCpu ? null : knownCpuMs, knownCpuMs, unknownCpu, missingCpu };
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
