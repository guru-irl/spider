// SPDX-License-Identifier: MIT
import { rootTest, safePath, sorted } from './manifest.mjs';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const artifactPath = path => safePath(path) && /^dist\/.+\.[cm]?js$/.test(path);

export function isArtifact(row) {
  return row && artifactPath(row.path) && digest(row.sha256) && safePath(row.entry)
    && row.entry.startsWith('packages/') && Array.isArray(row.inputs) && row.inputs.every(safePath);
}

// v2 maps without this optional section still use the blanket. A broken or
// unsupported section cannot act as evidence for excluding any test.
function indexEvidence(evidence) {
  if (evidence?.version !== 1 || !Array.isArray(evidence.artifacts) || !evidence.artifacts.length
    || !object(evidence.tests)) return null;
  const byHash = new Map(), keys = new Set();
  for (const artifact of evidence.artifacts) {
    if (!isArtifact(artifact)) return null;
    const key = `${artifact.path}:${artifact.sha256}`;
    if (keys.has(key)) return null;
    keys.add(key);
    if (!byHash.has(artifact.sha256)) byHash.set(artifact.sha256, []);
    byHash.get(artifact.sha256).push(artifact);
  }
  for (const [file, row] of Object.entries(evidence.tests)) {
    if (!safePath(file) || !rootTest.test(file) || !row || typeof row.ambiguous !== 'boolean'
      || !Array.isArray(row.hashes) || !row.hashes.every(hash => byHash.has(hash))) return null;
  }
  return byHash;
}

export function createArtifactRouter({ evidence, mapTests, changes, related, buildChanged, mayNarrow,
  contracts, loadBlobs, readDigest }) {
  const byHash = indexEvidence(evidence);
  if (!byHash) return null;
  const changed = new Set(changes.map(({ file }) => file));
  const reached = new Set(related);
  const affected = new Set(evidence.artifacts.filter(artifact => buildChanged || changed.has(artifact.path)
    || changed.has(artifact.entry) || reached.has(artifact.entry) || artifact.inputs.some(input => changed.has(input))));
  const selected = new Map();
  for (const [test, observation] of Object.entries(evidence.tests)) {
    const paths = sorted(observation.hashes.flatMap(hash => byHash.get(hash).filter(artifact => affected.has(artifact)).map(artifact => artifact.path)));
    if (paths.length) selected.set(test, paths);
  }
  const outputs = new Map();
  let blobs;
  return {
    affected: affected.size > 0,
    selected,
    exclusion(test) {
      const contract = contracts.get(test), observation = evidence.tests[test], record = mapTests[test];
      if (!mayNarrow || !contract || !observation || observation.ambiguous || !observation.hashes.length || !record
        || record.incomplete || record.result !== 'passed' || record.unresolved.length || selected.has(test)) return null;
      const artifacts = observation.hashes.flatMap(hash => byHash.get(hash));
      if (observation.hashes.some(hash => byHash.get(hash).length !== 1) || artifacts.length !== contract.outputs.length
        || sorted(artifacts.map(artifact => artifact.path)).join('\0') !== sorted(contract.outputs).join('\0')) return null;
      blobs ??= loadBlobs(sorted([...contracts.values()].flatMap(({ blobs }) => Object.keys(blobs))));
      if (Object.entries(contract.blobs).some(([file, blob]) => changed.has(file) || blobs.get(file) !== blob)) return null;
      for (const { path, sha256 } of artifacts) {
        if (!outputs.has(path)) outputs.set(path, readDigest(path));
        if (outputs.get(path) !== sha256) return null;
      }
      return { artifacts, blobs: contract.blobs };
    },
  };
}
