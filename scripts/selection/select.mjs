// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, matchesGlob, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { partitionFiles } from '../test-shards.ts';
import { github } from './github.mjs';
import { groupCount, rootTest, safePath, selectionHash, sorted } from './manifest.mjs';

const commitId = /^[\da-f]{40}$/;
const code = /\.[cm]?[jt]sx?$/;
const knownResult = new Set(['passed', 'failed', 'skipped']);
const policyURL = new URL('../test-resources.json', import.meta.url);
const fallbackDurationsURL = new URL('../test-durations.json', import.meta.url);
const read = file => JSON.parse(readFileSync(file, 'utf8'));

export const git = (root, ...args) => execFileSync('git', args, {
  cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});
const matches = (file, patterns) => patterns.reduce((included, pattern) => {
  const excluded = pattern.startsWith('!');
  return matchesGlob(file, excluded ? pattern.slice(1) : pattern) ? !excluded : included;
}, false);
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
const sourcePath = file => !file.includes('\\') && !/[\x00-\x1f]/.test(file)
  && !file.split('/').some(part => part === '' || part === '.' || part === '..');

function isMap(map, run) {
  return map?.version === 1 && commitId.test(map.commit) && map.commit === run.head_sha && map.runId === String(run.id)
    && Number.isFinite(Date.parse(map.createdAt)) && strings(map.files) && map.files.every(sourcePath)
    && new Set(map.files).size === map.files.length && map.tests && typeof map.tests === 'object' && !Array.isArray(map.tests)
    && Object.entries(map.tests).every(([file, row]) => safePath(file) && rootTest.test(file)
      && row && knownResult.has(row.result) && Number.isFinite(row.ms) && row.ms >= 0
      && (row.ranBundle === undefined || typeof row.ranBundle === 'boolean') && strings(row.unresolved)
      && Array.isArray(row.reads) && row.reads.every(index => Number.isSafeInteger(index) && index >= 0 && index < map.files.length));
}

export async function lookupMap({ mergeBase, asOf, listRuns, isAncestor, load }) {
  const unusable = new Set();
  try {
    for (const run of await listRuns()) {
      if (!commitId.test(run.head_sha) || !isAncestor(run.head_sha, mergeBase)) continue;
      try {
        const artifact = await load(run.id);
        if (!artifact) unusable.add('missing');
        else if (artifact.expired) unusable.add('expired');
        else if (!(Date.parse(artifact.publishedAt) <= Date.parse(asOf))) unusable.add('published after run start');
        else {
          const map = artifact.read ? artifact.read() : artifact.map;
          if (isMap(map, run)) return { map, fallback: null };
          unusable.add('invalid');
        }
      } catch {
        unusable.add('unreadable');
      }
    }
  } catch {
    return { map: null, fallback: 'selection-map lookup failed' };
  }
  return { map: null, fallback: `no usable ancestor selection map${unusable.size ? ` (${sorted(unusable).join(', ')})` : ''}` };
}

function readPolicy() {
  const policy = read(policyURL);
  if (policy.version !== 1 || !Array.isArray(policy.rules) || !strings(policy.bundles?.entries) || !strings(policy.bundles?.consumers)
      || !policy.rules.every(rule => strings(rule.inputs) && strings(rule.tests) && strings(rule.related)
        && typeof rule.id === 'string' && typeof rule.reason === 'string')) throw new Error('invalid resource policy');
  return policy;
}

export function testInventory(root, head = 'HEAD') {
  const files = git(root, 'ls-tree', '-r', '-z', '--name-only', head, '--', 'packages').split('\0').filter(file => rootTest.test(file));
  if (!files.length || files.some(file => !safePath(file))) throw new Error('Invalid or empty root test inventory');
  return sorted(files);
}

