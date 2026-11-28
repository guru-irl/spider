import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const helper = new URL('../packages/herdr/src/__tests__/spaces-a-fixture.ts', import.meta.url);
let source = ts.transpileModule(readFileSync(helper, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
source = source.replace(/from '(\.[^']+)'/g, (_match, relative) => `from '${new URL(relative, helper).href}'`)
  .replaceAll('import.meta.url', JSON.stringify(helper.href));
const { composeSpacesARecipe } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const manifestPath = new URL('../packages/herdr/assets/look/patches.json', import.meta.url);
const original = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(original);
const args = process.argv.slice(2);
const check = args.includes('--check');
const through = args.filter(arg => arg !== '--check')[0] ?? 'full';
if (!['agents', 'spaces', 'full'].includes(through)) throw new Error('Expected agents, spaces, or full');
for (const version of ['0.1.13', '0.1.16', '0.1.18']) {
  const fragments = {};
  for (const mod of through === 'agents' ? ['agents'] : ['agents', 'spaces']) {
    fragments[mod] = JSON.parse(readFileSync(new URL(`../packages/herdr/assets/look/spaces-a-sidebar/${mod}-${version}.json`, import.meta.url), 'utf8'));
  }
  if (through === 'full') {
    const probes = JSON.parse(readFileSync(new URL('../packages/herdr/src/__tests__/fixtures/spaces-a-anchor-probes.json', import.meta.url), 'utf8'));
    const pane = probes[version].pane;
    const imports = pane.find(p => p.id === 'a-pane-imports');
    const park = pane.find(p => p.id === 'a-pane-park');
    fragments.pane = [
      { ...imports, replacement: imports.anchor.replace('from "herdr";', 'from "herdr";\nimport * as herdrApi from "herdr";\nimport { parkFocusedTerminal } from "./park.js";') },
      { ...park, replacement: park.anchor + '\n          if (command === "park" && p?.focused && props()?.labelContract) parkFocusedTerminal(herdrApi.focused(), herdrApi.terminals(), props().labelContract, run, title => herdrApi.notify({ title, level: "warning" }));' },
    ];
    fragments.menu = JSON.parse(readFileSync(new URL(`../packages/herdr/assets/look/spaces-a-goto/menu-${version}.json`, import.meta.url), 'utf8'));
  }
  const derived = [];
  if (through === 'full') {
    for (const [mod, asset, sourceMod] of [['spider-picker', 'picker', 'picker'], ...(version !== '0.1.13' ? [['spider-toast', 'toast', 'toast']] : [])]) {
      for (const file of ['main.js', 'mod.json']) {
        const assetFile = `${asset}/${version === '0.1.18' && asset === 'toast' && file === 'main.js' ? 'main-0.1.18.js' : file}`;
        const contents = readFileSync(new URL(`../packages/herdr/assets/${assetFile}`, import.meta.url), 'utf8');
        const hashes = JSON.parse(readFileSync(new URL(`../packages/herdr/src/__tests__/fixtures/herdr-${version}/source-hashes.json`, import.meta.url), 'utf8'));
        const { createHash } = await import('node:crypto');
        derived.push({ mod, file, sourceMod, sourceFile: file, sourceHash: hashes[`mods/${sourceMod}/${file}`], contents, outputHash: createHash('sha256').update(contents).digest('hex'), asset: assetFile });
      }
    }
    const contents = readFileSync(new URL('../packages/herdr/assets/look/spaces-a-sidebar/agents-mod.json', import.meta.url), 'utf8');
    const hashes = JSON.parse(readFileSync(new URL(`../packages/herdr/src/__tests__/fixtures/herdr-${version}/source-hashes.json`, import.meta.url), 'utf8'));
    const { createHash } = await import('node:crypto');
    derived.push({ mod: 'agents', file: 'mod.json', sourceMod: 'agents', sourceFile: 'mod.json', sourceHash: hashes['mods/agents/mod.json'], contents, outputHash: createHash('sha256').update(contents).digest('hex'), asset: 'look/spaces-a-sidebar/agents-mod.json' });
  }
  const recipe = composeSpacesARecipe(version, fragments, derived);
  for (const [mod, patches] of Object.entries(recipe.mods)) for (const patch of patches) {
    if (typeof patch.replacement !== 'string' || patch.replacement.length === 0) throw new Error(`${version} ${mod}/${patch.id}: empty patch replacement`);
  }
  const { retainedMods, aFragments, ...record } = recipe;
  record.derivedFiles = derived.map(({ contents, ...entry }) => entry);
  (manifest.spacesA ??= {})[version] = record;
  console.log(`${version}: ${Object.values(retainedMods).flat().length} retained, ${Object.values(fragments).flat().length} additions, ${derived.length} derived files`);
}
const output = JSON.stringify(manifest, null, 2) + '\n';
if (check) {
  if (output !== original) throw new Error('Published Spaces A recipes differ from composed output');
  console.log('Published Spaces A recipes match composed output');
} else writeFileSync(manifestPath, output);
