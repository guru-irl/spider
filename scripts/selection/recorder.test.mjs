// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { reduce } from './reduce.mjs';

const hook = fileURLToPath(new URL('./cov-hook.cjs', import.meta.url));
const id = 'packages/example/src/probe.test.ts';

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

function fixtureRecords(t, { snapshots = [], results = [], hookErrors = '', launches = [] } = {}) {
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

function reduceProbe({ root, raw, maps, workspace }) {
  writeFileSync(join(root, 'dist/reference.mjs'), 'export {};');
  writeFileSync(join(maps, 'reference.mjs.map'), JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }));
  const reportFile = join(workspace, 'vitest.json');
  writeFileSync(reportFile, JSON.stringify({ testResults: [{ name: join(root, id), status: 'passed', startTime: 0, endTime: 1 }] }));
  return reduce({ root, rawDir: raw, mapsDir: maps, reportFile }).records[id];
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

test('records non-code file reads through Node fs APIs in a child with a replacement environment', t => {
  const paths = fixture(t);
  const { root, raw, workspace, installed } = paths;
  for (const name of ['callback.json', 'handle.html', 'open.sql', 'openSync.txt', 'promise.css', 'stream.svg', 'sync.yaml', 'output.txt']) {
    writeFileSync(join(root, name), name);
  }
  writeFileSync(join(workspace, 'outside.txt'), 'outside');
  writeFileSync(join(installed, 'dependency.txt'), 'dependency');
  writeFileSync(join(root, 'data-child.mjs'), `
    import assert from 'node:assert/strict';
    import { createReadStream, open, openSync, close, readFile, readFileSync, closeSync } from 'node:fs';
    import { open as openPromise, readFile as readPromise } from 'node:fs/promises';
    import { promisify } from 'node:util';
    assert.equal(readFileSync(new URL('./sync.yaml', import.meta.url), 'utf8'), 'sync.yaml');
    assert.equal(await promisify(readFile)(Buffer.from('callback.json'), 'utf8'), 'callback.json');
    assert.equal(await readPromise('promise.css', 'utf8'), 'promise.css');
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
  assert.deepEqual(record.reads, ['callback.json', 'data-child.mjs', 'handle.html', 'open.sql', 'openSync.txt',
    'promise.css', 'stream.svg', 'sync.yaml']);
  assert.equal(record.incomplete, false);
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
