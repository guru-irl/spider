import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { selectSessionFiles } from '../transcript';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const scratch = join(process.cwd(), '.spider/scratch/tmp');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pi-sessions-'));
  roots.push(root);
  const home = join(root, 'home'), project = join(root, 'project'), other = join(root, 'other');
  for (const dir of [home, project, other]) mkdirSync(dir);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'agent'));
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined);
  return { root, project, other };
}
function session(cwd: string, dir?: string): string {
  const manager = SessionManager.create(cwd, dir);
  manager.appendMessage({ role: 'user', content: 'fixture', timestamp: Date.now() });
  return manager.getSessionFile()!;
}

it('selects pi sessions from the configured agent directory', () => {
  const { project, other } = fixture();
  const selected = session(project), foreign = session(other);
  expect(selectSessionFiles({ cwd: project })).toEqual([selected]);
  expect(selectSessionFiles({ cwd: project, project: other })).toEqual([foreign]);
  expect(selectSessionFiles({ cwd: project, all: true }).sort()).toEqual([selected, foreign].sort());
  vi.stubEnv('PI_CODING_AGENT_DIR', undefined);
  const defaultSession = session(project);
  expect(selectSessionFiles({ cwd: project })).toEqual([defaultSession]);
});

it('selects sessions from the shared session directory with project filtering', () => {
  const { root, project, other } = fixture();
  const dir = join(root, 'session-override');
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', dir);
  const selected = session(project, dir), foreign = session(other, dir);
  expect(selectSessionFiles({ cwd: project })).toEqual([selected]);
  expect(selectSessionFiles({ cwd: project, project: other })).toEqual([foreign]);
  expect(selectSessionFiles({ cwd: project, all: true }).sort()).toEqual([selected, foreign].sort());
  expect(selectSessionFiles({ cwd: project, all: true, glob: foreign })).toEqual([foreign]);
});

it('expands a home-relative pi session directory override', () => {
  const { root, project } = fixture();
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', '~/shared-sessions');
  const selected = session(project, join(root, 'home', 'shared-sessions'));
  expect(selectSessionFiles({ cwd: project })).toEqual([selected]);
});

it('does not import nested sessions from a flat custom pi session directory', () => {
  const { root, project } = fixture();
  const dir = join(root, 'shared-sessions');
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', dir);
  const selected = session(project, dir);
  session(project, join(dir, 'archive'));
  expect(selectSessionFiles({ cwd: project })).toEqual([selected]);
  expect(selectSessionFiles({ cwd: project, all: true })).toEqual([selected]);
});
