import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestFile = join(repo, 'packages/intercom/upstream-assertions.json');
const defaultFork = join(repo, 'packages/intercom/src');
const commit = '199279ae861bf53ce014809fb2a03337538ae13e';
const installedTests = new Set([
  'broker/client-liveness.test.ts', 'broker/client.test.ts', 'broker/extension.test.ts',
  'broker/framing.test.ts', 'broker/paths.test.ts', 'broker/runtime-claim.test.ts', 'broker/spawn.test.ts',
]);
const allowedChanges = [
  { change: 'relative import extensions', reason: 'The compiled ESM bundle uses .js specifiers.' },
  { change: 'type annotations and casts', reason: 'The fork is typechecked with its host dependencies.' },
  { change: 'compiled broker and removal of tsx arguments', reason: 'The distributed broker is executable JavaScript.' },
  { change: 'default-forwarding broker connection port', reason: 'Host tests can fence broker startup without changing production connections.' },
  { change: 'test runner and isolated temporary directories', reason: 'Vitest runs the same tests without using user state.' },
  { change: 'escaped em dash in test literals', reason: 'The public source avoids non-ASCII punctuation without changing values.' },
];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

function originHashes() {
  const hashes = new Map();
  for (const line of readFileSync(join(repo, 'packages/intercom/ORIGIN.md'), 'utf8').split('\n')) {
    const cells = line.split('|').map(cell => cell.trim());
    const digest = /^`([a-f0-9]{64})`$/.exec(cells[2] ?? '')?.[1];
    if (!digest) continue;
    const source = cells[1];
    const name = source.startsWith('`') ? source.slice(1, -1) : source.includes(`/${commit}/`) ? source.split(`/${commit}/`)[1] : undefined;
    if (!name) continue;
    if (hashes.has(name) && hashes.get(name) !== digest) throw new Error(`Conflicting provenance hashes for ${name}`);
    hashes.set(name, digest);
  }
  return hashes;
}

function normalAssertion(text, name, upstream) {
  let value = text.replaceAll('\u2014', '\\u2014');
  if (upstream && name === 'broker/spawn.test.ts') {
    value = value.replaceAll('"${expectedTsxPath}" ', '')
      .replaceAll('"${getTsxCliPath("C:/repo")}" ', '')
      .replaceAll('    getTsxCliPath("C:/repo"),\n', '')
      .replaceAll('    getTsxCliPath("/repo"),\n', '');
  }
  return value;
}

function assertions(text, name, upstream) {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length) throw new Error(`Cannot parse test ${name}`);
  const cases = [], values = [];
  function visit(node, currentCase) {
    let nestedCase = currentCase;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test') {
      if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0])) throw new Error(`Nonliteral upstream test name in ${name}`);
      nestedCase = node.arguments[0].text;
      cases.push(nestedCase);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'assert') {
      const normalized = normalAssertion(printer.printNode(ts.EmitHint.Unspecified, node, source), name, upstream);
      values.push({ case: currentCase, text: normalized, sha256: sha256(normalized) });
    }
    ts.forEachChild(node, child => visit(child, nestedCase));
  }
  visit(source, null);
  return { cases, assertions: values };
}

function replaceRequired(text, from, to) {
  if (!text.includes(from)) throw new Error('an explicitly permitted adapter no longer matches');
  return text.replace(from, to);
}

