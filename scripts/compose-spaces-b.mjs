// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// B records stay separate from the production manifest until native admission.
// This composes source text only. It never mounts a mod or starts Herdr.
function helperUrl(name, imports = {}) {
  const url = new URL(`../packages/herdr/src/__tests__/${name}.ts`, import.meta.url);
  let source = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  source = source.replace(/from '(\.[^']+)'/g, (_match, relative) => `from '${imports[relative] ?? new URL(relative, url).href}'`)
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}
const aUrl = helperUrl('spaces-a-fixture');
const { loadSpacesAFiles } = await import(aUrl);
const { replaySpacesBRecipe } = await import(helperUrl('spaces-b-fixture', { './spaces-a-fixture.js': aUrl }));
const records = JSON.parse(readFileSync(new URL('../packages/herdr/assets/look/cross-machine-patches.json', import.meta.url), 'utf8'));
assert.equal(records.version, 1);
assert.deepEqual(Object.keys(records.versions).sort(), ['0.1.13', '0.1.16']);
for (const version of Object.keys(records.versions)) {
  const fragments = records.versions[version];
  const output = replaySpacesBRecipe(version, loadSpacesAFiles(version), fragments);
  assert.deepEqual(replaySpacesBRecipe(version, output, fragments), output);
  const changed = structuredClone(output);
  changed.agents['main.js'] += '\n// changed output\n';
  assert.throws(() => replaySpacesBRecipe(version, changed, fragments), /digest/);
  const missing = structuredClone(output);
  delete missing.agents['main.js'];
  assert.throws(() => replaySpacesBRecipe(version, missing, fragments), /missing/);
  const hashes = {};
  for (const [mod, files] of Object.entries(output).sort()) for (const [name, contents] of Object.entries(files).sort()) {
    if (name.endsWith('.js')) {
      const parsed = ts.createSourceFile(name, contents, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
      assert.equal(parsed.parseDiagnostics.length, 0, `Invalid composed JavaScript: ${version} ${mod}/${name}`);
    }
    hashes[`${mod}/${name}`] = createHash('sha256').update(contents).digest('hex');
  }
  const digest = createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
  console.log(`${version}: ${Object.values(fragments).flat().length} B records, ${Object.keys(hashes).length} files, ${digest}`);
}
