import { existsSync, lstatSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { paths } from '@spider/db-core';
// The runner is also importable; importing it must not launch a suite.
// @ts-ignore JavaScript runner boundary is exercised at runtime.
import { parseOptions, selectScenarios, buildMatrix, complete, renderMatrix, scenarioExports, runnerEnvironment, discoverScenarios, cleanupEntry, storyRunBudgetMs, profileIds, storyWorkerEnvironment, storyWorkers, command, finishCleanup, runStoryWork, storyExecutionDeadline, runnerCleanupDeadline } from '../../../../scripts/herdr-e2e.mjs';
import { runHc, verifyHcBinaryPin } from '../harness/hc.js';
import { storyId } from '../harness/scenario.js';
import { restorationPending, presentationInProgress } from './roam-recovery.test.js';
import { effectJsonLines, moveRecoveryPending } from './roam-move.test.js';
import { coldCliStartup } from './roam-intercom.test.js';

vi.mock('../harness/scenario.js', async importOriginal => ({
  ...await importOriginal<typeof import('../harness/scenario.js')>(), registerScenarios: () => {},
}));
describe('controllable intercom clock', () => {
  it('can be imported without starting a machine service', async () => {
    // @ts-ignore The same ESM adapter is loaded by the fixture processes.
    await expect(import('../fixtures/roam-hub-clock.mjs')).resolves.toHaveProperty('createFixtureClock', expect.any(Function));
  });
  it('expires a passive route without waiting in wall time and retains its offset', async () => {
    // @ts-ignore The same ESM adapter is loaded by the fixture processes.
    const { createFixtureClock } = await import('../fixtures/roam-hub-clock.mjs');
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const controlled = createFixtureClock(2_000);
    try {
      const expired: number[] = [];
      controlled.clock.later(35_000, () => expired.push(controlled.clock.now()));
      controlled.advance(34_999);
      await vi.advanceTimersByTimeAsync(0);
      expect(expired).toEqual([]);
      const advanced = controlled.advance(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(expired).toEqual([38_000]);
      expect(advanced.offset).toBe(37_000);
      const restarted = createFixtureClock(advanced.offset);
      try { expect(restarted.clock.now()).toBe(38_000); } finally { restarted.close(); }
    } finally { controlled.close(); vi.useRealTimers(); }
  });
  it('stops clock requests before service shutdown without cancelling its pending work', async () => {
    // @ts-ignore The same ESM adapter is loaded by the fixture processes.
    const { serveFixtureClock } = await import('../fixtures/roam-hub-clock.mjs');
    const root = mkdtempSync(resolve(paths.scratch('worktree', process.cwd()), 'clock-stop-'));
    const socket = resolve(root, 'c.sock');
    const controlled = await serveFixtureClock(socket);
    vi.useFakeTimers();
    try {
      let finished = false;
      controlled.clock.later(100, () => { finished = true; });
      controlled.stopAccepting();
      expect(existsSync(socket)).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(finished).toBe(true);
    } finally { controlled.close(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); }
  });
  it('does not resurrect cancelled timers when advancing or closing', async () => {
    // @ts-ignore The same ESM adapter is loaded by the fixture processes.
    const { createFixtureClock } = await import('../fixtures/roam-hub-clock.mjs');
    vi.useFakeTimers();
    const controlled = createFixtureClock();
    try {
      const fired: string[] = [];
      const cancel = controlled.clock.later(35_000, () => fired.push('cancelled'));
      cancel();
      controlled.advance(35_000);
      controlled.clock.later(1, () => fired.push('closed'));
      controlled.close();
      await vi.runAllTimersAsync();
      expect(fired).toEqual([]);
    } finally { controlled.close(); vi.useRealTimers(); }
  });
});

describe('final runner cleanup budget', () => {
  it('bounds cleanup and reconciliation by one absolute deadline', async () => {
    const root = mkdtempSync(resolve(paths.scratch('worktree', process.cwd()), 'cleanup-budget-'));
    try {
      const module = resolve(root, 'resources.mjs');
      writeFileSync(module, `import {writeFileSync} from 'node:fs';
        export async function cleanupLedger() { await new Promise(ok => setTimeout(ok, 100)); writeFileSync(${JSON.stringify(resolve(root, 'cleaned'))}, 'yes'); return {clean:true}; }
        export async function reconcileLedgers() { writeFileSync(${JSON.stringify(resolve(root, 'reconciling'))}, 'yes'); await new Promise(ok => setTimeout(ok, 5000)); return []; }`);
      const at = Date.now() + 500;
      await expect(finishCleanup({ module, ledgers: root }, resolve(root, 'ledger.json'), process.cwd(), process.env, root,
        { at, expire() {} })).rejects.toThrow('runner-deadline');
      expect(existsSync(resolve(root, 'cleaned'))).toBe(true);
      expect(existsSync(resolve(root, 'reconciling'))).toBe(true);
      expect(JSON.parse(readFileSync(resolve(root, 'cleanup-deadline.json'), 'utf8'))).toEqual({ reason: 'cleanup-deadline', deadlineAt: at });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([true, false])('retains the cleanup proof when reconciliation succeeds: %s', async clean => {
    const root = mkdtempSync(resolve(paths.scratch('worktree', process.cwd()), 'cleanup-proof-'));
    try {
      const module = resolve(root, 'resources.mjs');
      writeFileSync(module, `export async function cleanupLedger() { return {clean:${clean}}; } export async function reconcileLedgers() { return []; }`);
      expect(await finishCleanup({ module, ledgers: root }, resolve(root, 'ledger.json'), process.cwd(), process.env, root,
        { at: Date.now() + 2000, expire() {} })).toBe(clean);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('story cleanup reserve', () => {
  it('gives runner reconciliation only the remaining cleanup reserve', () => {
    expect(runnerCleanupDeadline({ at: 1_000 }, 3_000)).toBe(11_000);
    expect(runnerCleanupDeadline({ at: 1_000 }, 500)).toBe(10_500);
    expect(runnerCleanupDeadline(undefined, 500)).toBe(10_500);
  });

  it('marks work only after it finishes, including a failed story', async () => {
    const root = mkdtempSync(resolve('.spider/scratch/work-complete-'));
    try {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const work = runStoryWork(root, 'R17', () => gate);
      const overall = { at: Date.now() + 10_000, expire() {} };
      const deadline = storyExecutionDeadline(overall, root, { ids: ['R17'], harness: false });
      expect(deadline.cleanupReady()).toBe(false);
      release(); await work;
      expect(deadline.cleanupReady()).toBe(true);
      await expect(runStoryWork(root, 'R18', async () => { throw new Error('story failed'); })).rejects.toThrow('story failed');
      expect(storyExecutionDeadline(overall, root, { ids: ['R17', 'R18'], harness: false }).cleanupReady()).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('finishes already-started cleanup in the existing reserve without expiring work', async () => {
    const root = mkdtempSync(resolve('.spider/scratch/work-complete-'));
    try {
      await runStoryWork(root, 'R17', async () => {});
      const expired: string[] = [], at = Date.now() + 400;
      const deadline = storyExecutionDeadline({ at, expire: () => { expired.push('work'); } }, root, { ids: ['R17'], harness: false });
      expect(deadline.cleanupAt).toBe(at + 5_000);
      const result = await command(process.execPath, ['-e', 'setTimeout(() => console.log("clean"), 650)'], process.cwd(), process.env, resolve(root, 'log'), true, undefined, 60_000, deadline);
      expect(result.code).toBe(0);
      expect(result.output).toContain('clean');
      expect(expired).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reconciles and writes a proof after suite cleanup hangs', async () => {
    const root = mkdtempSync(resolve('.spider/scratch/work-complete-'));
    try {
      await runStoryWork(root, 'R17', async () => {});
      const module = resolve(root, 'resources.mjs');
      writeFileSync(module, `export async function cleanupLedger() { return {clean:true}; } export async function reconcileLedgers() { return [{clean:true}]; }`);
      const overall = { at: Date.now() + 250, expire() {} };
      const deadline = storyExecutionDeadline(overall, root, { ids: ['R17'], harness: false });
      await expect(command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.cwd(), process.env, resolve(root, 'log'), true, undefined, 60_000, deadline)).rejects.toThrow('runner-deadline');
      expect(await finishCleanup({ module, ledgers: root }, resolve(root, 'ledger.json'), process.cwd(), process.env, root,
        { at: runnerCleanupDeadline(overall), expire() {} })).toBe(true);
      expect(JSON.parse(readFileSync(resolve(root, 'final-reconciliation.json'), 'utf8'))).toEqual({ proof: { clean: true }, reconciled: [{ clean: true }] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 16_000);

  it('kills work if any selected story has not finished by the work deadline', async () => {
    const root = mkdtempSync(resolve('.spider/scratch/work-complete-'));
    try {
      await runStoryWork(root, 'R17', async () => {});
      const expired: string[] = [], at = Date.now() + 350;
      const deadline = storyExecutionDeadline({ at, expire: () => { expired.push('work'); } }, root, { ids: ['R17', 'R18'], harness: false });
      await expect(command(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], process.cwd(), process.env, resolve(root, 'log'), true, undefined, 60_000, deadline)).rejects.toThrow('runner-deadline');
      expect(expired).toEqual(['work']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects late markers and never grants harness work the story cleanup reserve', async () => {
    const root = mkdtempSync(resolve('.spider/scratch/work-complete-'));
    try {
      await runStoryWork(root, 'R17', async () => {});
      const finishedAt = JSON.parse(readFileSync(resolve(root, 'work-complete/R17.json'), 'utf8')).finishedAt as number;
      const overall = { at: finishedAt - 1, expire() {} };
      expect(storyExecutionDeadline(overall, root, { ids: ['R17'], harness: false }).cleanupReady()).toBe(false);
      expect(storyExecutionDeadline(overall, root, { ids: ['R17'], harness: true })).toBe(overall);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects a marker written late with a misleading completion timestamp', async () => {
    const root = mkdtempSync(resolve('.spider/scratch/work-complete-'));
    try {
      await runStoryWork(root, 'R17', async () => {});
      const file = resolve(root, 'work-complete/R17.json');
      const at = Math.floor(lstatSync(file).mtimeMs) - 1;
      writeFileSync(file, JSON.stringify({ id: 'R17', finishedAt: at - 1 }));
      expect(storyExecutionDeadline({ at, expire() {} }, root, { ids: ['R17'], harness: false }).cleanupReady()).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('stops cleanup at its shared ceiling instead of granting a second reserve', async () => {
    const root = mkdtempSync(resolve('.spider/scratch/work-complete-'));
    try {
      await runStoryWork(root, 'R17', async () => {});
      const expired: string[] = [], at = Date.now() + 300;
      const deadline = storyExecutionDeadline({ at, expire: () => { expired.push('deadline'); } }, root, { ids: ['R17'], harness: false });
      deadline.cleanupAt = at + 300; // Accelerate the clock boundary in this unit test only.
      await expect(command(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], process.cwd(), process.env, resolve(root, 'log'), true, undefined, 60_000, deadline)).rejects.toThrow('runner-deadline');
      expect(expired).toEqual(['deadline']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('overall runner deadline', () => {
  it('refuses overflowing timers without starting the command', async () => {
    const root = mkdtempSync(resolve('.spider/scratch/deadline-overflow-'));
    try {
      const log = resolve(root, 'not-started.log');
      await expect(command(process.execPath, ['-e', 'console.log("wrong")'], process.cwd(), process.env, log, true, undefined, 60_000,
        { at: Date.now() + 2 ** 31 + 60_000, expire() {} })).rejects.toThrow('invalid runner deadline');
      expect(existsSync(log)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('stops unfinished work and writes evidence before rejecting', async () => {
    const root = mkdtempSync(resolve('.spider/scratch/deadline-'));
    try {
      const log = resolve(root, 'command.log');
      const evidence: unknown[] = [];
      await expect(command(process.execPath, ['-e', 'console.log("started"); setTimeout(() => {}, 1200)'], process.cwd(), process.env, log, true, undefined, 60_000,
        { at: Date.now() + 500, expire: () => { evidence.push(JSON.parse(JSON.stringify({ reason: 'runner-deadline' }))); } })).rejects.toThrow('runner-deadline');
      expect(readFileSync(log, 'utf8')).toContain('started');
      expect(evidence).toEqual([{ reason: 'runner-deadline' }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('does not start another command after the overall deadline', async () => {
    const root = mkdtempSync(resolve('.spider/scratch/deadline-'));
    try {
      const log = resolve(root, 'not-started.log');
      await expect(command(process.execPath, ['-e', 'console.log("wrong")'], process.cwd(), process.env, log, true, undefined, 60_000,
        { at: Date.now() - 1, expire: () => {} })).rejects.toThrow('runner-deadline');
      expect(existsSync(log)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('cold packed CLI startup measurement', () => {
  it('times one fresh successful help process through the packed entry', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    try {
      const invoke = vi.fn(async () => { vi.setSystemTime(1_250); return { exitCode: 0, stdout: 'Usage: spider <command>\n', stderr: '' }; });
      const env = { HOME: '/fixture/home' };
      expect(await coldCliStartup(invoke, '/packed/roam-cli.mjs', env)).toBe(250);
      expect(invoke).toHaveBeenCalledExactlyOnceWith(process.execPath, ['/packed/roam-cli.mjs', '--help'], env);
    } finally { vi.useRealTimers(); }
  });
  it.each([
    { exitCode: 1, stdout: 'Usage: spider <command>\n', stderr: 'failed' },
    { exitCode: 0, stdout: '', stderr: '' },
  ])('does not report an unsuccessful or missing help response: $exitCode', async result => {
    await expect(coldCliStartup(async () => result, '/packed/roam-cli.mjs', {})).rejects.toThrow('cold-cli-help-unavailable');
  });
});

describe('structured move effect evidence', () => {
  it('retains the mandatory conflict record beside plain service-manager effects', () => {
    const conflict = JSON.stringify({ effect: 'participant-wake-conflict', intent: { epoch: 4 } });
    expect(effectJsonLines(`--user start spider-roam-supervisor.service\n${conflict}\n`).map(line => JSON.parse(line))).toEqual([
      { effect: 'participant-wake-conflict', intent: { epoch: 4 } },
    ]);
  });
  it('does not silently discard a malformed JSON effect', () => {
    expect(() => effectJsonLines('{broken').map(line => JSON.parse(line))).toThrow(SyntaxError);
  });
});

describe('move fixture transport failures', () => {
  it.each([
    { fault: { offline: 'box-1.invalid' }, args: ['fixture-ingest', 'session-a'] },
    { fault: { intercomDown: 'box-1.invalid' }, args: ['--global-root', '/fixture', 'roam', 'intercom', 'exchange'] },
  ])('prints a structured refusal for $args', ({ fault, args }) => {
    const source = readFileSync(new URL('./roam-move.test.ts', import.meta.url), 'utf8');
    const start = source.indexOf('if (linkFault.offline === machine.id');
    const end = source.indexOf('} else if (args.length === 5', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const output: string[] = [], process = { exitCode: 0, stdout: { write: (text: string) => output.push(text) } };
    runInNewContext(source.slice(start, end).replaceAll('\\\\n', '\\n') + '}', { linkFault: fault, args, machine: { id: 'box-1.invalid' }, record: () => {}, process });
    expect(process.exitCode).toBe(1);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0])).toEqual({ code: 1, reason: 'fixture-machine-unavailable', machineId: 'box-1.invalid' });
  });
});

describe('move launch observation command', () => {
  it.each(['pending', 'exited', 'uncertain'] as const)('reports %s from the actual participant observation', async state => {
    const source = readFileSync(new URL('./roam-move.test.ts', import.meta.url), 'utf8');
    const start = source.indexOf("} else if (args[0] === 'fixture-observe')");
    const end = source.indexOf("} else if (args[0] === 'fixture-baseline')", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const home = { sessionId: 'session-a', machineId: 'box-a', epoch: 4, moveId: 'move-a' };
    const receipt = state === 'pending' ? null : { kind: 'exited-without-adoption', launchId: 'launch-a', terminalId: 't1' };
    const observed = { owner: { kind: state === 'uncertain' ? 'uncertain' : 'absent' }, readiness: null };
    const observation = vi.fn(async () => observed), close = vi.fn(), stop = vi.fn(async () => {}), output: string[] = [];
    const process = { exitCode: 0, stdout: { write: (text: string) => output.push(text) } };
    const script = '(async () => {' + source.slice(start + 7, end).replaceAll('\\\\n', '\\n') + '}})()';
    await runInNewContext(stripTypeScriptTypes(script), {
      args: ['fixture-observe', 'session-a', 'move-a'], root: '/fixture', machine: { id: 'box-a' }, join: (...parts: string[]) => parts.join('/'), process,
      openLocalCore: () => ({ db: {}, config: {}, close }), openFreezeJournal: () => ({}), sessionHome: () => home, existsSync: () => true, readFileSync: () => 'null',
      moveFactory: async () => ({ bindings: { participant: { observation } }, close: stop }), readMoveLaunchAbsenceReceipt: () => receipt,
    });
    expect(observation).toHaveBeenCalledWith(home, expect.objectContaining({ kind: 'move-observation', expectedEpoch: 4 }));
    expect(JSON.parse(output[0])).toMatchObject({ code: state === 'exited' ? 0 : 3, reason: state === 'exited' ? 'exited-without-adoption' : 'launch-outcome-pending', receipt });
    expect(close).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce();
  });
});

describe('documented move recovery states', () => {
  it('keeps waiting for a named pending intercom endpoint without accepting a refusal as success', () => {
    for (const reason of ['move-destination-pending', 'move-pending', 'intercom-endpoint-not-ready']) expect(moveRecoveryPending({ code: 3, reason })).toBe(true);
    for (const value of [null, {}, { code: 0, reason: 'intercom-endpoint-not-ready' }, { code: 1, reason: 'intercom-endpoint-not-ready' },
      { code: 3, reason: 'move-home-changed' }, { code: 3, reason: 'unknown' }, { code: '3', reason: 'intercom-endpoint-not-ready' }]) expect(moveRecoveryPending(value)).toBe(false);
  });
});

describe('cross-machine pane story registration', () => {
  const ids = ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08'];
  it('selects every packed pane story serially in headless and app tiers', async () => {
    // @ts-ignore Vite provides import.meta.glob during test transformation.
    const definitions = await discoverScenarios(import.meta.glob('./cross-machine-*.test.ts'));
    for (const tier of ['headless', 'app']) {
      const env = { SPIDER_HERDR_APP_TESTS: '1', SPIDER_HERDR_TEST_DISPLAY_UUID: 'owned-display' };
      const options = parseOptions(['--tier', tier, '--story', ids.join(',')], env);
      expect(selectScenarios(definitions, options).map((definition: { id: string }) => definition.id)).toEqual(ids);
      expect(profileIds[tier]).toEqual(expect.arrayContaining(ids));
      expect(storyWorkers(options)).toBe(1);
    }
    expect(profileIds.ci.filter((id: string) => ids.includes(id))).toEqual([]);
    expect(profileIds.remote.filter((id: string) => ids.includes(id))).toEqual([]);
  });
  it('labels successful synthetic results without certifying native interaction', () => {
    expect(parseOptions(['--tier', 'headless', '--task', 'panes'], {}).ids).toEqual(ids);
    expect(() => parseOptions(['--tier', 'ci', '--task', 'panes'], {})).toThrow(/no stories/);
    expect(storyWorkers({ tier: 'headless', ids: ['B04'], workers: 4 })).toBe(1);
    const reports = ids.map(id => ({ id, tier: 'headless', result: 'passed', evidence: `${id}.json`, startedAt: 100, finishedAt: 200 }));
    const matrix = buildMatrix('headless', ids, reports);
    for (const id of ids) {
      const row = matrix.find((row: { id: string }) => row.id === id);
      expect(row).toMatchObject({ result: 'passed', startedAt: 100, finishedAt: 200 });
      expect(row.reason).toMatch(/synthetic transport and app placement/);
      expect(row.reason).toMatch(/native input, SSH and continuous pixels not exercised/);
    }
  });
  it('retains blocked app results and missing headless results without claiming success', () => {
    const reports = ids.map(id => ({ id, tier: 'app', result: 'blocked', evidence: `${id}.json`, reason: 'owned native input unavailable', startedAt: 100, finishedAt: 200 }));
    const blocked = buildMatrix('app', ids, reports);
    for (const id of ids) {
      expect(blocked.find((row: { id: string }) => row.id === id)).toMatchObject({ result: 'blocked', startedAt: 100, finishedAt: 200 });
      expect(renderMatrix(blocked)).toContain(`| ${id} | app | blocked |`);
      expect(buildMatrix('headless', ids, []).find((row: { id: string }) => row.id === id).result).toBe('failed');
    }
    expect(complete(blocked, ids)).toBe(false);
    expect(complete(buildMatrix('headless', ids, []), ids)).toBe(false);
  });
});

describe('runner boundary and report', () => {
  it('pins the Linux release and selects registered headless stories for CI', async () => {
    const file = resolve('packages/herdr/e2e/controls/ci-stories.json');
    expect(existsSync(file)).toBe(true);
    const config = JSON.parse(readFileSync(file, 'utf8')) as {
      version: string; url: string; sha256: string; binarySha256: string; stories: string[];
    };
    expect(config).toMatchObject({
      version: '0.1.16',
      url: 'https://releases.herdr.dev/core/0.1.16/herdr-core-linux-x86_64.tar.gz',
      sha256: '58d6861176dc6fe905b58880d5bff07a9959be613a98e5d66b4583b04b6cfa45',
      binarySha256: '8c4c0930974e2b31978cbbb14b892cd29d5ace917f4c04ce6dfdd5573e1fe193',
      timeouts: { R15: 4, R16: 4 },
    });
    expect(config.stories).toEqual(['R01', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R16', 'R17']);
    expect(new Set(config.stories).size).toBe(config.stories.length);
    expect(config.stories.every(id => profileIds.headless.includes(id))).toBe(true);
    // @ts-ignore Vite provides import.meta.glob during test transformation.
    const definitions = await discoverScenarios(import.meta.glob('./*.test.ts'));
    const selected = selectScenarios(definitions, parseOptions(['--tier', 'headless', '--story', config.stories.join(',')], {}));
    expect(selected.map((definition: { id: string }) => definition.id)).toEqual([...config.stories].sort());
  }, 5000);
  it('accepts the pinned Linux hc executable and rejects unknown binaries', () => {
    expect(verifyHcBinaryPin('0.1.16', '8c4c0930974e2b31978cbbb14b892cd29d5ace917f4c04ce6dfdd5573e1fe193')).toBe('0.1.16');
    expect(verifyHcBinaryPin('0.1.16', 'c617feeb4d1b5f59b30e4ab6b4e9e7f7ac114d0681d207d9f41efa12c813b922')).toBe('0.1.16');
    expect(() => verifyHcBinaryPin('0.1.16', '0'.repeat(64))).toThrow(/digest mismatch/);
    expect(() => verifyHcBinaryPin('0.1.17', '8c4c0930974e2b31978cbbb14b892cd29d5ace917f4c04ce6dfdd5573e1fe193')).toThrow(/unlisted/);
  });
  it('reports a closed client input pipe without an uncaught stream error', async () => {
    const env = { HOME: process.cwd(), PATH: process.env.PATH ?? '/usr/bin:/bin' };
    await expect(runHc('/usr/bin/true', [], env, { input: 'x'.repeat(1024 * 1024) })).rejects.toMatchObject({ code: 'EPIPE' });
    expect(await runHc('/usr/bin/true', [], env)).toMatchObject({ exitCode: 0, stdout: '', stderr: '' });
    const echo = "process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => process.stdout.write(chunk));";
    expect(await runHc(process.execPath, ['-e', echo], env, { input: 'owned input' })).toMatchObject({ exitCode: 0, stdout: 'owned input' });
  });
  it('forwards an explicit native clone only to the app worker environment', () => {
    const input = { SPIDER_HERDR_E2E_APP: '/owned/native.app/Contents/MacOS/Herdr' };
    expect(storyWorkerEnvironment({}, input, 'app')).toHaveProperty('SPIDER_HERDR_E2E_APP', input.SPIDER_HERDR_E2E_APP);
    expect(storyWorkerEnvironment({}, input, 'headless')).not.toHaveProperty('SPIDER_HERDR_E2E_APP');
    expect(storyWorkerEnvironment({}, {}, 'app')).not.toHaveProperty('SPIDER_HERDR_E2E_APP');
  });
  it('forwards the explicit 0.1.13 screenshot opt-in only to app workers', () => {
    const input = { SPIDER_SPACES_A_SCREENSHOTS_013: '1' };
    expect(storyWorkerEnvironment({}, input, 'app')).toEqual(input);
    for (const tier of ['headless', 'ci', 'remote']) expect(storyWorkerEnvironment({}, input, tier)).toEqual({});
    for (const value of [undefined, '0', 'true']) expect(storyWorkerEnvironment({}, { SPIDER_SPACES_A_SCREENSHOTS_013: value }, 'app')).toEqual({});
  });
  it('every default profile selects actual supported story exports, including the real remote smoke', async () => {
    // @ts-ignore Vite provides import.meta.glob during test transformation.
    const modules = import.meta.glob('./*.test.ts');
    const definitions = await discoverScenarios(modules);
    for (const [tier, ids] of Object.entries(profileIds)) {
      expect(() => selectScenarios(definitions, { tier, ids })).not.toThrow();
    }
    expect(profileIds.remote).toContain('H-tier2-smoke');
    const r01 = definitions.find((definition: { id: string }) => definition.id === 'R01');
    const r02 = definitions.find((definition: { id: string }) => definition.id === 'R02');
    expect(r01).toMatchObject({ tiers: ['headless'] });
    expect(r02).toMatchObject({ tiers: ['headless'] });
    expect(r02.title).toMatch(/admitted box readiness.*packaged hub/i);
  }, 5000);
  it('discovers the packaged hosting stories and reports missing or inapplicable results honestly', async () => {
    // @ts-ignore Vite provides import.meta.glob during test transformation.
    const definitions = await discoverScenarios(import.meta.glob('./*.test.ts'));
    const ids = ['R03', 'R04', 'R05'];
    const selected = selectScenarios(definitions, parseOptions(['--tier', 'headless', '--story', ids.join(',')], {}));
    expect(selected.map((definition: { id: string }) => definition.id)).toEqual(ids);
    expect(selected.every((definition: { tiers: string[] }) => definition.tiers.join(',') === 'headless')).toBe(true);
    for (const id of ids) {
      expect(profileIds.headless).toContain(id);
      expect(profileIds.ci).not.toContain(id);
      expect(buildMatrix('ci', profileIds.ci, []).find((row: { id: string }) => row.id === id).result).toBe('not exercised');
      const missing = buildMatrix('headless', [id], []);
      expect(missing.find((row: { id: string }) => row.id === id).result).not.toBe('passed');
      expect(complete(missing, [id])).toBe(false);
    }
  }, 5000);
  it('selects R01 and R02 in their own tiers and reports them unexercised in CI', () => {
    expect(storyId('R01')).toBe('R01'); expect(storyId('R02')).toBe('R02');
    expect(parseOptions(['--tier', 'headless', '--story', 'R01'], {}).ids).toEqual(['R01']);
    expect(parseOptions(['--tier', 'headless', '--story', 'R02'], {}).ids).toEqual(['R02']);
    expect(profileIds.headless).toContain('R01'); expect(profileIds.headless).toContain('R02'); expect(profileIds.app).not.toContain('R02');
    expect(profileIds.ci).not.toContain('R01'); expect(profileIds.ci).not.toContain('R02');
    expect(parseOptions(['--tier', 'headless', '--task', 'roam'], {}).ids).toEqual(['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R16', 'R17']);
    expect(() => parseOptions(['--tier', 'app', '--task', 'roam'], { SPIDER_HERDR_APP_TESTS: '1', SPIDER_HERDR_TEST_DISPLAY_UUID: 'fixture' })).toThrow(/no stories/);
    expect(() => parseOptions(['--tier', 'ci', '--task', 'roam'], {})).toThrow(/no stories/);
    const matrix = buildMatrix('ci', profileIds.ci, []);
    expect(matrix.find((row: { id: string }) => row.id === 'R01').result).toBe('not exercised');
    expect(matrix.find((row: { id: string }) => row.id === 'R02').result).toBe('not exercised');
    expect(storyWorkers({ tier: 'headless', ids: profileIds.headless })).toBe(1);
    expect(storyWorkers({ tier: 'headless', ids: ['S01', 'R01'] })).toBe(2);
    expect(storyWorkers({ tier: 'headless', ids: ['S01'] })).toBe(2);
    expect(storyWorkers({ tier: 'headless', ids: ['R02'] })).toBe(2);
    expect(storyWorkers({ tier: 'app', ids: ['S01'] })).toBe(1);
    const passed = buildMatrix('headless', ['R02'], [{ id: 'R02', tier: 'headless', result: 'passed', evidence: 'R02.json' }]);
    const r02 = passed.find((row: { id: string }) => row.id === 'R02');
    expect(r02.reason).toMatch(/native app.*not exercised/i);
    expect(r02.reason).toMatch(/packaged observer.*placement/i);
    expect(renderMatrix(passed)).toContain(r02.reason);
  }, 5000);
  it('discovers move and recovery stories as serial headless work with explicit results', async () => {
    // @ts-ignore Vite provides import.meta.glob during test transformation.
    const definitions = await discoverScenarios(import.meta.glob('./*.test.ts'));
    const ids = ['R06', 'R07', 'R08', 'R09', 'R10', 'R15', 'R16', 'R17'];
    const selected = selectScenarios(definitions, parseOptions(['--tier', 'headless', '--story', ids.join(',')], {}));
    expect(selected.map((definition: { id: string }) => definition.id)).toEqual(ids);
    expect(selected.find((definition: { id: string }) => definition.id === 'R15').title).toBe('revoked home restores a visible presentation');
    expect(selected.find((definition: { id: string }) => definition.id === 'R16').title).toBe('revoked home restores a parked presentation');
    expect(selected.find((definition: { id: string }) => definition.id === 'R17').title).toBe('proved launch failure permits rollback');
    for (const id of ids) {
      expect(profileIds.headless).toContain(id);
      expect(profileIds.ci).not.toContain(id);
      expect(profileIds.app).not.toContain(id);
      expect(storyWorkers({ tier: 'headless', ids: [id] })).toBe(1);
      const missing = buildMatrix('headless', [id], []);
      expect(complete(missing, [id])).toBe(false);
      const blocked = buildMatrix('headless', [id], [{ id, tier: 'headless', result: 'blocked', evidence: `${id}.json`, reason: 'native window unavailable' }]);
      expect(complete(blocked, [id])).toBe(false);
      expect(renderMatrix(blocked)).toContain('native window unavailable');
    }
  }, 5000);
  it('opts into the installed-upstream R14 variant only with both local inputs', async () => {
    // @ts-ignore Vite provides import.meta.glob during test transformation.
    const definitions = await discoverScenarios(import.meta.glob('./*.test.ts'));
    const local = definitions.find((definition: { id: string }) => definition.id === 'R14local');
    expect(local).toMatchObject({ tiers: ['headless'] });
    expect(parseOptions(['--story', 'R14local'], {}).ids).toEqual(['R14local']);
    expect(profileIds.headless).not.toContain('R14local');
    expect(buildMatrix('ci', profileIds.ci, []).find((row: { id: string }) => row.id === 'R14local').result).toBe('not exercised');
    const fenced = { HOME: '/owned/home' };
    const base = { SPIDER_HERDR_E2E_R14_BASE: '/fixture/base.js' };
    const both = { ...base, SPIDER_HERDR_E2E_R14_UPSTREAM: '/fixture/package' };
    expect(storyWorkerEnvironment(fenced, base, 'headless')).toEqual(fenced);
    expect(storyWorkerEnvironment(fenced, both, 'ci')).toEqual(fenced);
    expect(storyWorkerEnvironment(fenced, both, 'headless')).toEqual({ ...fenced, ...both });
    const reason = local.notExercised({});
    expect(reason).toMatch(/both.*R14/i);
    expect(local.notExercised(both)).toBeUndefined();
    const skipped = buildMatrix('headless', ['R14local'], [{ id: 'R14local', tier: 'headless', result: 'not exercised', evidence: 'local.json', reason }]);
    expect(complete(skipped, ['R14local'])).toBe(true);
    expect(complete(buildMatrix('headless', ['R14local'], []), ['R14local'])).toBe(false);
  });
  it('budgets every selected story at its full deadline plus bounded startup and teardown', () => {
    const ids = Array.from({ length: 55 }, (_, index) => `S${String(index + 1).padStart(2, '0')}`);
    expect(storyRunBudgetMs({ ids, harness: false })).toBe(54 * 300_000 + 600_000 + 60_000);
    expect(storyRunBudgetMs({ ids: ['S29'], harness: false })).toBe(360_000);
    expect(storyRunBudgetMs({ ids: ['S55'], harness: true })).toBe(960_000);
    expect(storyRunBudgetMs({ ids: ['S08'], harness: false })).toBe(660_000);
  });
  it('selects and reports harness IDs separately from the 56 product stories', () => {
    const id = 'H-tier2-smoke';
    expect(parseOptions(['--tier', 'remote', '--story', id], { SPIDER_HERDR_REAL_MACHINE: 'fixture.invalid' }).ids).toEqual([id]);
    expect(selectScenarios([{ id, title: 'smoke', tiers: ['remote'] }], { tier: 'remote', ids: [id] })).toHaveLength(1);
    expect(() => selectScenarios([], { tier: 'remote', ids: [id] })).toThrow(/missing selected story/);
    const matrix = buildMatrix('remote', [id], [{ id, tier: 'remote', result: 'passed', evidence: 'smoke.json' }]);
    expect(matrix.filter((row: { id: string }) => row.id.startsWith('S'))).toHaveLength(56);
    expect(matrix.filter((row: { id: string }) => row.id.startsWith('S')).every((row: { result: string }) => row.result === 'not exercised')).toBe(true);
    expect(renderMatrix(matrix)).toContain('## Harness stories\n');
    expect(renderMatrix(matrix).split('## Harness stories\n')[0]).not.toContain(id);
    expect(complete(matrix, [id])).toBe(true);
    expect(() => parseOptions(['--story', 'H-INVALID'], {})).toThrow(/unknown story/);
    expect(() => buildMatrix('ci', ['H-missing'], [{ id: 'H-INVALID', tier: 'ci', result: 'passed', evidence: 'x' }])).toThrow(/invalid report story/);
  });
  it('names the foundation independent cleanup CLI exactly', () => {
    expect(cleanupEntry('/checkout')).toEqual({ module: '/checkout/packages/herdr/e2e/harness/resources.ts', ledgers: '/checkout/.spider/scratch/e2/_ledgers' });
  });
  it('confines killed-run fixture mode to its exact story and no native window', () => {
    expect(parseOptions(['--tier', 'ci', '--story', 'S55', '--cleanup-control', 'daemon'], {})).toMatchObject({ cleanupControl: 'daemon' });
    expect(() => parseOptions(['--story', 'S54', '--cleanup-control', 'daemon'], {})).toThrow(/S55/);
    expect(() => parseOptions(['--story', 'S55', '--cleanup-control', 'unknown'], {})).toThrow(/control/);
  });
  it('passes only system runtime variables and explicit owned paths to worker tools', () => {
    const env = runnerEnvironment({ PATH: 'fixture-path', HOME: 'foreign-home', API_KEY: 'secret', NODE_OPTIONS: '--require foreign', HC_SESSION: 'default', VITEST: 'true', PI_SUBAGENT_CHILD: '1', SSH_AUTH_SOCK: 'foreign-socket', LANG: 'C' }, '/fixture-owned');
    expect(env).toMatchObject({ PATH: 'fixture-path', LANG: 'C', HOME: '/fixture-owned/home', TMPDIR: '/fixture-owned/tmp' });
    for (const key of ['API_KEY', 'NODE_OPTIONS', 'HC_SESSION', 'VITEST', 'PI_SUBAGENT_CHILD', 'SSH_AUTH_SOCK']) expect(env).not.toHaveProperty(key);
  });
  it('passes only the existing SSH agent socket to the remote transport worker', () => {
    const fenced = { HOME: '/owned/home', PATH: 'fixture-path' };
    const caller = { SSH_AUTH_SOCK: '/existing-agent/socket', API_KEY: 'secret', HC_SESSION: 'default' };
    expect(storyWorkerEnvironment(fenced, caller, 'remote')).toEqual({ ...fenced, SSH_AUTH_SOCK: caller.SSH_AUTH_SOCK });
    expect(storyWorkerEnvironment(fenced, caller, 'headless')).toEqual(fenced);
    expect(storyWorkerEnvironment(fenced, {}, 'remote')).toEqual(fenced);
    expect(fenced).not.toHaveProperty('SSH_AUTH_SOCK');
  });
  it('requires explicit native consent and display without inventing either', () => {
    expect(() => parseOptions(['--tier', 'app'], {})).toThrow(/consent/);
    expect(() => parseOptions(['--tier', 'app'], { SPIDER_HERDR_APP_TESTS: '1' })).toThrow(/display/);
    expect(parseOptions(['--tier', 'app'], { SPIDER_HERDR_APP_TESTS: '1', SPIDER_HERDR_TEST_DISPLAY_UUID: 'fixture-display' })).toMatchObject({ tier: 'app', displayUuid: 'fixture-display', consent: true });
    expect(() => parseOptions(['--tier', 'remote'], {})).toThrow(/machine/);
    expect(() => parseOptions(['--story', 'S99'], {})).toThrow(/story/);
    expect(() => parseOptions(['--unknown'], {})).toThrow(/unknown/);
  });
  it('selects only profile-supported stories in a task group, without hiding explicit IDs', () => {
    expect(parseOptions(['--tier', 'headless', '--task', 'runner'], {}).ids).toEqual(['S52', 'S54', 'S55', 'S56']);
    expect(parseOptions(['--tier', 'headless', '--story', 'S53'], {}).ids).toEqual(['S53']);
    expect(() => parseOptions(['--tier', 'ci', '--task', 'look'], {})).toThrow(/no stories/);
  });
  it('accepts only the named scenarios array', () => {
    const run = async () => {};
    expect(scenarioExports({ scenarios: [{ id: 'S52', run }] }, 'look.test.ts')).toHaveLength(1);
    expect(() => scenarioExports({ default: [] }, 'bad.test.ts')).toThrow(/named scenarios/);
    expect(() => scenarioExports({ scenario: {} }, 'bad.test.ts')).toThrow(/named scenarios/);
    expect(() => scenarioExports({ scenarios: [{}] }, 'bad.test.ts')).toThrow(/run/);
  });
  it('discovers runner story modules without recursively loading its own tests', async () => {
    const run = async () => {};
    const definitions = await discoverScenarios({
      './runner-integrity.test.ts': async () => ({ scenarios: [{ id: 'S55', title: 'cleanup', tiers: ['ci'], run }] }),
      './runner-contract.test.ts': async () => { throw new Error('must not load test utility'); },
      './runner-stories.test.ts': async () => { throw new Error('must not load central driver'); },
    });
    expect(definitions.map((x: { id: string }) => x.id)).toEqual(['S55']);
  });
  it('discovers by tier and id and fails missing requested stories', () => {
    const definitions = [ { id: 'S52', title: 'look', tiers: ['headless'] }, { id: 'S53', title: 'frames', tiers: ['app'] } ];
    expect(selectScenarios(definitions, { tier: 'headless', ids: ['S52'] }).map((x: { id: string }) => x.id)).toEqual(['S52']);
    expect(() => selectScenarios(definitions, { tier: 'ci', ids: ['S52'] })).toThrow(/tier/);
    expect(() => selectScenarios(definitions, { tier: 'headless', ids: ['S54'] })).toThrow(/missing/);
    expect(() => selectScenarios([...definitions, definitions[0]], { tier: 'headless', ids: [] })).toThrow(/duplicate/);
  });
  it('keeps blocked, failed, passed and unexercised stories distinct', () => {
    const matrix = buildMatrix('ci', ['S52', 'S54', 'S55', 'S56'], [
      { id: 'S52', tier: 'ci', result: 'passed', evidence: 'S52.json' },
      { id: 'S54', tier: 'ci', result: 'blocked', evidence: 'S54.json', reason: 'native-input' },
      { id: 'S55', tier: 'ci', result: 'failed', evidence: 'S55.json', reason: 'cleanup failed' },
    ]);
    expect(matrix).toHaveLength(82);
    expect(matrix.find((x: { id: string }) => x.id === 'R14').result).toBe('not exercised');
    expect(matrix.find((x: { id: string }) => x.id === 'S01').result).toBe('not exercised');
    expect(matrix.find((x: { id: string }) => x.id === 'S56').result).toBe('failed');
    expect(complete(matrix, ['S52'])).toBe(true);
    expect(complete(matrix, ['S54'])).toBe(false);
    expect(complete(matrix, ['S55'])).toBe(false);
    expect(renderMatrix(matrix)).toContain('| S54 | ci | blocked | S54.json | native-input |');
  });
  it('does not accept duplicate, wrong-tier or malformed reports as success', () => {
    expect(() => buildMatrix('ci', ['S52'], [{ id: 'S52', tier: 'ci', result: 'skipped', evidence: 'x' }])).toThrow(/result/);
    expect(() => buildMatrix('ci', ['S52'], [{ id: 'S52', tier: 'app', result: 'passed', evidence: 'x' }])).toThrow(/tier/);
    const report = { id: 'S52', tier: 'ci', result: 'passed', evidence: 'x' };
    expect(() => buildMatrix('ci', ['S52'], [report, report])).toThrow(/duplicate/);
  });
});


describe('roaming completion states', () => {
  it.each([
    [3, 'recovery-pending', true], [3, 'readiness-pending', true], [0, 'destroyed-machine-recovered', false],
    [1, 'readiness-pending', false], [3, 'participant-owner-unproved', false], [3, 'unknown', false],
  ] as const)('reconciles restoration code %s reason %s only when explicitly pending', (code, reason, pending) => {
    expect(restorationPending({ code, reason })).toBe(pending);
  });
  it('replays a recovered home while its presentation is explicitly pending', () => {
    expect(restorationPending({ code: 0, reason: 'destroyed-machine-recovered', value: { presentation: 'pending' } })).toBe(true);
    for (const result of [{ code: 0, reason: 'destroyed-machine-recovered', value: { presentation: 'complete' } },
      { code: 0, reason: 'unknown', value: { presentation: 'pending' } }, { code: 1, reason: 'destroyed-machine-recovered', value: { presentation: 'pending' } },
      { code: 0, reason: 'destroyed-machine-recovered', value: null }, { code: 0, reason: 'destroyed-machine-recovered', value: {} }]) expect(restorationPending(result)).toBe(false);
  });
  it.each([
    ['pending', 'operation-in-progress', true], ['complete', 'native-view-converted', false], ['refused', 'operation-in-progress', false],
    ['pending', 'presentation-unavailable', false], ['pending', 'target-changed', false], ['pending', 'unknown', false],
  ] as const)('joins presentation status %s reason %s only for an existing operation', (status, reason, pending) => {
    expect(presentationInProgress({ status, reason })).toBe(pending);
  });
});


it.each([null, undefined, {}, [], { code: '3', reason: 'readiness-pending' }])('refuses malformed restoration status %j', result => {
  expect(restorationPending(result)).toBe(false);
});
