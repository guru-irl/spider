import { expect, it } from 'vitest';
import { participantBootSettings } from './roam-hosting.js';

it('installs the participant boot extension exactly once across repeated fixtures', () => {
  const original = { packages: ['/fixture/release', '/fixture/provider'], theme: 'fixture' };
  const first = participantBootSettings(original, '/fixture/release', '/fixture/boot.mjs');
  expect(first).toEqual({ packages: [{ source: '/fixture/release', extensions: [] }, '/fixture/boot.mjs', '/fixture/provider'], theme: 'fixture' });
  expect(original.packages).toEqual(['/fixture/release', '/fixture/provider']);
  expect(participantBootSettings(first, '/fixture/release', '/fixture/boot.mjs')).toEqual(first);
  expect(() => participantBootSettings({ packages: [] }, '/fixture/release', '/fixture/boot.mjs')).toThrow(/packed extension/);
  expect(() => participantBootSettings({ packages: ['/fixture/release', '/fixture/release'] }, '/fixture/release', '/fixture/boot.mjs')).toThrow(/packed extension/);
});
