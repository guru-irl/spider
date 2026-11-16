// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createAppClient } from '@spider/herdr/client/app';
import { createHcClient } from '@spider/herdr/client/hc';
import { HerdrError, object } from '@spider/herdr/client/parse';
import type { HcClient, HerdrConfig } from '@spider/herdr/contracts';
import { createRoamPresentationOperations, type RoamPresentationOperations } from '@spider/herdr/roam-placement';
import type { PaneTarget, PaneActionOutcome } from '@spider/herdr/panes/types';
import { readPrivateJson } from '@spider/herdr/sessions/registry';
import { loadHerdrConfig } from '@spider/roam/host-config';
import { createPaneRuntime, type PaneRuntime } from './pane-runtime.js';

export interface RoamPresentationPorts extends RoamPresentationOperations {
  resolveTarget(locator: { sessionId: string; machineId: string; homeEpoch: number; coreId?: string; terminalId?: string; local?: boolean }): Promise<PaneTarget | null>;
  dispose(): Promise<void>;
}

/** Share the presentation service without loading CLI, setup, or pi APIs. */
export async function createRoamPresentationPorts(input: {
  config: HerdrConfig; env: Readonly<NodeJS.ProcessEnv>; client(): HcClient; runtime(): Promise<PaneRuntime>;
}): Promise<RoamPresentationPorts> {
  const { config, env } = input;
  if (config.mode === 'core-only') {
    const pending = async (): Promise<PaneActionOutcome> => ({ status: 'pending', reason: 'presentation-unavailable', presentation: null });
    return { resolveTarget: async () => null, prepareHandoff: pending, presentReadyTarget: pending, dispose: async () => {} };
  }
  const runtime = await input.runtime();
  const call: Parameters<typeof createRoamPresentationOperations>[0]['request'] = async request => {
    const connection = await runtime.connect(); try { return await connection.request(request); } finally { await connection.stop(); }
  };
  const operations = createRoamPresentationOperations({ stateRoot: join(config.globalRoot, 'roam', 'placement'), hc: input.client(),
    app: createAppClient({ binary: config.app.binary, env: { ...env, HERDR_APP_HOME: config.app.home } }), request: call });
  return { ...operations, dispose: async () => {}, async resolveTarget(locator) {
    const reply = await call({ version: 1, op: 'snapshot', operationId: randomBytes(16).toString('hex') });
    if (reply.kind !== 'snapshot') return null;
    const localCore = reply.machines.find(machine => machine.alias === null)?.coreId;
    const targets = [...reply.rows.flatMap(row => row.target ? [row.target] : []), ...reply.presentations.map(p => p.target)].filter(target => target.kind === 'session' && (!locator.local || target.coreId === localCore) && target.sessionId === locator.sessionId && target.homeEpoch === locator.homeEpoch && target.generation !== null && target.createdMs > 0 && (!locator.coreId || target.coreId === locator.coreId) && (!locator.terminalId || target.terminalId === locator.terminalId));
    const unique = [...new Map(targets.map(target => [JSON.stringify([target.coreId, target.terminalId, target.createdMs, target.generation]), target])).values()];
    return unique.length === 1 ? unique[0] : null;
  } };
}

export function createProductionRoamPresentationPorts(globalRoot: string): RoamPresentationPorts {
  let hc: ReturnType<typeof createHcClient> | undefined, runtime: PaneRuntime | undefined;
  let opened: Promise<RoamPresentationPorts> | undefined;
  const dispose = async () => { try { await runtime?.dispose(); } finally { await hc?.dispose(); } };
  const open = () => opened ??= (async () => {
    const config = loadHerdrConfig(globalRoot), env = { ...process.env, SPIDER_GLOBAL_ROOT: globalRoot };
    return createRoamPresentationPorts({ config, env, client: () => hc ??= createHcClient({ binary: config.core.binary, env }), async runtime() {
      const installed = object(await readPrivateJson(join(globalRoot, 'herdr', 'installation.json')));
      if (installed.version !== 1 || typeof installed.packageRoot !== 'string' || !isAbsolute(installed.packageRoot)) throw new HerdrError('pane-installation-missing', 'Presentation installation is unavailable');
      const packageRoot = installed.packageRoot, endpointBytes = await readFile(join(packageRoot, 'dist/herdr/pane-endpoint.mjs'));
      return runtime ??= createPaneRuntime({ config, env, packageRoot, endpointBytes, hc: hc ??= createHcClient({ binary: config.core.binary, env }) });
    } });
  })().catch(async error => { await dispose(); runtime = undefined; hc = undefined; opened = undefined; throw error; });
  return {
    resolveTarget: async locator => (await open()).resolveTarget(locator),
    prepareHandoff: async (session, source) => (await open()).prepareHandoff(session, source),
    presentReadyTarget: async target => (await open()).presentReadyTarget(target), dispose,
  };
}
