// SPDX-License-Identifier: MIT
import { it } from 'vitest';
import { scenario } from './child-remote-scenario.js';

it('a real child exec names its failed event stream without relying on stderr', async () => { await scenario('fake', false, false, true); }, 45000);
it('session and child activate with a large snapshot and remote exec returns its output', async () => { await scenario('fake', false, true); }, 60000);
it('the real-child regression detects the legacy missing-policy branch in an isolated compiled artifact', async () => { await scenario('fake', true); }, 45000);
