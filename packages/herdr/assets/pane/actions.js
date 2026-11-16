// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { panePresentation } from './machine.js';

const pendingKey = 'spider.pane-confirmations';
const now = ports => ports.now ? ports.now() : Date.now();
const operationId = ports => ports.operationId ? ports.operationId() : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const proxyLabels = labels => labels['spider.kind'] === 'pane-proxy' || labels['spider.kind'] === 'roam-proxy' || Boolean(labels['spider.target-core'] || labels['spider.target-terminal']);
function pendingEntries(ports) {
  const stored = ports.shared(pendingKey);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  return Object.fromEntries(Object.entries(stored).flatMap(([key, value]) => {
    if (!value || typeof value !== 'object' || value.operationId !== key || !/^[a-z0-9]+$/.test(key) ||
        typeof value.presentationId !== 'string' || !value.presentationId || !Number.isInteger(value.expectedRevision) ||
        typeof value.coreId !== 'string' || !value.coreId || typeof value.terminalId !== 'string' || !value.terminalId ||
        !Number.isFinite(value.createdMs) || !Number.isFinite(value.expires)) return [];
    return [[key, { operationId: value.operationId, presentationId: value.presentationId, expectedRevision: value.expectedRevision,
      coreId: value.coreId, terminalId: value.terminalId, createdMs: value.createdMs, expires: value.expires }]];
  }));
}

export async function handlePaneCommand(command, context, ports) {
  const match = /^confirm-([a-z0-9]+)$/.exec(command);
  if (match) {
    const entries = pendingEntries(ports);
    const pending = Object.prototype.hasOwnProperty.call(entries, match[1]) ? entries[match[1]] : null;
    delete entries[match[1]]; ports.setShared(pendingKey, entries);
    if (!pending) return;
    if (pending.expires <= now(ports)) { ports.notify('Confirmation expired'); return; }
    try {
      const target = await ports.resolveTarget(pending);
      if (!target) { ports.notify('Pane target changed'); return; }
      if (pending.expires <= now(ports)) { ports.notify('Confirmation expired'); return; }
      await ports.request({ version: 1, op: 'close-confirmed', operationId: pending.operationId, presentationId: pending.presentationId, expectedRevision: pending.expectedRevision, target });
    } catch (error) { ports.notify(String(error?.message ?? 'Could not close pane')); }
    return;
  }
  if (command !== 'close' && command !== 'park') return;
  if (!context?.pane || !context.header) { ports.notify('Pane is unavailable'); return; }
  const item = context.presentation;
  const proxy = item?.mode === 'proxy' || context.unknownProxy || proxyLabels(context.header.labels);
  if (!proxy) {
    if (command === 'close') ports.nativeClose(context);
    else ports.nativePark(context);
    return;
  }
  const verified = item?.mode === 'proxy' ? panePresentation(context.header, [item]) : null;
  if (!verified || !verified.slot || verified.slot.space !== context.pane.space || verified.slot.tab !== context.pane.tab || verified.slot.pane !== context.pane.pane) {
    ports.notify('Pane target is unavailable'); return;
  }
  const id = operationId(ports);
  if (!/^[a-z0-9]+$/.test(id)) { ports.notify('Pane operation is unavailable'); return; }
  if (command === 'park') {
    try { await ports.request({ version: 1, op: 'park', operationId: id, presentationId: verified.id, expectedRevision: verified.revision }); }
    catch (error) { ports.notify(String(error?.message ?? 'Could not send pane back')); }
    return;
  }
  const entries = Object.fromEntries(Object.entries(pendingEntries(ports)).filter(([, value]) => value.expires > now(ports)));
  entries[id] = { operationId: id, presentationId: verified.id, expectedRevision: verified.revision,
    coreId: verified.target.coreId, terminalId: verified.target.terminalId, createdMs: verified.target.createdMs, expires: now(ports) + 30000 };
  ports.setShared(pendingKey, entries);
  try {
    ports.openConfirm({ mod: 'confirm', kind: 'dialog', width: 420, height: 190, props: {
      title: 'Close this terminal?', detail: 'This ends the program on its machine.', command: { name: `spider-pane.confirm-${id}`, args: {} },
    } });
  } catch (error) {
    const current = pendingEntries(ports); delete current[id]; ports.setShared(pendingKey, current);
    ports.notify(String(error?.message ?? 'Could not confirm close'));
  }
}

