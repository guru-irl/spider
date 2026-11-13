#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, appendFileSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const storyIds = Array.from({ length: 56 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`);
export const roamStoryIds = ['R01', 'R02'];
const allStoryIds = [...storyIds, ...roamStoryIds];
const validStoryId = id => typeof id === 'string' && (allStoryIds.includes(id) || /^H-[a-z0-9-]+$/.test(id));
export const profileIds = {
  headless: [...storyIds.filter(id => id !== 'S53'), 'R01'],
  ci: ['S03', 'S04', 'S14', 'S27', 'S45', 'S46', 'S47', 'S48', 'S49', 'S51', 'S55', 'S56'],
  remote: ['H-tier2-smoke', 'S05', 'S07', ...storyIds.slice(14, 26), 'S28', 'S36', 'S45', 'S48'],
  app: [...storyIds.slice(0, 3), ...storyIds.slice(4, 13), ...storyIds.slice(14, 23), 'S25', ...storyIds.slice(25, 44).filter(id => id !== 'S27'), 'S50', 'S51', ...storyIds.slice(51, 54), 'R02'],
};
const taskIds = {
  setup: ['S04', ...storyIds.slice(4, 12), 'S14'],
  remote: storyIds.slice(14, 25), subagents: storyIds.slice(25, 33),
  status: storyIds.slice(0, 3), lifecycle: [...storyIds.slice(0, 3), 'S13', ...storyIds.slice(48, 51)],
  panels: storyIds.slice(33, 44), ssh: storyIds.slice(44, 48), runner: storyIds.slice(51), look: ['S52', 'S53'], shortcuts: ['S54'], roam: roamStoryIds,
};
export function parseOptions(argv, env = process.env) {
  const options = { tier: 'headless', ids: [], shuffle: false, seed: 'fixture', build: true, harness: false };
  const groups = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--shuffle') options.shuffle = true;
    else if (arg === '--built') options.build = false;
    else if (arg === '--harness') options.harness = true;
    else if (arg === '--help') options.help = true;
    else if (['--tier', '--story', '--task', '--seed', '--cleanup-control'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
      if (arg === '--story') options.ids.push(...value.split(','));
      else if (arg === '--task') {
        if (!taskIds[value]) throw new Error(`unknown task: ${value}`);
        groups.push(value);
      } else if (arg === '--cleanup-control') options.cleanupControl = value;
      else options[arg.slice(2)] = value;
    } else throw new Error(`unknown option: ${arg}`);
  }
  if (!['headless', 'ci', 'remote', 'app'].includes(options.tier)) throw new Error('unknown tier');
  for (const group of groups) {
    const ids = taskIds[group].filter(id => profileIds[options.tier].includes(id));
    if (!ids.length) throw new Error(`no stories in task ${group} for tier ${options.tier}`);
    options.ids.push(...ids);
  }
  for (const id of options.ids) if (!validStoryId(id)) throw new Error(`unknown story: ${id}`);
  options.ids = [...new Set(options.ids)];
  if (options.tier === 'remote') {
    if (!env.SPIDER_HERDR_REAL_MACHINE?.trim()) throw new Error('prerequisite: explicit remote machine required');
    options.machine = env.SPIDER_HERDR_REAL_MACHINE;
  }
  if (options.tier === 'app') {
    if (env.SPIDER_HERDR_APP_TESTS !== '1') throw new Error('prerequisite: native app consent required');
    if (!env.SPIDER_HERDR_TEST_DISPLAY_UUID?.trim()) throw new Error('prerequisite: owned built-in display UUID required');
    options.displayUuid = env.SPIDER_HERDR_TEST_DISPLAY_UUID;
    options.consent = true;
  }
  if (options.cleanupControl && (!['daemon', 'destination'].includes(options.cleanupControl) || options.ids.join(',') !== 'S55' || !['ci', 'headless'].includes(options.tier))) throw new Error('cleanup control requires only S55 in ci/headless and a known control phase');
  return options;
}
export function cleanupEntry(checkout) {
  return { module: path.join(checkout, 'packages/herdr/e2e/harness/resources.ts'), ledgers: path.join(checkout, '.spider/scratch/e2/_ledgers') };
}
export function scenarioExports(module, filename) {
  if ('default' in module || 'scenario' in module || !Array.isArray(module.scenarios)) throw new Error(`${filename}: expected named scenarios array, no scenario or default export`);
  for (const definition of module.scenarios) if (typeof definition?.run !== 'function') throw new Error(`${filename}: scenario run must be a function`);
  return module.scenarios;
}
export async function discoverScenarios(loaders) {
  const reserved = new Set(['runner-contract.test.ts', 'runner-stories.test.ts']);
  const files = Object.entries(loaders).filter(([filename]) => !reserved.has(path.basename(filename))).sort(([a], [b]) => a.localeCompare(b));
  const definitions = [];
  for (const [filename, load] of files) definitions.push(...scenarioExports(await load(), filename));
  return definitions;
}
export function selectScenarios(definitions, options) {
  const seen = new Set();
  for (const def of definitions) {
    if (!validStoryId(def.id) || !def.title || !Array.isArray(def.tiers)) throw new Error('malformed scenario definition');
    if (seen.has(def.id)) throw new Error(`duplicate scenario: ${def.id}`);
    seen.add(def.id);
  }
  if (options.ids.length) for (const id of options.ids) {
    const def = definitions.find(x => x.id === id);
    if (!def) throw new Error(`missing selected story: ${id}`);
    if (!def.tiers.includes(options.tier)) throw new Error(`selected story ${id} unavailable in tier ${options.tier}`);
  }
  let selected = definitions.filter(x => x.tiers.includes(options.tier) && (!options.ids.length || options.ids.includes(x.id)));
  selected = selected.sort((a, b) => a.id.localeCompare(b.id));
  if (options.shuffle) selected.sort((a, b) => createHash('sha256').update(`${options.seed}:${a.id}`).digest('hex').localeCompare(createHash('sha256').update(`${options.seed}:${b.id}`).digest('hex')));
  return selected;
}
export function buildMatrix(tier, selected, reports) {
  const seen = new Set();
  for (const report of reports) {
    if (!validStoryId(report.id)) throw new Error('invalid report story');
    if (seen.has(report.id)) throw new Error(`duplicate report: ${report.id}`);
    if (report.tier !== tier) throw new Error('wrong report tier');
    if (!['passed', 'failed', 'blocked', 'not exercised'].includes(report.result)) throw new Error('invalid report result');
    if (typeof report.evidence !== 'string' || !report.evidence) throw new Error('missing report evidence');
    seen.add(report.id);
  }
  const harnessIds = [...new Set([...selected, ...reports.map(x => x.id)].filter(id => id.startsWith('H-')))].sort();
  return [...allStoryIds, ...harnessIds].map(id => {
    const report = reports.find(x => x.id === id) ?? {
      id, tier, result: selected.includes(id) ? 'failed' : 'not exercised', evidence: 'invocation.json',
      reason: selected.includes(id) ? 'selected story produced no result (worker failed or interrupted)' : 'outside selected profile or no discovered implementation',
    };
    if (id !== 'R02' || report.result !== 'passed') return report;
    const limit = 'Placement adapter only with synthetic readiness; packaged observer-to-placement path deferred to Task 3.4';
    return { ...report, reason: [report.reason, limit].filter(Boolean).join('; ') };
  });
}
export function complete(matrix, selected) {
  return selected.length > 0 && selected.every(id => matrix.find(x => x.id === id)?.result === 'passed');
}
export function renderMatrix(matrix) {
  const cell = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
  const table = rows => ['| Story | Tier | Result | Evidence | Reason / coverage limit |', '| --- | --- | --- | --- | --- |', ...rows.map(x => `| ${x.id} | ${x.tier} | ${x.result} | ${cell(x.evidence)} | ${cell(x.reason)} |`)].join('\n') + '\n';
  const harness = matrix.filter(row => row.id.startsWith('H-'));
  return table(matrix.filter(row => !row.id.startsWith('H-'))) + (harness.length ? '\n## Harness stories\n\n' + table(harness) : '');
}
export function runnerEnvironment(host, root) {
  const env = {};
  for (const key of ['PATH', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (host[key]) env[key] = host[key];
  return Object.assign(env, { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'), XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_STATE_HOME: path.join(root, 'xdg-state'), npm_config_cache: path.join(root, 'npm-cache'), npm_config_logs_dir: path.join(root, 'npm-logs') });
}
function ownedDirectory(checkout, candidate) {
  const scratch = path.join(checkout, '.spider', 'scratch');
  for (const part of ['.spider', '.spider/scratch']) {
    const p = path.join(checkout, part);
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error(`symlink scratch: ${part}`);
    mkdirSync(p, { recursive: true, mode: 0o700 });
  }
  if (!candidate.startsWith(scratch + path.sep)) throw new Error('runner root outside scratch');
  const parent = path.dirname(candidate);
  if (existsSync(parent) && (lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== parent)) throw new Error('symlink runner parent');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  mkdirSync(candidate, { mode: 0o700 });
  if (realpathSync(candidate) !== candidate || lstatSync(candidate).uid !== process.getuid?.()) throw new Error('unowned runner root');
}
export function storyWorkerEnvironment(fenced, caller, tier) {
  return { ...fenced, ...(tier === 'remote' && caller.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: caller.SSH_AUTH_SOCK } : {}), ...(caller.SPIDER_HERDR_E2E_HC ? { SPIDER_HERDR_E2E_HC: caller.SPIDER_HERDR_E2E_HC } : {}) };
}
export function storyWorkers(options) {
  return options.tier === 'app' || options.ids.some(id => roamStoryIds.includes(id)) ? 1 : 2;
}
export function storyTimeoutMs(id) {
  // S08 compares two fresh thirteen-session installations, not one cutover.
  return id === 'S08' ? 600_000 : 300_000;
}
export function storyRunBudgetMs(options) {
  return 60_000 + options.ids.reduce((total, id) => total + storyTimeoutMs(id), 0) + (options.harness ? 10 * 60_000 : 0);
}
function command(executable, argv, cwd, env, log, quiet = false, supervisor, timeoutMs = 10 * 60_000) {
  return new Promise((resolve, reject) => {
    writeFileSync(log, '');
    const child = spawn(executable, argv, { cwd, env, detached: Boolean(supervisor), timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid && supervisor) {
      try { supervisor.ledger.update(l => l.processes.push({ ...supervisor.identityOf(child.pid), label: path.basename(executable), group: true })); }
      catch (error) { child.kill('SIGKILL'); reject(error); }
    }
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; appendFileSync(log, data); if (!quiet) process.stdout.write(data); });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, output }));
  });
}
export async function packEntryDigests(checkout, root, pack) {
  const result = await pack();
  if (result.code !== 0) throw new Error('pack failed');
  // npm 10 may rebuild dist during pack even with --ignore-scripts. Snapshot
  // the checkout as packed, including the new build id, not its pre-pack state.
  const entries = ['extension.js', 'herdr/cli.mjs', 'herdr/viewer.mjs', 'herdr/feed-reader.mjs', 'herdr/remote-runtime.mjs', 'herdr/viewer-pi.mjs', 'herdr/subagent-supervisor.mjs', 'roam/cli.mjs', 'roam/supervisor.mjs'];
  const digests = Object.fromEntries(entries.map(entry => [entry, createHash('sha256').update(readFileSync(path.join(checkout, 'dist', entry))).digest('hex')]));
  writeFileSync(path.join(root, 'entries.json'), JSON.stringify(digests, null, 2));
  return { entries, digests };
}
export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) { console.log('herdr-e2e --tier headless|ci|remote|app [--story S52,R01] [--task setup|remote|subagents|lifecycle|panels|ssh|runner|roam] [--shuffle --seed value] [--built] [--harness]'); return 0; }
  if (!options.ids.length) options.ids = profileIds[options.tier];
  const checkout = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const root = path.join(checkout, '.spider/scratch/e2', randomBytes(3).toString('hex'));
  ownedDirectory(checkout, root);
  for (const directory of ['tmp', 'home', 'xdg-config', 'xdg-state']) mkdirSync(path.join(root, directory), { mode: 0o700 });
  mkdirSync(path.join(root, 'stories'), { mode: 0o700 });
  const started = Date.now();
  // Tool credentials and HC ownership are not inherited by fixture processes.
  const env = runnerEnvironment(process.env, root);
  Object.assign(env, { TMPDIR: path.join(root, 'tmp'), SPIDER_HERDR_E2E_RUN_ROOT: root, SPIDER_HERDR_E2E_OPTIONS: JSON.stringify(options), SPIDER_TEST_FIXTURE_CHECKOUT: checkout, npm_config_cache: path.join(root, 'npm-cache'), npm_config_logs_dir: path.join(root, 'npm-logs') });
  if (options.tier === 'app') Object.assign(env, { SPIDER_HERDR_APP_TESTS: '1', SPIDER_HERDR_TEST_DISPLAY_UUID: options.displayUuid });
  if (options.tier === 'remote') env.SPIDER_HERDR_REAL_MACHINE = options.machine;
  if (process.env.SPIDER_HERDR_E2E_HC) env.SPIDER_HERDR_E2E_HC = process.env.SPIDER_HERDR_E2E_HC;
  writeFileSync(path.join(root, 'invocation.json'), JSON.stringify({ version: 1, options, startedAt: started }, null, 2));
  let selected = options.ids;
  let exit = 1;
  let runSucceeded = false;
  let runnerFailure;
  let cleanupFailed = false;
  // A SIGKILL cannot write a final report. Persist the selected failures first.
  const interrupted = buildMatrix(options.tier, selected, []);
  writeFileSync(path.join(root, 'matrix.json'), JSON.stringify(interrupted, null, 2));
  writeFileSync(path.join(root, 'matrix.md'), renderMatrix(interrupted));
  const entry = cleanupEntry(checkout);
  const resources = await import(pathToFileURL(entry.module).href);
  const recovery = await command(process.execPath, [entry.module, 'reconcile', entry.ledgers], checkout, env, path.join(root, 'startup-reconciliation.json'), true);
  if (recovery.code !== 0) throw new Error('startup cleanup reconciliation failed');
  const ledger = resources.openLedger(entry.ledgers, root);
  const watchdog = resources.startWatchdog(ledger, Date.now() + storyRunBudgetMs(options) + 20 * 60_000, path.join(entry.ledgers, `${ledger.id}.watchdog.log`));
  const supervisor = { ledger, identityOf: resources.identityOf };
  writeFileSync(path.join(root, 'runner-ledger.json'), JSON.stringify({ ledgerPath: ledger.path, cleanupProofPath: ledger.path.replace(/\.json$/, '.cleanup.json'), watchdog: watchdog.identity }, null, 2));
  try {
    if (options.build) {
      const build = await command('npm', ['run', 'build'], checkout, env, path.join(root, 'build.log'), false, supervisor);
      if (build.code !== 0) throw new Error('build failed');
    }
    Object.assign(env, { npm_config_cache: path.join(root, 'npm-cache'), npm_config_logs_dir: path.join(root, 'npm-logs') });
    const { entries, digests } = await packEntryDigests(checkout, root, () => command('npm', ['pack', '--json', '--ignore-scripts', '--foreground-scripts=false', '--pack-destination', root], checkout, env, path.join(root, 'pack.log'), false, supervisor));
    // npm output may include prepare diagnostics; use the actual owned tarball,
    // not an untrusted filename obtained from mixed stdout and stderr.
    const tarballs = readdirSync(root).filter(name => name.endsWith('.tgz'));
    if (tarballs.length !== 1) throw new Error('pack must produce exactly one tarball');
    const tarball = path.join(root, tarballs[0]);
    const listing = await command('tar', ['-tzf', tarball], checkout, env, path.join(root, 'tar-list.log'), true, supervisor);
    if (listing.code !== 0 || listing.output.trim().split('\n').some(name => !name.startsWith('package/') || name.split('/').includes('..'))) throw new Error('unsafe package paths');
    const metadata = await command('tar', ['-tvzf', tarball], checkout, env, path.join(root, 'tar-metadata.log'), true, supervisor);
    if (metadata.code !== 0 || metadata.output.trim().split('\n').some(line => !['-', 'd'].includes(line[0]))) throw new Error('package links or unsupported entries');
    const unpack = path.join(root, 'packed');
    mkdirSync(unpack, { mode: 0o700 });
    const extract = await command('tar', ['-xzf', tarball, '-C', unpack], checkout, env, path.join(root, 'extract.log'), false, supervisor);
    if (extract.code !== 0) throw new Error('package extraction failed');
    const packedRoot = path.join(unpack, 'package');
    for (const entry of entries) {
      const file = path.join(packedRoot, 'dist', entry);
      if (realpathSync(file) !== file || !lstatSync(file).isFile() || createHash('sha256').update(readFileSync(file)).digest('hex') !== digests[entry]) throw new Error(`packed entry mismatch: ${entry}`);
    }
    env.SPIDER_HERDR_E2E_PACKED_ROOT = packedRoot;
    env.SPIDER_HERDR_E2E_TIER = options.tier;
    env.SPIDER_HERDR_E2E_STORIES = options.ids.join(',');
    const run = await command(process.execPath, [path.join(checkout, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'packages/herdr/e2e/vitest.config.ts', '--maxWorkers', String(storyWorkers(options))], checkout, storyWorkerEnvironment(env, process.env, options.tier), path.join(root, 'vitest.log'), false, supervisor, storyRunBudgetMs(options));
    const selectionPath = path.join(root, 'selection.json');
    if (existsSync(selectionPath)) selected = JSON.parse(readFileSync(selectionPath, 'utf8'));
    runSucceeded = run.code === 0;
  } catch (error) {
    writeFileSync(path.join(root, 'runner-error.txt'), String(error.stack ?? error));
    runnerFailure = String(error.message ?? error);
    console.error(error.message);
  } finally {
    try {
      const proof = await resources.cleanupLedger(ledger.path, 'runner-close');
      const reconcile = await command(process.execPath, [entry.module, 'reconcile', entry.ledgers], checkout, env, path.join(root, 'final-reconciliation.json'), true);
      cleanupFailed = !proof.clean || reconcile.code !== 0;
    } catch (error) { cleanupFailed = true; writeFileSync(path.join(root, 'cleanup-error.txt'), String(error.stack ?? error)); }
    watchdog.release();
  }
  const reports = readdirSync(path.join(root, 'stories')).filter(x => x.endsWith('.json')).map(x => JSON.parse(readFileSync(path.join(root, 'stories', x), 'utf8')));
  const matrix = buildMatrix(options.tier, selected, reports);
  if (cleanupFailed) for (const row of matrix) if (selected.includes(row.id)) { row.result = 'failed'; row.reason = 'runner cleanup unproved; see runner-ledger.json and final-reconciliation.json'; }
  exit = runSucceeded && !runnerFailure && !cleanupFailed && complete(matrix, selected) ? 0 : 1;
  writeFileSync(path.join(root, 'matrix.json'), JSON.stringify(matrix, null, 2));
  const duration = exit === 0 ? `Complete successful ${options.tier} run: ${((Date.now() - started) / 1000).toFixed(1)} seconds.\n\n` : '';
  writeFileSync(path.join(root, 'matrix.md'), duration + renderMatrix(matrix));
  console.log(`Herdr e2e report: ${path.relative(checkout, root)}/matrix.md`);
  return exit;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
