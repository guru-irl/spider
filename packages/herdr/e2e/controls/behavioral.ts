import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HarnessError } from '../harness/environment.js';
import { createSuite, type Suite } from '../harness/suite.js';
import { spawnOwned } from '../harness/processes.js';
import { deadline, waitFor } from '../harness/wait.js';
import type { ScenarioDefinition } from '../harness/scenario.js';
import { packedControl, requireCaughtControl, type ControlKind, type PackedMutation } from './packed.js';

export interface ControlReport { kind: ControlKind; result: 'caught'; reason: string }
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
let invocations = 0;
async function runtimeProbe(suite: Suite, packed: string): Promise<void> {
  const directory = suite.ownPath(join(suite.root, `probe-${++invocations}`));
  await mkdir(directory, { mode: 0o700 });
  const result = await suite.invoke(process.execPath, [join(packed, 'dist/herdr/remote-runtime.mjs'), '--probe', directory]);
  if (result.exitCode !== 0) throw new Error(`runtime-probe: exit must be zero: ${result.stderr.replace(/[\r\n]/g, ' ')}`);
  const probe = JSON.parse(result.stdout) as { directory: string; mode: number };
  if (probe.directory !== directory || probe.mode !== 0o700) throw new Error('runtime-probe: wrong owned directory or mode');
}
async function helperImports(suite: Suite, packed: string): Promise<void> {
  const module = join(packed, 'packages/herdr/assets/mods/spider/data.js');
  const code = `const m=await import(${JSON.stringify(module)}); if(typeof m.projectSpiderPanel!=='function')throw new Error('missing export'); console.log('helper-loaded');`;
  const result = await suite.invoke(process.execPath, ['--input-type=module', '-e', code]);
  if (result.exitCode !== 0 || result.stdout !== 'helper-loaded\n') {
    const bounded = (text: string) => text.length > 2000 ? `${text.slice(0, 1000)}...(${text.length - 2000} characters omitted)...${text.slice(-1000)}` : text;
    throw new Error(`helper-import: actual packed helper did not load: exit=${result.signal ? 'null' : result.exitCode} signal=${result.signal ?? 'none'} stdout=${JSON.stringify(bounded(result.stdout))} stderr=${JSON.stringify(bounded(result.stderr))}`);
  }
}
async function runtimeOutcome(suite: Suite, packed: string): Promise<void> {
  const root = suite.ownPath(join(suite.root, `runtime-${++invocations}`)), program = suite.ownPath(join(root, 'job'));
  await mkdir(program, { recursive: true, mode: 0o700 });
  const nonce = randomBytes(16).toString('hex'), programNonce = randomBytes(16).toString('hex');
  const request = JSON.stringify({ version: 1, jobId: 'confidence-job', nonce, programNonce, argv: [process.execPath, '-e', "process.stdout.write('actual-out\\n');process.stderr.write('actual-err\\n');process.exit(23)"], cwd: suite.root, env: {}, files: [], releaseWindowMs: 10_000 });
  const requestFile = join(program, 'request.json');
  await writeFile(join(program, '.spider-program'), programNonce, { mode: 0o600 });
  await writeFile(requestFile, request, { mode: 0o600 }); await writeFile(requestFile + '.sha256', hash(request));
  const proc = spawnOwned(suite.ledger, { label: 'confidence-runtime', command: process.execPath, args: [join(packed, 'dist/herdr/remote-runtime.mjs'), requestFile], cwd: suite.root, env: { ...suite.env }, stdio: 'pipe' });
  proc.child.stdin!.end(); let output = '', errors = '';
  proc.child.stdout!.on('data', b => { output += b; }); proc.child.stderr!.on('data', b => { errors += b; });
  try {
    await waitFor('packed runtime real release readiness', () => output, text => text.includes(`SPIDER_HERDR_READY ${nonce}\n`), deadline(10_000));
    await writeFile(join(program, 'release.json'), JSON.stringify({ version: 1, jobId: 'confidence-job', nonce, requestSha256: hash(request) }), { mode: 0o600 });
    const exit = await proc.exited;
    const receiptText = await readFile(join(program, 'receipt.json'), 'utf8');
    const receipt = JSON.parse(receiptText) as { exitCode: number | null; signal: string | null; outcome: string; stdoutBytes: number; stderrBytes: number };
    await suite.evidence(`runtime-observation-${invocations}.json`, { exit, output, errors, receipt });
    if (exit.code !== 23 || receipt.exitCode !== 23 || receipt.signal !== null || receipt.outcome !== 'exited') throw new Error(`runtime-outcome: actual exit ${exit.code}, receipt ${JSON.stringify(receipt)}; expected exit 23 independently`);
    if (await readFile(join(program, 'stdout.log'), 'utf8') !== 'actual-out\n' || await readFile(join(program, 'stderr.log'), 'utf8') !== 'actual-err\n') throw new Error('runtime-output: separate saved streams changed');
    if (receipt.stdoutBytes !== 11 || receipt.stderrBytes !== 11 || (await readFile(join(program, 'receipt.json.sha256'), 'utf8')).trim() !== hash(receiptText)) throw new Error('runtime-publication: counts or independent digest changed');
  } finally { await proc.stop(); }
}
const artifactControls: readonly { kind: ControlKind; mutation: PackedMutation; assert(suite: Suite, packed: string): Promise<void>; failure: RegExp }[] = [
  { kind: 'missing-runtime', mutation: { operation: 'remove', file: 'dist/herdr/remote-runtime.mjs' }, assert: runtimeProbe, failure: /^runtime-probe:.*Cannot find module/ },
  { kind: 'helper-import', mutation: { operation: 'remove', file: 'packages/herdr/assets/mods/spider/data.js' }, assert: helperImports, failure: /^helper-import: actual packed helper did not load: exit=1 signal=none stdout="" stderr="(?:\\.|[^"\\])*Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module (?:\\.|[^"\\])*data\.js/ },
  { kind: 'incorrect-outcome', mutation: { operation: 'replace', file: 'dist/herdr/remote-runtime.mjs', from: '\t\t\toutcome,\n\t\t\texitCode,\n', to: '\t\t\toutcome: "exited",\n\t\t\texitCode: 0,\n' }, assert: runtimeOutcome, failure: /^runtime-outcome:/ },
];
/** CI artifacts: no hc, app, SSH, fabricated receipts or replacement loaders. */
export async function runArtifactControls(suite: Suite): Promise<ControlReport[]> {
  const results: ControlReport[] = [];
  for (const spec of artifactControls) {
    await spec.assert(suite, suite.packed.root);
    const control = packedControl({ packedRoot: suite.packed.root, destination: suite.ownPath(join(suite.root, `bad-${spec.kind}-${++invocations}`)), kind: spec.kind, mutation: spec.mutation });
    results.push(await requireCaughtControl(control, copy => spec.assert(suite, copy), spec.failure));
    await suite.evidence('artifact-controls.json', results);
  }
  return results;
}

export function matchesComposedFailure(kind: ControlKind, failure: unknown): boolean {
  if (!failure || typeof failure !== 'object') return false;
  const error = failure as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown; expected?: unknown; actual?: unknown; details?: { last?: unknown } };
  if (kind === 'wrong-transcript-path') return error.code === 'wait-deadline' && typeof error.message === 'string' && /^wait-deadline: viewer output VIEW_(?:TOOL|TRANSCRIPT_TAIL|TEXT)/.test(error.message) && typeof error.details?.last === 'string';
  if (kind === 'duplicated-notice') return error.code === 'ERR_ASSERTION' && typeof error.message === 'string' && error.message.includes('exact per-job persisted notice count') && error.expected === 1 && typeof error.actual === 'number' && error.actual > 1;
  if (kind === 'main-pane-mutation') {
    if (error.name !== 'AssertionError' || typeof error.message !== 'string' || typeof error.stack !== 'string' || !/(?:^|[\s/\\])scenarios[/\\]panes[^:\n]*\.test\.ts:/.test(error.stack)) return false;
    if (error.message.startsWith('main-pane-layout-preserved:')) return Array.isArray(error.expected) && error.expected.length > 0 && error.expected.every(pane => pane && typeof pane === 'object' && typeof pane.terminal === 'string' && typeof pane.pane === 'string') && Array.isArray(error.actual) && JSON.stringify(error.actual) !== JSON.stringify(error.expected);
    if (!error.message.startsWith('main-pane-focus-preserved:')) return false;
    const expected = error.expected, actual = error.actual;
    return Boolean(expected && typeof expected === 'object' && !Array.isArray(expected) && Object.keys(expected).length === 1 && 'agent' in expected && typeof expected.agent === 'string' && expected.agent.length > 0 && actual && typeof actual === 'object' && !Array.isArray(actual) && (!('agent' in actual) || actual.agent !== expected.agent));
  }
  return false;
}

