// SPDX-License-Identifier: MIT
import { createInterface } from 'node:readline';
import { createBashTool } from '@earendil-works/pi-coding-agent';
import { mountHerdr } from '../../../host/src/herdr/mount.js';
import { runExec, runExecFile, runBatch } from '../../../context/src/actions/exec.js';
const handlers = new Map<string, Function[]>();
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const pi = { on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); return () => handlers.set(name, (handlers.get(name) ?? []).filter(f => f !== fn)); }, sendMessage(message: unknown) { send({ type: 'notice', message }); }, registerTool() {}, registerShortcut() { throw new Error('child shortcut initialization'); } };
const ctx = { cwd: process.env.SPIDER_CHILD_FIXTURE_CWD!, mode: 'rpc', hasUI: false, ui: { notify() {}, setWidget() { throw new Error('child status initialization'); } }, sessionManager: { getSessionId: () => 'child-session', getSessionFile: () => undefined, getBranch: () => [] } };
const mount = mountHerdr(pi as never, { packageRoot: process.env.SPIDER_CHILD_FIXTURE_PACKAGE!, actionContext: () => { throw new Error('child parent action context'); }, reportError: error => send({ type: 'monitor-error', error: String(error) }), views: { agents: { open: async () => { throw new Error('child view'); } }, todos: { handler: async () => {} }, usage: { handler: async () => {} }, memory: async () => {}, loop: { handler: async () => {} } } });
async function emit(name: string, event: unknown) { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); }
await emit('session_start', { reason: 'startup' }); send({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  try {
    const refusal = await mount.guard({ toolName: command.action === 'bash' ? 'bash' : 'spider', input: command });
    if (refusal) { send({ type: 'refused', id: command.id, reason: refusal.reason }); continue; }
    if (command.action === 'bash') { send({ type: 'result', id: command.id, result: await createBashTool(ctx.cwd).execute(command.id, { command: command.command }, undefined, undefined) }); continue; }
    const action = command.action === 'exec_file' ? runExecFile : command.action === 'batch' ? runBatch : runExec;
    const result = await action(command, { cwd: ctx.cwd, ...mount.execution() });
    send({ type: 'result', id: command.id, result });
  } catch (error) { send({ type: 'error', id: command.id, error: String(error) }); }
}
await emit('session_shutdown', { reason: 'quit' }); await mount.dispose();
