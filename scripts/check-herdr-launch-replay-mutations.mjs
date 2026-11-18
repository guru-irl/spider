// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Run in an idle worktree. The runner must accept a test file followed by Vitest arguments.
// Usage: node scripts/check-herdr-launch-replay-mutations.mjs --runner <runner.sh> --output <scratch-directory>
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--runner' || args[2] !== '--output' || !existsSync(args[1])) {
  throw new Error('Pass --runner with a single-file test runner and --output with an artifact directory');
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runner = resolve(args[1]);
const relativeSource = 'packages/herdr/src/sessions/launch-environment.ts';
const source = join(root, relativeSource);
const test = 'packages/herdr/src/__tests__/launch-environment.test.ts';
const scratch = resolve(root, args[3]);
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const lock = join(scratch, 'mutation.lock');
const descriptor = openSync(lock, 'wx', 0o600);
closeSync(descriptor);
const original = readFileSync(source, 'utf8');
let written = original;
const digest = value => createHash('sha256').update(value).digest('hex');
const mutations = [
  { name: 'drop-denylist', find: '.filter(([name]) => !currentLaunchVariable(name))', replace: '', test: 'keeps current terminal' },
  { name: 'replay-model', find: "'--provider', '--model', '--thinking'", replace: "'--provider', '--thinking'", test: 'resume restores launch variables' },
  { name: 'replay-prompts', find: "if (!argument.startsWith('-')) continue;", replace: "if (!argument.startsWith('-')) { args.push(argument); continue; }", test: 'never replays positional prompts' },
  { name: 'print-value', find: 'export function replayLaunchVariables(current: Readonly<NodeJS.ProcessEnv>, launch: RecordedLaunch): NodeJS.ProcessEnv {', replace: 'export function replayLaunchVariables(current: Readonly<NodeJS.ProcessEnv>, launch: RecordedLaunch): NodeJS.ProcessEnv {\n  console.error(launch.variables.API_TOKEN);', test: 'never exposes recorded variable values' },
];
const results = [];
function run(name, pattern) {
  if (loadavg()[0] >= 40) throw new Error('INCONCLUSIVE: load is at least 40');
  const result = spawnSync('bash', [runner, test, ...(pattern ? ['-t', pattern] : [])], {
    cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' }, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const log = /Full test log: ([^\r\n]+)/.exec(output)?.[1];
  const detail = log && existsSync(log) ? readFileSync(log, 'utf8') : output;
  writeFileSync(join(scratch, `${name}.log`), output, { mode: 0o600 });
  if (result.error || result.signal || !/Test Files\s+1 (?:passed|failed)/.test(detail)) throw new Error(`INCONCLUSIVE: ${name} did not finish its test file`);
  return { name, exitCode: result.status, log, detail };
}
try {
  for (const command of [['ls-files', '--error-unmatch', relativeSource], ['diff', '--exit-code', 'HEAD', '--', relativeSource]]) {
    const result = spawnSync('git', command, { cwd: root, stdio: 'ignore' });
    if (result.status !== 0) throw new Error('Commit the launch replay implementation before running mutations');
  }
  writeFileSync(join(scratch, 'original.ts'), original, { mode: 0o600 });
  const baseline = run('baseline');
  if (baseline.exitCode !== 0) throw new Error('Baseline is not green; no mutations were applied');
  console.log('baseline: passed');
  for (const mutation of mutations) {
    if (readFileSync(source, 'utf8') !== original) throw new Error('Source changed outside this mutation run');
    if (original.split(mutation.find).length !== 2) throw new Error(`Mutation anchor is missing or ambiguous: ${mutation.name}`);
    written = original.replace(mutation.find, mutation.replace);
    writeFileSync(source, written);
    let result;
    try { result = run(mutation.name, mutation.test); }
    finally {
      if (readFileSync(source, 'utf8') !== written) throw new Error('Source changed outside this mutation run; original retained in scratch');
      writeFileSync(source, original); written = original;
    }
    const killed = result.exitCode !== 0 && /Tests\s+[1-9]\d* failed/.test(result.detail) && result.detail.includes(mutation.test);
    results.push({ name: mutation.name, killed, exitCode: result.exitCode, log: result.log });
    console.log(`${mutation.name}: ${killed ? 'caught' : 'SURVIVED'}`);
    if (!killed) throw new Error(`Mutation survived or failed for another reason: ${mutation.name}`);
  }
  console.log(`source restored: ${digest(original)}`);
} finally {
  if (written !== original && readFileSync(source, 'utf8') === written) writeFileSync(source, original);
  writeFileSync(join(scratch, 'results.json'), JSON.stringify({ sha256: digest(original), results }, null, 2) + '\n', { mode: 0o600 });
  unlinkSync(lock);
}
