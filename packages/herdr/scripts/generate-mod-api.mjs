// SPDX-License-Identifier: MIT
import { pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

export function generateModApi(herdr, gpui) {
  const sources = new Map([['/herdr.d.ts', herdr], ['/gpui-kit.d.ts', gpui]].map(([name, text]) =>
    [name, ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)]));
  for (const source of sources.values()) {
    if (source.parseDiagnostics.length) throw new Error('Invalid declaration input');
  }
  // All input is supplied by the caller; do not resolve user files or declaration references.
  const program = ts.createProgram([...sources.keys()], { noLib: true }, {
    getSourceFile: name => sources.get(name), getDefaultLibFileName: () => '',
    writeFile() {}, getCurrentDirectory: () => '/', getDirectories: () => [],
    fileExists: name => sources.has(name), readFile: name => sources.get(name)?.text,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  });
  const checker = program.getTypeChecker();
  const modules = {}, elements = {};
  const inspect = (name, symbol) => {
    if (!symbol) throw new Error(`Missing module ${name}`);
    const exports = checker.getExportsOfModule(symbol);
    modules[name] = exports.filter(s => {
      const value = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
      return Boolean(value.flags & ts.SymbolFlags.Value);
    }).map(s => s.name).sort();
    for (const symbol of exports) {
      if (!symbol.name.endsWith('Element') || !(symbol.flags & ts.SymbolFlags.Interface)) continue;
      const methods = checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))
        .filter(s => s.flags & ts.SymbolFlags.Method).map(s => s.name).sort();
      elements[`${name}.${symbol.name}`] = methods;
    }
  };
  inspect('herdr', checker.getSymbolAtLocation(sources.get('/herdr.d.ts')));
  for (const node of sources.get('/gpui-kit.d.ts').statements) {
    if (ts.isModuleDeclaration(node) && node.name.text.startsWith('gpui')) inspect(node.name.text, checker.getSymbolAtLocation(node.name));
  }
  const sorted = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b, 'en')));
  return { modules: sorted(modules), elements: sorted(elements) };
}
export function assertApiMatches(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Mod API fixture drift: regenerate from the supplied declarations');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [herdrPath, gpuiPath, fixturePath, flag] = process.argv.slice(2);
  if (!herdrPath || !gpuiPath || !fixturePath || (flag && flag !== '--check')) {
    throw new Error('Usage: node generate-mod-api.mjs <herdr.d.ts> <gpui-kit.d.ts> <fixture.json> [--check]');
  }
  const api = generateModApi(await readFile(herdrPath, 'utf8'), await readFile(gpuiPath, 'utf8'));
  if (flag) {
    assertApiMatches(api, JSON.parse(await readFile(fixturePath, 'utf8')));
    console.log('Mod API fixture matches');
  } else {
    await writeFile(fixturePath, JSON.stringify(api, null, 2) + '\n');
  }
}
