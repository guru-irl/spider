// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it } from 'vitest';
import { encodePairCommand } from '../../../../roam/src/intercom-pair-files.js';
// @ts-ignore The same ESM fixture is loaded directly by the owned connector.
import { acceptsConnectCommand, connectCommands, pairConnectCommand } from '../../fixtures/roam-pair-command.mjs';

it('accepts only the exact connect probes for the owned session', () => {
  const posix = `sh -c 'p=$(command -v herdr-core) || p=$HOME/.local/bin/herdr-core; [ -x "$p" ] || { echo "herdr-core is not installed here" >&2; exit 127; }; HC_SESSION=c exec "$p" connect'`;
  const windows = 'cmd /d /c "if exist .\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe (.\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe connect --session c) else (echo herdr-core is not installed here 1>&2 & exit /b 127)"';
  expect(acceptsConnectCommand(posix, 'c')).toBe(true);
  expect(acceptsConnectCommand(windows, 'c')).toBe(true);
  expect(acceptsConnectCommand(`${posix}; touch unexpected`, 'c')).toBe(false);
  expect(acceptsConnectCommand(posix.replace('HC_SESSION=c', 'HC_SESSION=d'), 'c')).toBe(false);
  expect(acceptsConnectCommand(posix, 'c;evil')).toBe(false);
});

it('accepts the production pair envelope and refuses a different pair or epoch', () => {
  expect(encodePairCommand).toBeTypeOf('function');
  const pair = { pairId: 'fixture-pair', edgeEpoch: 'fixture-epoch' };
  const commands = connectCommands('c').map((command: string) => ({ command, envelope: encodePairCommand(pair, command) }));
  expect(commands).toHaveLength(2);
  for (const { command, envelope } of commands) {
    expect(pairConnectCommand(envelope, 'c', commands)).toBe(command);
    expect(pairConnectCommand(encodePairCommand({ ...pair, pairId: 'wrong-pair' }, command), 'c', commands)).toBeNull();
    expect(pairConnectCommand(encodePairCommand({ ...pair, edgeEpoch: 'wrong-epoch' }, command), 'c', commands)).toBeNull();
    expect(pairConnectCommand(command, 'c', commands)).toBeNull();
  }
}, 5000);
