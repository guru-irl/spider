import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, string>; 'timeout-minutes'?: number | string };
type Job = { name?: string; uses?: string; needs?: string[] | string; permissions?: Record<string, string>; if?: string; outputs?: Record<string, string>; steps: Step[]; 'timeout-minutes'?: number | string; strategy?: { matrix: any; 'fail-fast'?: boolean } };
type Workflow = { on: Record<string, unknown>; permissions?: Record<string, string>; env?: Record<string, string>; jobs: Record<string, Job>; concurrency?: unknown };
const source = (name: string): string => readFileSync(join(process.cwd(), '.github/workflows', `${name}.yml`), 'utf8');
const workflow = (name: string): Workflow => parse(source(name)) as Workflow;
const step = (job: Job, name: string): Step => job.steps.find(item => item.name === name)!;
const gitAt = (cwd: string, ...args: string[]): string => execFileSync('git', [
  '-c', 'user.name=Workflow Fixture', '-c', 'user.email=workflow@example.invalid', '-c', 'commit.gpgsign=false', ...args,
], { cwd, encoding: 'utf8' }).trim();

describe('package installation contract', () => {
  it('skips the unbundled GPU runtime download in every workflow that installs packages', () => {
    // onnxruntime-node downloads its CUDA provider from NuGet during npm ci on
    // Linux x64. CI never uses it, and that download times out intermittently.
    const names = readdirSync(join(process.cwd(), '.github/workflows')).filter(file => file.endsWith('.yml')).map(file => file.slice(0, -4));
    const installing = names.filter(name => /\bnpm ci\b/.test(source(name)));
    expect(installing).toEqual(expect.arrayContaining(['ci', 'herdr-stories', 'test-files']));
    for (const name of installing) expect(workflow(name).env?.ONNXRUNTIME_NODE_INSTALL, name).toBe('skip');
  });
});

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
    const checks = workflow('ci').jobs.compile!;
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

