// SPDX-License-Identifier: MIT
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isArtifact } from './artifact-routing.mjs';
import { bundleDigest } from './bundle-keys.mjs';
import { sorted } from './manifest.mjs';

// A production Vite build currently emits one standalone JS entry at a time.
// A different output shape has no exact manifest until it has a build recipe.
export function archiveArtifactInputs(bucket, dest, root = process.cwd()) {
  const repoInput = id => {
    if (!id || !isAbsolute(id)) return null;
    const path = relative(root, id.split(/[?#]/, 1)[0]).split(sep).join('/');
    return path && !isAbsolute(path) && !path.split('/').some(part =>
      ['..', 'node_modules', '.git', '.spider', 'dist'].includes(part)) ? path : null;
  };
  let configInputs = [];
  let moduleInputs = [];
  return {
    name: 'selection-archive-artifact-inputs',
    configResolved(config) { configInputs = [config.configFile, ...config.configFileDependencies]; },
    buildEnd() { moduleInputs = [...this.getModuleIds()]; },
    writeBundle({ dir }, bundle) {
      const chunks = Object.values(bundle).filter(output => output.type === 'chunk');
      if (chunks.length !== 1 || !chunks[0].isEntry) return;
      const { fileName, facadeModuleId } = chunks[0];
      const name = resolve(dir, fileName);
      const path = relative(root, name).split(sep).join('/');
      if (path !== ['dist', bucket, fileName].filter(Boolean).join('/')) return;
      const entry = repoInput(facadeModuleId);
      const inputs = sorted([...configInputs, ...moduleInputs].map(repoInput).filter(Boolean));
      const artifact = { path, sha256: bundleDigest(root, path), entry, inputs };
      if (!isArtifact(artifact)) return;
      const archive = join(dest, `${fileName}.artifact.json`);
      mkdirSync(dirname(archive), { recursive: true });
      writeFileSync(archive, JSON.stringify(artifact) + '\n');
    },
  };
}
