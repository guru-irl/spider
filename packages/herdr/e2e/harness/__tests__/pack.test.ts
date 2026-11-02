// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, it, expect, afterAll } from 'vitest';
import { cpSync, rmSync, mkdirSync, existsSync, readlinkSync, lstatSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createFixtureRoot, checkoutRoot } from '../environment.js';
import { stagePackedBuild, verifyPackedRoot, PACKED_ENTRIES, PACKED_ROOT_ENV } from '../pack.js';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

describe('packed build staging', () => {
  const staged = stagePackedBuild({});

  it('stages the npm-packed package under scratch with every entry and digest', () => {
    expect(staged.root.startsWith(join(checkoutRoot(), '.spider/scratch/e2/_pack/'))).toBe(true);
    for (const entry of PACKED_ENTRIES) { expect(existsSync(join(staged.root, entry))).toBe(true); expect(staged.digests[entry]).toMatch(/^[0-9a-f]{64}$/); }
    expect(existsSync(join(staged.root, 'node_modules', '@spider'))).toBe(false);
    expect(existsSync(join(staged.root, 'packages/herdr/src'))).toBe(false);
    // Dependencies resolve through the private clone, never through workspace links.
    const link = join(staged.root, 'node_modules', '@earendil-works', 'pi-ai');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).not.toMatch(/\/packages\//);
  });

  it('reuses the same staged root for the same build', () => {
    expect(stagePackedBuild({}).root).toBe(staged.root);
  });

  it('reuses an exported runner root after verification', () => {
    expect(stagePackedBuild({ [PACKED_ROOT_ENV]: staged.root }).root).toBe(staged.root);
  });

  it('fails closed on an exported root outside scratch, a missing root, or a copy that lacks an entry', async () => {
    expect(() => stagePackedBuild({ [PACKED_ROOT_ENV]: checkoutRoot() })).toThrow(/packed-root-outside-scratch/);
    expect(() => stagePackedBuild({ [PACKED_ROOT_ENV]: join(checkoutRoot(), '.spider/scratch/e2/none') })).toThrow(/packed-root-missing/);
    const root = await createFixtureRoot(); roots.push(root);
    for (const entry of ['dist/herdr/remote-runtime.mjs', 'packages/herdr/assets/mods/spider/main.js']) {
      const copy = join(root, entry.replaceAll('/', '_'));
      cpSync(staged.root, copy, { recursive: true, verbatimSymlinks: true, filter: src => !src.includes('/node_modules') });
      rmSync(join(copy, entry));
      expect(() => verifyPackedRoot(copy)).toThrow(new RegExp(`packed-entry-missing: packed build lacks ${entry}`));
    }
    const sourceLinked = join(root, 'linked');
    cpSync(staged.root, sourceLinked, { recursive: true, verbatimSymlinks: true, filter: src => !src.includes('/node_modules') });
    mkdirSync(join(sourceLinked, 'node_modules'));
    symlinkSync(join(checkoutRoot(), 'packages'), join(sourceLinked, 'node_modules', '@spider'));
    expect(() => verifyPackedRoot(sourceLinked)).toThrow(/packed-source-link/);
  });
});
