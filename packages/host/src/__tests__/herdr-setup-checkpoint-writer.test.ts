// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { beginRunCheckpoint } from '../../../herdr/src/setup/checkpoint.js';
import { fixture, put, roots } from '../../../herdr/src/__tests__/setup-checkpoint-fixture.js';
import { verifiedHerdrFile } from '../herdr/ports.js';

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
test('runtime template publication cannot rewrite the journal during an interrupted undo', async () => {
  const f = await fixture(), checkpoint = await beginRunCheckpoint(f.request.journalRoot, [f.paths.added]);
  checkpoint.state = 'undoing'; checkpoint.undo = { phase: 'files', expected: [], targets: [] };
  await put(join(f.request.journalRoot, 'checkpoint.json'), JSON.stringify(checkpoint));
  await expect(verifiedHerdrFile(f.request.journalRoot, { path: f.paths.added, bytes: Buffer.from('runtime instructions'), expected: null })).rejects.toMatchObject({ code: 'upgrade-undo-in-progress' });
});