const absolute = value => typeof value === 'string' && (/^\//.test(value) || /^[a-zA-Z]:[\\/]/.test(value)) && !value.includes('\0');
async function requestPane(host, request) {
  const text = await host.readTextFile(`${host.appHome()}/mods/spider-machine-picker/config.json`);
  const config = text ? JSON.parse(text) : null;
  if (!config || config.version !== 1 || config.checkMode || !absolute(config.nodePath) || !absolute(config.cliPath)) throw new Error('Pane service is not configured');
  const result = await host.exec(config.nodePath, [config.cliPath, 'panes', 'request', '--json', JSON.stringify(request)], { timeout: 5000 });
  if (result.code !== 0) throw new Error('Pane service is unavailable');
  return JSON.parse(result.stdout);
}
export function paneActionPorts(host, nativeClose, nativePark) {
  return {
    shared: key => host.shared(key), setShared: (key, value) => host.setShared(key, value),
    resolveTarget: async pending => {
      const reply = await requestPane(host, { version: 1, op: 'snapshot', operationId: operationId({}) });
      if (reply?.version !== 1 || reply.kind !== 'snapshot' || !Array.isArray(reply.presentations)) throw new Error('Invalid pane service reply');
      const matches = reply.presentations.filter(item => item?.id === pending.presentationId);
      const item = matches.length === 1 ? matches[0] : null;
      return item?.mode === 'proxy' && item.visibility === 'visible' && item.revision === pending.expectedRevision &&
        item.target?.coreId === pending.coreId && item.target?.terminalId === pending.terminalId && item.target?.createdMs === pending.createdMs ? item.target : null;
    },
    request: async request => {
      const reply = await requestPane(host, request);
      if (reply?.version !== 1 || reply.kind !== 'outcome' || !reply.outcome || !['complete', 'pending', 'refused'].includes(reply.outcome.status)) throw new Error('Invalid pane service reply');
      if (reply.outcome.status === 'refused') throw new Error(reply.outcome.reason || 'Pane action was refused');
      return reply.outcome;
    },
    openConfirm: spec => host.openOverlay(spec), notify: title => host.notify({ title, level: 'warning' }),
    nativeClose, nativePark, run: host.run, nextCommand: host.nextCommand,
  };
}

export function capturePaneAction(host, paneId, snapshot) {
  const pane = host.panes().find(row => row.pane === paneId);
  if (!pane) return null;
  const space = host.spaces().find(row => row.machine === null && row.tabs?.some(tab => tab.id === pane.tab));
  if (!space) return null;
  const terminal = host.terminals().find(row => row.address === pane.terminal);
  const header = { address: pane.terminal ?? null, programIsAgent: Boolean(pane.program?.agent || pane.app), nativeTitle: pane.title ?? '', nativeStatus: pane.status ?? null,
    nativeCwd: pane.cwd ?? null, labels: { ...(terminal?.labels ?? {}) } };
  const rows = snapshot?.presentations ?? [];
  const candidates = rows.filter(row => row.mode === 'proxy' && row.visibility === 'visible' && row.proxy === header.address && header.address !== null);
  const verified = panePresentation(header, rows);
  return { pane: { space: space.id, tab: pane.tab, pane: pane.pane }, header, presentation: verified ?? (candidates.length === 1 ? candidates[0] : null),
    unknownProxy: candidates.length > 0 && !verified };
}

export async function routeMenuPaneCommand(command, target, host) {
  const first = capturePaneAction(host, target.pane, null);
  const warn = title => host.notify({ title, level: 'warning' });
  if (!first || (target.terminal && first.header.address !== target.terminal)) { warn('Pane is unavailable'); return; }
  let snapshot = null;
  try {
    const reply = await requestPane(host, { version: 1, op: 'snapshot', operationId: operationId({}) });
    if (reply?.version !== 1 || reply.kind !== 'snapshot' || !Array.isArray(reply.presentations)) throw new Error('Invalid pane service reply');
    snapshot = reply;
  } catch {
    if (proxyLabels(first.header.labels)) { warn('Pane target is unavailable'); return; }
  }
  const current = capturePaneAction(host, target.pane, snapshot);
  if (!current || current.pane.space !== first.pane.space || current.pane.tab !== first.pane.tab || current.header.address !== first.header.address ||
      ['spider.kind', 'spider.pane-id', 'spider.target-core', 'spider.target-terminal'].some(key => current.header.labels[key] !== first.header.labels[key])) {
    warn('Pane target changed'); return;
  }
  const ports = paneActionPorts(host, ctx => host.run('pane.close', { pane: ctx.pane.pane }), ctx => host.run('terminal.park', { terminal: ctx.header.address }));
  await handlePaneCommand(command, current, ports);
}
