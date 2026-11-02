// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Offline scripted provider for e2e fixtures. No network. Turns are selected by a `[[e2e:<marker>]]` marker in the
// conversation and by how many assistant turns already followed it. Steps are text, a provider error, a real tool
// call that pi executes, or a wait on a fixture-owned gate. Unknown markers and exhausted scripts are provider errors.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject } from '@earendil-works/pi-ai';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

export const PROVIDER = 'e2e-fixture';
export const MODEL = 'scripted';
export type ScriptStep =
  | { text: string }
  | { error: string }
  | { tool: { id: string; name: string; arguments: JsonObject } }
  | { gate: string };
export interface ScriptTurn { steps: ScriptStep[] }
export interface ScriptFile { story: string; scripts: Record<string, ScriptTurn[]> }
export const marker = (name: string) => `[[e2e:${name}]]`;

type Message = { role?: string; content?: unknown; stopReason?: string };
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') ? part.text : '').join('');
  return '';
}
/** The latest marker in a user message wins; the turn index is the number of assistant messages after it. */
export function selectTurn(messages: readonly Message[], scripts: ScriptFile['scripts']): { marker: string; index: number; turn: ScriptTurn } | { error: string } {
  let at = -1, name = '';
  messages.forEach((m, i) => { if (m.role === 'user') { const found = [...textOf(m.content).matchAll(/\[\[e2e:([A-Za-z0-9_.-]+)\]\]/g)].at(-1); if (found) { at = i; name = found[1]; } } });
  if (at < 0) return { error: 'e2e-script: no [[e2e:<marker>]] in the conversation' };
  const turns = scripts[name];
  if (!turns) return { error: `e2e-script: unknown marker ${name}` };
  const index = messages.slice(at + 1).filter(m => m.role === 'assistant').length;
  if (index >= turns.length) return { error: `e2e-script: script ${name} exhausted after ${turns.length} turns` };
  return { marker: name, index, turn: turns[index] };
}

let gateStep = 0;
/** Ready, then wait for the matching release. Closing, malformed replies and mismatched releases are errors. */
function awaitGate(socketPath: string, message: { story: string; gate: string; marker: string }, signal?: AbortSignal): Promise<void> {
  const step = ++gateStep;
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '', settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; signal?.removeEventListener('abort', onAbort); socket.destroy(); if (error) reject(error); else resolve(); };
    const onAbort = () => finish(new Error(`gate-aborted: request aborted at gate ${message.gate}`));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'ready', ...message, step, pid: process.pid }) + '\n'));
    socket.on('data', data => {
      buffer += data.toString('utf8');
      const newline = buffer.indexOf('\n'); if (newline < 0) return;
      let reply: { type?: unknown; story?: unknown; gate?: unknown; step?: unknown };
      try { reply = JSON.parse(buffer.slice(0, newline)); } catch { return finish(new Error(`gate-malformed: unparseable release for gate ${message.gate}`)); }
      if (reply.type !== 'release' || reply.story !== message.story || reply.gate !== message.gate || reply.step !== step) return finish(new Error(`gate-release-mismatch: expected ${message.story}/${message.gate}#${step}, got ${JSON.stringify(reply)}`));
      finish();
    });
    socket.on('error', error => finish(new Error(`gate-aborted: ${error.message}`)));
    socket.on('close', () => finish(new Error(`gate-aborted: control connection closed at gate ${message.gate}`)));
  });
}

export default function (pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER, {
    baseUrl: 'https://offline.invalid', apiKey: 'fixture-only', api: 'e2e-fixture-api',
    models: [{ id: MODEL, name: 'Scripted fixture', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 8000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(), stopReason: 'stop' };
      const fail = (text: string, reason: 'error' | 'aborted' = 'error') => {
        message.stopReason = reason; message.errorMessage = text;
        stream.push({ type: 'error', reason, error: message }); stream.end();
      };
      stream.push({ type: 'start', partial: message });
      void (async () => {
        const path = process.env.SPIDER_E2E_SCRIPT;
        if (!path) return fail('e2e-script: SPIDER_E2E_SCRIPT is not set');
        let file: ScriptFile;
        try { file = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { return fail(`e2e-script: unreadable script ${String(error)}`); }
        const selected = selectTurn((context as { messages: Message[] }).messages, file.scripts);
        if ('error' in selected) return fail(selected.error);
        let usedTools = false;
        for (const step of selected.turn.steps) {
          if (options?.signal?.aborted) return fail('e2e-script: aborted', 'aborted');
          if ('gate' in step) {
            const socket = process.env.SPIDER_E2E_GATE_SOCKET;
            if (!socket) return fail('gate-missing: SPIDER_E2E_GATE_SOCKET is not set');
            try { await awaitGate(socket, { story: file.story, gate: step.gate, marker: selected.marker }, options?.signal); }
            catch (error) { return fail(String((error as Error).message), options?.signal?.aborted ? 'aborted' : 'error'); }
          } else if ('error' in step) return fail(step.error);
          else if ('text' in step) {
            const index = message.content.length; message.content.push({ type: 'text', text: '' });
            stream.push({ type: 'text_start', contentIndex: index, partial: message });
            (message.content[index] as { text: string }).text = step.text;
            stream.push({ type: 'text_delta', contentIndex: index, delta: step.text, partial: message });
            stream.push({ type: 'text_end', contentIndex: index, content: step.text, partial: message });
          } else {
            usedTools = true;
            const index = message.content.length;
            const call = { type: 'toolCall' as const, id: step.tool.id, name: step.tool.name, arguments: step.tool.arguments };
            message.content.push({ ...call, arguments: {} });
            stream.push({ type: 'toolcall_start', contentIndex: index, partial: message });
            message.content[index] = call;
            stream.push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(step.tool.arguments), partial: message });
            stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: call, partial: message });
          }
        }
        message.stopReason = usedTools ? 'toolUse' : 'stop';
        stream.push({ type: 'done', reason: usedTools ? 'toolUse' : 'stop', message }); stream.end();
      })().catch(error => fail(`e2e-script: ${String(error)}`));
      return stream;
    },
  });
}
