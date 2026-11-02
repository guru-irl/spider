// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Read-only fixture observer: records public pi events and mode to <SPIDER_E2E_OBSERVER_DIR>/<pid>.jsonl and answers
// draft queries with ctx.ui.getEditorText() on <dir>/<pid>.s. It never changes results, status, or session state.
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export default function (pi: ExtensionAPI): void {
  const directory = process.env.SPIDER_E2E_OBSERVER_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  const log = join(directory, `${process.pid}.jsonl`), socketPath = join(directory, `${process.pid}.s`);
  let latest: ExtensionContext | undefined; let server: Server | undefined;
  const record = (type: string, fields: Record<string, unknown> = {}) => appendFileSync(log, JSON.stringify({ at: Date.now(), pid: process.pid, type, ...fields }) + '\n');
  const session = (ctx: ExtensionContext) => { latest = ctx; return { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() ?? null }; };
  const serve = () => {
    if (server) return;
    rmSync(socketPath, { force: true });
    server = createServer(socket => {
      let buffer = '';
      socket.on('data', data => {
        buffer += data.toString('utf8'); const newline = buffer.indexOf('\n'); if (newline < 0) return;
        let request: { op?: unknown };
        try { request = JSON.parse(buffer.slice(0, newline)); } catch { socket.end(JSON.stringify({ error: 'malformed' }) + '\n'); return; }
        if (request.op === 'draft' && latest?.mode === 'tui') socket.end(JSON.stringify({ draft: latest.ui.getEditorText() }) + '\n');
        else socket.end(JSON.stringify({ error: latest ? `unsupported in ${latest.mode}` : 'no context' }) + '\n');
      });
    });
    server.listen(socketPath);
    server.unref();
  };
  pi.on('session_start', (event, ctx) => { record('session_start', { reason: (event as { reason?: string }).reason ?? null, mode: ctx.mode, hasUI: ctx.hasUI, cwd: ctx.cwd, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null, hcTerminal: process.env.HC_TERMINAL_ID ?? null, hcScopeHash: process.env.HC_SCOPE ? createHash('sha256').update(process.env.HC_SCOPE).digest('hex') : null, subagentChild: process.env.PI_SUBAGENT_CHILD ?? null, probe: process.env.SPIDER_E2E_PROBE ?? null, stdinTTY: process.stdin.isTTY === true, ...session(ctx) }); serve(); });
  pi.on('tool_execution_start', (event, ctx) => { latest = ctx; record('tool_execution_start', { toolCallId: event.toolCallId, toolName: event.toolName }); });
  pi.on('tool_execution_end', (event, ctx) => { latest = ctx; record('tool_execution_end', { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, result: event.result }); });
  pi.on('message_end', (event, ctx) => {
    latest = ctx; const m = event.message as { role?: string; stopReason?: string; errorMessage?: string; content?: unknown; customType?: string };
    record('message_end', { role: m.role, stopReason: m.stopReason ?? null, errorMessage: m.errorMessage ?? null, customType: m.customType ?? null, content: m.content });
  });
  pi.on('agent_end', (_event, ctx) => { latest = ctx; record('agent_end'); });
  pi.on('agent_settled', (_event, ctx) => { latest = ctx; record('agent_settled', session(ctx)); });
  pi.on('session_shutdown', (event) => { record('session_shutdown', { reason: (event as { reason?: string }).reason ?? null }); server?.close(); server = undefined; rmSync(socketPath, { force: true }); });
}
