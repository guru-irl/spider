// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it } from 'vitest';
import { describeOpenFailure } from '../../assets/shared/open-failure.js';

it.each([
  ['wrong-generation', 'wrong-generation', 'Owning session unavailable'],
  ['not-found', 'not-found', 'Owning session unavailable'],
  ['unknown-op', 'unknown-op', 'Run /reload to enable session reopening'],
  ['unavailable', 'pane-timeout', 'Timed out opening the pane'],
  ['refused', 'view-on-mac', 'This needs the Herdr app on this Mac'],
  ['unavailable', 'box-1.invalid is unreachable', 'box-1.invalid is unreachable'],
  ['unavailable', 'No space on box-1.invalid to reopen it in', 'No space on box-1.invalid to reopen it in'],
  ['unavailable', '/private/owner/file', "Couldn't open the session"],
  ['unavailable', 'constructor', "Couldn't open the session"],
])('describes %s and %s without leaking codes', (code, message, expected) => {
  expect(describeOpenFailure({ ok: false, code, message } as any)).toBe(expected);
});
