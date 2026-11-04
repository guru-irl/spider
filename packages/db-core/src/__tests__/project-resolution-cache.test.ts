import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { paths, repoRoot, worktreeRoot, resetProjectResolutionCacheForTests } from '../paths';
import { resolveProject, setGlobalDbPathForTests } from '../registry';
import { scratchDbPath, cleanupScratch } from '../testutil';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
beforeEach(() => { resetProjectResolutionCacheForTests(); setGlobalDbPathForTests(scratchDbPath('cached-global')); });
afterEach(() => { setGlobalDbPathForTests(null); vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllEnvs(); cleanupScratch(); });
function directory(name: string) {
  const dir = scratchDbPath(name).replace(/\.db$/, ''); mkdirSync(dir, { recursive: true }); return dir;
}
function git(dir: string, ...args: string[]) { execFileSync('git', args, { cwd: dir }); }

it.each([
  ['spawn', { code: 'EAGAIN' }],
  ['memory', { code: 'ENOMEM' }],
  ['timeout', { code: 'ETIMEDOUT', signal: 'SIGTERM' }],
  ['signal', { status: null, signal: 'SIGKILL' }],
  ['exit', { status: 1, stderr: 'git failed' }],
  ['other fatal error', { status: 128, stderr: 'fatal: bad configuration' }],
])('retries discovery after a transient %s failure', (_name, details) => {
  const dir = directory('retry-repo'); git(dir, 'init', '-q');
  const sub = join(dir, 'sub'); mkdirSync(sub);
  vi.mocked(execFileSync).mockImplementationOnce(() => { throw Object.assign(new Error('git unavailable'), details); });
  expect(worktreeRoot(sub)).toBe(sub);
  expect(worktreeRoot(sub)).toBe(dir);
  expect(repoRoot(sub)).toBe(join(dir, '.git', 'spider'));
  expect(resolveProject(sub).dbPath).toBe(join(dir, '.spider', 'project.db'));
});
it('retries a failed common-directory query on the next call', () => {
  const dir = directory('retry-common'); git(dir, 'init', '-q');
  vi.mocked(execFileSync).mockImplementationOnce(() => dir)
    .mockImplementationOnce(() => { throw Object.assign(new Error('git unavailable'), { code: 'EAGAIN' }); });
  expect(repoRoot(dir)).toBeUndefined();
  expect(repoRoot(dir)).toBe(join(dir, '.git', 'spider'));
});
it('caches a definite non-repository answer', () => {
  const dir = directory('not-repo');
  vi.stubEnv('GIT_CEILING_DIRECTORIES', dirname(dir));
  expect(repoRoot(dir)).toBeUndefined();
  const initial = vi.mocked(execFileSync).mock.calls.length;
  expect(worktreeRoot(dir)).toBe(dir);
  expect(repoRoot(dir)).toBeUndefined();
  expect(vi.mocked(execFileSync).mock.calls.length).toBe(initial);
});
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
it('notices a removed root git entry from a subdirectory cwd', () => {
  const dir = directory('removed-root'); git(dir, 'init', '-q');
  vi.stubEnv('GIT_CEILING_DIRECTORIES', dirname(dir));
  const sub = join(dir, 'sub'); mkdirSync(sub);
  expect(worktreeRoot(sub)).toBe(dir);
  renameSync(join(dir, '.git'), join(dir, 'old-git'));
  expect(worktreeRoot(sub)).toBe(sub);
  expect(repoRoot(sub)).toBeUndefined();
  expect(resolveProject(sub).dbPath).toBe(join(sub, '.spider', 'project.db'));
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
