import assert from 'node:assert/strict';
import { beforeEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type * as Pi from '@earendil-works/pi-coding-agent';

const observed = vi.hoisted(() => ({ summaryCalls: [] as any[] }));
export const summaryCalls: any[] = observed.summaryCalls;
vi.mock('@earendil-works/pi-coding-agent', async importOriginal => {
  const actual = await importOriginal<typeof Pi>();
  return { ...actual, generateSummaryWithUsage: (...args: Parameters<typeof Pi.generateSummaryWithUsage>) => {
    const [currentMessages, model, reserveTokens, , , signal, customInstructions, previousSummary, thinkingLevel, , , retry] = args;
    observed.summaryCalls.push({ currentMessages, model, reserveTokens, signal, customInstructions, previousSummary, thinkingLevel, retry });
    return actual.generateSummaryWithUsage(...args);
  } };
});

export const ROOT: string = resolve('.spider/scratch/compaction-move/tests', String(process.pid));
const agentDir = `${ROOT}/agent`;
mkdirSync(agentDir, { recursive: true });
mkdirSync(`${ROOT}/test/cwd`, { recursive: true });
const modelsPath = `${ROOT}/models.fixture.json`;
writeFileSync(modelsPath, JSON.stringify({ providers: { 'fixture-provider': {
  modelOverrides: { 'session-model': { compactAtPercent: 50 } },
} } }));
writeFileSync(`${agentDir}/settings.json`, JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 20, reserveTokens: 1000 }, retry: { enabled: false } }));

// Missing implementation is an assertion failure, not an unresolved-import RED.
const implementationPath = '../index.js';
const moved = await import(implementationPath);
const install = moved.registerCompaction ?? (() => {});
export const USAGE: any = { input: 137, output: 31, cacheRead: 7, cacheWrite: 0, totalTokens: 175, cost: { input: 0.02, output: 0.03, cacheRead: 0.001, cacheWrite: 0, total: 0.051 } };
export const sessionModel: any = { provider: 'fixture-provider', id: 'session-model', name: 'Session', api: 'openai-responses', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 128000, baseUrl: 'https://example.invalid', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const summaryModel = { ...sessionModel, id: 'summary-model', name: 'Summary', contextWindow: 1050000 };
export const user = (text: string): { role: 'user'; content: string; timestamp: number } => ({ role: 'user' as const, content: text, timestamp: 1 });
export const assistant = (text: string): any => ({ role: 'assistant', api: sessionModel.api, provider: sessionModel.provider, model: sessionModel.id, content: [{ type: 'text', text }], usage: USAGE, stopReason: 'stop', timestamp: 2 });
export function setup(child = false): any {
  writeFileSync(modelsPath, JSON.stringify({ providers: { 'fixture-provider': {
    modelOverrides: { 'session-model': { compactAtPercent: 50 } },
  } } }));
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  vi.stubEnv('PI_SUBAGENT_CHILD', child ? '1' : '0');
  const handlers = new Map<string, any>();
  const config: Record<string, unknown> = { 'compaction.summaryModel': 'fixture-provider/summary-model' };
  const readConfig = vi.fn(() => config);
  const register = () => install({ on: (name: string, fn: any) => handlers.set(name, fn), getThinkingLevel: () => 'low' }, {
    readConfig, modelsPath,
  });
  register();
  const requests: any[] = [], notices: any[] = [];
  const controller = new AbortController();
  const response = assistant('## Goal\nPreserve the task\n## Next Steps\nContinue');
  const registry: any = {
    find: (provider: string, id: string) => provider === summaryModel.provider && id === summaryModel.id ? summaryModel : undefined,
    getAvailable: () => [{ ...summaryModel }],
    streamSimple(model: any, context: any, options: any) {
      requests.push({ model, context, options });
      return { result: async () => response };
    },
  };
  const ctx: any = { cwd: `${ROOT}/test/cwd`, hasUI: true, ui: { notify: (text: string, kind: string) => notices.push({ text, kind }) },
    model: sessionModel, signal: undefined, modelRegistry: registry, isProjectTrusted: () => true,
    getContextUsage: () => ({ tokens: 600000, percent: 60 }) };
  const event: any = { type: 'session_before_compact', reason: 'manual', willRetry: false, signal: controller.signal,
    customInstructions: 'Preserve the boundary conditions', branchEntries: [], preparation: {
      messagesToSummarize: [user('COMPLETE HISTORY')], turnPrefixMessages: [user('SPLIT TURN PREFIX')],
      isSplitTurn: true, previousSummary: '## Goal\nPREVIOUS SUMMARY', tokensBefore: 600000,
      firstKeptEntryId: 'kept-42', settings: { enabled: false, reserveTokens: 400000, keepRecentTokens: 20000 },
      fileOps: { read: new Set(['z.ts', 'shared.ts', 'a.ts']), written: new Set(['shared.ts', 'written.ts']), edited: new Set(['edited.ts']) },
    } };
  const run = (): Promise<any> => {
    assert.equal(typeof handlers.get('session_before_compact'), 'function', 'parent must register compaction hook');
    return handlers.get('session_before_compact')(event, ctx);
  };
  return { handlers, requests, notices, controller, response, registry, ctx, event, run, config, modelsPath, agentDir, readConfig, register };
}
beforeEach(() => { summaryCalls.length = 0; });
export const pi: typeof Pi = await import('@earendil-works/pi-coding-agent');
