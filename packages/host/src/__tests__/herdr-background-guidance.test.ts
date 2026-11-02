// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SPIDER_PARAMETERS } from '../extension.js';
import { runExec } from '../../../context/src/actions/exec.js';
import { writeAgentsMd } from '../../../superpowers/src/agentsmd.js';

it('describes the remote background completion notice in the tool schema', () => {
  const description = SPIDER_PARAMETERS.properties.background.description;
  expect(description).toContain('spider.job_done');
  expect(description).toMatch(/remote|on/i);
  expect(description).toMatch(/do not poll|don.t poll/i);
});

it('tells a detached remote caller to wait for the notice instead of polling', async () => {
  const remote = { execute: async () => ({ stdout: '', stderr: '', outcome: 'timeout', exitCode: null, timedOut: true,
    backgrounded: true, remote: { jobId: 'job-1', machine: 'alpha.invalid', address: 'alpha.invalid/t1' },
    backgroundJob: { id: 'job-1', dir: '/job', manifest: '/job/job.json', receipt: '/job/receipt.json', logs: { stdout: '/job/stdout.log', stderr: '/job/stderr.log' } },
    backgroundLogs: { stdout: '/job/stdout.log', stderr: '/job/stderr.log' },
  }) };
  const result = await runExec({ on: 'alpha.invalid', language: 'shell', code: 'true', background: true, timeout: 1 }, { cwd: process.cwd(), owner: {} as never, remote: remote as never });
  expect(result.text).toContain('spider.job_done');
  expect(result.text).toMatch(/do not poll|don.t poll/i);
  expect(result.text).not.toMatch(/tail the logs|re-check with another exec/i);
});

it('writes the background notice and no-poll rule in the Herdr agent instructions', async () => {
  const root = await mkdtemp(resolve('.spider/scratch/tmp/agents-guidance-'));
  try {
    const path = join(root, 'AGENTS.md');
    writeAgentsMd(path);
    const text = await readFile(path, 'utf8');
    const herdr = text.slice(text.indexOf('## Herdr terminals'));
    expect(herdr).toContain('background:true');
    expect(herdr).toContain('spider.job_done');
    expect(herdr).toMatch(/don.t.*poll.*schedule/i);
    expect(text).toMatch(/(?:never|not).*remote.*jobs/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
