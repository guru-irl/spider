// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { randomBytes } from 'node:crypto';
import { copyFile, chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import type { JsonObject } from '@earendil-works/pi-ai';
import type { ScriptTurn } from '../scripted-provider.js';
import { marker } from '../scripted-provider.js';
import { HarnessError, type OwnedPath } from '../../harness/environment.js';
import { writeScript, type InteractiveDriver, type ObservedEvent } from '../../harness/pi.js';
import type { Suite } from '../../harness/suite.js';
import { deadline, waitFor } from '../../harness/wait.js';

export const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export const scripted = (id: string, name: string, args: JsonObject): ScriptTurn[] => [
  { steps: [{ tool: { id, name, arguments: args } }] },
  { steps: [{ text: `fixture tool complete: ${id}` }] },
];

export async function transportRecords(path: string): Promise<{ argv: string[] }[]> {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

export interface ActiveRouting {
  suite: Suite; driver: InteractiveDriver; cwd: OwnedPath; sentinel: OwnedPath; log: OwnedPath;
  env: Record<string, string>; cache: { path: string; value: unknown };
  records(): Promise<{ argv: string[] }[]>;
}

/** Called after actual packed setup. The product still owns its activation, policy, cache and shim. */
export async function launchActiveRouting(suite: Suite, scripts: Record<string, ScriptTurn[]>, extraEnv: Record<string, string> = {}): Promise<ActiveRouting> {
  if (!suite.cores) throw new HarnessError('missing-prerequisite', 'active routing needs the owned cores');
  const sentinel = suite.ownPath(join(suite.pi.bin, 'ssh'));
  const tag = randomBytes(4).toString('hex');
  const log = suite.ownPath(join(suite.root, `active-transport-${tag}.jsonl`));
  await copyFile(resolve('packages/herdr/e2e/fixtures/transports/ssh-sentinel.mjs'), sentinel);
  await chmod(sentinel, 0o700);
  const configPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  // The documented opt-out makes native model-issued bash available in these routing stories.
  await writeFile(configPath, JSON.stringify({ ...config, 'exec.enforce': false }));
  await writeScript(suite.pi.scriptPath, { story: suite.story, scripts });
  const cwd = await suite.project('routing-parent');
  const env = { ...extraEnv, FIXTURE_TRANSPORT_LOG: log, FIXTURE_TRANSPORT_SKIP_INPUT: '1' };
  const driver = await suite.launchPi({ mode: 'interactive', cwd, label: 'routing-parent', extraEnv: env });
  if (driver.mode !== 'interactive') throw new HarnessError('missing-prerequisite', 'an owned interactive terminal is required');
  try {
    const start = await driver.waitEvent('session_start', () => true, deadline(60_000));
    expect(start).toMatchObject({ mode: 'tui', hcTerminal: driver.terminal });
    if (typeof start.sessionId !== 'string') throw new Error('pi did not report its session ID');
    const feedPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr/sessions', start.sessionId, 'session.json');
    const feed = await waitFor('active parent feed', async () => {
      try { return JSON.parse(await readFile(feedPath, 'utf8')); } catch { return null; }
    }, value => value?.owner?.terminal?.coreId === suite.cores!.local.coreId && value?.owner?.terminal?.address === driver.terminal, deadline(60_000));
    const cacheDirectory = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr/ssh');
    const cache = await waitFor('actual parent machine cache', async () => {
      for (const name of await readdir(cacheDirectory).catch(() => [])) {
        if (!name.endsWith('.json')) continue;
        const path = join(cacheDirectory, name);
        try {
          const value = JSON.parse(await readFile(path, 'utf8'));
          if (value.identity?.coreId === suite.cores!.local.coreId && value.machines?.some((machine: { name?: string }) => machine.name === suite.cores!.machine)) return { path, value };
        } catch { /* wait for the real cache publication */ }
      }
      return null;
    }, value => value !== null, deadline(60_000));
    await suite.evidence(`routing-activation-${tag}.json`, { start, feed, cache });
    return { suite, driver, cwd, sentinel, log, env, cache: cache!, records: (): Promise<{ argv: string[] }[]> => transportRecords(log) };
  } catch (error) { await driver.close(); throw error; }
}

/** Each marker and call ID is unique within the story, so a prior result cannot satisfy the wait. */
export async function runTool(driver: InteractiveDriver, name: string, callId: string): Promise<ObservedEvent> {
  const settled = (await driver.events()).filter(event => event.type === 'agent_settled').length;
  await driver.prompt(`${marker(name)} execute the routing fixture`);
  const result = await driver.toolResult(callId, deadline(90_000));
  await driver.waitEvent('message_end', event => event.role === 'assistant' && JSON.stringify(event.content).includes(`fixture tool complete: ${callId}`), deadline(90_000));
  await waitFor('new parent turn settles', () => driver.events(), events => events.filter(event => event.type === 'agent_settled').length > settled, deadline(90_000));
  return result;
}
