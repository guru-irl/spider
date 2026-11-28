// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

import { buildSelectionMap } from './map.mjs';
import { reduce } from './reduce.mjs';
import { selectTests } from './select.mjs';

const hook = fileURLToPath(new URL('./cov-hook.cjs', import.meta.url));
const id = 'packages/example/src/probe.test.ts';
// The map workflow also runs this file before starting its outer strace.
const canTrace = !process.env.SPIDER_SELECTION_DIR && process.platform === 'linux' &&
  spawnSync('strace', ['--version']).status === 0 &&
  spawnSync('sudo', ['-n', 'test', '-r', '/sys/kernel/tracing/events/io_uring/io_uring_submit_req/format']).status === 0;

function fixture(t) {
  const scratch = resolve('.spider/scratch/selection');
  mkdirSync(scratch, { recursive: true });
  const workspace = mkdtempSync(join(scratch, 'recorder-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const root = join(workspace, 'repo');
  const raw = join(workspace, 'raw');
  const maps = join(workspace, 'maps');
  const installed = join(workspace, 'installed/node_modules/spider/dist');
  for (const dir of [join(root, 'packages/example/src'), join(root, 'dist'), raw, maps, installed]) {
    mkdirSync(dir, { recursive: true });
  }
  return { root, raw, maps, installed, workspace };
}

const runNode = (args, options) => spawnSync(process.execPath, args, { encoding: 'utf8', ...options });

function records(raw) {
  return readdirSync(raw).filter(name => name.endsWith('.json')).map(name => {
    const journal = join(raw, name.replace(/\.json$/, '.ndjson'));
    const scripts = existsSync(journal) ? readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.url) : [];
    return { ...JSON.parse(readFileSync(join(raw, name))), scripts };
  });
}

function fixtureRecords(t, { snapshots = [], results = [], hookErrors = '', launches = [], kernelTrace,
  kernelStatus, ringEvents, trackedInputs = [] } = {}) {
  const { root, raw, maps, workspace } = fixture(t);
  writeFileSync(join(root, 'dist/reference.mjs'), 'export {};');
  writeFileSync(join(maps, 'reference.mjs.map'), JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }));
  const reportFile = join(workspace, 'vitest.json');
  writeFileSync(reportFile, JSON.stringify({ testResults: results.map(row => ({
    startTime: 50, endTime: 75, status: 'passed', ...row, name: join(root, row.name),
  })) }));
  for (const [i, snapshot] of snapshots.entries()) {
    const scripts = snapshot.scripts?.map(script => ({ ...script, url: resolve(root, script.url) }))
      ?? snapshot.paths.map(path => ({ kind: 'source', url: resolve(root, path) }));
    const { scripts: _, paths: _paths, ...metadata } = snapshot;
    writeFileSync(join(raw, `${i + 1}-abc.json`), JSON.stringify(metadata));
    writeFileSync(join(raw, `${i + 1}-abc.ndjson`), scripts.map(row => JSON.stringify(row) + '\n').join(''));
  }
  if (hookErrors) writeFileSync(join(raw, 'hook-errors.ndjson'), hookErrors);
  if (kernelTrace) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    for (const file of trackedInputs) writeFileSync(join(root, file), 'fixture');
    if (trackedInputs.length) execFileSync('git', ['add', '--', ...trackedInputs], { cwd: root });
    writeFileSync(join(raw, 'kernel-mode'), kernelStatus === undefined ? 'linux-strace-v2\n' : 'linux-strace-v3\n');
    if (kernelStatus !== undefined && kernelStatus !== null) writeFileSync(join(raw, 'kernel-status'), `${kernelStatus}\n`);
    writeFileSync(`${raw}.linux-trace`, kernelTrace.replaceAll('$ROOT', root));
    if (ringEvents) writeFileSync(`${raw}.io-uring`, ringEvents);
  }
  if (launches.length) writeFileSync(join(raw, 'launches.ndjson'), launches.map(row => JSON.stringify(row)).join('\n') + '\n');
  return reduce({ root, tmpRoot: join(root, '.spider/scratch/tmp'), rawDir: raw, mapsDir: maps, reportFile });
}

test('unions direct reads from a fork, child process, and worker thread for the owning test', t => {
  const other = 'packages/example/src/other.test.ts';
  const { records } = fixtureRecords(t, {
    results: [{ name: id }, { name: other }],
    snapshots: [
      { test: id, worker: true, pid: 3, paths: ['src/main.ts'] },
      { test: id, pid: 4, paths: ['src/child.ts', 'src/main.ts'] },
      { test: id, pid: 4, threadId: 1, paths: ['src/thread.ts'] },
      { test: other, worker: true, pid: 5, paths: ['src/other.ts'] },
    ],
  });
  assert.deepEqual(records[id].reads, ['src/child.ts', 'src/main.ts', 'src/thread.ts']);
  assert.equal(records[id].ranBundle, false);
  assert.deepEqual(records[id].workerPids, [3]);
  assert.equal(records[id].ms, 25);
  assert.equal(records[id].result, 'passed');
  assert.deepEqual(records[other].reads, ['src/other.ts']);
});

test('counts distinct processes and worker threads once and does not double-count process CPU', t => {
  const { records } = fixtureRecords(t, {
    results: [{ name: id }],
    launches: [
      { test: id, kind: 'process', launchId: 'child' },
      { test: id, kind: 'thread', processId: 'parent', threadId: 1 },
      { test: id, kind: 'thread', processId: 'parent', threadId: 1 },
    ],
    snapshots: [
      { test: id, worker: true, pid: 3, processId: 'parent', threadId: 0, cpuMs: 100, paths: [] },
      { test: id, pid: 3, processId: 'parent', threadId: 0, cpuMs: 130, ended: true, paths: [] },
      { test: id, pid: 3, processId: 'parent', threadId: 1, cpuMs: 120, ended: true, paths: [] },
      { test: id, pid: 4, processId: 'child-process', launchId: 'child', threadId: 0, cpuMs: 50, ended: true, paths: [] },
    ],
  });
  assert.equal(records[id].processes, 3);
  assert.equal(records[id].cpuMs, 180);
  assert.equal(records[id].knownCpuMs, 180);
  assert.equal(records[id].unknownCpu, 0);
  assert.equal(records[id].missingCpu, 0);
});

test('marks CPU incomplete when a process was killed after a checkpoint', t => {
  const { records } = fixtureRecords(t, {
    results: [{ name: id }],
    snapshots: [
      { test: id, worker: true, pid: 3, processId: 'parent', threadId: 0, cpuMs: 100, ended: true, paths: [] },
      { test: id, pid: 4, processId: 'child', threadId: 0, cpuMs: 25, ended: false, paths: [] },
    ],
  });
  assert.equal(records[id].processes, 2);
  assert.equal(records[id].cpuMs, null);
  assert.equal(records[id].knownCpuMs, 125);
  assert.equal(records[id].unknownCpu, 1);
  assert.equal(records[id].missingCpu, 0);
});

test('counts a Node child that never reports CPU and preserves the measured lower bound', t => {
  const { records } = fixtureRecords(t, {
    results: [{ name: id }],
    launches: [{ test: id, kind: 'process', launchId: 'killed-before-hook' }],
    snapshots: [{ test: id, worker: true, pid: 3, processId: 'parent', threadId: 0, cpuMs: 100, ended: true, paths: [] }],
  });
  assert.equal(records[id].processes, 2);
  assert.equal(records[id].cpuMs, null);
  assert.equal(records[id].knownCpuMs, 100);
  assert.equal(records[id].unknownCpu, 1);
  assert.equal(records[id].missingCpu, 1);
});

