// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { stageSpacesAFiles } from '../../fixtures/spaces-a-inputs.js';
import { scratchRoot } from '../environment.js';

for (const version of ['0.1.13', '0.1.16'] as const) {
  it(`${version}: stages exact composed files with resolved imports and digest manifest`, async () => {
    const parent = join(scratchRoot(), 'e2-tests'); mkdirSync(parent, { recursive: true });
    const root = process.env.SPIDER_SPACES_A_STAGE_ROOT ? join(process.env.SPIDER_SPACES_A_STAGE_ROOT, version) : mkdtempSync(join(parent, 'a-files-'));
    const staged = await stageSpacesAFiles(root, version);
    expect(staged.unresolved).toEqual([]);
    expect(staged.files.map(file => file.path)).toContain('mods/spider-picker/shared/navigation.js');
    expect(staged.files.map(file => file.path)).toContain('mods/spider-panel/sound.js');
    expect(staged.files.some(file => file.path.startsWith('mods/toast/'))).toBe(false);
    expect(staged.files.some(file => file.path === 'mods/spider-toast/main.js')).toBe(version === '0.1.16');
    const pane = readFileSync(join(root, 'mods/spider-pane/main.js'), 'utf8');
    expect(pane).toContain('parkFocusedTerminal');
    expect(readFileSync(staged.manifest, 'utf8').split('\n')).toHaveLength(staged.files.length + 2);
    expect(await stageSpacesAFiles(root, version)).toEqual(staged);
  });
}
