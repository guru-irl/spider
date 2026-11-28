// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const workflow = file => parse(readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8'));
const map = workflow('selection-map.yml');

test('automatic maps wait for main CI, use its commit, and share its runner lock', () => {
  const ci = workflow('ci.yml');
  assert.equal(map.on.push, undefined);
  assert.deepEqual(map.on.workflow_run, { workflows: ['CI'], branches: ['main'], types: ['completed'] });
  const mainLock = ci.concurrency.group.includes('ci-main') ? 'ci-main' : 'ci-CI-refs/heads/main';
  assert.ok(map.concurrency.group.toLowerCase().includes(`'${mainLock.toLowerCase()}'`));
  assert.equal(map.concurrency['cancel-in-progress'], false);
  assert.equal(map.concurrency.queue, 'max');
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
