// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

// Compose source text and the verified A-to-B transition for production setup.
// This never mounts a mod or starts Herdr.
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
const { loadSpacesAFiles, loadPublishedSpacesARecipe, replaySpacesARecipe } = await import(aUrl);
const { replaySpacesBRecipe } = await import(helperUrl('spaces-b-fixture', { './spaces-a-fixture.js': aUrl }));
const args = process.argv.slice(2);
if (args.some(arg => !['--check', '--write'].includes(arg)) || new Set(args).size !== args.length || args.length > 1)
  throw new Error('Expected --check or --write');
const check = args.includes('--check');
const manifestPath = new URL('../packages/herdr/assets/look/cross-machine-patches.json', import.meta.url);
const original = check ? readFileSync(manifestPath, 'utf8') : null;
const versions = ['0.1.13', '0.1.16', '0.1.18'];
const agents = JSON.parse(readFileSync(new URL('./spaces-b-fragments/agents.json', import.meta.url), 'utf8'));
const records = { version: 1, versions: Object.fromEntries(versions.map(version => {
  const { agents: agentAdditions = [], agentOverrides = {}, ...fragments } = JSON.parse(readFileSync(new URL(`./spaces-b-fragments/${version}.json`, import.meta.url), 'utf8'));
  for (const [id, replacement] of Object.entries(agentOverrides)) {
    assert(agents.some(fragment => fragment.id === id) && typeof replacement === 'string' && replacement.length > 0, `Invalid agent override ${id} in ${version}`);
  }
  const sharedAgents = agents.map(fragment => Object.hasOwn(agentOverrides, fragment.id)
    ? { ...fragment, replacement: agentOverrides[fragment.id] } : fragment);
  const combined = [...sharedAgents, ...agentAdditions];
  assert.equal(new Set(combined.map(fragment => fragment.id)).size, combined.length, `Duplicate agent fragment id in ${version}`);
  return [version, { ...fragments, agents: combined }];
})) };
records.checks = {};
for (const version of versions) {
  const fragments = records.versions[version];
  const recipe = loadPublishedSpacesARecipe(version);
  const afterA = replaySpacesARecipe(version, loadSpacesAFiles(version), recipe.aFragments, recipe);
  const output = replaySpacesBRecipe(version, loadSpacesAFiles(version), fragments);
  assert.deepEqual(replaySpacesBRecipe(version, output, fragments), output);
  const changed = structuredClone(output);
  changed.agents['main.js'] += '\n// changed output\n';
  assert.throws(() => replaySpacesBRecipe(version, changed, fragments), /digest/);
  const missing = structuredClone(output);
  delete missing.agents['main.js'];
  assert.throws(() => replaySpacesBRecipe(version, missing, fragments), /missing/);
  const transitionHashes = files => Object.fromEntries(Object.keys(fragments).sort().flatMap(mod => Object.entries(files[mod]).sort().map(([file, text]) => [`${mod}/${file}`, createHash('sha256').update(text).digest('hex')])));
  records.checks[version] = {
    recordsHash: createHash('sha256').update(JSON.stringify(fragments)).digest('hex'),
    inputHashes: transitionHashes(afterA),
    outputHashes: transitionHashes(output),
    helperHashes: Object.fromEntries(['pane/actions.js', 'pane/machine.js', 'machines/actions.js', 'machines/picker.js'].map(name => [name, createHash('sha256').update(readFileSync(new URL(`../packages/herdr/assets/${name}`, import.meta.url))).digest('hex')])),
  };
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
const output = JSON.stringify(records, null, 2) + '\n';
if (check) {
  assert.equal(output, original, 'Published Spaces B recipes differ from composed output');
  console.log('Published Spaces B recipes match composed output');
} else {
  writeFileSync(manifestPath, output);
  console.log('Wrote Spaces B recipes');
}
