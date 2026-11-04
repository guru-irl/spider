import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { paths, repoRoot, worktreeRoot, resetProjectResolutionCacheForTests } from '../paths';
import { resolveProject, setGlobalDbPathForTests } from '../registry';
import { scratchDbPath, cleanupScratch } from '../testutil';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
beforeEach(() => { resetProjectResolutionCacheForTests(); setGlobalDbPathForTests(scratchDbPath('cached-global')); });
afterEach(() => { setGlobalDbPathForTests(null); vi.useRealTimers(); vi.clearAllMocks(); cleanupScratch(); });
function directory(name: string) {
  const dir = scratchDbPath(name).replace(/\.db$/, ''); mkdirSync(dir, { recursive: true }); return dir;
}
function git(dir: string, ...args: string[]) { execFileSync('git', args, { cwd: dir }); }

it('reuses the first git resolution across project and path consumers', () => {
  const dir = directory('cached-repo'); git(dir, 'init', '-q');
  const first = resolveProject(dir); const initial = vi.mocked(execFileSync).mock.calls.length;
  for (let i = 0; i < 20; i++) {
    expect(resolveProject(dir)).toEqual(first);
    expect(worktreeRoot(relative(process.cwd(), dir))).toBe(dir);
    expect(repoRoot(dir)).toBe(join(dir, '.git', 'spider'));
    expect(paths.projectRoot(dir)).toBe(join(dir, '.spider'));
  }
  expect(vi.mocked(execFileSync).mock.calls.length).toBe(initial);
});
it('notices a newly created git entry without waiting for expiry', () => {
  const dir = directory('new-repo'); const first = resolveProject(dir);
  git(dir, 'init', '-q');
  const second = resolveProject(dir);
  expect(first.gitCommonDir).not.toBe(join(dir, '.git'));
  expect(second.gitCommonDir).toBe(join(dir, '.git'));
});
it('notices a replaced worktree git file', () => {
  const dir = directory('linked-repo'); git(dir, 'init', '-q');
  git(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'init');
  const linked = directory('linked-tree'); git(dir, 'worktree', 'add', '--detach', linked);
  expect(worktreeRoot(linked)).toBe(linked);
  renameSync(join(linked, '.git'), join(linked, 'old-git'));
  git(linked, 'init', '-q');
  expect(resolveProject(linked).gitCommonDir).toBe(join(linked, '.git'));
});
it('bounds staleness when a repository appears above the cwd', () => {
  vi.useFakeTimers();
  const dir = directory('parent-repo'), child = join(dir, 'child'); mkdirSync(child);
  const first = resolveProject(child); git(dir, 'init', '-q');
  vi.advanceTimersByTime(60_000);
  expect(resolveProject(child).projectKey).toBe(dir);
  expect(first.projectKey).not.toBe(dir);
});
it('keys relative paths by their absolute cwd and notices changed symlink targets', () => {
  const a = directory('relative-a'), b = directory('relative-b'); git(a, 'init', '-q'); git(b, 'init', '-q');
  const link = join(directory('relative-link'), 'repo'); symlinkSync(a, link);
  expect(worktreeRoot(link)).toBe(a);
  renameSync(link, link + '-old'); symlinkSync(b, link);
  expect(worktreeRoot(link)).toBe(b);
});
