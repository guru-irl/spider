import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { realHcBinary } from '../harness/hc.js';
import { scratchRoot } from '../harness/environment.js';

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  userInfo: vi.fn(),
}));

let fixture: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(userInfo).mockReset();
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});
describe('installed binary resolution', () => {
  it('finds installed hc through the OS account, independent of subprocess HOME', () => {
    const parent = join(scratchRoot(), 'e2-tests');
    mkdirSync(parent, { recursive: true });
    fixture = mkdtempSync(join(parent, 'binary-resolution-'));
    const accountHome = join(fixture, 'account-home');
    const processHome = join(fixture, 'process-home');
    mkdirSync(accountHome);
    mkdirSync(processHome);
    vi.mocked(userInfo).mockReturnValue({ username: 'fixture', uid: -1, gid: -1, shell: null, homedir: accountHome });
    vi.stubEnv('SPIDER_HERDR_E2E_HC', undefined);
    vi.stubEnv('HOME', processHome);
    const expected = join(accountHome, '.local/bin/hc');
    expect(existsSync(expected)).toBe(false);
    expect(realHcBinary()).toBe(expected);
  });
});