test('keeps unmapped checkout bundles once per test even when multiple processes run them', t => {
  const script = { kind: 'bundle', url: 'packages/example/dist/bundle.js', sha256: 'unmatched' };
  const { records, stats } = fixtureRecords(t, {
    results: [{ name: id }],
    snapshots: [{ test: id, worker: true, pid: 3, scripts: [script] }, { test: id, pid: 4, scripts: [script] }],
  });
  assert.deepEqual(records[id].unresolved, ['packages/example/dist/bundle.js']);
  assert.equal(stats.unresolvedBundles, 2);
});

test('normalizes temporary bundles relative to the temporary root even inside the checkout', t => {
  const { records } = fixtureRecords(t, {
    results: [{ name: id }],
    snapshots: [{ test: id, worker: true, pid: 3, scripts: [
      { kind: 'bundle', url: '.spider/scratch/tmp/probe-abc/dist/fixture.mjs', sha256: 'unmatched' },
    ] }],
  });
  assert.deepEqual(records[id].unresolved, ['<tmp>/probe-abc/dist/fixture.mjs']);
});

test('normalizes generated worktree and package scratch bundles as temporary paths', t => {
  const { records, stats } = fixtureRecords(t, {
    results: [{ name: id }],
    snapshots: [{ test: id, worker: true, pid: 3, scripts: [
      { kind: 'bundle', url: '.spider/scratch/h/42/dist/cli.mjs', sha256: 'unmatched-1' },
      { kind: 'bundle', url: 'packages/example/.spider/scratch/process-1/dist/cli.mjs', sha256: 'unmatched-2' },
    ] }],
  });
  assert.deepEqual(records[id].unresolved, ['<tmp>/h/42/dist/cli.mjs', '<tmp>/process-1/dist/cli.mjs']);
  assert.deepEqual(stats.unresolvedGroups, { checkout: 0, temporary: 2, other: 0 });
});

test('decodes file URLs and does not mistake a temporary-root prefix for the root', t => {
  const { root, raw, maps, workspace } = fixture(t);
  writeFileSync(join(root, 'dist/reference.mjs'), 'export {};');
  writeFileSync(join(maps, 'reference.mjs.map'), JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }));
  const reportFile = join(workspace, 'vitest.json');
  writeFileSync(reportFile, JSON.stringify({ testResults: [{ name: join(root, id), status: 'passed', startTime: 0, endTime: 1 }] }));
  const url = new URL('file://' + join(root, 'tmp-other/a b.mjs'));
  writeFileSync(join(raw, '1-abc.json'), JSON.stringify({ test: id, worker: true, pid: 3 }));
  writeFileSync(join(raw, '1-abc.ndjson'), JSON.stringify({ kind: 'bundle', url: url.href, sha256: 'unmatched' }) + '\n');
  const { records } = reduce({ root, tmpRoot: join(root, 'tmp'), rawDir: raw, mapsDir: maps, reportFile });
  assert.deepEqual(records[id].unresolved, ['tmp-other/a b.mjs']);
});

test('reduces encoded query and fragment suffixes on scripts and bundle sources', t => {
  const { root, raw, maps, workspace } = fixture(t);
  const bundle = 'export {};';
  writeFileSync(join(root, 'dist/reference.mjs'), bundle);
  writeFileSync(join(maps, 'reference.mjs.map'), JSON.stringify({ version: 3,
    sources: ['../src/style.css%3Furl', '../src/entry.ts%23inline', '../src/literal.txt?raw'], names: [], mappings: '' }));
  const reportFile = join(workspace, 'vitest.json');
  writeFileSync(reportFile, JSON.stringify({ testResults: [{ name: join(root, id), status: 'passed', startTime: 0, endTime: 1 }] }));
  writeFileSync(join(raw, '1-abc.json'), JSON.stringify({ test: id, worker: true, pid: 3 }));
  const scripts = [
    { kind: 'source', url: pathToFileURL(join(root, 'src/data.ts?raw')).href },
    { kind: 'bundle', url: pathToFileURL(join(root, 'dist/reference.mjs')).href, sha256: createHash('sha256').update(bundle).digest('hex') },
  ];
  writeFileSync(join(raw, '1-abc.ndjson'), scripts.map(script => JSON.stringify(script) + '\n').join(''));
  const { records } = reduce({ root, rawDir: raw, mapsDir: maps, reportFile });
  assert.deepEqual(records[id].reads, ['src/data.ts', 'src/entry.ts', 'src/literal.txt', 'src/style.css']);
});

