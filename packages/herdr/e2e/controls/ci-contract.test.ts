import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, string> };
type Job = { name?: string; uses?: string; needs?: string[] | string; permissions?: Record<string, string>; if?: string; steps: Step[]; 'timeout-minutes'?: number; strategy?: { matrix: Record<string, (string | number)[]> } };
type Workflow = { on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job>; concurrency?: unknown };
const source = (name: string): string => readFileSync(join(process.cwd(), '.github/workflows', `${name}.yml`), 'utf8');
const workflow = (name: string): Workflow => parse(source(name)) as Workflow;
const step = (job: Job, name: string): Step => job.steps.find(item => item.name === name)!;

describe('release installation contract', () => {
  it('runs on version tags and calls the complete CI workflow', () => {
    const ci = workflow('ci');
    const release = workflow('release');
    expect(ci.on).toHaveProperty('workflow_call');
    expect(release.on).toEqual({ push: { tags: ['v*'] } });
    expect(release.jobs.verify!.uses).toBe('./.github/workflows/ci.yml');
    expect(release.permissions).toEqual({ contents: 'read' });
    expect(release.jobs.release!.needs).toBe('verify');
    expect(release.jobs.release!.permissions).toEqual({ contents: 'write' });
  });

  it('uploads the checked tarball from CI and downloads that same artifact for release', () => {
    const checks = workflow('ci').jobs.checks!;
    const upload = step(checks, 'Save release package');
    expect(upload?.uses).toBe('actions/upload-artifact@v4');
    expect(upload.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(upload.with).toMatchObject({ name: 'release-package', path: '.spider/scratch/packaging/*.tgz', 'if-no-files-found': 'error', 'include-hidden-files': true });
    const verify = step(checks, 'Verify package contents');
    expect(verify.run).toContain("require('./scripts/check-package-files.cjs')");
    expect(verify.run).toContain('scripts/assert-bundle.mjs --package');
    expect(checks.steps.indexOf(upload)).toBeGreaterThan(checks.steps.indexOf(verify));
    const download = step(workflow('release').jobs.release!, 'Download release package');
    expect(download.uses).toBe('actions/download-artifact@v4');
    expect(download.with).toEqual({ name: 'release-package', path: '.spider/scratch/packaging' });
  });

  it('rejects a tag that differs from the package version', () => {
    const verify = step(workflow('release').jobs.release!, 'Verify tag matches package.json version');
    expect(verify?.run).toBeTypeOf('string');
    const version = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version;
    const run = (tag: string) => spawnSync('bash', ['-e', '-c', verify.run!], { env: { ...process.env, GITHUB_REF_NAME: tag }, encoding: 'utf8' });
    expect(run(`v${version}`).status).toBe(0);
    expect(run('v0.0.0').status).not.toBe(0);
    expect(run(version).status).not.toBe(0);
  });

  it('publishes the tarball and its SHA-256 with generated notes and a pinned pi install command', () => {
    const job = workflow('release').jobs.release!;
    const publish = step(job, 'Publish GitHub release');
    expect(publish?.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    const parent = join(process.cwd(), '.spider/scratch');
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(join(parent, 'release-contract-'));
    try {
      const version = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version;
      const filename = `guru-irl-spider-${version}.tgz`;
      const payload = 'synthetic release package';
      mkdirSync(join(directory, 'bin'));
      mkdirSync(join(directory, '.spider/scratch/packaging'), { recursive: true });
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ version }));
      writeFileSync(join(directory, '.spider/scratch/packaging', filename), payload);
      writeFileSync(join(directory, 'bin/gh'), `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.writeFileSync('release.json', JSON.stringify({ args, notes: fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8') }));\n`);
      chmodSync(join(directory, 'bin/gh'), 0o755);
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', publish.run!], { cwd: directory, env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`, GITHUB_REF_NAME: `v${version}`, GITHUB_REPOSITORY: 'example/spider' }, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      const record = JSON.parse(readFileSync(join(directory, 'release.json'), 'utf8'));
      expect(record.args).toEqual(expect.arrayContaining(['release', 'create', `v${version}`, '--generate-notes', '--verify-tag', `.spider/scratch/packaging/${filename}`, '.spider/scratch/packaging/SHA256SUMS']));
      expect(record.args).not.toContain('--draft');
      expect(record.notes).toContain(`pi install npm:@guru-irl/spider@https://github.com/example/spider/releases/download/v${version}/${filename}`);
      expect(readFileSync(join(directory, '.spider/scratch/packaging/SHA256SUMS'), 'utf8')).toBe(`${createHash('sha256').update(payload).digest('hex')}  ${filename}\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('never starts npm publishing from a release event', () => {
    expect(workflow('publish').on).toEqual({ workflow_dispatch: { inputs: { tag: { description: 'Tag to publish (e.g. v0.1.0)', required: true } } } });
    expect(source('publish')).not.toContain('github.event.release');
    expect(source('release')).not.toContain('NPM_TOKEN');
    expect(source('release')).not.toContain('npm publish');
    expect(source('release')).not.toContain('secrets.');
  });
});

describe('CI acceptance contract', () => {
  it('builds before confidence utilities, runs the packed subset next and keeps failure artifacts in the same job', () => {
    for (const name of ['ci', 'release']) {
      const selected = workflow(name);
      if (name === 'release') expect(selected.jobs.verify!.uses).toBe('./.github/workflows/ci.yml');
      const jobs = name === 'release' ? workflow('ci').jobs : selected.jobs;
      const job = jobs['herdr-acceptance']!;
      const install = job.steps.findIndex(item => item.name === 'Install');
      const utilities = job.steps.findIndex(item => item.name === 'Herdr confidence utilities (no hc, app or SSH)');
      const subset = job.steps.findIndex(item => item.name === 'Herdr packed acceptance (no hc, app or SSH)');
      const artifacts = job.steps.findIndex(item => item.name === 'Herdr acceptance failure artifacts');
      expect(install).toBeGreaterThan(-1); expect(utilities).toBeGreaterThan(install); expect(subset).toBeGreaterThan(utilities); expect(artifacts).toBeGreaterThan(subset);
      expect(step(job, 'Install').run).toBe('npm ci'); // prepare builds the checkout.
      const checks = jobs.checks!;
      const typecheck = step(checks, 'Herdr acceptance typecheck');
      expect(typecheck.run).toContain('npm run typecheck:herdr:e2e');
      expect(checks.steps.findIndex(item => item.name === 'Install')).toBeLessThan(checks.steps.indexOf(typecheck));
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
    expect([...(ci.jobs.required!.needs! as string[])].sort()).toEqual(names);
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
        const setup = (job.steps ?? []).filter(item => item.uses === 'actions/setup-node@v4');
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
