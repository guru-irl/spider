// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { createClientFixture } from './testutil.js';
import type { TerminalAddress, OwnerPlacement } from '../contracts.js';
import { clearPlacementRepair, readPlacementRepairs, writePlacementRepair } from '../jobs/placement-repairs.js';

test('keeps independent repair records for reused terminal addresses across apps and cores', async () => {
  const f = await createClientFixture();
  const base = { viewer: 't2' as TerminalAddress, anchor: { space: 's1', tab: 'tb1', pane: 'p1' } as OwnerPlacement, error: 'failed', app: 'app-one', coreId: 'core-one' };
  try {
    await writePlacementRepair(f.root, base);
    await writePlacementRepair(f.root, { ...base, coreId: 'core-two' });
    await writePlacementRepair(f.root, { ...base, app: 'app-two' });
    expect(await readPlacementRepairs(f.root)).toHaveLength(3);
    await clearPlacementRepair(f.root, base);
    expect(await readPlacementRepairs(f.root)).toHaveLength(2);
    expect(await readPlacementRepairs(f.root)).toEqual(expect.arrayContaining([expect.objectContaining({ coreId: 'core-two' }), expect.objectContaining({ app: 'app-two' })]));
  } finally { await f.close(); }
});
