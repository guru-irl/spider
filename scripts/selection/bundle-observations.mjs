// SPDX-License-Identifier: MIT
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isArtifact } from './artifact-routing.mjs';
import { bundleDigest } from './bundle-keys.mjs';
import { sorted } from './manifest.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8'));

export function observeArtifacts({ root, rawDir, mapsDir, records }) {
  const artifacts = readdirSync(mapsDir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.artifact.json'))
    .map(entry => read(join(entry.parentPath, entry.name)))
    .filter(artifact => isArtifact(artifact) && bundleDigest(root, artifact.path) === artifact.sha256);
  if (!artifacts.length) return undefined;
  const byPath = new Map(artifacts.map(artifact => [artifact.path, artifact.sha256]));
  const known = new Set(byPath.values());
  const observations = new Map();
  const observe = test => {
    if (!observations.has(test)) observations.set(test, { hashes: new Set(), ambiguous: Boolean(records[test].unresolved.length) });
    return observations.get(test);
  };
  for (const [test, row] of Object.entries(records)) {
    for (const path of row.reads.filter(path => path.startsWith('dist/'))) {
      if (byPath.has(path)) observe(test).hashes.add(byPath.get(path));
      else observe(test).ambiguous = true;
    }
  }
  for (const name of readdirSync(rawDir).filter(name => /^\d+-[a-f0-9-]+\.json$/.test(name))) {
    const { test } = read(join(rawDir, name));
    const journal = join(rawDir, name.replace(/\.json$/, '.ndjson'));
    if (!Object.hasOwn(records, test) || !existsSync(journal)) continue;
    for (const line of readFileSync(journal, 'utf8').split('\n').filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.kind === 'bundle' || event.kind === 'fixture') {
        // A copy or installed executable can have a different name. The
        // same bytes under two shipped paths will select both paths' users.
        if (known.has(event.sha256)) observe(test).hashes.add(event.sha256);
        else observe(test).ambiguous = true;
      } else if (event.kind === 'build') {
        observe(test).ambiguous = true;
      } else if (event.kind === 'tree' && event.url?.startsWith('file:')) {
        const path = relative(root, fileURLToPath(event.url)).split(sep).join('/');
        if (path === '' || path === 'dist' || path.startsWith('dist/')) {
          // Inventory and recursive copies can include generated assets and
          // files other than the known JS outputs. Never scope them down.
          observe(test).ambiguous = true;
          for (const [file, hash] of byPath) {
            if (!path || file === path || file.startsWith(`${path}/`)) observe(test).hashes.add(hash);
          }
        }
      }
    }
  }
  return { version: 1, artifacts, tests: Object.fromEntries([...observations].map(([file, row]) => [file,
    { hashes: sorted(row.hashes), ambiguous: row.ambiguous }])) };
}

export function mergeArtifactEvidence(sections) {
  const artifacts = new Map(), tests = new Map();
  for (const { version, artifacts: rows, tests: observations } of sections.filter(Boolean)) {
    if (version !== 1) return undefined;
    for (const row of rows) {
      const key = `${row.path}:${row.sha256}`;
      const prior = artifacts.get(key);
      if (prior && prior.entry !== row.entry) return undefined;
      artifacts.set(key, prior ? { ...row, inputs: sorted([...prior.inputs, ...row.inputs]) } : row);
    }
    for (const [file, observation] of Object.entries(observations)) tests.set(file, observation);
  }
  return artifacts.size ? { version: 1, artifacts: [...artifacts.values()].sort((a, b) =>
    a.path.localeCompare(b.path) || a.sha256.localeCompare(b.sha256)), tests: Object.fromEntries(tests) } : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [rawDir, mapsDir, output] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node scripts/selection/bundle-observations.mjs RAW MAPS SHARD');
  const shard = read(output);
  const bundleRouting = observeArtifacts({ root: process.cwd(), rawDir, mapsDir, records: shard.records });
  if (bundleRouting) writeFileSync(output, JSON.stringify({ ...shard, bundleRouting }) + '\n');
}
