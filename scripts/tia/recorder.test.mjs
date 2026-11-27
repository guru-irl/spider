import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const hook = fileURLToPath(new URL('./cov-hook.cjs', import.meta.url));
const reducer = fileURLToPath(new URL('./reduce.mjs', import.meta.url));
const id = 'packages/example/src/probe.test.ts';

function fixture(t) {
  const scratch = resolve('.spider/scratch/tia');
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
  return readdirSync(raw).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(raw, name))));
}

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
    env: { ...process.env, SPIDER_TIA_DIR: raw, SPIDER_TIA_ROOT: root, SPIDER_TIA_TEST: id,
      NODE_OPTIONS: `--require=${JSON.stringify(hook)}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout + result.stderr, '');
  const seen = records(raw).filter(process => process.argv[1] === child);
  assert.equal(seen.length, 7);
  assert.ok(seen.every(process => process.test === id && process.cpuUsage.user > 0 && process.ended));
  for (const process of seen) {
    const script = process.scripts.find(entry => entry.url.endsWith('/child.cjs'));
    assert.deepEqual(script.offsets, [0]); // `ran`, not the unnamed CJS script root at the same offset.
    assert.match(script.sha256, /^[0-9a-f]{64}$/);
  }
});

test('child code sees its original Node options and inherits only the outer test identity', t => {
  const { root, raw } = fixture(t);
  const child = join(root, 'packages/example/src/clean-child.cjs');
  const parent = join(root, 'packages/example/src/clean-parent.cjs');
  writeFileSync(child, `
    const assert = require('node:assert/strict');
    assert.equal(process.env.SPIDER_TIA, undefined);
    if (process.argv[2] === 'unset') assert.equal(Object.hasOwn(process.env, 'NODE_OPTIONS'), false);
    else assert.equal(process.env.NODE_OPTIONS, process.argv[2]);
  `);
  writeFileSync(parent, `
    const { execFileSync } = require('node:child_process');
    const leaf = process.argv[2];
    for (const opts of [undefined, '', '--no-warnings']) {
      const env = { SPIDER_TIA: '1', ...(opts === undefined ? {} : { NODE_OPTIONS: opts }) };
      execFileSync(process.execPath, [leaf, opts ?? 'unset'], { env });
    }
  `);
  const result = runNode([parent, child], { env: { ...process.env, SPIDER_TIA: '1', SPIDER_TIA_DIR: raw,
    SPIDER_TIA_ROOT: root, SPIDER_TIA_TEST: id, NODE_OPTIONS: `--require=${JSON.stringify(hook)}` } });
  assert.equal(result.status, 0, result.stderr);
  const children = records(raw).filter(process => process.argv[1] === child);
  assert.equal(children.length, 3);
  assert.ok(children.every(process => process.test === id && !process.worker && process.ended));
});

test('reducer maps a deleted packed copy by hash and keeps bundle-only loads out of the lower bound', t => {
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
  const result = runNode([main], { env: { ...process.env, SPIDER_TIA_DIR: raw, SPIDER_TIA_ROOT: root,
    SPIDER_TIA_TEST: id, NODE_OPTIONS: `--require=${JSON.stringify(hook)}` } });
  assert.equal(result.status, 0, result.stderr);
  const recorded = records(raw).flatMap(process => process.scripts).find(script => script.url.endsWith('/packed.mjs'));
  assert.equal(recorded?.sha256, createHash('sha256').update(compiled).digest('hex'));
  rmSync(file);
  const report = join(workspace, 'vitest.json');
  const reduced = join(workspace, 'records.json');
  writeFileSync(report, JSON.stringify({ testResults: [{ name: join(root, id), status: 'passed', startTime: 50, endTime: 120 }] }));
  const reduction = runNode([reducer, raw, maps, report, reduced], { cwd: root });
  assert.equal(reduction.status, 0, reduction.stderr);
  const data = JSON.parse(readFileSync(reduced));
  const entry = data.records[id];
  assert.deepEqual(entry.executed, ['packages/example/src/ran.ts']);
  assert.deepEqual(entry.loaded, ['packages/example/src/load-only.ts', 'packages/example/src/main.mjs', 'packages/example/src/ran.ts', 'packages/example/src/top-level.ts']);
  assert.deepEqual(entry.functionLines, { 'packages/example/src/ran.ts': [11] });
  assert.equal(entry.result, 'passed');
  assert.equal(entry.processCount, 1);
});
