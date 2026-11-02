// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { test, expect } from 'vitest';
import { createSuite } from '../../harness/suite.js';
import { storyId } from '../../harness/scenario.js';
import { inventory } from './story.js';

test('inventory obtains actual native details for list summaries', async () => {
  const suite = await createSuite({ story: storyId('H-inventory-details'), tier: 'headless' });
  try {
    const run = await suite.hc(['run', '--json', '--bg', '--no-notify', '--outlive-parent', '--keep', '--label', 'e2e.inventory=actual', '--', '/bin/sh', '-c', 'printf actual-inventory']);
    expect(run.exitCode).toBe(0);
    const address = (run.json as { address: string }).address;
    suite.ledger.update(l => l.terminals.push({ side: 'local', address }));
    const rows = await inventory(suite), row = rows.find(row => row.address === address);
    expect(row).toBeDefined();
    expect(row!.labels).toEqual({ 'e2e.inventory': 'actual' });
    expect(['live', 'finished']).toContain(row!.state);
  } finally { await suite.close(); }
});
