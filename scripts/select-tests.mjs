#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, matchesGlob, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const policyPath = fileURLToPath(new URL('./test-resources.json', import.meta.url));
const timingPath = fileURLToPath(new URL('./test-durations.json', import.meta.url));
const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
const rootTest = /^packages\/[^/]+\/src\/.+\.test\.ts$/;
const code = /\.[cm]?[jt]sx?$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value);
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const sorted = values => [...new Set(values)].sort();
const safePath = file => typeof file === 'string' && /^[a-zA-Z0-9_./-]+$/.test(file) && !file.startsWith('/') && !file.split('/').some(part => part === '..' || part === '' || part === '.');
const matches = (file, patterns) => patterns.reduce((included, pattern) => {
  const excluded = pattern.startsWith('!');
  return matchesGlob(file, excluded ? pattern.slice(1) : pattern) ? !excluded : included;
}, false);

export function testInventory(root) {
  const files = sorted(git(root, 'ls-files', '-z', '--', 'packages').split('\0').filter(file => rootTest.test(file)));
  if (!files.length || files.some(file => !safePath(file) || !existsSync(resolve(root, file)))) throw new Error('invalid or empty tracked test inventory');
  return files;
}

function manifestDigest(manifest) {
  const { selectionHash: _hash, selectionMs: _time, ...stable } = manifest;
  return hash(canonical(stable));
}

export function optionalSuites(changedPaths, fallback = false) {
  return Object.fromEntries(Object.entries(policy.optional).map(([name, patterns]) => [name,
    fallback || changedPaths.some(file => matches(file, patterns) || policy.rules.some(rule => rule.full && matches(file, rule.inputs))),
  ]));
}

// File-only discovery never collects test modules or starts workers/global setup.
// Bundle entries join the include set as virtual specifications, not runnable tests.
export async function createGraphResolver(root, inventory) {
  const { createVitest } = await import('vitest/node');
  const ctx = await createVitest('test', {
    root, run: true, watch: false, maxWorkers: 3,
    include: ['packages/**/src/**/*.test.ts', ...policy.bundles.entries],
  });
  try {
    const discovered = await ctx.globTestSpecifications();
    const paths = sorted(discovered.map(spec => relative(root, spec.moduleId).replaceAll('\\', '/')));
    if (inventory.some(file => !paths.includes(file))) throw new Error('Vitest discovery omitted tracked tests');
    if (policy.bundles.entries.some(file => !paths.includes(file))) throw new Error('bundle entry is missing from the Vite graph');
  } catch (error) { await ctx.close(); throw error; }
  return {
    async resolveRelated(seeds) {
      ctx.config.related = seeds.map(file => resolve(root, file));
      const specs = await ctx.getRelevantTestSpecifications();
      return specs.map(spec => relative(root, spec.moduleId).replaceAll('\\', '/'));
    },
    close: () => ctx.close(),
  };
}