test('records the real file when the inspector encodes the Vite query in its URL', t => {
  const { root, raw } = fixture(t);
  const file = join(root, 'packages/example/src/raw-input.ts');
  writeFileSync(file, 'export const value = 42;');
  const url = pathToFileURL(file + '?raw').href;
  // Vitest's evaluated module sets an encoded sourceURL for the transformed file.
  const script = `eval(${JSON.stringify(`console.log(42);\n//# sourceURL=${url}`)});`;
  const result = runNode(['--eval', script], { env: recorderEnv(root, raw) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '42');
  assert.ok(records(raw).some(process => process.scripts.some(entry =>
    entry.kind === 'source' && entry.url === pathToFileURL(file).href)));
});

test('counts unresolved observations by checkout, temporary, and other paths', t => {
  const { stats } = fixtureRecords(t, {
    results: [{ name: id }],
    snapshots: [{ test: id, worker: true, pid: 3, scripts: [
      { kind: 'bundle', url: 'dist/app.mjs', sha256: 'unmatched-1' },
      { kind: 'bundle', url: '.spider/scratch/tmp/fixture/dist/app.mjs', sha256: 'unmatched-2' },
      { kind: 'bundle', url: '/outside/dist/app.mjs', sha256: 'unmatched-3' },
    ] }],
  });
  assert.deepEqual(stats.unresolvedGroups, { checkout: 1, temporary: 1, other: 1 });
});

test('does not mark a bundle unresolved when its hash matches an archived map', t => {
  const hash = createHash('sha256').update('export {};').digest('hex');
  const { records, stats } = fixtureRecords(t, {
    results: [{ name: id }],
    snapshots: [{ test: id, worker: true, pid: 3, scripts: [
      { kind: 'bundle', url: 'dist/reference.mjs', sha256: hash },
    ] }],
  });
  assert.deepEqual(records[id].unresolved, []);
  assert.equal(stats.unresolvedBundles, 0);
  assert.equal(records[id].ranBundle, true);
});

test('keeps only repository source paths', t => {
  const { records } = fixtureRecords(t, {
    results: [{ name: id }],
    snapshots: [{ test: id, worker: true, pid: 3, paths: ['src/main.ts', '../elsewhere.ts', 'node_modules/dep.mjs', '.spider/scratch/stub.cjs'] }],
  });
  assert.deepEqual(records[id].reads, ['src/main.ts']);
});

test('labels an entirely skipped test file even when Vitest reports the file as passed', t => {
  const { records } = fixtureRecords(t, {
    results: [{ name: id, assertionResults: [{ status: 'skipped' }, { status: 'todo' }] }],
    snapshots: [{ test: id, worker: true, pid: 3, paths: [] }],
  });
  assert.equal(records[id].result, 'skipped');
});

test('preserves reported files even when their snapshot is missing', t => {
  const { reportedFiles, records } = fixtureRecords(t, { results: [{ name: id }] });
  assert.deepEqual(reportedFiles, [id]);
  assert.deepEqual(records, {});
});

test('counts every hook error, even if a log entry is malformed', t => {
  const { stats } = fixtureRecords(t, { hookErrors: '{"where":"flush"}\npartial line\n' });
  assert.equal(stats.hookErrors, 2);
});

test('all launch APIs preserve attribution with a replacement environment', t => {
  const { root, raw } = fixture(t);
  const child = join(root, 'packages/example/src/child.cjs');
  writeFileSync(child, `function ran() { return process.env.LOCAL; }\nif (ran() !== 'kept') process.exitCode = 4;\n`);
  const parent = join(root, 'packages/example/src/parent.cjs');
  writeFileSync(parent, `
    const cp = require('node:child_process');
    const { promisify } = require('node:util');
    const { once } = require('node:events');
    const [leaf, node] = process.argv.slice(2);
    const command = JSON.stringify(node) + ' ' + JSON.stringify(leaf);
    const opts = Object.freeze({ env: Object.freeze({ LOCAL: 'kept', NODE_OPTIONS: '--no-warnings' }) });
    (async () => {
      const esm = await import('node:child_process');
      for (const start of [() => esm.spawn(node, [leaf], opts), () => cp.fork(leaf, opts)]) {
        if ((await once(start(), 'exit'))[0] !== 0) process.exitCode = 7;
      }
      if (cp.spawnSync(node, [leaf], opts).status !== 0) process.exitCode = 8;
      cp.execFileSync(node, [leaf], opts);
      cp.execSync(command, opts);
      const file = promisify(esm.execFile)(node, [leaf], opts);
      if (!file.child) process.exitCode = 9;
      await file;
      await promisify(esm.exec)(command, opts);
    })().catch(error => { console.error(error); process.exitCode = 10; });
  `);
  const result = runNode([parent, child, process.execPath], {
    env: { ...process.env, SPIDER_SELECTION_DIR: raw, SPIDER_SELECTION_ROOT: root, SPIDER_SELECTION_TEST: id,
      NODE_OPTIONS: `--require=${JSON.stringify(hook)}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout + result.stderr, '');
  const seen = records(raw).filter(process => process.argv[1] === child);
  assert.equal(seen.length, 7);
  assert.ok(seen.every(process => process.test === id && process.ended));
  for (const process of seen) {
    const script = process.scripts.find(entry => entry.url.endsWith('/child.cjs'));
    assert.equal(script.kind, 'source');
  }
});

test('counts a child killed before its preload and records CPU from the parent', { skip: process.platform === 'win32' }, t => {
  const { root, raw, maps, workspace } = fixture(t);
  writeFileSync(join(root, 'dist/reference.mjs'), 'export {};');
  writeFileSync(join(maps, 'reference.mjs.map'), JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }));
  const parent = join(root, 'packages/example/src/killed-child.cjs');
  writeFileSync(parent, `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    child.kill('SIGKILL');
  `);
  const result = runNode([parent], { env: recorderEnv(root, raw) });
  assert.equal(result.status, 0, result.stderr);
  const report = join(workspace, 'vitest.json');
  writeFileSync(report, JSON.stringify({ testResults: [{ name: join(root, id), status: 'passed', startTime: 0, endTime: 1 }] }));
  const entry = reduce({ root, rawDir: raw, mapsDir: maps, reportFile: report }).records[id];
  assert.equal(entry.processes, 2);
  assert.equal(entry.cpuMs, null);
  assert.ok(entry.knownCpuMs > 0);
  assert.equal(entry.unknownCpu, 1);
  assert.equal(entry.missingCpu, 1);
});

test('measures a real child, grandchild and worker without counting shared process CPU twice', t => {
  const { root, raw, maps, workspace } = fixture(t);
  writeFileSync(join(root, 'dist/reference.mjs'), 'export {};');
  writeFileSync(join(maps, 'reference.mjs.map'), JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }));
  const parent = join(root, 'packages/example/src/tree.cjs');
  writeFileSync(parent, `
    const { spawnSync } = require('node:child_process');
    const { Worker } = require('node:worker_threads');
    const level = Number(process.argv[2] || 0);
    if (level < 2) {
      const result = spawnSync(process.execPath, [__filename, String(level + 1)]);
      if (result.status !== 0) throw new Error(result.stderr.toString());
    }
    if (level === 0) {
      const worker = new Worker('let n=0; for(let i=0;i<1000000;i++) n+=i;', { eval: true });
      worker.on('error', error => { throw error; });
    }
  `);
  const result = runNode([parent], { env: recorderEnv(root, raw) });
  assert.equal(result.status, 0, result.stderr);
  const report = join(workspace, 'vitest.json');
  writeFileSync(report, JSON.stringify({ testResults: [{ name: join(root, id), status: 'passed', startTime: 0, endTime: 1 }] }));
  const entry = reduce({ root, rawDir: raw, mapsDir: maps, reportFile: report }).records[id];
  assert.equal(entry.processes, 4);
  assert.equal(entry.unknownCpu, 0);
  assert.ok(entry.cpuMs > 0);
  const snapshots = records(raw);
  const expected = [...new Set(snapshots.map(p => p.processId))].reduce((sum, processId) =>
    sum + Math.max(...snapshots.filter(p => p.processId === processId).map(p => p.cpuMs)), 0);
  assert.ok(Math.abs(entry.cpuMs - expected) < 0.0011);
});

test('child code sees its original Node options and inherits only the outer test identity', t => {
  const { root, raw } = fixture(t);
  const child = join(root, 'packages/example/src/clean-child.cjs');
  const parent = join(root, 'packages/example/src/clean-parent.cjs');
  writeFileSync(child, `
    const assert = require('node:assert/strict');
    assert.equal(process.env.SPIDER_SELECTION, undefined);
    if (process.argv[2] === 'unset') assert.equal(Object.hasOwn(process.env, 'NODE_OPTIONS'), false);
    else assert.equal(process.env.NODE_OPTIONS, process.argv[2]);
  `);
  writeFileSync(parent, `
    const { execFileSync } = require('node:child_process');
    const leaf = process.argv[2];
    for (const opts of [undefined, '', '--no-warnings']) {
      const env = { SPIDER_SELECTION: '1', ...(opts === undefined ? {} : { NODE_OPTIONS: opts }) };
      execFileSync(process.execPath, [leaf, opts ?? 'unset'], { env });
    }
  `);
  const result = runNode([parent, child], { env: { ...process.env, SPIDER_SELECTION: '1', SPIDER_SELECTION_DIR: raw,
    SPIDER_SELECTION_ROOT: root, SPIDER_SELECTION_TEST: id, NODE_OPTIONS: `--require=${JSON.stringify(hook)}` } });
  assert.equal(result.status, 0, result.stderr);
  const children = records(raw).filter(process => process.argv[1] === child);
  assert.equal(children.length, 3);
  assert.ok(children.every(process => process.test === id && !process.worker && process.ended));
});

test('reducer maps a deleted packed copy by hash and includes all mapped sources', t => {
  const { root, raw, maps, installed, workspace } = fixture(t);
  const compiled = 'function ran() {}\nran();\n';
  const file = join(installed, 'packed.mjs');
  const main = join(root, 'packages/example/src/main.mjs');
  writeFileSync(file, compiled);
  writeFileSync(join(root, 'dist/packed.mjs'), compiled);
  writeFileSync(join(maps, 'packed.mjs.map'), JSON.stringify({
    version: 3, sources: ['../packages/example/src/ran.ts', '../packages/example/src/load-only.ts'],
    names: [], mappings: 'AAUA;ACAA',
  }));
  const transformed = join(root, 'packages/example/src/top-level.ts');
  writeFileSync(transformed, 'export const value = 2;\n');
  writeFileSync(main, `
    import { runInThisContext } from 'node:vm';
    await runInThisContext("'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__)=>{{ __vite_ssr_exports__.value = 2; }}", { filename: ${JSON.stringify(transformed)} })({});
    await import(${JSON.stringify(file)});
  `);
  const result = runNode([main], { env: { ...process.env, SPIDER_SELECTION_DIR: raw, SPIDER_SELECTION_ROOT: root,
    SPIDER_SELECTION_TEST: id, NODE_OPTIONS: `--require=${JSON.stringify(hook)}` } });
  assert.equal(result.status, 0, result.stderr);
  const recorded = records(raw).flatMap(process => process.scripts).find(script => script.url.endsWith('/packed.mjs'));
  assert.equal(recorded?.sha256, createHash('sha256').update(compiled).digest('hex'));
  rmSync(file);
  const report = join(workspace, 'vitest.json');
  writeFileSync(report, JSON.stringify({ testResults: [{ name: join(root, id), status: 'passed', startTime: 50, endTime: 120 }] }));
  const data = reduce({ root, rawDir: raw, mapsDir: maps, reportFile: report });
  const entry = data.records[id];
  assert.deepEqual(entry.reads, ['packages/example/src/load-only.ts', 'packages/example/src/main.mjs', 'packages/example/src/ran.ts', 'packages/example/src/top-level.ts']);
  assert.equal(entry.result, 'passed');
  assert.equal(entry.ms, 70);
});

function recorderEnv(root, raw) {
  return { ...process.env, SPIDER_SELECTION_DIR: raw, SPIDER_SELECTION_ROOT: root,
    SPIDER_SELECTION_TEST: id, NODE_OPTIONS: `--require=${JSON.stringify(hook)}` };
}

test('short signal exits persist execution without changing exit status', { skip: process.platform === 'win32' }, t => {
  const { root, raw } = fixture(t);
  const child = join(root, 'packages/example/src/signals.cjs');
  writeFileSync(child, `
    const signal = process.argv[2];
    if (process.argv[3] === 'own') process.on(signal, () => process.exit(23));
    function ran() { process.kill(process.pid, signal); }
    setImmediate(ran);
    setInterval(() => {}, 30_000);
  `);
  for (const [signal, own] of [['SIGTERM', false], ['SIGTERM', true], ['SIGKILL', false]]) {
    const result = runNode([child, signal, own ? 'own' : ''], { env: recorderEnv(root, raw), timeout: 5000 });
    assert.deepEqual([result.status, result.signal], own ? [23, null] : [null, signal]);
    const snapshot = records(raw).find(p => p.argv[2] === signal && p.argv[3] === (own ? 'own' : ''));
    assert.ok(snapshot?.scripts.some(s => s.url.endsWith('signals.cjs')));
  }
});

test('a synchronous self-signal still kills an otherwise idle child', { skip: process.platform === 'win32' }, t => {
  const { root, raw } = fixture(t);
  const child = join(root, 'packages/example/src/idle-signal.cjs');
  writeFileSync(child, `function ran() { process.kill(process.pid, Number(process.argv[2])); } ran();`);
  const result = runNode([child, '15'], { env: recorderEnv(root, raw), timeout: 5000 });
  assert.deepEqual([result.status, result.signal], [null, 'SIGTERM']);
  assert.ok(records(raw).some(p => p.scripts.some(s => s.url.endsWith('idle-signal.cjs'))));
});

test('a native signal can kill a Node process blocked inside Atomics.wait', { skip: process.platform === 'win32' }, t => {
  const { root, raw } = fixture(t);
  const child = join(root, 'packages/example/src/blocked.cjs');
  writeFileSync(child, `process.stdout.write('ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`);
  const result = runNode(['--input-type=module', '-e', `
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import assert from 'node:assert/strict';
    const child = spawn(process.execPath, [${JSON.stringify(child)}]);
    const exited = once(child, 'close');
    await once(child.stdout, 'data');
    child.kill('SIGTERM');
    const cleanup = setTimeout(() => child.kill('SIGKILL'), 500);
    assert.deepEqual(await exited, [null, 'SIGTERM']);
    clearTimeout(cleanup);
  `], { env: recorderEnv(root, raw), timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
});

function probeShard({ root, raw, maps, workspace }) {
  writeFileSync(join(root, 'dist/reference.mjs'), 'export {};');
  writeFileSync(join(maps, 'reference.mjs.map'), JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }));
  const reportFile = join(workspace, 'vitest.json');
  writeFileSync(reportFile, JSON.stringify({ testResults: [{ name: join(root, id), status: 'passed', startTime: 0, endTime: 1 }] }));
  return reduce({ root, rawDir: raw, mapsDir: maps, reportFile });
}

const reduceProbe = paths => probeShard(paths).records[id];

test('publishes the dependencies of exact Node version probes without inventing CPU samples', t => {
  const paths = fixture(t);
  const { root, raw } = paths;
  const result = runNode(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { spawn, spawnSync, execFile, execFileSync } from 'node:child_process';
    import { once } from 'node:events';
    import { promisify } from 'node:util';
    globalThis[Symbol.for('spider.selection.tag')](${JSON.stringify(id)});
    const options = { env: {}, encoding: 'utf8' };
    const args = ['--version'];
    const expected = process.version + '\\n';
    const child = spawn(process.execPath, args, { env: {}, stdio: 'ignore' });
    assert.deepEqual(await once(child, 'exit'), [0, null]);
    assert.equal(spawnSync(process.execPath, args, options).stdout, expected);
    assert.equal(execFileSync(process.execPath, args, options), expected);
    assert.equal((await promisify(execFile)(process.execPath, args, options)).stdout, expected);
  `], { cwd: root, env: recorderEnv(root, raw) });
  assert.equal(result.status, 0, result.stderr);
  const shard = probeShard(paths);
  const { map, problems } = buildSelectionMap({ shards: [shard], expectedFiles: [id] });
  assert.deepEqual(problems, []);
  const record = map.tests[id];
  assert.equal(record.incomplete, false);
  assert.equal(record.processes, 5);
  assert.equal(record.missingCpu, 4);
  assert.equal(record.unknownCpu, 4);
  assert.equal(record.cpuMs, null);
});

for (const [label, invocation] of [
  ['a PATH wrapper named node', `spawnSync('node', ['--version'], { env: { PATH: process.cwd() } })`],
  ['extra arguments', `spawnSync(process.execPath, ['--version', 'config.toml'], { env: {} })`],
  ['unverified startup options', `spawnSync(process.execPath, ['--version'], { env: { NODE_OPTIONS: '--no-warnings' } })`],
]) {
  test(`keeps the startup gap for ${label}`, { skip: process.platform === 'win32' }, t => {
    const paths = fixture(t);
    const { root, raw } = paths;
    writeFileSync(join(root, 'config.toml'), 'fixture\n');
    writeFileSync(join(root, 'node'), '#!/bin/sh\nread value < config.toml || exit 1\nprintf "%s" "$value"\n', { mode: 0o700 });
    const result = runNode(['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      assert.equal((${invocation}).status, 0);
    `], { cwd: root, env: recorderEnv(root, raw) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(reduceProbe(paths).incomplete, true);
  });
}

test('keeps scripts loaded by an externally killed child and marks its record incomplete', { skip: process.platform === 'win32' }, t => {
  const paths = fixture(t);
  const { root, raw } = paths;
  writeFileSync(join(root, 'dependency.mjs'), 'export const value = 42;');
  writeFileSync(join(root, 'child.mjs'), `
    import { value } from './dependency.mjs';
    process.stdout.write(String(value));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  `);
  const result = runNode(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    const child = spawn(process.execPath, ['child.mjs']);
    const exited = once(child, 'close');
    const [ready] = await once(child.stdout, 'data');
    child.kill('SIGKILL');
    assert.deepEqual(await exited, [null, 'SIGKILL']);
    assert.equal(String(ready), '42');
  `], { cwd: root, env: recorderEnv(root, raw), timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const record = reduceProbe(paths);
  assert.deepEqual(record.reads, ['child.mjs', 'dependency.mjs']);
  assert.equal(record.incomplete, true);
  assert.equal(record.cpuMs, null);
});

test('a Node test supervisor without an inspector stays incomplete without breaking publication', t => {
  const paths = fixture(t);
  const { root, raw } = paths;
  writeFileSync(join(root, 'sample.test.mjs'), `import { test } from 'node:test'; test('sample', () => {});`);
  const result = runNode(['--input-type=module', '-e', `
    import { execFileSync } from 'node:child_process';
    execFileSync(process.execPath, ['--test', 'sample.test.mjs']);
  `], { cwd: root, env: recorderEnv(root, raw) });
  assert.equal(result.status, 0, result.stderr);
  const { records, stats } = probeShard(paths);
  assert.equal(stats.hookErrors, 0);
  assert.equal(records[id].incomplete, true);
});

test('a nested recorder keeps its fixture journal and does not claim an outer startup', t => {
  const outer = fixture(t);
  const inner = fixture(t);
  writeFileSync(join(inner.root, 'nested.cjs'), 'process.stdout.write(require("node:fs").readFileSync("nested.txt"));');
  writeFileSync(join(inner.root, 'nested.txt'), 'inner fixture');
  const result = runNode(['--input-type=module', '-e', `
    import { execFileSync } from 'node:child_process';
    import assert from 'node:assert/strict';
    const child = execFileSync(process.execPath, ['nested.cjs'], {
      cwd: ${JSON.stringify(inner.root)}, env: ${JSON.stringify({
        SPIDER_SELECTION_DIR: inner.raw, SPIDER_SELECTION_ROOT: inner.root,
        SPIDER_SELECTION_TEST: id, NODE_OPTIONS: `--require=${JSON.stringify(hook)}`,
      })}, encoding: 'utf8',
    });
    assert.equal(child, 'inner fixture');
  `], { cwd: outer.root, env: recorderEnv(outer.root, outer.raw) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(reduceProbe(inner)?.reads, ['nested.cjs', 'nested.txt']);
  assert.equal(reduceProbe(outer).incomplete, true);
});

test('a kernel trace attributes shell and killed Node reads to the test that spawned them', {
  skip: !canTrace,
}, t => {
  const paths = fixture(t);
  const { root, raw } = paths;
  // Use the real wrapper in a tiny checkout, without building any bundles.
  const selection = join(root, 'scripts/selection');
  mkdirSync(selection, { recursive: true });
  for (const name of ['with-recorder.sh', 'cov-hook.cjs', 'bundle-keys.mjs']) {
    copyFileSync(fileURLToPath(new URL(name, import.meta.url)), join(selection, name));
  }
  writeFileSync(join(root, 'resume.sh'), 'read text < shell.txt; printf "%s" "$text"\n');
  writeFileSync(join(root, 'shell.txt'), 'shell read\n');
  writeFileSync(join(root, 'child.txt'), 'child read');
  writeFileSync(join(root, 'worker.txt'), 'worker read');
  writeFileSync(join(root, 'thread.mjs'), `
    import { readFileSync } from 'node:fs';
    import { parentPort } from 'node:worker_threads';
    parentPort.postMessage(readFileSync('worker.txt', 'utf8'));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  `);
  writeFileSync(join(root, 'child.mjs'), `
    import { readFileSync } from 'node:fs';
    process.stdout.write(readFileSync('child.txt'));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  `);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '--', 'child.txt', 'shell.txt', 'resume.sh', 'worker.txt'], { cwd: root });
  const result = spawnSync('bash', ['scripts/selection/with-recorder.sh', raw, process.execPath, '--input-type=module', '-e', `
    import { spawn, execFileSync } from 'node:child_process';
    import { Worker } from 'node:worker_threads';
    import { once } from 'node:events';
    import assert from 'node:assert/strict';
    globalThis[Symbol.for('spider.selection.tag')](${JSON.stringify(id)});
    // The shell cannot inherit or rely on JavaScript instrumentation.
    assert.equal(execFileSync('/bin/sh', ['resume.sh'], { env: {}, encoding: 'utf8' }), 'shell read');
    const child = spawn(process.execPath, ['child.mjs']);
    const exited = once(child, 'exit');
    const [ready] = await once(child.stdout, 'data');
    assert.equal(String(ready), 'child read');
    child.kill('SIGKILL');
    assert.deepEqual(await exited, [null, 'SIGKILL']);
    const thread = new Worker('./thread.mjs', { execArgv: [] });
    assert.deepEqual(await once(thread, 'message'), ['worker read']);
    assert.equal(await thread.terminate(), 1);
  `], { cwd: root, env: { ...process.env, SPIDER_SELECTION_KERNEL_TRACE: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const record = reduceProbe(paths);
  assert.deepEqual(record.reads, ['child.mjs', 'child.txt', 'resume.sh', 'shell.txt', 'thread.mjs', 'worker.txt']);
  assert.equal(record.incomplete, false, JSON.stringify(record.capture));
  assert.equal(record.unknownCpu, 1);
  assert.equal(record.cpuMs, null);
});

for (const [label, parent, ready, exitLine, extra, complete] of [
  ['a traced descendant', 3, true, '4 +++ killed by SIGKILL +++\n', '', true],
  ['a PID outside the test fork', 1, true, '4 +++ killed by SIGKILL +++\n', '', false],
  ['a child killed before recorder setup', 3, false, '4 +++ killed by SIGKILL +++\n', '', false],
  ['a trace cut off before exit', 3, true, '', '', false],
  ['a pathless successful file open', 3, true, '4 +++ killed by SIGKILL +++\n', '4 open("unseen", O_RDONLY) = 8\n', false],
]) {
  test(`uses independent lifecycle proof only for complete input traces: ${label}`, t => {
    const result = fixtureRecords(t, {
      results: [{ name: id }],
      snapshots: [
        { test: id, worker: true, pid: 3, processId: 'parent', threadId: 0, cpuMs: 100, ended: true, paths: [] },
        { test: id, pid: 4, processId: 'child', threadId: 0, cpuMs: 25, ended: false, captureReady: ready, paths: [] },
      ],
      trackedInputs: ['native.txt'],
      kernelTrace: `1 execve("/usr/bin/node", ["node"], 0x0) = 0
1 clone(child_stack=NULL, flags=SIGCHLD) = 3
${parent} clone(child_stack=NULL, flags=SIGCHLD) = 4
4 openat(AT_FDCWD, "native.txt", O_RDONLY <unfinished ...>
4 <... openat resumed>) = 3<$ROOT/native.txt>
${extra}${exitLine}3 +++ exited with 0 +++
1 +++ exited with 0 +++
`,
    });
    const record = result.records[id];
    assert.equal(record.incomplete, !complete);
    assert.equal(record.cpuMs, null);
    if (complete) assert.deepEqual(record.reads, ['native.txt']);
  });
}

for (const [label, parent, rootExit, childExit, written, complete] of [
  ['a lost syscall parent link', 3, true, true, 2, true],
  ['a fork whose parent was not traced', 9, true, true, 2, false],
  ['a missing root exit', 3, false, true, 2, false],
  ['a child with no observed exit', 3, true, false, 2, false],
  ['dropped kernel events', 3, true, true, 3, false],
]) {
  test(`joins independent fork evidence without excusing a missing exit: ${label}`, t => {
    const { records } = fixtureRecords(t, {
      results: [{ name: id }],
      snapshots: [{ test: id, worker: true, pid: 3, cpuMs: 100, ended: true, paths: [] }],
      trackedInputs: ['native.txt'],
      kernelTrace: `1 clone(child_stack=NULL, flags=SIGCHLD) = 3
4 openat(AT_FDCWD<$ROOT>, "native.txt", O_RDONLY) = 8<$ROOT/native.txt>
${childExit ? '4 +++ exited with 0 +++\n' : ''}3 +++ exited with 0 +++
${rootExit ? '1 +++ exited with 0 +++\n' : ''}`,
      ringEvents: `# entries-in-buffer/entries-written: 2/${written}   #P:4
 env-1 [001] .... 22.91180: sched_process_fork: comm=env pid=1 child_comm=env child_pid=3
 node-${parent} [001] .... 22.92180: sched_process_fork: comm=node pid=${parent} child_comm=node child_pid=4
`,
    });
    assert.equal(records[id].incomplete, !complete);
    if (complete) assert.deepEqual(records[id].reads, ['native.txt']);
  });
}

for (const [label, status, complete] of [
  ['matching tracer status', 0, true],
  ['no tracer status', null, false],
  ['inconsistent tracer status', 1, false],
]) {
  test(`requires matching completion evidence: ${label}`, t => {
    const { records } = fixtureRecords(t, {
      results: [{ name: id }],
      snapshots: [{ test: id, worker: true, pid: 3, cpuMs: 100, ended: true, paths: [] }],
      kernelStatus: status,
      kernelTrace: `1 clone(child_stack=NULL, flags=SIGCHLD) = 3
3 +++ exited with 0 +++
1 +++ exited with 0 +++
`,
    });
    assert.equal(records[id].incomplete, !complete);
  });
}

for (const [label, ready, exited, complete] of [
  ['a ready worker with observed termination', true, true, true],
  ['a heap-limited worker without a recorder', false, true, false],
  ['a ready worker without an observed exit', true, false, false],
]) {
  test(`reconciles forced worker termination without assuming a flush: ${label}`, t => {
    const processId = 'worker-parent';
    const thread = { test: id, processId, threadId: 1 };
    const result = fixtureRecords(t, {
      results: [{ name: id }],
      launches: [{ ...thread, kind: 'thread' }, ...(exited ? [{ ...thread, kind: 'thread-exit' }] : [])],
      snapshots: [
        { test: id, worker: true, pid: 3, processId, threadId: 0, cpuMs: 132, ended: true, paths: [] },
        ...(ready ? [{ ...thread, pid: 3, cpuMs: 50, captureReady: true, paths: ['src/worker.ts'] }] : []),
      ],
      kernelTrace: `1 clone(child_stack=NULL, flags=SIGCHLD) = 3
3 clone(child_stack=NULL, flags=CLONE_THREAD) = 4
4 +++ exited with 0 +++
3 +++ exited with 0 +++
1 +++ exited with 0 +++
`,
    });
    const record = result.records[id];
    assert.equal(record.incomplete, !complete);
    assert.equal(record.cpuMs, 132);
    if (complete) assert.deepEqual(record.reads, ['src/worker.ts']);
  });
}

for (const [label, flags, submissions, complete] of [
  ['a ring allocated but not used to submit work', 'IORING_SETUP_NO_SQARRAY', 0, true],
  ['a ring that submits without entering the kernel explicitly', 'IORING_SETUP_SQPOLL', 0, false],
  ['a ring used to submit work that strace cannot see', 'IORING_SETUP_NO_SQARRAY', 1, false],
]) {
  test(`treats io_uring as an input gap only when operations may be submitted: ${label}`, t => {
    const { records } = fixtureRecords(t, {
      results: [{ name: id }],
      snapshots: [{ test: id, worker: true, pid: 3, processId: 'parent', cpuMs: 100, ended: true, paths: [] }],
      kernelTrace: `1 clone(child_stack=NULL, flags=SIGCHLD) = 3
3 io_uring_setup(256, {flags=${flags}, sq_thread_cpu=0}) = 10
3 io_uring_enter(10, ${submissions}, 0, IORING_ENTER_GETEVENTS, NULL, 0) = ${submissions}
3 +++ exited with 0 +++
1 +++ exited with 0 +++
`,
    });
    assert.equal(records[id].incomplete, !complete);
  });
}

for (const [label, pid, opcode, written, complete] of [
  ['the submitting thread only used epoll', 3, 'EPOLL', 1, true],
  ['the event describes an unobserved file open', 3, 'OPENAT', 1, false],
  ['the trace buffer lost events', 3, 'EPOLL_CTL', 2, false],
  ['the epoll operation belongs to an unrelated thread', 7, 'EPOLL_CTL', 1, false],
]) {
  test(`matches io_uring operations to known submissions: ${label}`, t => {
    const result = fixtureRecords(t, {
      results: [{ name: id }],
      snapshots: [{ test: id, worker: true, pid: 3, processId: 'parent', cpuMs: 100, ended: true, paths: [] }],
      kernelTrace: `1 clone(child_stack=NULL, flags=SIGCHLD) = 3
3 io_uring_setup(256, {flags=IORING_SETUP_NO_SQARRAY, sq_thread_cpu=0}) = 10
3 io_uring_enter(10<anon_inode:[io_uring]>, 1, 1, IORING_ENTER_GETEVENTS, NULL, 0) = 1
3 +++ exited with 0 +++
1 +++ exited with 0 +++
`,
      ringEvents: `# entries-in-buffer/entries-written: 1/${written}   #P:4
 node-${pid} [001] .... 22.91180: io_uring_submit_req: ring abc, req def, user_data 0x0, opcode ${opcode}, flags 0x0, sq_thread 0
`,
    });
    assert.equal(result.records[id].incomplete, !complete);
  });
}

test('a Node image reached through a clean shell is not complete without startup evidence', t => {
  const { records } = fixtureRecords(t, {
    results: [{ name: id }],
    snapshots: [{ test: id, worker: true, pid: 3, processId: 'parent', cpuMs: 100, ended: true, paths: [] }],
    trackedInputs: ['shell.txt'],
    kernelTrace: `1 clone(child_stack=NULL, flags=SIGCHLD) = 3
3 clone(child_stack=NULL, flags=SIGCHLD) = 4
4 execve("/bin/sh", ["sh"], 0x0) = 0
4 execve(${JSON.stringify(process.execPath)}, ["node", "script.cjs"], 0x0) = 0
4 open("shell.txt", O_RDONLY) = 8<$ROOT/shell.txt>
4 +++ exited with 0 +++
3 +++ exited with 0 +++
1 +++ exited with 0 +++
`,
  });
  assert.deepEqual(records[id].reads, ['shell.txt']);
  assert.equal(records[id].incomplete, true);
});

test('recovers the tracked directory from a split getdents64 call', t => {
  const { records } = fixtureRecords(t, {
    results: [{ name: id }],
    snapshots: [{ test: id, worker: true, pid: 3, cpuMs: 100, ended: true, paths: [] }],
    trackedInputs: ['packages/example/src/native.txt', 'unrelated.txt'],
    kernelTrace: `1 clone(child_stack=NULL, flags=SIGCHLD) = 3
3 getdents64(21<$ROOT/packages/example/src> <unfinished ...>
3 <... getdents64 resumed>, 0x7f000 /* 3 entries */, 32768) = 80
3 getdents64(22</usr/lib> <unfinished ...>
3 <... getdents64 resumed>, 0x7f000 /* 0 entries */, 32768) = 0
3 +++ exited with 0 +++
1 +++ exited with 0 +++
`,
  });
  assert.deepEqual(records[id].reads, ['packages/example/src/native.txt']);
  assert.equal(records[id].incomplete, false);
});

test('joins written pathnames and resolved fd targets without discarding tracked aliases', t => {
  const { records } = fixtureRecords(t, {
    results: [{ name: id }],
    snapshots: [{ test: id, worker: true, pid: 3, cpuMs: 100, ended: true, paths: [] }],
    trackedInputs: ['packages/example/src/relative', 'packages/example/src/alias', 'native.txt'],
    kernelTrace: `1 clone(child_stack=NULL, flags=SIGCHLD) = 3
3 openat(AT_FDCWD<$ROOT/packages/example/src>, "relative", O_RDONLY) = 5<$ROOT/packages/example/src/relative>
3 openat(8<$ROOT/packages/example/src>, "alias", O_RDONLY) = 9</usr/lib/resolved>
3 openat(AT_FDCWD<$ROOT>, "/proc/self/fd/6", O_RDONLY) = 10<$ROOT/native.txt>
3 openat(AT_FDCWD<$ROOT>, "/proc/self/fd/7", O_RDONLY) = 11<pipe:[111]>
3 +++ exited with 0 +++
1 +++ exited with 0 +++
`,
  });
  assert.deepEqual(records[id].reads, ['native.txt', 'packages/example/src/alias', 'packages/example/src/relative']);
  assert.equal(records[id].incomplete, false);
});

for (const [label, open, reads] of [
  ['recorded cwd', 'openat(AT_FDCWD<$ROOT>, "native.txt", O_RDONLY) = 7', ['native.txt']],
  ['recorded dirfd', 'openat(8<$ROOT>, "native.txt", O_RDONLY) = 7', ['native.txt']],
  ['unknown cwd', 'openat(AT_FDCWD, "native.txt", O_RDONLY) = 7', []],
  ['proc fd with unknown target', 'openat(AT_FDCWD<$ROOT>, "/proc/self/fd/8", O_RDONLY) = 7', []],
  ['a real syscall using a node: spelling', 'openat(AT_FDCWD, "node:internal", O_RDONLY) = 7', []],
]) {
  test(`keeps the input gap when the opened target is unknown: ${label}`, t => {
    const { records } = fixtureRecords(t, {
      results: [{ name: id }],
      snapshots: [{ test: id, worker: true, pid: 3, cpuMs: 100, ended: true, paths: [] }],
      trackedInputs: ['native.txt'],
      kernelTrace: `1 clone(child_stack=NULL, flags=SIGCHLD) = 3
3 ${open}
3 +++ exited with 0 +++
1 +++ exited with 0 +++
`,
    });
    assert.deepEqual(records[id].reads, reads);
    assert.equal(records[id].incomplete, true);
  });
}

test('native reads of a generated bundle retain the unresolved bundle fallback', t => {
  const { records } = fixtureRecords(t, {
    results: [{ name: id }],
    snapshots: [{ test: id, worker: true, pid: 3, processId: 'parent', cpuMs: 100, ended: true, paths: [] }],
    kernelTrace: `1 clone(child_stack=NULL, flags=SIGCHLD) = 3
3 clone(child_stack=NULL, flags=SIGCHLD) = 4
4 open("dist/reference.mjs", O_RDONLY) = 8<$ROOT/dist/reference.mjs>
4 +++ exited with 0 +++
3 +++ exited with 0 +++
1 +++ exited with 0 +++
`,
  });
  assert.equal(records[id].ranBundle, true);
  assert.deepEqual(records[id].unresolved, ['dist/reference.mjs']);
});

test('records non-code file reads through Node fs APIs in a child with a replacement environment', t => {
  const paths = fixture(t);
  const { root, raw, workspace, installed } = paths;
  for (const name of ['callback.json', 'copy.json', 'handle.html', 'open.sql', 'openSync.txt', 'promise.css', 'stream.svg', 'sync.yaml', 'output.txt']) {
    writeFileSync(join(root, name), name);
  }
  writeFileSync(join(workspace, 'outside.txt'), 'outside');
  writeFileSync(join(installed, 'dependency.txt'), 'dependency');
  writeFileSync(join(root, 'data-child.mjs'), `
    import assert from 'node:assert/strict';
    import { createReadStream, open, openSync, close, readFile, readFileSync, closeSync } from 'node:fs';
    import { copyFile, open as openPromise, readFile as readPromise } from 'node:fs/promises';
    import { promisify } from 'node:util';
    assert.equal(readFileSync(new URL('./sync.yaml', import.meta.url), 'utf8'), 'sync.yaml');
    assert.equal(await promisify(readFile)(Buffer.from('callback.json'), 'utf8'), 'callback.json');
    assert.equal(await readPromise('promise.css', 'utf8'), 'promise.css');
    await copyFile('copy.json', '../copied.json');
    assert.equal(await readPromise('../copied.json', 'utf8'), 'copy.json');
    closeSync(await promisify(open)('open.sql', 'r'));
    closeSync(openSync('openSync.txt', 'r'));
    const handle = await openPromise('handle.html', 'r');
    assert.equal(await handle.readFile('utf8'), 'handle.html');
    await handle.close();
    let body = '';
    for await (const chunk of createReadStream('stream.svg')) body += chunk;
    assert.equal(body, 'stream.svg');
    closeSync(openSync('output.txt', 'w'));
    readFileSync('../outside.txt');
    readFileSync(${JSON.stringify(join(installed, 'dependency.txt'))});
  `);
  const result = runNode(['--input-type=module', '-e', `
    import { execFileSync } from 'node:child_process';
    execFileSync(process.execPath, ['data-child.mjs'], { env: {} });
  `], { cwd: root, env: recorderEnv(root, raw) });
  assert.equal(result.status, 0, result.stderr);
  const record = reduceProbe(paths);
  assert.deepEqual(record.reads, ['callback.json', 'copy.json', 'data-child.mjs', 'handle.html', 'open.sql', 'openSync.txt',
    'promise.css', 'stream.svg', 'sync.yaml']);
  assert.equal(record.incomplete, false);
});

const trackedInputs = ['inputs/first.txt', 'inputs/nested/second.json'];
for (const [api, action, expected = trackedInputs] of [
  ['cpSync directory', `fs.cpSync('inputs', '../copy', { recursive: true })`],
  ['cpSync file', `fs.cpSync('inputs/first.txt', '../copy')`, [trackedInputs[0]]],
  ['cp promise with a filter', `await fs.promises.cp(new URL('file://' + process.cwd() + '/inputs'), '../copy', {
    recursive: true, filter: source => !/(?:nested|untracked\\.txt)$/.test(source),
  })`],
  ['readdirSync', `fs.readdirSync(Buffer.from('inputs'))`],
  ['readdir callback', `await promisify(fs.readdir)('inputs')`],
  ['readdir promise', `await readdir('inputs')`],
  ['opendirSync', `const dir = fs.opendirSync('inputs'); dir.readSync(); dir.closeSync()`],
  ['opendir callback', `const dir = await promisify(fs.opendir)('inputs'); await dir.read(); await dir.close()`],
  ['opendir promise', `const dir = await opendir('inputs'); await dir.read(); await dir.close()`],
  ['checkout root listing', `fs.readdirSync('.')`, ['inputs-other/sibling.txt', ...trackedInputs]],
]) {
  test(`${api} records tracked files and selects their reader`, async t => {
    const paths = fixture(t);
    const { root, raw } = paths;
    mkdirSync(join(root, 'inputs/nested'), { recursive: true });
    mkdirSync(join(root, 'inputs-other'));
    const tracked = [...trackedInputs, 'inputs-other/sibling.txt'];
    for (const file of [...tracked, 'inputs/untracked.txt']) writeFileSync(join(root, file), 'fixture');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '--', ...tracked], { cwd: root });
    const result = runNode(['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { readdir, opendir } from 'node:fs/promises';
      import { promisify } from 'node:util';
      ${action};
    `], { cwd: root, env: recorderEnv(root, raw) });
    assert.equal(result.status, 0, result.stderr);
    const record = reduceProbe(paths);
    assert.equal(record.incomplete, false);
    const other = 'packages/example/src/unrelated.test.ts';
    await t.test('selects only the reader on a tracked input edit', async () => {
      for (const file of expected) {
        const selection = await selectTests({ head: 'a'.repeat(40), inventory: [id, other], changes: [{ file, status: 'M' }],
          map: { files: record.reads, tests: { [id]: { ...record, reads: record.reads.map((_, i) => i) },
            [other]: { ...record, reads: [] } } } });
        assert.equal(selection.mode, 'scoped');
        assert.deepEqual(selection.selected, { [id]: [`recorded input: ${file}`] });
      }
    });
    assert.deepEqual(record.reads, expected);
  });
}

test('records a declared fixture input even when only a shell reads it', { skip: process.platform === 'win32' }, t => {
  const paths = fixture(t);
  const { root, raw } = paths;
  writeFileSync(join(root, 'fixture.sh'), 'printf shell-output');
  const result = runNode(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { fixtureInput } from './scripts/test-fixture-input.ts';
    const input = fixtureInput(new URL(${JSON.stringify(`file://${join(root, 'fixture.sh')}`)}));
    assert.equal(execFileSync('/bin/sh', [input], { encoding: 'utf8' }), 'shell-output');
  `], { env: recorderEnv(root, raw) });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(reduceProbe(paths).reads.includes('fixture.sh'));
});

test('records all inputs of an in-memory bundle even when no output script runs', t => {
  const paths = fixture(t);
  const { root, raw } = paths;
  writeFileSync(join(root, 'entry.mjs'), "import { unused } from './elided.mjs'; export const live = 42;");
  writeFileSync(join(root, 'elided.mjs'), 'export const unused = 10;');
  const result = runNode(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { buildViteFixture } from './scripts/test-fixture-build.ts';
    const output = await buildViteFixture({ configFile: false, logLevel: 'silent',
      build: { ssr: ${JSON.stringify(join(root, 'entry.mjs'))}, write: false } });
    assert.match(output.output[0].code, /live = 42/);
    assert.doesNotMatch(output.output[0].code, /unused/);
  `], { env: recorderEnv(root, raw) });
  assert.equal(result.status, 0, result.stderr);
  const record = reduceProbe(paths);
  assert.deepEqual(record.reads, ['elided.mjs', 'entry.mjs']);
  assert.equal(record.ranBundle, true);
});

test('resolves a renamed in-memory fixture output run from dist', t => {
  const paths = fixture(t);
  const { root, raw } = paths;
  writeFileSync(join(root, 'fixture-source.mjs'), 'export const original = 42;');
  const result = runNode(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    import { buildViteFixture } from './scripts/test-fixture-build.ts';
    const output = await buildViteFixture({ configFile: false, logLevel: 'silent',
      build: { ssr: ${JSON.stringify(join(root, 'fixture-source.mjs'))}, write: false } });
    const copied = ${JSON.stringify(join(root, 'dist/renamed.mjs'))};
    writeFileSync(copied, output.output[0].code);
    assert.equal((await import(copied)).original, 42);
  `], { env: { ...recorderEnv(root, raw), SPIDER_SELECTION_BUNDLE_KEYS: '1:unmatched' } });
  assert.equal(result.status, 0, result.stderr);
  const record = reduceProbe(paths);
  assert.deepEqual(record.unresolved, []);
  assert.ok(record.reads.includes('fixture-source.mjs'));
});

test('an intentionally tiny Worker keeps recoverable OOM behavior', t => {
  const { root, raw } = fixture(t);
  const result = runNode(['--input-type=module', '-e', `
    import { Worker } from 'node:worker_threads';
    import assert from 'node:assert/strict';
    const child = new Worker('const retained=[];while(true)retained.push(Array(50_000).fill(1));', {
      eval: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4 },
    });
    const code = await new Promise(resolve => child.on('error', error => resolve(error.code)));
    assert.equal(code, 'ERR_WORKER_OUT_OF_MEMORY');
  `], { env: recorderEnv(root, raw), timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
});

test('a terminated worker reports its own execution with an explicit replacement environment', t => {
  const { root, raw } = fixture(t);
  const child = join(root, 'dist/thread.mjs');
  const parent = join(root, 'packages/example/src/thread-parent.mjs');
  writeFileSync(child, `
    import { parentPort } from 'node:worker_threads';
    function ran() { parentPort.postMessage([process.env.KEPT, process.env.NODE_OPTIONS, process.execArgv]); }
    ran();
    setInterval(() => {}, 30_000);
  `);
  writeFileSync(parent, `
    import { Worker } from 'node:worker_threads';
    import { once } from 'node:events';
    import assert from 'node:assert/strict';
    const worker = new Worker(process.argv[2], { env: { KEPT: 'yes' }, execArgv: [] });
    assert.deepEqual(await once(worker, 'message'), [['yes', undefined, []]]);
    assert.equal(await worker.terminate(), 1);
  `);
  const result = runNode([parent, child], { env: recorderEnv(root, raw), timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(records(raw).some(p => p.test === id && p.scripts.some(s => s.url.endsWith('thread.mjs'))));
});


test('maps a rebuilt fixture after it is copied and its build directory is removed', t => {
  const { root, raw, maps, workspace } = fixture(t);
  const runtime = join(workspace, 'renamed.mjs');
  const main = join(root, 'packages/example/src/fixture-main.mjs');
  const output = 'function ran() {}\nran();\n';
  const payload = { version: 3, sources: ['../packages/example/src/fixture-source.ts'], names: [], mappings: 'AAEA;AAAA' };
  writeFileSync(runtime, output);
  writeFileSync(join(root, 'dist/reference.mjs'), 'export {};');
  writeFileSync(join(maps, 'reference.mjs.map'), JSON.stringify(payload));
  writeFileSync(main, `await import(${JSON.stringify(runtime)});`);
  const helper = fileURLToPath(new URL('./build-maps.mjs', import.meta.url));
  const result = runNode(['--input-type=module', '-e', `
    const { registerFixtureMap } = await import(${JSON.stringify(helper)});
    registerFixtureMap(${JSON.stringify(join(root, 'dist/original.mjs'))}, ${JSON.stringify(output)}, ${JSON.stringify(payload)});
    await import(${JSON.stringify(main)});
  `], { env: recorderEnv(root, raw) });
  assert.equal(result.status, 0, result.stderr);
  rmSync(runtime);
  const report = join(workspace, 'vitest.json');
  writeFileSync(report, JSON.stringify({ testResults: [{ name: join(root, id), status: 'passed', startTime: 50, endTime: 120 }] }));
  const { records } = reduce({ root, rawDir: raw, mapsDir: maps, reportFile: report });
  assert.deepEqual(records[id].reads, ['packages/example/src/fixture-main.mjs', 'packages/example/src/fixture-source.ts']);
});
