// SPDX-License-Identifier: MIT
import { readFile, writeFile } from 'node:fs/promises';
import { createHcClient } from '../client/hc.js';
import { createJobMonitor } from '../jobs/monitor.js';
import { processStartIdentity } from '../jobs/handoff.js';
import { parseHerdrConfig } from '../config.js';
import { runtimeInstallPath } from '../setup/installer.js';
import { sha256 } from '../remote/runtime.js';
import { createHostHerdrPorts } from '../../../host/src/herdr/ports.js';
import { prepareRemoteProgram } from '../../../context/src/remote-plan.js';
import type { Owner, RunId, RuntimeTarget } from '../contracts.js';

const input = JSON.parse(await readFile(process.argv[2], 'utf8')) as {
  owner: Owner; runId?: RunId; configFile: string; runtimeFile: string; journalRoot: string; readyFile: string; foreground: string; background: string;
};
const config = parseHerdrConfig(JSON.parse(await readFile(input.configFile, 'utf8')));
const runtime = await readFile(input.runtimeFile);
const runtimePath = runtimeInstallPath(config.machines[0].runtime.directory, runtime);
// The remote originals must not inherit hc parenting from the caller terminal.
const env = { ...process.env }; delete env.HC_TERMINAL_ID; delete env.HC_TERMINAL_SOCKET;
const hc = createHcClient({ binary: config.core.binary, env });
const ports = createHostHerdrPorts({ hc, config, runtimeBytes: runtime, runtimePath: () => runtimePath });
const jobs = createJobMonitor({ hc, journalRoot: input.journalRoot, outputCollector: ports.outputCollector,
  ...(input.runId ? { child: { id: input.runId, pid: process.pid, startIdentity: processStartIdentity(process.pid)! } } : {}),
  clock: Date.now, observedJobMessages: async () => [], notifier: () => { throw new Error('Owner must be killed before completion'); }, reportError: error => { console.error(error); },
});
const target: RuntimeTarget = { on: config.machines[0].name, ...config.machines[0].runtime, nodePath: process.execPath,
  runtimePath, runtimeSha256: sha256(runtime), environment: {},
};
const background = await jobs.start(await prepareRemoteProgram({ kind: 'code', language: 'shell', code: input.background }, target), input.owner, target.on, { background: true });
const foreground = await jobs.start(await prepareRemoteProgram({ kind: 'code', language: 'shell', code: input.foreground }, target), input.owner, target.on, {});
await writeFile(input.readyFile, JSON.stringify({ pid: process.pid, foreground: { id: foreground.id, address: foreground.address }, background: { id: background.id, address: background.address } }));
await foreground.finished;
throw new Error('Foreground waiter unexpectedly returned before the owner crash');
