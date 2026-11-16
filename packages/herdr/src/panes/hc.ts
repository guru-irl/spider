// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { invokeCli } from '../client/hc.js';
import { HerdrError, parseCore, object } from '../client/parse.js';
import { PANE_REPLY_LIMIT, parsePaneTerminal } from './codec.js';
import type { PaneTarget, PaneTerminalFacts } from './types.js';
export async function readPaneTerminal(target: PaneTarget, ports: { binary: string; env: Readonly<NodeJS.ProcessEnv> }): Promise<PaneTerminalFacts> {
  const local = parseCore(await invokeCli(ports.binary, ['server', 'status', '--json'], ports.env, PANE_REPLY_LIMIT, undefined, { timeoutMs: 5000 }), ports.env);
  if (target.alias === null && target.coreId !== local.coreId) throw new HerdrError('core-mismatch', 'Local target core identity changed');
  const address = `${target.coreId}/${target.terminalId}`;
  const facts = parsePaneTerminal(await invokeCli(ports.binary, ['get', address, '--json'], ports.env, PANE_REPLY_LIMIT, undefined, { timeoutMs: 5000 }));
  let matchesAddress = facts.terminal.address === address;
  if (!matchesAddress && target.coreId === local.coreId && facts.terminal.address === String(target.terminalId)) {
    const after = parseCore(await invokeCli(ports.binary, ['server', 'status', '--json'], ports.env, PANE_REPLY_LIMIT, undefined, { timeoutMs: 5000 }), ports.env);
    matchesAddress = after.coreId === local.coreId && after.socket === local.socket && after.sessionNamespace === local.sessionNamespace;
  } else if (!matchesAddress && target.alias !== null && facts.terminal.address.split('/').at(-1) === target.terminalId) {
    const raw = object(await invokeCli(ports.binary, ['machine', 'ls', '--json'], ports.env, PANE_REPLY_LIMIT, undefined, { timeoutMs: 5000 }));
    const prefix = facts.terminal.address.split('/')[0];
    const matches = Array.isArray(raw.machines) ? raw.machines.map(object).filter(machine => machine.id === target.coreId && [machine.name, ...(Array.isArray(machine.aliases) ? machine.aliases : [])].includes(prefix)) : [];
    if (matches.length === 1) {
      const after = parseCore(await invokeCli(ports.binary, ['server', 'status', '--json'], ports.env, PANE_REPLY_LIMIT, undefined, { timeoutMs: 5000 }), ports.env);
      matchesAddress = after.coreId === local.coreId && after.socket === local.socket && after.sessionNamespace === local.sessionNamespace;
    }
  }
  if (!matchesAddress || facts.createdMs !== target.createdMs || Object.entries(target.identityLabels).some(([key, value]) => facts.identityLabels[key] !== value))
    throw new HerdrError('target-mismatch', 'Terminal identity differs from the captured target');
  return { ...facts, terminal: { ...facts.terminal, address: address as PaneTarget['address'] } };
}
