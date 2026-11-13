import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import ts from 'typescript';
const root = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: node scripts/check-intercom-parity.mjs <recovered-source-directory>');
const destination = resolve('packages/intercom/src');
function walk(directory) { return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]); }
function runtime(text) {
  const normalized = text.replaceAll('\\u2014', '\u2014').replace(/(\.\.?\/[^"']+)\.ts(?=["'])/g, '$1.js')
    .replace('pi: ExtensionAPI, brokerPort: IntercomBrokerPort = connect => connect()', 'pi: ExtensionAPI')
    .replace(`        await brokerPort(async () => {
          await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
          await nextClient.connect(buildRegistration(), currentIntercomSessionId ?? currentSessionId!);
        });`, `        await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
        await nextClient.connect(buildRegistration(), currentIntercomSessionId ?? currentSessionId);`);
  return ts.transpileModule(normalized, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true } }).outputText;
}
let protectedFiles = 0, testFiles = 0, assertions = 0;
for (const file of walk(root).filter(file => file.endsWith('.ts'))) {
  const name = relative(root, file).replaceAll('\\', '/');
  const original = readFileSync(file, 'utf8');
  const adopted = readFileSync(join(destination, name === 'index.ts' ? 'local.ts' : name), 'utf8');
  if (name.endsWith('.test.ts')) {
    const count = text => (text.match(/\bassert\.(?:equal|notEqual|deepEqual|notDeepEqual|ok|match|doesNotMatch|throws|rejects|doesNotThrow|doesNotReject)\(/g) ?? []).length;
    if (count(original) !== count(adopted)) throw new Error(`Upstream assertion inventory changed in ${name}`);
    const cases = text => (text.match(/^test\(/gm) ?? []).length;
    if (cases(original) !== cases(adopted)) throw new Error(`Upstream test inventory changed in ${name}`);
    testFiles++; assertions += count(original);
  } else if (name !== 'broker/spawn.ts') {
    if (runtime(original) !== runtime(adopted)) throw new Error(`Messaging implementation changed in ${name}`);
    protectedFiles++;
  }
}
if (testFiles !== 15) throw new Error(`Expected all 15 upstream test files, found ${testFiles}`);
console.log(`Messaging parity verified for ${protectedFiles} files. Retained ${testFiles} test files and ${assertions} upstream assertions. Only compiled broker spawning and the exact default-forwarding connection-port wrapper differ.`);
