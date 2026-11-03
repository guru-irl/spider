import { expect, it, vi } from 'vitest';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U'
    ? [
      '99999991 MainThread MainThread renamed /opt/pi-coding-agent/dist/cli.js',
      '99999992 MainThread MainThread /usr/bin/node /opt/pi-coding-agent/dist/bundle/cli.mjs',
      '99999993 MainThread MainThread /usr/bin/node /opt/viewer.js --pi-root /opt/pi-coding-agent',
      '99999994 MainThread MainThread /usr/bin/node /opt/pi-coding-agent/dist/cli.js',
    ].join('\n')
    : actual.execFileSync(...args) };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readlinkSync: (path: Parameters<typeof actual.readlinkSync>[0], ...args: unknown[]) => {
    if (path === '/proc/99999991/exe' || path === '/proc/99999993/exe') return '/opt/bin/node';
    if (path === '/proc/99999994/exe') return '/opt/bin/python';
    return actual.readlinkSync(path, ...args as []);
  } };
});

import { createProcessInventory } from '../ports.js';
import { FIXTURE_PROCESS_DOMAIN_ENV } from '../fixture-process-domain.js';

it('uses Linux executable links and falls back to argv when the link is unavailable', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const domain = process.env[FIXTURE_PROCESS_DOMAIN_ENV];
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  delete process.env[FIXTURE_PROCESS_DOMAIN_ENV];
  try {
    const listed = await createProcessInventory(process.cwd(), true).processes();
    expect(listed.map(row => row.pid)).toEqual([99999991, 99999992]);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    if (domain === undefined) delete process.env[FIXTURE_PROCESS_DOMAIN_ENV];
    else process.env[FIXTURE_PROCESS_DOMAIN_ENV] = domain;
  }
});
