// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const workflow = file => parse(readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8'));
const map = workflow('selection-map.yml');

test('automatic maps wait for main CI, use its commit, and share its runner lock', () => {
  const ci = workflow('ci.yml');
  assert.equal(map.on.push, undefined);
  assert.deepEqual(map.on.workflow_run, { workflows: ['CI'], branches: ['main'], types: ['completed'] });
  const mainLock = 'ci-CI-refs/heads/main';
  assert.equal(ci.concurrency.group,
    `\${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && '${mainLock}' || format('ci-{0}', github.run_id) }}`);
  assert.ok(map.concurrency.group.includes(`'${mainLock}'`));
  for (const { concurrency } of [ci, map]) {
    assert.equal(concurrency['cancel-in-progress'], false);
    assert.equal(concurrency.queue, 'max');
  }
  assert.equal(workflow('pr.yml').concurrency['cancel-in-progress'], true);
  assert.match(map.jobs.eligible.if, /workflow_run\.event == 'push'/);
  assert.match(map.jobs.eligible.if, /workflow_run\.head_sha == github\.sha/);
  assert.equal(map.jobs.record.needs, 'eligible');
  assert.match(map.jobs.record.if, /needs\.eligible\.outputs\.record == 'true'/);
  assert.match(map.jobs.eligible.steps[0].run, /git\/ref\/heads\/main/);
  for (const job of [map.jobs.record, map.jobs['selection-map']]) {
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ github.sha }}');
    assert.equal(checkout.with['persist-credentials'], false);
  }
});

test('manual main maps share the main queue and record only the current commit', t => {
  // These expressions use the same boolean operators as JavaScript. Evaluate
  // the workflow values against the event instead of matching their spelling.
  const eligible = new Function('github', `return (${map.jobs.eligible.if});`);
  const group = new Function('github', 'format', `return (${map.concurrency.group.slice(3, -2)});`);
  const event = { event_name: 'workflow_dispatch', run_id: 3 };
  const main = { ...event, ref: 'refs/heads/main' }, canary = { ...event, ref: 'refs/heads/canary' };
  const format = (template, id) => template.replace('{0}', id);
  assert.equal(eligible(main), true);
  assert.equal(group(main, format), 'ci-CI-refs/heads/main');
  assert.equal(eligible(canary), true);
  assert.equal(group(canary, format), 'selection-map-3');

  const scratch = resolve('.spider/scratch');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'manual-map-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\n[ "$2" = "repos/example/spider/git/ref/heads/main" ] || exit 64\nprintenv MAIN_TIP\n', { mode: 0o700 });
  const output = join(dir, 'output');
  const sha = 'a'.repeat(40);
  const run = (ref, tip) => spawnSync('bash', ['-e', '-c', map.jobs.eligible.steps[0].run], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_EVENT_NAME: event.event_name,
      GITHUB_REPOSITORY: 'example/spider', GITHUB_REF: ref, GITHUB_SHA: sha, GITHUB_OUTPUT: output, MAIN_TIP: tip },
    encoding: 'utf8',
  });
  const stale = run(main.ref, 'b'.repeat(40));
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, /Main advanced/);
  assert.equal(existsSync(output), false);
  for (const [ref, tip] of [[main.ref, sha], [canary.ref, '']]) {
    const result = run(ref, tip);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(readFileSync(output, 'utf8'), 'record=true\nrecord=true\n');
});

test('a scoreboard failure cannot stop a valid map from being published', () => {
  const steps = map.jobs['selection-map'].steps;
  const upload = steps.findIndex(step => step.with?.name === 'selection-map');
  const scoreboard = steps.findIndex(step => step.run?.includes('scoreboard.mjs'));
  assert.ok(upload >= 0 && scoreboard > upload);
  assert.equal(steps[upload].with.path, 'selection-map.json');
  assert.equal(steps[scoreboard]['continue-on-error'], true);
  const preflight = map.jobs.record.steps.find(step => step.name?.startsWith('Test recorder'));
  assert.doesNotMatch(preflight.run, /scoreboard|\*\.test\.mjs/);
});
