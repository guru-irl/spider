// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { TerminalAddress } from '../../../herdr/src/contracts.js';
import type { PaneScreen } from '../../../herdr/src/panes/open.js';
type ScreenPorts = { get(address: TerminalAddress): Promise<unknown>; read(address: TerminalAddress): Promise<unknown> };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export async function readPaneScreen(address: TerminalAddress, ports: ScreenPorts): Promise<PaneScreen> {
  const before = record(await ports.get(address)); const screen = record(await ports.read(address)); const after = record(await ports.get(address));
  const cols = typeof before.cols === 'number' && Number.isSafeInteger(before.cols) && before.cols > 0 ? before.cols : 0;
  const rows = typeof before.rows === 'number' && Number.isSafeInteger(before.rows) && before.rows > 0 ? before.rows : 0;
  return { text: typeof screen.text === 'string' ? screen.text : '', cols, rows,
    complete: screen.complete === true && screen.how === 'screen' && cols > 0 && rows > 0 && before.address === address && after.address === address && typeof before.created_ms === 'number' && before.created_ms === after.created_ms && cols === after.cols && rows === after.rows };
}
