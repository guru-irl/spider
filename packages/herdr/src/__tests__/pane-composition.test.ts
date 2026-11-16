// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync } from 'node:fs';
import { createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { expect, test, vi } from 'vitest';
import { resolvePaneAgentProgram } from '../../../host/src/herdr/pane-program.js';
import { runHerdrCli, type HerdrCliPorts } from '../setup/cli.js';
const snapshot = { version: 1, op: 'snapshot', operationId: 'snapshot-1' };
function fixture() {
  const ports = { request: vi.fn(), setupParts: vi.fn(), doctorParts: vi.fn(), stdout: vi.fn(), stderr: vi.fn(),
    panes: vi.fn(async () => ({ version: 1, kind: 'snapshot', complete: true, omittedRows: 0, revision: 0, machines: [], presentations: [], rows: [], targetFacts: {} })),
    servePanes: vi.fn(async () => {}), proxyPane: vi.fn(async () => 0), remotePane: vi.fn(async () => ({ version: 1, op: 'handshake', protocol: 1, buildDigest: 'a'.repeat(64) })) };
  return ports;
}
test('packaged pane CLI binds every service and endpoint effect', async () => {
  const p = fixture();
  expect(await runHerdrCli(['panes', 'request', '--json', JSON.stringify(snapshot)], p as unknown as HerdrCliPorts)).toBe(0);
  expect(p.panes).toHaveBeenCalledWith(snapshot);
  expect(JSON.parse(p.stdout.mock.calls[0][0])).toMatchObject({ kind: 'snapshot' });
  expect(await runHerdrCli(['panes', 'serve'], p as unknown as HerdrCliPorts)).toBe(0);
  expect(p.servePanes).toHaveBeenCalledOnce();
  expect(await runHerdrCli(['panes', 'proxy', '--id', 'pane-1', '--binding-root', '/fixture/panes', '--hc', '/fixture/hc'], p as unknown as HerdrCliPorts)).toBe(0);
  expect(p.proxyPane).toHaveBeenCalledWith({ id: 'pane-1', bindingRoot: '/fixture/panes', hcBinary: '/fixture/hc' });
  expect(await runHerdrCli(['panes', 'remote', '--json', JSON.stringify({ version: 1, op: 'handshake', protocol: 1, buildDigest: 'a'.repeat(64) })], p as unknown as HerdrCliPorts)).toBe(0);
  expect(p.remotePane).toHaveBeenCalledOnce();
});
test.each([
  ['panes', 'request', '--json', '{'], ['panes', 'request', '--json', '{}'], ['panes', 'serve', '--extra'],
  ['panes', 'proxy', '--id', '../escape', '--binding-root', '/fixture', '--hc', '/fixture/hc'],
  ['panes', 'proxy', '--id', 'p1', '--binding-root', 'relative', '--hc', '/fixture/hc'],
  ['panes', 'remote', '--json', '{}'], ['--help'],
])('malformed pane CLI has no effect: %j', async (...args) => {
  const p = fixture(); await runHerdrCli(args, p as unknown as HerdrCliPorts);
  for (const effect of [p.request, p.setupParts, p.doctorParts, p.panes, p.servePanes, p.proxyPane, p.remotePane]) expect(effect).not.toHaveBeenCalled();
});

test('agent launch keys use the session launcher and reject unknown or missing programs', async () => {
  const probe = vi.fn(async () => true);
  expect(await resolvePaneAgentProgram('pi', probe)).toEqual(['pi']);
  expect(probe).toHaveBeenCalledWith('pi');
  probe.mockClear();
  await expect(resolvePaneAgentProgram('unlisted', probe)).rejects.toMatchObject({ code: 'unknown-agent' });
  expect(probe).not.toHaveBeenCalled();
  probe.mockResolvedValue(false);
  await expect(resolvePaneAgentProgram('pi', probe)).rejects.toMatchObject({ code: 'agent-program-missing' });
});
test('request argv never grants launch authority', async () => {
  const p = fixture();
  const request = { version: 1, op: 'open', operationId: 'o1', machineKey: 'box-1.invalid', coreId: 'core-1', machineId: null,
    intent: { operationId: 'o1', space: 's1', place: 'tab', anchor: null, program: { kind: 'agent', key: 'pi', argv: ['untrusted'] } } };
  expect(await runHerdrCli(['panes', 'request', '--json', JSON.stringify(request)], p as unknown as HerdrCliPorts)).toBe(2);
  expect(p.panes).not.toHaveBeenCalled();
});

test('production composition binds pane ports and never reserves automatic views directly', async () => {
  const ports = createProductionHerdrCliPorts(process.cwd(), {});
  try {
    for (const name of ['panes', 'servePanes', 'proxyPane', 'remotePane'] as const) expect(typeof ports[name]).toBe('function');
    const source = readFileSync('packages/host/src/herdr/pane-runtime.ts', 'utf8');
    expect(source).toContain('.openPresented(');
    expect(source).not.toContain('.reservePresented(');
  } finally { await ports.dispose(); }
});
