import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { setGlobalDbPathForTests } from '@spider/db-core';
import spiderExtension from '../extension';
import { assertPreflightIsolation, gitInit } from './fixture-safety';

let root = '';
afterEach(() => {
  vi.unstubAllEnvs();
  setGlobalDbPathForTests(null);
  if (root) rmSync(root, { recursive: true, force: true });
});

it('imports from the session directory pi selected and falls back when context is sparse', async () => {
  const scratch = join(process.cwd(), '.spider/scratch/tmp');
  mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, 'host-pi-sessions-'));
  gitInit(root);
  const project = join(root, 'project'), fallbackProject = join(root, 'fallback');
  mkdirSync(project); mkdirSync(fallbackProject);
  assertPreflightIsolation(project, root);
  assertPreflightIsolation(fallbackProject, root);
  setGlobalDbPathForTests(join(root, 'global.db'));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'agent'));
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined);
  const selected = SessionManager.create(project, join(root, 'chosen-by-pi'));
  selected.appendMessage({ role: 'user', content: 'selected session', timestamp: Date.now() });
  const fallback = SessionManager.create(fallbackProject);
  fallback.appendMessage({ role: 'user', content: 'fallback session', timestamp: Date.now() });
  const tools: Record<string, any> = {};
  spiderExtension({ registerTool: (tool: { name: string }) => { tools[tool.name] = tool; }, registerCommand: () => {}, on: () => {} } as never);
  const invoke = (cwd: string, context: unknown) => tools.spider.execute('call', { action: 'import', cwd, select: {} }, undefined, undefined, context);
  const result = await invoke(project, { cwd: project, sessionManager: selected });
  expect(result.isError).toBe(false);
  expect(result.details.imported).toBe(1);
  expect(result.details.perSession[0].sessionId).toBe(selected.getSessionId());
  const sparse = await invoke(fallbackProject, undefined);
  expect(sparse.isError).toBe(false);
  expect(sparse.details.imported).toBe(1);
  expect(sparse.details.perSession[0].sessionId).toBe(fallback.getSessionId());
});
