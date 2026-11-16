// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
export function parkFocusedTerminal(focus, terminals, contract, run) {
  if (!focus?.pane || !focus.terminal) return false;
  const matches = terminals.filter(terminal => terminal.address === focus.terminal);
  if (matches.length !== 1) return false;
  const terminal = matches[0];
  if (terminal.state !== 'live' || !terminal.labels || typeof terminal.labels !== 'object') return false;
  const kind = terminal.labels[contract.labels.kind];
  if (kind !== undefined && typeof kind !== 'string') return false;
  if ([contract.kinds.exec, contract.kinds.execFile, contract.kinds.batch].includes(kind)) return false;
  run('terminal.park', { terminal: terminal.address });
  return true;
}