describe('headless story matrix', () => {
  const select = (input: string) => spawnSync(process.execPath, ['packages/herdr/e2e/controls/ci-matrix.mjs', input], { cwd: process.cwd(), encoding: 'utf8' });
  const matrixFor = (input: string): { story: string; timeout: number }[] => {
    const result = select(input);
    expect(result.status, result.stderr).toBe(0);
    return (JSON.parse(result.stdout) as { include: { story: string; timeout: number }[] }).include;
  };

  it('selects the relay story explicitly with the unmeasured timeout', () => {
    expect(matrixFor('R19')).toEqual([{ story: 'R19', timeout: 5 }]);
  });

  it('keeps the relay story out of the default CI matrix', () => {
    expect(matrixFor('')).not.toContainEqual(expect.objectContaining({ story: 'R19' }));
  });

  it('runs each default or explicitly requested story exactly once', () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), 'packages/herdr/e2e/controls/ci-stories.json'), 'utf8'));
    const defaults = select('');
    expect(defaults.status, defaults.stderr).toBe(0);
    const matrix = JSON.parse(defaults.stdout) as { include: { story: string; timeout: number }[] };
    expect(matrix.include.map(row => row.story)).toEqual(config.stories);
    expect(new Set(matrix.include.map(row => row.story)).size).toBe(config.stories.length);
    expect(matrix.include.every(row => Number.isInteger(row.timeout) && row.timeout > 0 && row.timeout <= 5)).toBe(true);
    const selected = select(' R04, S01, R13 ');
    expect(selected.status, selected.stderr).toBe(0);
    const explicit = JSON.parse(selected.stdout) as typeof matrix;
    expect(explicit.include.map(row => row.story)).toEqual(['R04', 'S01', 'R13']);
    expect(explicit.include.find(row => row.story === 'R13')!.timeout).toBe(config.timeouts.R13);
    for (const invalid of ['R10,,R13', 'R10,R10', 'R99', 'R10;echo']) expect(select(invalid).status).not.toBe(0);
  });

  it('defaults to relocation and keeps R12 available only by explicit selection', () => {
    const defaults = select('');
    expect(defaults.status, defaults.stderr).toBe(0);
    const matrix = JSON.parse(defaults.stdout) as { include: { story: string; timeout: number }[] };
    expect(matrix.include.map(row => row.story)).toEqual(['R18', 'R10', 'R11']);
    expect(matrix.include).toContainEqual({ story: 'R18', timeout: 3 });
    const requested = select('R12');
    expect(requested.status, requested.stderr).toBe(0);
    expect(JSON.parse(requested.stdout).include).toEqual([{ story: 'R12', timeout: 2 }]);
  });

  it('rejects the retired hosting story IDs', () => {
    for (const id of ['R03', 'R05']) expect(select(id).status, id).not.toBe(0);
  });

  it('keeps move story budgets and leaves the flaky ones out of the default set', () => {
    const defaults = JSON.parse(select('').stdout) as { include: { story: string; timeout: number }[] };
    // R06 to R08 are flaky in CI and stay out of the default set until fixed.
    expect(defaults.include).toContainEqual({ story: 'R10', timeout: 5 });
    for (const story of ['R06', 'R07', 'R08']) expect(defaults.include.map(row => row.story)).not.toContain(story);
    for (const story of ['R06', 'R07', 'R08', 'R10'])
      expect(JSON.parse(select(story).stdout).include).toEqual([{ story, timeout: 5 }]);
  });

  it('uses the matrix timeout for the story step and preserves the overall deadline', () => {
    const job = workflow('herdr-stories').jobs.stories!;
    const setup = step(job, 'Set overall story deadline'), story = step(job, 'Run headless story');
    const root = mkdtempSync(join(process.cwd(), '.spider/scratch/story-deadline-'));
    try {
      mkdirSync(join(root, 'bin'));
      writeFileSync(join(root, 'bin/date'), '#!/bin/sh\nprintf "%s\\n" "$CLOCK_NOW"\n', { mode: 0o700 });
      writeFileSync(join(root, 'bin/npm'), '#!/bin/sh\nprintf "%s\\n" "$SPIDER_HERDR_E2E_DEADLINE" > "$CAPTURE"\n', { mode: 0o700 });
      const output = join(root, 'environment'), capture = join(root, 'effective-deadline');
      const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, GITHUB_ENV: output,
        JOB_MINUTES: '2', STEP_MINUTES: '2', SHORT_DEADLINE: '', CLOCK_NOW: '1000000', CAPTURE: capture, STORY: 'R04' };
      const shell = (source: string, extra = {}) => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', source], { env: { ...env, ...extra }, encoding: 'utf8' });
      expect(shell(setup.run!).status).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe('SPIDER_HERDR_E2E_DEADLINE=1100000\n');
      expect(shell(story.run!, { CLOCK_NOW: '1030000', SPIDER_HERDR_E2E_DEADLINE: '1200000' }).status).toBe(0);
      expect(readFileSync(capture, 'utf8')).toBe('1130000\n');
      expect(shell(story.run!, { CLOCK_NOW: '1030000', SPIDER_HERDR_E2E_DEADLINE: '1040000' }).status).toBe(0);
      expect(readFileSync(capture, 'utf8')).toBe('1040000\n');
      expect(shell(setup.run!, { SHORT_DEADLINE: '101' }).status).not.toBe(0);
      expect(story.env?.STEP_MINUTES).toBe('${{ matrix.timeout }}');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('transfers only Linux x64 ONNX binaries and rejects a corrupt shared archive', () => {
    const prepare = workflow('herdr-stories').jobs.prepare!, story = workflow('herdr-stories').jobs.stories!;
    const root = mkdtempSync(join(process.cwd(), '.spider/scratch/shared-build-'));
    const workspace = join(root, 'workspace'), restored = join(root, 'restored'), temp = join(root, 'temp');
    const hc = '.spider/scratch/herdr-ci/hc', binary = 'synthetic core';
    try {
      for (const dir of [workspace, restored, temp, join(root, 'bin')]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(root, 'bin/sha256sum'), `#!/usr/bin/env node
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
if (process.argv[2] !== '--check') {
  const file = process.argv[2];
  console.log(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') + '  ' + file);
  process.exit(0);
}
const lines = fs.readFileSync(process.argv[3] || 0, 'utf8').trim().split('\\n');
for (const line of lines) {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  if (!match || crypto.createHash('sha256').update(fs.readFileSync(match[2])).digest('hex') !== match[1]) { console.error('checksum FAILED'); process.exit(1); }
}
`, { mode: 0o700 });
      for (const file of [hc, '.spider/scratch/herdr-ci/herdr-core', 'dist/index.js',
        'node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node',
        'node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/onnxruntime_binding.node',
        'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node',
        'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node']) {
        mkdirSync(join(workspace, file, '..'), { recursive: true });
        writeFileSync(join(workspace, file), file.startsWith('.spider/') ? binary : file);
      }
      const config = join(restored, 'packages/herdr/e2e/controls/ci-stories.json');
      mkdirSync(join(config, '..'), { recursive: true });
      writeFileSync(config, JSON.stringify({ binarySha256: createHash('sha256').update(binary).digest('hex') }));
      const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, RUNNER_TEMP: temp, GITHUB_WORKSPACE: workspace, SPIDER_HERDR_E2E_HC: join(workspace, hc), GITHUB_OUTPUT: join(root, 'output') };
      const shell = (script: string, cwd: string, extra = {}) => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
      const bundle = shell(step(prepare, 'Bundle shared build').run!, workspace);
      expect(bundle.status, bundle.stderr).toBe(0);
      const restore = () => shell(step(story, 'Restore shared build').run!, restored, { GITHUB_WORKSPACE: restored, HC_RELATIVE_PATH: hc, GITHUB_ENV: join(root, 'env') });
      const result = restore();
      expect(result.status, result.stderr).toBe(0);
      const listing = spawnSync('tar', ['-tzf', join(temp, 'herdr-build.tar.gz')], { encoding: 'utf8' }).stdout;
      expect(listing).toContain('node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node');
      expect(listing).not.toContain('node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/');
      expect(listing).not.toContain('node_modules/onnxruntime-node/bin/napi-v6/darwin/');
      expect(listing).not.toContain('node_modules/onnxruntime-node/bin/napi-v6/win32/');
      expect(step(prepare, 'Upload shared build').with?.path).toContain('herdr-build.sha256');
      writeFileSync(join(temp, 'herdr-build.tar.gz'), 'corrupt');
      const rejected = restore();
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout + rejected.stderr).toMatch(/FAILED|checksum/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('shares one build and keeps each matrix story independently bounded', () => {
    const definition = workflow('herdr-stories'), prepare = definition.jobs.prepare!, story = definition.jobs.stories!;
    expect(definition.on).not.toHaveProperty('pull_request');
    expect(definition.on).toHaveProperty('workflow_call');
    expect(definition.on).toHaveProperty('workflow_dispatch');
    expect(prepare.outputs?.matrix).toBe('${{ steps.selection.outputs.matrix }}');
    expect(step(prepare, 'Select stories').run).toContain('ci-matrix.mjs');
    expect(step(prepare, 'Install and build').run).toContain('npm ci');
    expect(step(prepare, 'Install the pinned Linux core').run).toContain('sha256sum --check');
    expect(step(prepare, 'Upload shared build').uses).toBe('actions/upload-artifact@v4');
    expect(story.needs).toBe('prepare');
    expect(story.strategy?.matrix).toBe('${{ fromJSON(needs.prepare.outputs.matrix) }}');
    expect(story.strategy?.['fail-fast']).toBe(false);
    expect(story['timeout-minutes']).toBe('${{ matrix.timeout }}');
    expect(step(story, 'Download shared build').uses).toBe('actions/download-artifact@v4');
    expect(story.steps.some(item => item.run?.includes('npm ci'))).toBe(false);
    const run = step(story, 'Run headless story');
    expect(run.env?.STORY).toBe('${{ matrix.story }}');
    expect(run['timeout-minutes']).toBe('${{ matrix.timeout }}');
    expect(run.run).toContain('--built --tier headless --story "$stories"');
    const artifacts = step(story, 'Upload failure artifacts');
    expect(artifacts.if).toBe('failure()');
    expect(artifacts.with?.name).toBe('herdr-headless-failures-${{ matrix.story }}');
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
      const checks = jobs.compile!;
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

  it('requires every full CI job except the audit to pass', () => {
    const ci = workflow('ci'), checks = ci.jobs.checks!;
    const required = ['chrome', 'compile', 'herdr-acceptance', 'stories', 'test'];
    expect(checks.name).toBe('typecheck · test · build');
    expect([...(checks.needs as string[])].sort()).toEqual(required);
    expect(checks.if).toBe('always()');
    const gate = step(checks, 'Require full CI jobs to pass');
    const run = (needs: unknown) => spawnSync('bash', ['-c', gate.run!], { env: { ...process.env, NEEDS_JSON: JSON.stringify(needs) } }).status;
    const main = Object.fromEntries(required.map(id => [id, { result: 'success' }]));
    expect(run(main)).toBe(0);
    for (const id of required) for (const result of ['failure', 'cancelled', 'skipped']) {
      expect(run({ ...main, [id]: { result } })).not.toBe(0);
    }
  });

  it('keeps full pushes, dispatches and reusable calls on the same path', () => {
    const ci = workflow('ci');
    expect(Object.keys(ci.on).sort()).toEqual(['push', 'workflow_call', 'workflow_dispatch']);
    expect(ci.on.workflow_dispatch).toEqual({ inputs: { force_full: {
      description: 'Run full CI on this ref; the force_full value is ignored',
      type: 'string',
      required: false,
      default: 'true',
    } } });
    expect(ci.on.push).toEqual({ branches: ['main'] });
    expect(ci.jobs.chrome!.strategy!.matrix.include).toHaveLength(4);
    expect(ci.jobs.stories).toEqual({ uses: './.github/workflows/herdr-stories.yml' });
    expect(ci.jobs.audit!.name).toBe('selection audit');
    expect(ci.jobs.audit!.needs).toEqual(['test']);
    for (const [id, job] of Object.entries(ci.jobs)) {
      if (id !== 'checks' && id !== 'audit') expect(job.if, id).toBeUndefined();
      const checkout = (job.steps ?? []).find(item => item.uses === 'actions/checkout@v4');
      expect(checkout?.with?.ref).toBeUndefined(); // Dispatch checkout must keep the requested ref.
    }
  });

  it('runs four PR test groups from a shared selection and keeps the audit upload out of the required check', () => {
    const pr = workflow('pr');
    expect(pr.on).toEqual({ pull_request: { branches: ['main'] } });
    expect(Object.keys(pr.jobs).sort()).toEqual(['checks', 'compile', 'save-selection', 'select', 'tests']);
    expect(pr.jobs.compile!.name).toBe('compile');
    expect(step(pr.jobs.compile!, 'Herdr acceptance typecheck')?.run ?? '').toContain('npm run typecheck:herdr:e2e');
    expect(step(pr.jobs.compile!, 'Check workflow contract')?.run ?? '').toContain('packages/herdr/e2e/controls/ci-contract.test.ts');
    expect(step(pr.jobs.compile!, 'Check workflow contract')?.run ?? '').toContain('--config packages/herdr/e2e/vitest.config.ts');
    expect(pr.jobs.tests!.strategy!.matrix.group).toEqual([1, 2, 3, 4]);
    expect(pr.jobs.tests!.if).toBeUndefined();
    expect(pr.jobs.tests!.needs).toEqual(['select']);
    expect(pr.jobs.checks!.name).toBe('typecheck · test · build');
    expect(pr.jobs.checks!.needs).toEqual(['compile', 'select', 'tests']);
    expect(pr.jobs.checks!.if).toBe('always()');
    expect(pr.jobs.checks!.steps).toHaveLength(1);
    expect(pr.jobs.checks!.steps[0]!.uses).toBeUndefined();
    expect(pr.jobs['save-selection']!.needs).toEqual(['select', 'tests']);
    for (const job of Object.values(pr.jobs)) for (const item of job.steps) {
      expect(item.run ?? '').not.toMatch(/npm run (?:-s )?(?:test:e2e|test:herdr:e2e:ci)/);
      if (item.name !== 'Check workflow contract') expect(item.run ?? '').not.toContain('--config packages/herdr/e2e/vitest.config.ts');
    }
  });

  it('runs the named-input sweep on main pushes and for PR selection or policy changes', () => {
    const main = step(workflow('ci').jobs.compile!, 'Check named test inputs');
    expect(main?.run).toBe('node scripts/selection/sweep.mjs');
    expect(main.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    const compile = workflow('pr').jobs.compile!;
    const pr = step(compile, 'Check named test inputs');
    expect(pr?.env?.BASE_SHA).toBe('${{ github.event.pull_request.base.sha }}');
    expect(compile.steps.find(item => item.uses === 'actions/checkout@v4')?.with?.['fetch-depth']).toBe(0);

    const scratch = join(process.cwd(), '.spider/scratch');
    mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(join(scratch, 'sweep-contract-'));
    try {
      mkdirSync(join(root, 'scripts/selection'), { recursive: true });
      writeFileSync(join(root, 'scripts/selection/sweep.mjs'), 'console.log("ran named-input sweep"); process.exitCode = Number(process.env.SWEEP_EXIT);');
      gitAt(root, 'init', '-q');
      const commit = (): string => {
        gitAt(root, 'add', '--', '.');
        gitAt(root, 'commit', '-qm', 'Fixture change');
        return gitAt(root, 'rev-parse', 'HEAD');
      };
      const run = (base: string, exit = '0') => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', pr.run!], {
        cwd: root, env: { ...process.env, BASE_SHA: base, SWEEP_EXIT: exit }, encoding: 'utf8',
      });
      const initial = commit();
      writeFileSync(join(root, 'unrelated.txt'), 'unrelated');
      const product = commit();
      const unneeded = run(initial);
      expect(unneeded.status, unneeded.stderr).toBe(0);
      expect(unneeded.stdout).not.toContain('ran named-input sweep');
      writeFileSync(join(root, 'scripts/test-resources.json'), '{}');
      const policy = commit();
      expect(run(product).stdout).toContain('ran named-input sweep');
      expect(run(product, '17').status).toBe(17);
      writeFileSync(join(root, 'scripts/selection/select.mjs'), 'export {};');
      commit();
      const selection = run(policy);
      expect(selection.status, selection.stderr).toBe(0);
      expect(selection.stdout).toContain('ran named-input sweep');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('selects from the base commit and runs the full head inventory if the base has no selector', () => {
    const selection = workflow('pr').jobs.select!;
    const select = step(selection, 'Select affected tests');
    const headCheckout = selection.steps.find(item => item.uses === 'actions/checkout@v4');
    expect(headCheckout?.with).toMatchObject({ ref: '${{ github.event.pull_request.head.sha }}',
      'fetch-depth': 0, 'persist-credentials': false });
    expect(select.env?.BASE_SHA).toBe('${{ github.event.pull_request.base.sha }}');

    const scratch = join(process.cwd(), '.spider/scratch');
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, 'base-selector-contract-'));
    const root = join(directory, 'head'), temp = join(directory, 'runner');
    mkdirSync(temp, { recursive: true });
    const output = join(root, '.spider/scratch/test-results/test-selection.json');
    const firstTest = 'packages/example/src/a.test.ts', newTest = 'packages/example/src/b.test.ts';
    const write = (file: string, text: string): void => {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    try {
      write('scripts/test-shards.ts', readFileSync(join(process.cwd(), 'scripts/test-shards.ts'), 'utf8'));
      write('scripts/test-durations.json', JSON.stringify({ [firstTest]: 120 }));
      write(firstTest, 'export {};');
      gitAt(root, 'init', '-q');
      const commit = (): string => {
        gitAt(root, 'add', '--', 'scripts', 'packages');
        gitAt(root, 'commit', '-qm', 'Fixture change');
        return gitAt(root, 'rev-parse', 'HEAD');
      };
      const legacy = commit();
      write('scripts/test-resources.json', '{"label":"base policy"}');
      write('scripts/roam-entries.json', '{"label":"base entries"}');
      write('scripts/selection/sidecar.mjs', 'export const marker = "base selector";');
      write('scripts/selection/select.mjs', `
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { marker } from './sidecar.mjs';
const [base, output] = process.argv.slice(2);
const read = file => JSON.parse(readFileSync(new URL('../' + file, import.meta.url), 'utf8')).label;
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const changes = execFileSync('git', ['diff', '--name-only', base, head], { encoding: 'utf8' }).trim().split('\\n');
writeFileSync(output, JSON.stringify({ marker, base, head, changes, policy: read('test-resources.json'), entries: read('roam-entries.json') }));
`);
      const base = commit();
      write('scripts/selection/select.mjs', `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[3], '{"marker":"head selector"}');`);
      write('scripts/test-resources.json', '{"label":"head policy"}');
      write('scripts/roam-entries.json', '{"label":"head entries"}');
      write('scripts/test-shards.ts', 'throw new Error("Used head partitioner");');
      write(newTest, 'export {};');
      write('packages/example/skip.test.ts', 'export {};');
      const head = commit();
      mkdirSync(join(root, 'node_modules'));
      mkdirSync(join(root, '.spider/scratch/test-results'), { recursive: true });
      const run = (baseSha: string): Record<string, unknown> => {
        const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', select.run!], { cwd: root,
          env: { ...process.env, RUNNER_TEMP: temp, BASE_SHA: baseSha, GITHUB_OUTPUT: join(directory, 'output'), GITHUB_STEP_SUMMARY: join(directory, 'summary') }, encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>;
      };
      expect(run(base)).toMatchObject({ marker: 'base selector', base, head, policy: 'base policy', entries: 'base entries',
        changes: expect.arrayContaining([newTest, 'scripts/selection/select.mjs']) });
      const { selectionHash, ...manifest } = run(legacy);
      expect(manifest).toMatchObject({ version: 1, head, mode: 'full', mapRunId: null, mapCommit: null,
        fallback: 'base commit has no selector', groups: [[firstTest], [newTest], [], []] });
      expect(Object.keys(manifest.selected as object)).toEqual([firstTest, newTest]);
      expect(selectionHash).toBe(createHash('sha256').update(JSON.stringify(manifest)).digest('hex'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('sets explicit timeouts for every runner job', () => {
    for (const name of ['ci', 'pr', 'release', 'publish']) for (const job of Object.values(workflow(name).jobs)) {
      if (!job.uses) expect(job['timeout-minutes']).toBeGreaterThan(0);
    }
    const expected = { ci: { checks: 2, compile: 10, test: 25, 'herdr-acceptance': 10, chrome: 10, audit: 5 },
      pr: { compile: 10, select: 10, tests: 30, checks: 5, 'save-selection': 5 } };
    for (const [name, jobs] of Object.entries(expected)) for (const [id, timeout] of Object.entries(jobs)) {
      expect(workflow(name).jobs[id]!['timeout-minutes'], `${name}:${id}`).toBe(timeout);
    }
  });

  it('uses the npm cache in installing jobs and names the required check once per workflow', () => {
    for (const name of ['ci', 'pr']) {
      expect(source(name).split('typecheck · test · build')).toHaveLength(2);
      for (const [id, job] of Object.entries(workflow(name).jobs)) {
        if (!job.steps?.some(item => /\bnpm ci\b/.test(item.run ?? ''))) continue;
        const node = job.steps.find(item => item.uses === 'actions/setup-node@v4');
        expect(node?.with?.cache, `${name}:${id}`).toBe('npm');
      }
    }
  });

  it('matches the shard matrix to the command and saves JSON timing reports from every shard', () => {
    const job = workflow('ci').jobs.test!;
    const matrix = job.strategy!.matrix;
    expect(matrix.shard).toEqual(Array.from({ length: 6 }, (_, index) => index + 1));
    const test = step(job, 'Test shard');
    expect(test.run).toContain('vitest run --shard=${{ matrix.shard }}/6 --maxWorkers=2');
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
    expect(artifact.with!.path).toContain('.spider/scratch/test-results/shard-${{ matrix.shard }}.json');
    expect(artifact.with!.path).toContain('.spider/scratch/test-results/shard-${{ matrix.shard }}.count');
    expect(step(job, 'Prepare isolated scratch').run).toContain('${{ strategy.job-total }}');
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
