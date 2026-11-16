// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdir } from 'node:fs/promises';
import { atomicRuntimeFile } from '../remote/runtime.js';
import { dirname, join } from 'node:path';
import type { HcClient } from '../contracts.js';
import { ensureAgentConsole, openAgentConsoleView, type AgentConsoleLaunch, type AgentConsoleHandle } from '../remote/console.js';
/** The fixture simulates an acknowledged display; command execution never calls this. */
export async function openRetainedConsole(request: AgentConsoleLaunch, hc: HcClient, env: Readonly<NodeJS.ProcessEnv> = process.env): Promise<AgentConsoleHandle | null> {
  const store = await ensureAgentConsole(request, hc, env); if (!store) return null;
  const displayLeaseFile = join(store.directory, 'fixture-display-lease.json');
  await mkdir(dirname(displayLeaseFile), { recursive: true, mode: 0o700 });
  await atomicRuntimeFile(displayLeaseFile, JSON.stringify({ version: 1, sessionId: request.owner.sessionId, generation: request.owner.generation, consoleId: store.consoleId,
    runId: env.PI_SUBAGENT_CHILD === '1' ? env.PI_SUBAGENT_RUN_ID : null, expiresAt: Date.now() + 20000 }));
  // Both isolated core fixtures share this test filesystem; emulate the private remote lease publication.
  return openAgentConsoleView({ ...request, job: undefined, displayLeaseFile }, hc, env);
}
