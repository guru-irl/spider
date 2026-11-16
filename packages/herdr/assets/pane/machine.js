// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { div } from 'gpui-kit';

const proxyKind = labels => labels['spider.kind'] === 'pane-proxy' || labels['spider.kind'] === 'roam-proxy' ||
  Boolean(labels['spider.target-core'] || labels['spider.target-terminal']);
const agentKind = labels => ['session', 'subagent-viewer', 'remote-console', 'remote-observer'].includes(labels['spider.kind']);

export function panePresentation(pane, presentations) {
  const matches = presentations.filter(item => item.visibility === 'visible' &&
    (item.mode === 'proxy' ? item.proxy === pane.address && pane.address !== null : item.target.address === pane.address && pane.address !== null));
  if (matches.length !== 1) return null;
  const item = matches[0];
  if (item.mode === 'proxy') {
    const labels = pane.labels;
    if (labels['spider.kind'] !== 'pane-proxy' || labels['spider.pane-id'] !== item.id ||
        labels['spider.target-core'] !== item.target.coreId || labels['spider.target-terminal'] !== item.target.terminalId) return null;
  } else if (Object.entries(item.target.identityLabels).some(([key, value]) => pane.labels[key] !== value)) return null;
  return item;
}

export function paneMachineFact(pane, presentations) {
  const item = panePresentation(pane, presentations);
  if (item) {
    if (item.role === 'shell' && item.mode === 'native' && !pane.programIsAgent && !agentKind(pane.labels)) return null;
    if (item.mode === 'proxy' && !item.target.alias) return { label: 'Machine unavailable', known: false };
    return { label: item.target.alias ?? 'This computer', known: true };
  }
  if (proxyKind(pane.labels) || presentations.some(item => pane.address !== null &&
    (item.mode === 'proxy' ? item.proxy === pane.address : item.target.address === pane.address)))
    return { label: 'Machine unavailable', known: false };
  if (!pane.programIsAgent && !agentKind(pane.labels)) return null;
  return pane.address && !pane.address.includes('/') ? { label: 'This computer', known: true } : { label: 'Machine unavailable', known: false };
}

export function paneTargetFacts(pane, presentations, targetFacts) {
  const item = panePresentation(pane, presentations);
  if (!item || item.mode !== 'proxy') return null;
  const target = item.target;
  const facts = targetFacts[JSON.stringify([target.coreId, target.terminalId])];
  if (!facts || facts.createdMs !== target.createdMs || facts.terminal?.address !== `${target.coreId}/${target.terminalId}` ||
      Object.entries(target.identityLabels).some(([key, value]) => facts.identityLabels?.[key] !== value || facts.terminal.labels?.[key] !== value)) return null;
  return facts;
}

export function resolvePaneHeaderFacts(pane, presentations, targetFacts) {
  const machine = paneMachineFact(pane, presentations);
  const item = panePresentation(pane, presentations);
  const isProxy = proxyKind(pane.labels) || presentations.some(row => row.mode === 'proxy' && row.proxy === pane.address && pane.address !== null);
  if (!isProxy) return { name: pane.nativeTitle, status: pane.nativeStatus, cwd: pane.nativeCwd, machine };
  const facts = paneTargetFacts(pane, presentations, targetFacts);
  const title = facts?.title || item?.target.name || (item?.role === 'shell' ? 'Terminal' : 'Agent');
  const name = /^\u03c0 - (.+) - [^/]*$/.exec(title)?.[1] ?? title;
  return { name, status: facts?.status ?? null, cwd: facts?.currentCwd ?? null, machine };
}

export function renderMachinePill(fact, theme, font) {
  return div().id('spider-machine-pill').flex_shrink_1().min_w(0).max_w(150).truncate().px(8).h(18).flex().items_center()
    .rounded(999).bg('#ffffff14').font_family(font).text_size(11).text_color(theme.muted ?? theme.dim ?? theme.foreground)
    .tooltip(fact.label).child(fact.label);
}

const absolute = value => typeof value === 'string' && (/^\//.test(value) || /^[a-zA-Z]:[\\/]/.test(value)) && !value.includes('\0');
const operationId = () => Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

export function initPaneHeaderProjection(view, cx, host) {
  const state = view.machineProjection = { closed: false, pending: false, timer: null };
  if (!cx || host.checking?.()) return;
  cx.spawn(async current => {
    try {
      const content = await host.readTextFile(`${host.appHome()}/mods/spider-machine-picker/config.json`);
      const config = content ? JSON.parse(content) : null;
      if (!config || config.version !== 1 || config.checkMode || !absolute(config.nodePath) || !absolute(config.cliPath) || state.closed) return;
      const refresh = async context => {
        if (state.pending || state.closed) return;
        state.pending = true;
        try {
          const request = { version: 1, op: 'snapshot', operationId: operationId() };
          const result = await host.exec(config.nodePath, [config.cliPath, 'panes', 'request', '--json', JSON.stringify(request)], { timeout: 5000 });
          const reply = result.code === 0 ? JSON.parse(result.stdout) : null;
          if (!state.closed && reply?.version === 1 && reply.kind === 'snapshot' && Array.isArray(reply.presentations) && reply.targetFacts && typeof reply.targetFacts === 'object') {
            view.machineSnapshot = { presentations: reply.presentations, targetFacts: reply.targetFacts };
            context.notify();
          }
        } catch { /* Retain the last verified display until the next refresh. */ }
        finally { state.pending = false; }
      };
      await refresh(current);
      if (!state.closed) state.timer = current.timer?.every(5000, next => next.spawn(async context => refresh(context)));
    } catch { /* A missing configuration leaves native headers unchanged. */ }
  });
}

export function closePaneHeaderProjection(view) {
  if (!view.machineProjection) return;
  view.machineProjection.closed = true;
  view.machineProjection.timer?.cancel?.();
}
