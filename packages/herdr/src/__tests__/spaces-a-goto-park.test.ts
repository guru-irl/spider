// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it } from 'vitest';
import { HerdrLabelContract } from '../contracts.js';
import { parkFocusedTerminal } from '../../assets/pane/park.js';

it('refuses to park a remote pane and explains why', () => {
  const commands: unknown[] = [], notices: unknown[] = [];
  const parked = parkFocusedTerminal({ pane: 'box-1.invalid/p2', terminal: 'box-1.invalid/t2' },
    [{ address: 'box-1.invalid/t2', parent: null, labels: {}, state: 'live', status: 'working' }], HerdrLabelContract,
    (name, args) => { commands.push([name, args]); return null; }, message => { notices.push(message); });
  expect(parked).toBe(false);
  expect(commands).toEqual([]);
  expect(notices).toEqual(["Send back works only for this computer's panes for now"]);
});

it('refuses to park a local roaming proxy with no local reopening feed', () => {
  const commands: unknown[] = [], notices: unknown[] = [];
  const parked = parkFocusedTerminal({ pane: 'p3', terminal: 'proxy' },
    [{ address: 'proxy', parent: null, labels: { 'spider.kind': 'roam-proxy' }, state: 'live', status: 'working' }], HerdrLabelContract,
    (name, args) => { commands.push([name, args]); return null; }, message => { notices.push(message); });
  expect(parked).toBe(false);
  expect(commands).toEqual([]);
  expect(notices).toEqual(["Pane target is unavailable"]);
});