function runtime(text, name, fork) {
  let normalized = text.replaceAll('\\u2014', '\u2014').replace(/(\.\.?\/[^"']+)\.ts(?=["'])/g, '$1.js');
  if (fork && name === 'index.ts') {
    normalized = replaceRequired(normalized,
      'pi: ExtensionAPI, brokerPort: IntercomBrokerPort = connect => connect()', 'pi: ExtensionAPI');
    normalized = replaceRequired(normalized, `        await brokerPort(async () => {
          await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
          await nextClient.connect(buildRegistration(), currentIntercomSessionId ?? currentSessionId!);
        });`, `        await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
        await nextClient.connect(buildRegistration(), currentIntercomSessionId ?? currentSessionId);`);
  }
  if (fork && name === 'broker/spawn.ts') {
    normalized = replaceRequired(normalized, `const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

export function getCompiledBrokerPath(): string {
  return fileURLToPath(new URL(import.meta.spiderIntercomBrokerRelative ?? "../../../../dist/intercom/broker.mjs", import.meta.url));
}`, 'const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");');
    normalized = replaceRequired(normalized,
      'return [quoteWindowsArg(getNodeCommand(nodePath)), quoteWindowsArg(brokerPath)].join(" ");',
      'return [quoteWindowsArg(getNodeCommand(nodePath)), quoteWindowsArg(getTsxCliPath(extensionDir)), quoteWindowsArg(brokerPath)].join(" ");');
    normalized = replaceRequired(normalized, 'args: [brokerPath],', 'args: [getTsxCliPath(extensionDir), brokerPath],');
    normalized = replaceRequired(normalized, 'const brokerPath = getCompiledBrokerPath();',
      'const brokerPath = join(dirname(fileURLToPath(import.meta.url)), "broker.ts");');
  }
  return ts.transpileModule(normalized, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true } }).outputText;
}

function snapshot(upstreamRoot, installedRoot) {
  const origin = originHashes(), tests = {}, sources = {};
  for (const file of walk(upstreamRoot).filter(file => file.endsWith('.ts')).sort()) {
    const name = relative(upstreamRoot, file).replaceAll('\\', '/');
    let text = readFileSync(file, 'utf8');
    const expectedHash = origin.get(name);
    if (!expectedHash || sha256(text) !== expectedHash) throw new Error(`Upstream provenance mismatch in ${name}`);
    if (name.endsWith('.test.ts')) {
      if (installedRoot && installedTests.has(name)) {
        const installed = readFileSync(join(installedRoot, name), 'utf8');
        if (sha256(installed) !== expectedHash) throw new Error(`Installed payload mismatch in ${name}`);
        text = installed;
      }
      tests[name] = { provenance: installedTests.has(name) ? 'installed-payload' : 'immutable-public-source', sourceSha256: expectedHash, ...assertions(text, name, true) };
    } else {
      sources[name] = { sourceSha256: expectedHash, normalizedSha256: sha256(runtime(text, name, false)) };
    }
  }
  if (Object.keys(tests).length !== 15 || Object.keys(sources).length !== 19) throw new Error('Expected 15 upstream test files and 19 implementation files');
  if (installedRoot) {
    const expected = origin.get('package.json');
    if (!expected || sha256(readFileSync(join(installedRoot, 'package.json'))) !== expected) throw new Error('Installed package manifest does not match ORIGIN.md');
  }
  return { version: 1, upstream: `pi-intercom@0.13.0 (${commit})`, allowedChanges, tests, sources };
}

function verify(manifest, forkRoot) {
  if (manifest.version !== 1 || JSON.stringify(manifest.allowedChanges) !== JSON.stringify(allowedChanges) ||
      Object.keys(manifest.tests ?? {}).length !== 15 || Object.keys(manifest.sources ?? {}).length !== 19) throw new Error('Invalid upstream parity manifest');
  let assertionCount = 0;
  const origin = originHashes();
  for (const [name, expected] of Object.entries(manifest.tests)) {
    if (expected.sourceSha256 !== origin.get(name) || expected.provenance !== (installedTests.has(name) ? 'installed-payload' : 'immutable-public-source')) throw new Error(`Provenance mismatch in ${name}`);
    const file = join(forkRoot, name);
    if (!existsSync(file)) throw new Error(`Missing upstream test ${name}`);
    const actual = assertions(readFileSync(file, 'utf8'), name, false);
    if (JSON.stringify(actual.cases) !== JSON.stringify(expected.cases)) throw new Error(`Test cases changed in ${name}`);
    if (!expected.assertions.length || expected.assertions.some(item => sha256(item.text) !== item.sha256)) throw new Error(`Invalid assertion manifest in ${name}`);
    if (JSON.stringify(actual.assertions) !== JSON.stringify(expected.assertions)) throw new Error(`Assertion content changed in ${name}`);
    assertionCount += expected.assertions.length;
  }
  for (const [name, expected] of Object.entries(manifest.sources)) {
    if (expected.sourceSha256 !== origin.get(name)) throw new Error(`Provenance mismatch in ${name}`);
    const file = join(forkRoot, name === 'index.ts' ? 'local.ts' : name);
    let actual;
    try { actual = sha256(runtime(readFileSync(file, 'utf8'), name, true)); }
    catch (error) { throw new Error(`Runtime mismatch in ${name}: ${error.message}`); }
    if (actual !== expected.normalizedSha256) throw new Error(`Runtime mismatch in ${name}`);
  }
  console.log(`Messaging parity verified for 19 implementation files, 15 test files and ${assertionCount} normalized assertions.`);
}

try {
  const args = process.argv.slice(2);
  const forkAt = args.indexOf('--fork-dir');
  const forkRoot = forkAt < 0 ? defaultFork : resolve(args[forkAt + 1] ?? '');
  if (forkAt >= 0) args.splice(forkAt, 2);
  const manifestAt = args.indexOf('--manifest-file');
  const inputManifest = manifestAt < 0 ? manifestFile : resolve(args[manifestAt + 1] ?? '');
  if (manifestAt >= 0) args.splice(manifestAt, 2);
  if (args[0] === '--manifest' && args.length === 1) verify(JSON.parse(readFileSync(inputManifest, 'utf8')), forkRoot);
  else if (args[0] === '--generate' && args.length === 3) {
    const result = snapshot(resolve(args[1]), resolve(args[2]));
    verify(result, forkRoot);
    writeFileSync(manifestFile, JSON.stringify(result, null, 2) + '\n');
  } else if (args.length === 1 && !args[0].startsWith('-')) verify(snapshot(resolve(args[0])), forkRoot);
  else throw new Error('Usage: check-intercom-parity.mjs --manifest [--fork-dir DIR] [--manifest-file FILE] | SOURCE_DIR | --generate SOURCE_DIR INSTALLED_DIR');
} catch (error) {
  console.error(`Intercom parity: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