const composedControls: readonly { kind: ControlKind; story: string; mutation: PackedMutation; failure: RegExp }[] = [
  { kind: 'wrong-transcript-path', story: 'S29', mutation: { operation: 'replace', file: 'dist/extension.js', from: 'const directory = join(resolve(root), "subagent-sessions", runId);', to: 'const directory = join(resolve(root), "wrong-subagent-sessions", runId);' }, failure: /^matching-control: wrong-transcript-path:/ },
  { kind: 'duplicated-notice', story: 'S22', mutation: { operation: 'replace', file: 'dist/extension.js', from: 'await options.notifier(notice);', to: 'await options.notifier(notice); await options.notifier(notice);' }, failure: /^matching-control: duplicated-notice:/ },
  { kind: 'main-pane-mutation', story: 'S34', mutation: { operation: 'replace', file: 'dist/extension.js', from: 'const g = group(s);\n\t\tconst operation = (displays.get(g) ?? Promise.resolve()).catch(() => {}).then(async () => {', to: 'await options.app.command("terminal.park", { terminal: s.owner.terminal.address });\n\t\tconst g = group(s);\n\t\tconst operation = (displays.get(g) ?? Promise.resolve()).catch(() => {}).then(async () => {' }, failure: /^matching-control: main-pane-mutation:/ },
];
/** Reuse the same real user-driven assertions, with only the installed package input changed. */
export async function runComposedControls(suite: Suite, definitions: readonly ScenarioDefinition[]): Promise<ControlReport[]> {
  const results: ControlReport[] = [];
  for (const spec of composedControls) {
    const definition = definitions.find(d => d.id === spec.story && d.tiers.includes('headless'));
    if (!definition) throw new HarnessError('missing-prerequisite', `confidence control ${spec.kind} needs the real ${spec.story} story`);
    const run = async (packedRoot: string) => {
      const controlSuite = await createSuite({ tier: 'headless', story: definition.id, script: definition.script ? { ...definition.script, story: definition.id } : undefined });
      let thrown: { value: unknown } | undefined;
      try {
        const settingsPath = join(controlSuite.directories.PI_CODING_AGENT_DIR, 'settings.json');
        const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { packages: string[] };
        settings.packages = settings.packages.map(p => p === controlSuite.packed.root ? packedRoot : p);
        await writeFile(settingsPath, JSON.stringify(settings));
        await definition.run({ ...controlSuite, get appConnection() { return controlSuite.appConnection; }, packed: { ...controlSuite.packed, root: packedRoot as Suite['packed']['root'], extension: join(packedRoot, 'dist/extension.js') as Suite['packed']['extension'] } });
      } catch (error) { thrown = { value: error }; }
      // Cleanup failures dominate; they cannot count as a behavior catch.
      await controlSuite.close();
      if (thrown) {
        if (matchesComposedFailure(spec.kind, thrown.value)) throw new Error(`matching-control: ${spec.kind}: ${String(thrown.value)}`);
        throw thrown.value;
      }
    };
    // A known-bad run is meaningful only if its same fresh story passes first.
    await run(suite.packed.root);
    const control = packedControl({ packedRoot: suite.packed.root, destination: suite.ownPath(join(suite.root, `bad-${spec.kind}-${++invocations}`)), kind: spec.kind, mutation: spec.mutation });
    results.push(await requireCaughtControl(control, run, spec.failure));
    await suite.evidence('composed-controls.json', results);
  }
  return results;
}
