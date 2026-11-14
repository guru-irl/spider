import { afterEach, describe, expect, it, vi } from 'vitest';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { realHcBinary } from '../harness/hc.js';
import { scratchRoot } from '../harness/environment.js';
afterEach(() => vi.unstubAllEnvs());
describe('installed binary resolution', () => {
  it('finds installed hc through the OS account, independent of subprocess HOME', () => {
    vi.stubEnv('SPIDER_HERDR_E2E_HC', undefined);
    vi.stubEnv('HOME', join(scratchRoot(), 'e2-tests/foreign-home'));
    expect(realHcBinary()).toBe(join(userInfo().homedir, '.local/bin/hc'));
  });
});
