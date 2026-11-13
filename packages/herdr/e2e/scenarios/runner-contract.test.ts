import { describe, expect, it, vi } from 'vitest';
// The runner is also importable; importing it must not launch a suite.
// @ts-ignore JavaScript runner boundary is exercised at runtime.
import { parseOptions, selectScenarios, buildMatrix, complete, renderMatrix, scenarioExports, runnerEnvironment, discoverScenarios, cleanupEntry, storyRunBudgetMs, profileIds, storyWorkerEnvironment, storyWorkers } from '../../../../scripts/herdr-e2e.mjs';
import { storyId } from '../harness/scenario.js';

vi.mock('../harness/scenario.js', async importOriginal => ({
  ...await importOriginal<typeof import('../harness/scenario.js')>(), registerScenarios: () => {},
}));
describe('runner boundary and report', () => {
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
    expect(r02.title).toMatch(/placement adapter only.*synthetic readiness/i);
  });
  it('selects R01 and R02 in their own tiers and reports them unexercised in CI', () => {
    expect(storyId('R01')).toBe('R01'); expect(storyId('R02')).toBe('R02');
    expect(parseOptions(['--tier', 'headless', '--story', 'R01'], {}).ids).toEqual(['R01']);
    expect(parseOptions(['--tier', 'headless', '--story', 'R02'], {}).ids).toEqual(['R02']);
    expect(profileIds.headless).toContain('R01'); expect(profileIds.headless).toContain('R02'); expect(profileIds.app).not.toContain('R02');
    expect(profileIds.ci).not.toContain('R01'); expect(profileIds.ci).not.toContain('R02');
    expect(parseOptions(['--tier', 'headless', '--task', 'roam'], {}).ids).toEqual(['R01', 'R02']);
    expect(() => parseOptions(['--tier', 'app', '--task', 'roam'], { SPIDER_HERDR_APP_TESTS: '1', SPIDER_HERDR_TEST_DISPLAY_UUID: 'fixture' })).toThrow(/no stories/);
    expect(() => parseOptions(['--tier', 'ci', '--task', 'roam'], {})).toThrow(/no stories/);
    const matrix = buildMatrix('ci', profileIds.ci, []);
    expect(matrix.find((row: { id: string }) => row.id === 'R01').result).toBe('not exercised');
    expect(matrix.find((row: { id: string }) => row.id === 'R02').result).toBe('not exercised');
    expect(storyWorkers({ tier: 'headless', ids: ['S01', 'R01'] })).toBe(1);
    expect(storyWorkers({ tier: 'headless', ids: ['S01'] })).toBe(2);
    expect(storyWorkers({ tier: 'headless', ids: ['R02'] })).toBe(1);
    const passed = buildMatrix('headless', ['R02'], [{ id: 'R02', tier: 'headless', result: 'passed', evidence: 'R02.json' }]);
    const r02 = passed.find((row: { id: string }) => row.id === 'R02');
    expect(r02.reason).toMatch(/adapter only/i);
    expect(r02.reason).toMatch(/packaged observer.*3\.4/i);
    expect(renderMatrix(passed)).toContain(r02.reason);
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
    expect(matrix).toHaveLength(58);
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
