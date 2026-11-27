import { expect, it } from 'vitest';
import { participantBootSettings, parseV0SupervisorUnit } from './roam-hosting.js';

it('installs the participant boot extension exactly once across repeated fixtures', () => {
  const original = { packages: ['/fixture/release', '/fixture/provider'], theme: 'fixture' };
  const first = participantBootSettings(original, '/fixture/release', '/fixture/boot.mjs');
  expect(first).toEqual({ packages: [{ source: '/fixture/release', extensions: [] }, '/fixture/boot.mjs', '/fixture/provider'], theme: 'fixture' });
  expect(original.packages).toEqual(['/fixture/release', '/fixture/provider']);
  expect(participantBootSettings(first, '/fixture/release', '/fixture/boot.mjs')).toEqual(first);
  expect(() => participantBootSettings({ packages: [] }, '/fixture/release', '/fixture/boot.mjs')).toThrow(/packed extension/);
  expect(() => participantBootSettings({ packages: ['/fixture/release', '/fixture/release'] }, '/fixture/release', '/fixture/boot.mjs')).toThrow(/packed extension/);
});

it('takes the command and environment from the installed v0 unit and refuses a different entry', () => {
  const node = '/fixture/bin/node', supervisor = '/fixture/package/dist/roam/supervisor.mjs';
  const unit = `[Service]\nExecStart="${node}" "${supervisor}" --v0\nEnvironment="SPIDER_GLOBAL_ROOT=/fixture/root"\nEnvironment="HC_SESSION=owned"\n`;
  expect(parseV0SupervisorUnit(unit, node, supervisor)).toEqual({
    command: node, args: [supervisor, '--v0'], env: { SPIDER_GLOBAL_ROOT: '/fixture/root', HC_SESSION: 'owned' },
  });
  for (const changed of [unit.replace(' --v0', ''), unit.replace(supervisor, '/fixture/other.mjs'),
    unit.replace(' --v0', ' --v0 --extra'), `${unit}ExecStart="${node}" "${supervisor}" --v0\n`,
    `${unit}Environment="HC_SESSION=other"\n`, `${unit}Environment="NODE_OPTIONS=--require foreign"\n`]) {
    expect(() => parseV0SupervisorUnit(changed, node, supervisor)).toThrow();
  }
});
