// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [runner, output] = process.argv.slice(2);
if (!runner || !output) throw new Error('usage: node scripts/checkpoint-model-mutations.mjs single-file-runner output-directory');
const directory = resolve(output);
mkdirSync(directory, { recursive: true });
const installer = 'packages/herdr/src/setup/installer.ts';
const checkpoint = 'packages/herdr/src/setup/checkpoint.ts';
const model = 'packages/herdr/src/__tests__/setup-checkpoint-model.test.ts';
const replace = (text, before, after) => {
  if (text.split(before).length !== 2) throw new Error(`mutation anchor is not unique: ${before}`);
  return text.replace(before, after);
};
const mutations = [
  {
    name: 'setup-owned-role-templates', file: installer,
    change: text => replace(text, '  });\n}\n\nasync function ensureSessionFeedDirectory', "  }).filter(path => path.startsWith(instructions + '/'));\n}\n\nasync function ensureSessionFeedDirectory"),
    tests: [
      ['packages/herdr/src/__tests__/setup-checkpoint.test.ts', 'role-template'],
      [model, 'N1 runtime writer'],
    ],
  },
  {
    name: 'missing-layout-reference-checks', file: checkpoint,
    change: text => replace(text, '    if (!layout) return;', '    return;\n    if (!layout) return;'),
    tests: [[model, 'N3 references']],
  },
  {
    name: 'missing-store-retention', file: installer,
    change: text => text.replace(/^      runtimeStorePaths:.*$/m, '      runtimeStorePaths: [],'),
    tests: [[model, 'N3 changed store']],
  },
  {
    name: 'ordinary-edit-refusal', file: checkpoint,
    change: text => replace(text, '  const targets: SavedFile[] = checkpoint.undo?.targets ?? [];', `  if (!options.replaceChanged && (await Promise.all(baseline.map(async file => (await snapshot(file.path)).bytes?.toString().includes('"user":"keep"')))).some(Boolean)) throw new HerdrError('upgrade-checkpoint-changed', 'Ordinary edit refused');
  const targets: SavedFile[] = checkpoint.undo?.targets ?? [];`),
    tests: [[model, 'N1 minimal']],
  },
  {
    name: 'pi-writer-ignores-undo', file: 'packages/host/src/herdr/ports.ts',
    change: text => replace(text, '    await assertSetupNotUndoing(journalRoot);\n', ''),
    tests: [[model, 'N4 verified pi writer']],
  },
  {
    name: 'missing-active-checkpoint', file: checkpoint,
    change: text => replace(text, "  const resumingOwners = checkpoint.state === 'undoing'", "  throw new HerdrError('upgrade-checkpoint-missing', 'Checkpoint lost');\n  const resumingOwners = checkpoint.state === 'undoing'"),
    tests: [[model, 'N3 unchanged store']],
  },
  {
    name: 'missing-store-copy-plan', file: 'packages/herdr/src/setup/mod-storage.ts',
    change: text => replace(text, '  const after = stores(planned), files: InstallFile[] = [];', '  return [];\n  const after = stores(planned), files: InstallFile[] = [];'),
    tests: [[model, 'N3 unchanged store']],
  },
];
const results = [];
for (const mutation of mutations) {
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', mutation.file]);
  const original = execFileSync('git', ['show', `HEAD:${mutation.file}`], { encoding: 'utf8' });
  const changed = mutation.change(original);
  if (changed === original) throw new Error(`mutation did not change ${mutation.file}`);
  try {
    writeFileSync(mutation.file, changed);
    for (const [index, [file, name]] of mutation.tests.entries()) {
      const report = join(directory, `${mutation.name}-${index}.json`);
      const run = spawnSync('bash', [resolve(runner), file, '-t', name, '--reporter=json', `--outputFile=${report}`], { encoding: 'utf8' });
      writeFileSync(join(directory, `${mutation.name}-${index}.log`), `${run.stdout ?? ''}${run.stderr ?? ''}`);
      if (run.error) throw run.error;
      const result = JSON.parse(readFileSync(report, 'utf8'));
      if (run.status === 0 || !result.numFailedTests) throw new Error(`mutation survived or did not reach an assertion: ${mutation.name}`);
      results.push({ mutation: mutation.name, file, failed: result.numFailedTests, tests: result.testResults.flatMap(row => row.assertionResults.filter(test => test.status === 'failed').map(test => test.title)) });
      console.log(`${mutation.name}: caught by ${result.numFailedTests} test(s)`);
    }
  } finally {
    execFileSync('git', ['restore', '--source=HEAD', '--', mutation.file]);
  }
}
writeFileSync(join(directory, 'results.json'), JSON.stringify(results, null, 2) + '\n');