export function changedBetween(root, base, head) {
  const fields = git(root, 'diff', '--name-status', '-z', '--no-renames', base, head).split('\0');
  fields.pop();
  const changes = [];
  for (let i = 0; i < fields.length; i += 2) {
    const [status, file] = fields.slice(i, i + 2);
    if (!/^[AMDT]$/.test(status) || !safePath(file)) throw new Error('unsupported changed-path form');
    changes.push({ status, file });
  }
  return changes;
}

export function namedByTests(root, head, file) {
  // Include basenames for references assembled from path segments or relative
  // to a test. Ambiguous names can select extra readers, not omit them.
  const needles = sorted([file, basename(file)]);
  try {
    return git(root, 'grep', '--threads=1', '-I', '-lz', '-F', ...needles.flatMap(needle => ['-e', needle]), head, '--',
      ':(glob)packages/*/src/**/*.test.ts').split('\0').filter(Boolean).map(match => match.slice(head.length + 1));
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

// Vite transforms away type imports. Resolve them from the tracked source
// before reaching for the Vite graph, which also handles its own asset plugins.
async function staticImporters(root) {
  const { default: ts } = await import('typescript');
  const config = resolve(root, 'tsconfig.json');
  const options = existsSync(config) ? ts.getParsedCommandLineOfConfigFile(config, {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => { throw new Error('invalid TypeScript resolution config'); },
  })?.options : { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, resolveJsonModule: true };
  if (!options) throw new Error('missing TypeScript resolution options');
  const cache = ts.createModuleResolutionCache(root, name => name, options);
  const files = new Set(git(root, 'ls-files', '-z').split('\0').filter(Boolean));
  const importers = new Map();
  for (const file of files) {
    if (!code.test(file)) continue;
    const path = resolve(root, file);
    const { importedFiles } = ts.preProcessFile(readFileSync(path, 'utf8'), true, true);
    for (const { fileName } of importedFiles) {
      const specifier = fileName.split(/[?#]/, 1)[0];
      const target = ts.resolveModuleName(specifier, path, options, ts.sys, cache).resolvedModule;
      if (!target) continue;
      const name = relative(root, target.resolvedFileName).replaceAll('\\', '/');
      if (!files.has(name)) continue;
      if (!importers.has(name)) importers.set(name, new Set());
      importers.get(name).add(file);
    }
  }
  return seeds => {
    const reached = new Set(seeds);
    for (const file of reached) for (const importer of importers.get(file) ?? []) reached.add(importer);
    return reached;
  };
}

// Vitest resolves the same imports and aliases it uses when collecting tests.
// A bundle entry can participate as a virtual specification without being run.
export async function createGraphResolver(root, inventory, entries) {
  const { createVitest } = await import('vitest/node');
  const ctx = await createVitest('test', { root, run: true, watch: false,
    maxWorkers: 3, include: ['packages/**/src/**/*.test.ts', ...entries] });
  const paths = specs => specs.map(spec => relative(root, spec.moduleId).replaceAll('\\', '/'));
  try {
    const discovered = new Set(paths(await ctx.globTestSpecifications()));
    if ([...inventory, ...entries].some(file => !discovered.has(file))) throw new Error('Vitest graph omitted a tracked test or bundle entry');
  } catch (error) { await ctx.close(); throw error; }
  let importers;
  return {
    async resolveRelated(seeds, targets) {
      importers ??= await staticImporters(root);
      const reached = importers(seeds);
      const candidates = targets ?? [...inventory, ...entries];
      ctx.config.related = seeds.map(file => resolve(root, file));
      return sorted([...candidates.filter(file => reached.has(file)), ...paths(await ctx.getRelevantTestSpecifications(targets))]);
    },
    close: () => ctx.close(),
  };
}

export async function selectTests({ head, inventory, changes, map, fallback = null,
  fallbackDurations = {}, namedBy = () => [], resolveRelated = async () => [] }) {
  const reasons = new Map();
  const tests = new Set(inventory);
  const add = (file, reason) => {
    if (!tests.has(file)) return;
    if (!reasons.has(file)) reasons.set(file, new Set());
    reasons.get(file).add(reason);
  };
  const changedFiles = [...changes].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  if (!map && !fallback) fallback = 'no usable selection map';
  if (!fallback) {
    try {
      const policy = readPolicy();
      const rules = changedFiles.map(change => ({ ...change, rules: policy.rules.filter(rule => matches(change.file, rule.inputs)) }));
      const toolchain = rules.find(change => change.rules.some(rule => rule.full));
      if (toolchain) {
        fallback = `toolchain changed: ${toolchain.file}`;
      } else {
        const readers = new Map(map.files.map(file => [file, []]));
        const unresolved = [], bundleExecutors = [];
        let legacyBundleRecords = false;
        for (const file of inventory) {
          const record = map.tests[file];
          if (!record) { add(file, 'missing from map'); continue; }
          if (record.result !== 'passed') add(file, `recorded result: ${record.result}`);
          if (record.unresolved.length) unresolved.push(file);
          if (record.ranBundle || record.unresolved.length) bundleExecutors.push(file);
          legacyBundleRecords ||= record.ranBundle === undefined;
          for (const index of record.reads) readers.get(map.files[index]).push(file);
        }
        const graphSeeds = new Set(), bundleSeeds = new Set();
        let buildChanged = false;
        for (const { file, status, rules: matching } of rules) {
          const ids = new Set(matching.map(rule => rule.id));
          const removed = status === 'D';
          const isDoc = ids.has('documentation'), isTest = rootTest.test(file);
          const isScript = file.startsWith('scripts/'), isHerdrE2e = file.startsWith('packages/herdr/e2e/');
          const isBuild = ids.has('build-install');
          const isPolicy = ids.has('test-policy');
          if (!isDoc && !isTest && (!isPolicy || code.test(file))) for (const test of unresolved) add(test, `unresolved bundle may reach ${file}`);
          for (const test of readers.get(file) ?? []) add(test, `recorded ${removed ? 'deleted ' : ''}input: ${file}`);
          if (isTest && !removed) add(file, 'changed test');
          if (isDoc || isScript || isHerdrE2e || isPolicy) {
            for (const test of namedBy(file)) add(test, `names ${file}`);
          }
          if (isBuild) buildChanged = true;
          const graphInput = !removed && !isDoc && !isTest && !isBuild && !isPolicy;
          if (!removed && (graphInput && !readers.has(file) || isScript || isHerdrE2e)) graphSeeds.add(file);
          if (graphInput && code.test(file)) bundleSeeds.add(file);
          const owner = file.match(/^packages\/([^/]+)\//)?.[1];
          for (const rule of matching) {
            if (rule.id === 'source-text' && (isTest || file.includes('/__tests__/'))) continue;
            const patterns = rule.tests.filter(pattern => owner || !pattern.includes('$package')).map(pattern => pattern.replaceAll('$package', owner));
            for (const test of inventory) if (matches(test, patterns)) add(test, `${rule.id}: ${rule.reason}`);
            for (const seed of rule.related) {
              for (const test of readers.get(seed) ?? []) add(test, `recorded resource reader: ${seed}`);
              graphSeeds.add(seed);
            }
          }
        }
        if (buildChanged && legacyBundleRecords) {
          fallback = 'build config changed but the map predates bundle-use records';
        } else {
          const related = graphSeeds.size ? await resolveRelated(sorted(graphSeeds)) : [];
          for (const test of related) add(test, 'static import graph');
          if (buildChanged) for (const test of bundleExecutors) add(test, 'ran a bundle affected by build configuration');
          const knownSeeds = sorted([...bundleSeeds].filter(file => !graphSeeds.has(file)));
          const bundleAffected = buildChanged || related.some(file => policy.bundles.entries.includes(file))
            || (knownSeeds.length && (await resolveRelated(knownSeeds, policy.bundles.entries)).some(file => policy.bundles.entries.includes(file)));
          if (bundleAffected) {
            for (const test of policy.bundles.consumers) add(test, 'bundle reader policy');
            for (const test of await resolveRelated(policy.bundles.consumers)) add(test, 'imports a bundle reader');
          }
        }
      }
    } catch (error) {
      // Do not put absolute paths or nondeterministic Vite diagnostics in a shared hash.
      console.error(`Selection failed: ${error.message}`);
      fallback = 'could not resolve resource policy or static import graph';
    }
  }
  if (fallback) for (const file of inventory) add(file, `full fallback: ${fallback}`);
  const durations = map ? Object.fromEntries(Object.entries(map.tests).map(([file, record]) => [file, record.ms])) : fallbackDurations;
  const files = sorted(reasons.keys());
  const selection = {
    version: 1, head, mode: fallback ? 'full' : 'scoped', fallback,
    mapRunId: map?.runId ?? null, mapCommit: map?.commit ?? null, changedFiles,
    selected: Object.fromEntries(files.map(file => [file, sorted(reasons.get(file))])),
    groups: partitionFiles(files, durations, groupCount),
  };
  return { ...selection, selectionHash: selectionHash(selection) };
}

function isAncestor(root, commit, target) {
  try { git(root, 'merge-base', '--is-ancestor', commit, target); return true; }
  catch (error) { if (error.status === 1 || error.status === 128) return false; throw error; }
}

export async function lookupMainMap({ root, mergeBase, repo, workflowRun, api = github(repo) }) {
  try {
    const asOf = api.get(`actions/runs/${workflowRun}`).created_at;
    const since = new Date(Date.parse(asOf) - 30 * 24 * 60 * 60 * 1000).toISOString();
    return await lookupMap({ mergeBase, asOf,
      listRuns: async () => api.pages(`actions/workflows/selection-map.yml/runs?branch=main&status=success&created=${encodeURIComponent(`>=${since}`)}&per_page=100`)
        .flatMap(page => page.workflow_runs)
        .filter(run => Date.parse(run.updated_at) <= Date.parse(asOf)),
      isAncestor: (commit, target) => isAncestor(root, commit, target),
      load: id => api.artifact(id, 'selection-map', 'selection-map.json'),
    });
  } catch { return { map: null, fallback: 'selection-map lookup failed' }; }
}

async function main(base, output) {
  if (!commitId.test(base) || !output) throw new Error('Usage: node scripts/selection/select.mjs PR_BASE_SHA OUTPUT');
  const root = process.cwd(), head = git(root, 'rev-parse', 'HEAD').trim();
  const mergeBase = git(root, 'merge-base', base, head).trim();
  const inventory = testInventory(root, head);
  const lookup = await lookupMainMap({ root, mergeBase, repo: process.env.GITHUB_REPOSITORY, workflowRun: process.env.GITHUB_RUN_ID });
  let changes = [], graph;
  try { changes = changedBetween(root, lookup.map?.commit ?? mergeBase, head); }
  catch { lookup.fallback = 'could not read map-to-head changed files'; }
  const selection = await selectTests({ head, inventory, changes, ...lookup, fallbackDurations: read(fallbackDurationsURL),
    namedBy: file => namedByTests(root, head, file),
    async resolveRelated(seeds, targets) {
      graph ??= await createGraphResolver(root, inventory, readPolicy().bundles.entries);
      return graph.resolveRelated(seeds, targets);
    },
  }).finally(() => graph?.close());
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
  const detail = selection.fallback ?? `map run ${selection.mapRunId} at ${selection.mapCommit}`;
  const summary = `Selection: ${Object.keys(selection.selected).length} of ${inventory.length} files (${detail}).\n\nGroups: ${selection.groups.map(group => group.length).join(', ')}.\n\nHash: ${selection.selectionHash}\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(...process.argv.slice(2));
