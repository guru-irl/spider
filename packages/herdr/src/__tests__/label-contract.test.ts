// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import * as contracts from '../contracts.js';

test('console runtime identity is a reserved spider label', () => {
  expect((contracts.HERDR_LABELS as Record<string, string>).runtime).toBe('spider.runtime');
});

test('setup label props retain the installed mod contract', () => {
  expect(contracts.HerdrLabelContract).toBeDefined();
  expect(JSON.parse(JSON.stringify(contracts.HerdrLabelContract))).toEqual({
    version: 1,
    labels: {
      session: 'spider.session', ownerCore: 'spider.owner-core', ownerTerminal: 'spider.owner-terminal',
      kind: 'spider.kind', job: 'spider.job', run: 'spider.run', space: 'herdr.space', tab: 'herdr.tab', machine: 'spider.machine',
      parentName: 'spider.parent-name', steer: 'spider.steer', displayName: 'spider.display-name', viewerLifetime: 'spider.viewer-lifetime',
    },
    kinds: {
      exec: 'exec', execFile: 'exec-file', batch: 'batch', remoteObserver: 'remote-observer',
      subagentViewer: 'subagent-viewer', setupProbe: 'setup-probe', session: 'session', remoteConsole: 'remote-console',
    },
  });
});
