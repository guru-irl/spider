// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { createHerdrHarness } from './testutil.js';
import { createAcceptanceHarness } from './scenario-setup.js';
import { createHcClient } from '../client/hc.js';

it('records the distinct scopes of actual hc events clients in fake mode', async () => {
  const h = await createAcceptanceHarness('fake'); await h.start();
  const first = createHcClient({ binary: h.hcBinary, env: { ...h.localEnv, HERDR_ACCEPTANCE_CLIENT: 'first' } });
  const second = createHcClient({ binary: h.hcBinary, env: { ...h.localEnv, HERDR_ACCEPTANCE_CLIENT: 'second' } });
  try {
    await Promise.all([first.events().ready, second.events().ready]);
    const scopes = (await h.calls()).filter(call => call.argv[0] === 'events').map(call => call.env.HERDR_ACCEPTANCE_CLIENT).sort();
    expect(scopes).toEqual(['first', 'second']);
  } finally { await first.dispose(); await second.dispose(); await h.close(); }
});

it('publishes scenario replacements without exposing partial JSON to concurrent readers', async () => {
  const h = await createHerdrHarness('fake'); const invalid: string[] = [];
  const reader = setInterval(() => {
    try { JSON.parse(readFileSync(join(h.directories.local, 'scenario.json'), 'utf8')); }
    catch (error) { invalid.push(String(error)); }
  }, 0);
  try {
    for (let i = 0; i < 12; i++) await h.scenario({ payload: 'x'.repeat(1024 * 1024), revision: i });
    expect(invalid).toEqual([]);
    expect(JSON.parse(readFileSync(join(h.directories.local, 'scenario.json'), 'utf8')).revision).toBe(11);
  } finally { clearInterval(reader); await h.close(); }
});
