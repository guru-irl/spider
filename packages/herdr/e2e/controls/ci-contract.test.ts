import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, string> };
type Job = { name?: string; needs?: string[]; if?: string; steps: Step[]; 'timeout-minutes'?: number; strategy?: { matrix: Record<string, (string | number)[]> } };
type Workflow = { jobs: Record<string, Job>; concurrency?: unknown };
const source = (name: string): string => readFileSync(join(process.cwd(), '.github/workflows', `${name}.yml`), 'utf8');
const workflow = (name: string): Workflow => parse(source(name)) as Workflow;
const step = (job: Job, name: string): Step => job.steps.find(item => item.name === name)!;

describe('CI acceptance contract', () => {
  it('builds before confidence utilities, runs the packed subset next and keeps failure artifacts in the same job', () => {
    for (const [name, jobName] of [['ci', 'herdr-acceptance'], ['release', 'verify']]) {
      const jobs = workflow(name).jobs;
      const job = jobs[jobName!]!;
      const install = job.steps.findIndex(item => item.name === 'Install');
      const utilities = job.steps.findIndex(item => item.name === 'Herdr confidence utilities (no hc, app or SSH)');
      const subset = job.steps.findIndex(item => item.name === 'Herdr packed acceptance (no hc, app or SSH)');
      const artifacts = job.steps.findIndex(item => item.name === 'Herdr acceptance failure artifacts');
      expect(install).toBeGreaterThan(-1); expect(utilities).toBeGreaterThan(install); expect(subset).toBeGreaterThan(utilities); expect(artifacts).toBeGreaterThan(subset);
      expect(step(job, 'Install').run).toBe('npm ci'); // prepare builds the checkout.
      const checks = name === 'ci' ? jobs.checks! : job;
      const typecheck = step(checks, 'Herdr acceptance typecheck');
      expect(typecheck.run).toContain('npm run typecheck:herdr:e2e');
      if (name === 'release') {
        const build = job.steps.findIndex(item => item.name === 'Build');
        expect(build).toBeGreaterThan(-1);
        expect(job.steps.indexOf(typecheck)).toBeGreaterThan(build);
        expect(job.steps.indexOf(typecheck)).toBeLessThan(utilities);
      } else {
        expect(checks.steps.findIndex(item => item.name === 'Install')).toBeLessThan(checks.steps.indexOf(typecheck));
      }
      const command = job.steps[utilities]!.run!;
      expect(command).toContain('packages/herdr/e2e/scenarios/runner-contract.test.ts packages/herdr/e2e/harness/__tests__/pi-observations.test.ts packages/herdr/e2e/native packages/herdr/e2e/controls');
      expect(command).toContain('-u SPIDER_HERDR_APP_TESTS');
      expect(job.steps[subset]!.run).toContain('npm run test:herdr:e2e:ci -- --built');
      expect(job.steps[artifacts]!.if).toBe('failure()');
      expect(job.steps[artifacts]!.uses).toBe('actions/upload-artifact@v4');
    }
  });

  it('keeps the exact aggregate name once and requires success from every parallel job, even when skipped or cancelled', () => {
    const ci = workflow('ci');
    expect(source('ci').match(/^    name: typecheck · test · build$/gm)).toHaveLength(1);
    expect(ci.jobs.required!.name).toBe('typecheck · test · build');
    const names = Object.keys(ci.jobs).filter(name => name !== 'required').sort();
    expect(names).toEqual(['checks', 'chrome', 'herdr-acceptance', 'test']);
    expect([...ci.jobs.required!.needs!].sort()).toEqual(names);
    expect(ci.jobs.required!.if).toBe('always()');
    const gate = ci.jobs.required!.steps[0]!;
    expect(gate.env?.NEEDS_JSON).toBe('${{ toJSON(needs) }}');
    const needs = Object.fromEntries(names.map(name => [name, { result: 'success' }]));
    const run = (value: typeof needs): number | null => spawnSync('bash', ['-c', gate.run!], { env: { ...process.env, NEEDS_JSON: JSON.stringify(value) } }).status;
    expect(run(needs)).toBe(0);
    for (const name of names) for (const result of ['failure', 'cancelled', 'skipped']) {
      expect(run({ ...needs, [name]: { result } })).not.toBe(0);
    }
    expect(ci.concurrency).toEqual({ group: 'ci-${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': "${{ github.event_name == 'pull_request' }}" });
  });

  it('uses only Node 26 with npm caches and gives every CI job a ten-minute budget', () => {
    for (const name of ['ci', 'release', 'publish']) {
      for (const job of Object.values(workflow(name).jobs)) {
        const setup = job.steps.filter(item => item.uses === 'actions/setup-node@v4');
        for (const node of setup) {
          const versions = node.with!['node-version'] === '${{ matrix.node }}' ? job.strategy!.matrix.node : [node.with!['node-version']];
          expect(versions).toEqual(['26.x']);
          expect(node.with!.cache).toBe('npm');
        }
        if (name === 'ci') expect(job['timeout-minutes']).toBe(10);
      }
    }
  });

  it('matches the shard matrix to the command and saves JSON timing reports from every shard', () => {
    const job = workflow('ci').jobs.test!;
    const matrix = job.strategy!.matrix;
    expect(matrix.shard).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    const test = step(job, 'Test shard');
    expect(test.run).toContain('vitest run --shard=${{ matrix.shard }}/12 --maxWorkers=2');
    expect(test.run).toContain('--reporter=json');
    expect(test.run).toContain('--outputFile=.spider/scratch/test-results/shard-${{ matrix.shard }}.json');
    for (const key of ['PI_SUBAGENT_CHILD', 'PI_SUBAGENT_RUN_ID', 'PI_SPIDER_DB_PATH', 'PI_SPIDER_SESSION_ID', 'SPIDER_HERDR_E2E', 'SPIDER_HERDR_APP_TESTS', 'SPIDER_HERDR_APP_E2E', 'XDG_RUNTIME_DIR']) expect(test.run).toContain(`-u ${key}`);
    const removal = step(job, 'Remove runner runtime directory');
    expect(removal.run).toContain('"/run/user/$(id -u)"');
    expect(job.steps.indexOf(removal)).toBeLessThan(job.steps.indexOf(test));
    const artifact = step(job, 'Shard timing report');
    expect(artifact.if).toBe('always()');
    expect(artifact.uses).toBe('actions/upload-artifact@v4');
    expect(artifact.with!.name).toBe('test-results-${{ matrix.shard }}');
    expect(artifact.with!.path).toBe('.spider/scratch/test-results/shard-${{ matrix.shard }}.json');
  });

  it('keeps the dashboard and acceptance typecheck entry points unchanged', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.scripts['test:e2e']).toBe('node scripts/usage-dashboard-playwright.mjs');
    expect(pkg.scripts['typecheck:herdr:e2e']).toBe('tsgo --noEmit -p packages/herdr/e2e/tsconfig.json');
    const config = JSON.parse(readFileSync(join(process.cwd(), 'packages/herdr/e2e/tsconfig.json'), 'utf8'));
    expect(config.compilerOptions.isolatedDeclarations).toBe(true);
    expect(config.include).toEqual(['**/*.ts']);
  });
});
