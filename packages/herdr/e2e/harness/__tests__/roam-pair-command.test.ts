// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it } from 'vitest';
// @ts-ignore The same ESM fixture is loaded directly by the owned connector.
import { acceptsConnectCommand } from '../../fixtures/roam-pair-command.mjs';

it('accepts only the exact connect probes for the owned session', () => {
  const posix = `sh -c 'p=$(command -v herdr-core) || p=$HOME/.local/bin/herdr-core; [ -x "$p" ] || { echo "herdr-core is not installed here" >&2; exit 127; }; HC_SESSION=c exec "$p" connect'`;
  const windows = 'cmd /d /c "if exist .\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe (.\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe connect --session c) else (echo herdr-core is not installed here 1>&2 & exit /b 127)"';
  expect(acceptsConnectCommand(posix, 'c')).toBe(true);
  expect(acceptsConnectCommand(windows, 'c')).toBe(true);
  expect(acceptsConnectCommand(`${posix}; touch unexpected`, 'c')).toBe(false);
  expect(acceptsConnectCommand(posix.replace('HC_SESSION=c', 'HC_SESSION=d'), 'c')).toBe(false);
  expect(acceptsConnectCommand(posix, 'c;evil')).toBe(false);
});
