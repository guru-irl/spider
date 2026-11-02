// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, it } from 'vitest';
import type { Suite } from '../suite.js';
import { destinationPath, destinationRoot } from '../destination.js';

const root = '/fixture/spider-herdr-e2e-0123abcd';
const suite = { options: { tier: 'remote' }, remote: { metadata: { root } }, ownPath() { throw new Error('local-path-used'); } } as unknown as Suite;
describe('destination paths', () => {
  it('uses the remote ownership root rather than the local checkout', () => {
    expect(destinationRoot(suite)).toBe(root);
    expect(destinationPath(suite, root + '/work/source 雪.txt')).toBe(root + '/work/source 雪.txt');
  });
  it.each([root, root + '/../escape', root + '/work/../../escape', root + '-other/work', 'work/source', '/foreign/work'])('refuses unowned or noncanonical remote path %s', path => {
    expect(() => destinationPath(suite, path)).toThrow(/outside-owned-root/);
  });
  it('keeps the existing local physical-path check for local fixtures', () => {
    const local = { options: { tier: 'headless' }, root: '/fixture/local', ownPath: (path: string) => { if (path !== '/fixture/local/work') throw new Error('local-fence'); return path; } } as unknown as Suite;
    expect(destinationRoot(local)).toBe('/fixture/local');
    expect(destinationPath(local, '/fixture/local/work')).toBe('/fixture/local/work');
    expect(() => destinationPath(local, '/foreign')).toThrow('local-fence');
  });
});
