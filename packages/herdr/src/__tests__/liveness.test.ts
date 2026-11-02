// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test } from 'vitest';
import { performance } from 'node:perf_hooks';
import { isCoreAvailable } from '../client/liveness.js';
import { createClientFixture, type ClientFixture } from './testutil.js';

const fixtures: ClientFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

test.each([400, 800])('a live core survives a synchronous event-loop stall of %i ms during its probe', async stallMs => {
  const h = await createClientFixture(); fixtures.push(h);
  expect(await isCoreAvailable(h.localEnv)).toBe(true);
  const probe = isCoreAvailable(h.localEnv);
  const until = performance.now() + stallMs;
  while (performance.now() < until) { /* Simulate synchronous pi startup work. */ }
  expect(await probe).toBe(true);
});