export async function selectTests({ root = process.cwd(), base, head = 'HEAD', resolveRelated: injectedGraph } = {}) {
  root = resolve(root);
  const started = performance.now();
  const inventory = testInventory(root);
  const reasons = new Map();
  const add = (file, reason) => {
    if (!inventory.includes(file)) return;
    if (!reasons.has(file)) reasons.set(file, new Set());
    reasons.get(file).add(reason);
  };
  const result = {
    version: 1, mode: 'scoped', baseSha: null, requestedBase: base ?? null,
    testedSha: git(root, 'rev-parse', 'HEAD').trim(), changedPaths: [],
    timingHash: hash(readFileSync(timingPath)), policyHash: hash(readFileSync(policyPath)),
    selectorHash: hash(readFileSync(fileURLToPath(import.meta.url))),
    inventoryHash: hash(canonical(inventory)), fallback: null,
  };
  let graph;
  try {
    if (!base) throw new Error('missing base revision');
    let target;
    try {
      target = git(root, 'rev-parse', '--verify', `${head}^{commit}`).trim();
      git(root, 'rev-parse', '--verify', `${base}^{commit}`);
    } catch { throw new Error('base or head revision is unavailable'); }
    if (target !== result.testedSha) throw new Error('tested revision is not the checkout HEAD');
    result.baseSha = git(root, 'merge-base', base, target).trim();
    const fields = git(root, 'diff', '--name-status', '-z', '--no-renames', result.baseSha, target).split('\0');
    fields.pop();
    const changes = [];
    for (let i = 0; i < fields.length; i += 2) {
      if (!/^[AMD]$/.test(fields[i]) || !safePath(fields[i + 1])) throw new Error('unsupported changed-path form');
      changes.push({ status: fields[i], file: fields[i + 1] });
    }
    result.changedPaths = sorted(changes.map(change => change.file));
    if (changes.some(change => change.status === 'D')) throw new Error('deleted input requires the full inventory until base-graph support');
    const seeds = new Set();
    for (const { file } of changes) {
      const rules = policy.rules.filter(rule => matches(file, rule.inputs));
      const everything = rules.find(rule => rule.full);
      if (everything) throw new Error(`${everything.id}: ${everything.reason}`);
      const isCode = /^packages\/[^/]+\/src\//.test(file) && code.test(file);
      if (!rules.length && !isCode) throw new Error(`unclassified changed path: ${file}`);
      if (isCode) seeds.add(file);
      if (rootTest.test(file)) add(file, 'changed test');
      const owner = file.match(/^packages\/([^/]+)\//)?.[1];
      for (const rule of rules) {
        // Tests are graph inputs, not production source-text changes.
        if (rule.id === 'source-text' && (rootTest.test(file) || file.includes('/__tests__/'))) continue;
        const patterns = rule.tests.filter(pattern => owner || !pattern.includes('$package')).map(pattern => pattern.replaceAll('$package', owner));
        for (const test of inventory) if (matches(test, patterns)) add(test, `${rule.id}: ${rule.reason}`);
        for (const seed of rule.related) seeds.add(seed);
      }
    }
    if (seeds.size) {
      graph = injectedGraph ? { resolveRelated: injectedGraph, close: async () => {} } : await createGraphResolver(root, inventory);
      const affected = await graph.resolveRelated(sorted(seeds), policy.bundles.entries);
      if (!Array.isArray(affected) || affected.some(file => !safePath(file) || !inventory.includes(file) && !policy.bundles.entries.includes(file))) throw new Error('invalid import graph result');
      for (const file of affected) add(file, 'import graph');
      if (affected.some(file => policy.bundles.entries.includes(file))) {
        const consumers = policy.bundles.consumers;
        for (const file of consumers) add(file, 'bundle consumer');
        const reached = await graph.resolveRelated(consumers, []);
        if (!Array.isArray(reached) || reached.some(file => !safePath(file) || !inventory.includes(file) && !policy.bundles.entries.includes(file))) throw new Error('invalid bundle graph result');
        for (const file of reached) add(file, 'bundle helper importer');
      }
    }
  } catch (error) {
    result.mode = 'full';
    // Avoid embedding local paths or command output in a portable manifest.
    result.fallback = error instanceof Error ? error.message.split('\n')[0].replaceAll(root, '<root>') : 'selector error';
    for (const file of inventory) add(file, `full fallback: ${result.fallback}`);
  } finally {
    if (graph) {
      try { await graph.close(); }
      catch { result.mode = 'full'; result.fallback = 'graph shutdown failed'; for (const file of inventory) add(file, 'graph shutdown fallback'); }
    }
  }
  result.optional = optionalSuites(result.changedPaths, result.mode === 'full');
  result.files = sorted(reasons.keys());
  result.reasons = Object.fromEntries(result.files.map(file => [file, sorted(reasons.get(file))]));
  result.selectionHash = manifestDigest(result);
  result.selectionMs = Math.round(performance.now() - started);
  return result;
}

export function validateManifest(manifest, { root = process.cwd(), testedSha = git(root, 'rev-parse', 'HEAD').trim() } = {}) {
  if (manifest?.version !== 1 || manifest.testedSha !== testedSha) throw new Error('manifest revision SHA does not match checkout');
  if (manifest.selectionHash !== manifestDigest(manifest)) throw new Error('manifest checksum does not match');
  const inventory = testInventory(root);
  if (manifest.inventoryHash !== hash(canonical(inventory))) throw new Error('manifest inventory changed');
  if (!Array.isArray(manifest.files) || manifest.files.some(file => !safePath(file) || !inventory.includes(file)) || canonical(manifest.files) !== canonical(sorted(manifest.files))) throw new Error('invalid manifest files');
  if (manifest.mode === 'full' && canonical(manifest.files) !== canonical(inventory)) throw new Error('full manifest omitted tests');
  return manifest.files;
}

async function main() {
  const args = process.argv.slice(2);
  const get = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const output = get('--output') ?? '.spider/scratch/test-selection.json';
  const manifest = await selectTests({ base: get('--base'), head: get('--head') ?? 'HEAD' });
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT,
    Object.entries(manifest.optional).map(([key, value]) => `${key}=${value}\n`).join('') + `selection-hash=${manifest.selectionHash}\n`, { flag: 'a' });
  console.log(`Selection: ${manifest.mode}, ${manifest.files.length} files, ${manifest.selectionMs} ms, ${manifest.selectionHash}`);
  if (manifest.fallback) console.log(`Full fallback: ${manifest.fallback}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
