// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { FEED_DISCONNECT_MS } from './shared/feed.js';
export async function loadAgentFeeds(root, ports) {
  const feeds = [], errors = [];
  const ids = await ports.listSessionIds(root);
  for (const id of ids.slice(0, 256)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) { errors.push('Invalid session directory'); continue; }
    try {
      const text = await ports.readTextFile(`${root}/${id}/session.json`);
      const feed = ports.parseFeed(text);
      if (!feed || feed.sessionId !== id) { errors.push(`${id}: invalid or unavailable feed`); continue; }
      feeds.push(feed);
    } catch { errors.push(`${id}: feed read failed`); }
  }
  return { feeds, errors, truncated: ids.length > 256 };
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => value == null || typeof value === 'string';
const title = value => text(value) || typeof value === 'number' && Number.isFinite(value);
const titleText = value => typeof value === 'number' ? String(value) : value;
const identity = value => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const texts = (value, keys) => keys.every(key => text(value[key]));
const numbers = (value, keys) => keys.every(key => value[key] == null || typeof value[key] === 'number' && Number.isFinite(value[key]));
const status = value => value == null || ['idle', 'working', 'blocked', 'done', 'error', 'queued', 'paused', 'disconnected', 'unreachable', 'cancelled', 'unknown', 'running', 'failed'].includes(value);
const program = value => value == null || object(value) && texts(value, ['key', 'name', 'icon']);
function renderRecords(values, kind, decode, rejected) {
  const result = [];
  if (!Array.isArray(values)) { rejected(kind); return result; }
  for (const value of values) {
    try {
      const decoded = decode(value);
      if (decoded) result.push(decoded); else rejected(kind);
    } catch { rejected(kind); }
  }
  return result;
}
const terminalRecord = value => object(value) && identity(value.address) && program(value.program)
  && texts(value, ['name', 'template', 'parent', 'reason']) && numbers(value, ['signal', 'exitCode', 'exit_code', 'finishedAt', 'finished_ms', 'created_ms'])
  && (value.labels === undefined || object(value.labels) && Object.values(value.labels).every(text))
  && (value.status == null || typeof value.status === 'string' && status(value.status) || object(value.status) && typeof value.status.state === 'string' && status(value.status.state))
  ? { ...value, labels: value.labels ?? {} } : null;

/** Snapshot and narrow external records once; one malformed record never poisons its neighbors. */
export function agentRenderInputs(input, rejected) {
  const agents = renderRecords(input.agents, 'agent', value => object(value) && identity(value.address)
    && program(value.program) && status(value.status) && numbers(value, ['seq']) && title(value.title)
    && texts(value, ['name', 'space_name', 'space', 'tab', 'pane']) ? { ...value, title: titleText(value.title) } : null, rejected);
  const terminals = renderRecords(input.terminals, 'terminal', terminalRecord, rejected);
  const panes = renderRecords(input.panes, 'pane', value => object(value) && program(value.program)
    && text(value.tab) && title(value.title) ? { ...value, title: titleText(value.title) } : null, rejected);
  const spaces = renderRecords(input.spaces, 'space', value => {
    if (!object(value) || !identity(value.id) || !text(value.name)) return null;
    const tabs = renderRecords(value.tabs ?? [], 'tab', tab => object(tab) && identity(tab.id) && title(tab.name) ? { ...tab, name: titleText(tab.name) ?? '' } : null, rejected);
    return { ...value, name: value.name ?? '', tabs };
  }, rejected);
  const machines = renderRecords(input.machines, 'machine', value => object(value) && (value.name === null || identity(value.name)) ? { ...value } : null, rejected);
  const feeds = renderRecords(input.feeds, 'feed', feed => {
    if (!object(feed) || !identity(feed.sessionId) || !Number.isFinite(feed.updatedAt)
      || !object(feed.owner) || !object(feed.owner.terminal) || !identity(feed.owner.terminal.address)
      || !text(feed.owner.name) || !object(feed.runs) || !Array.isArray(feed.runs.rows)) return null;
    const rows = renderRecords(feed.runs.rows, 'run', run => object(run) && identity(run.id)
      && identity(run.ownerSessionId) && status(run.status) && texts(run, ['name', 'viewer']) && numbers(run, ['finishedAt']) ? run : null, rejected);
    return { ...feed, owner: { ...feed.owner, terminal: { ...feed.owner.terminal } }, runs: { ...feed.runs, rows } };
  }, rejected);
  return { agents, terminals, panes, spaces, machines, feeds };
}

/** Optional labels/addresses can disappear during replacement; identities and text types cannot. */
export function agentChildRows(values, rejected) {
  return renderRecords(values, 'child', row => {
    if (!object(row) || !identity(row.key) || !['native', 'subagent', 'remote', 'console'].includes(row.kind)
      || !Number.isSafeInteger(row.depth) || row.depth < 0 || row.depth >= values.length || !program(row.program)
      || !status(row.status) || !texts(row, ['name', 'template', 'address', 'originalAddress', 'description', 'outcome', 'parentKey'])
      || row.terminal != null && !terminalRecord(row.terminal)) return null;
    return { ...row, name: row.name || row.template || row.program?.name || row.address || row.key };
  }, rejected);
}

const state = t => typeof t.status === 'string' ? t.status : t.status?.state ?? 'idle';
const isJob = (t, labels, kinds) => Boolean(t.labels[labels.job]) && [kinds.exec, kinds.execFile, kinds.batch].includes(t.labels[labels.kind]);
const isConsole = (t, labels, kinds) => t.labels[labels.kind] === kinds.remoteConsole;

export function filterTopLevelAgents(agents, terminals, { labels, kinds }) {
  const hidden = new Set(terminals.filter(t => t.labels[labels.kind] === kinds.remoteObserver || t.labels[labels.kind] === kinds.subagentViewer || isJob(t, labels, kinds) || isConsole(t, labels, kinds)).map(t => t.address));
  return agents.filter(a => !hidden.has(a.address));
}

// Retained run rows are roots. When the history is collapsed, only a retained
// run that is an ancestor of a live terminal needs a row; the rest need a count.
function summarizeFinished(all, deferred, feed, viewersBySession, labels, now, options, addRun, rows) {
  const limit = options.completedRows ?? 50, age = (options.completedHours ?? 24) * 3600000;
  const eligible = row => row.finishedAt !== null && now - row.finishedAt <= age && row.finishedAt <= now;
  const compare = (a, b) => b.finishedAt - a.finishedAt || a.key.localeCompare(b.key);
  const active = all.filter(row => !row.retained);
  const nativeFinished = all.filter(row => row.retained && eligible(row));
  let total = nativeFinished.length;
  for (const run of deferred.values()) if (eligible(run)) total++;

  // If retention trims candidates, select the newest keys with a bounded heap.
  // The heap holds only keys and timestamps, never projected hidden rows.
  let selected = null;
  if (total > limit) {
    const keys = [], times = [];
    const worse = (a, b) => times[a] < times[b] || times[a] === times[b] && keys[a].localeCompare(keys[b]) > 0;
    const swap = (a, b) => { [keys[a], keys[b]] = [keys[b], keys[a]]; [times[a], times[b]] = [times[b], times[a]]; };
    const offer = (key, time) => {
      if (!limit) return;
      if (keys.length < limit) {
        let i = keys.push(key) - 1; times.push(time);
        while (i > 0) { const parent = Math.floor((i - 1) / 2); if (!worse(i, parent)) break; swap(i, parent); i = parent; }
      } else if (time > times[0] || time === times[0] && key.localeCompare(keys[0]) < 0) {
        keys[0] = key; times[0] = time; let i = 0;
        for (;;) {
          const left = i * 2 + 1, right = left + 1;
          if (left >= keys.length) break;
          const child = right < keys.length && worse(right, left) ? right : left;
          if (!worse(child, i)) break;
          swap(i, child); i = child;
        }
      }
    };
    for (const row of nativeFinished) offer(row.key, row.finishedAt);
    for (const [key, run] of deferred) if (eligible(run)) offer(key, run.finishedAt);
    selected = new Set(keys);
  }
  const selectedRun = key => {
    const run = deferred.get(key);
    return Boolean(run && eligible(run) && (!selected || selected.has(key)));
  };
  const retained = nativeFinished.filter(row => !selected || selected.has(row.key)).sort(compare);
  const existing = [...active, ...retained], byKey = new Map(existing.map(row => [row.key, row]));
  const keyByAddress = new Map(existing.filter(row => row.originalAddress).map(row => [row.originalAddress, row.key]));
  const viewers = feed && viewersBySession.get(feed.sessionId);
  if (viewers) for (const [key, terminal] of viewers) if (selectedRun(key)) keyByAddress.set(terminal.address, key);
  for (const [key, run] of deferred) if (run.viewer && selectedRun(key) && !viewers?.has(key)) keyByAddress.set(run.viewer, key);
  const consoles = new Map();
  for (const row of existing) if (row.kind === 'console') {
    if (!consoles.has(row.machine)) consoles.set(row.machine, new Map());
    const runs = consoles.get(row.machine), runId = row.terminal.labels[labels.run] ?? null;
    if (!runs.has(runId)) runs.set(runId, row);
  }
  const parentOf = row => {
    if ((row.kind === 'native' || row.kind === 'subagent') && row.parentKey) return keyByAddress.get(row.parentKey) ?? row.parentKey;
    if (row.kind !== 'remote' && row.kind !== 'console') return row.parentKey;
    const runId = row.terminal.labels[labels.run], run = byKey.get(runId);
    const console = row.kind === 'remote' && row.machine ? consoles.get(row.machine)?.get(runId ?? null) : null;
    return console?.key ?? (run?.kind === 'subagent' || selectedRun(runId) ? runId : null);
  };
  const needed = new Set(), live = new Set();
  for (const row of active) for (let key = row.key; key && !live.has(key);) {
    live.add(key);
    if (selectedRun(key)) {
      needed.add(key);
      key = keyByAddress.get(viewers?.get(key)?.parent) ?? null;
    } else {
      const current = byKey.get(key);
      key = current ? parentOf(current) : null;
    }
  }
  const hiddenNative = new Set(), folded = options.folded ?? new Set(), expanded = options.expandedConsoles ?? new Set();
  const expandedSubagents = options.expandedSubagents ?? new Set(), visibility = new Map();
  const visibleThroughParents = key => {
    const path = [], seen = new Set();
    let current = key, visible = true;
    while (current && (byKey.has(current) || selectedRun(current))) {
      if (visibility.has(current)) { visible = visibility.get(current); break; }
      if (seen.has(current)) { visible = false; break; }
      seen.add(current); path.push(current);
      const parent = selectedRun(current) ? keyByAddress.get(viewers?.get(current)?.parent) ?? null : parentOf(byKey.get(current));
      const parentRow = byKey.get(parent);
      if (parentRow || selectedRun(parent)) {
        if ((parentRow?.kind === 'subagent' || selectedRun(parent)) ? !expandedSubagents.has(parent)
          : folded.has(parent) || parentRow?.kind === 'console' && !expanded.has(parent)) { visible = false; break; }
      }
      current = parent;
    }
    for (const item of path) visibility.set(item, visible);
    return visible;
  };
  let hiddenNativeCount = 0;
  for (const row of retained) {
    if (live.has(row.key)) continue;
    let current = row;
    const seen = new Set();
    while (current && !seen.has(current.key)) {
      seen.add(current.key);
      const parent = parentOf(current), parentRow = byKey.get(parent);
      if (selectedRun(parent)) {
        if (!needed.has(parent)) { hiddenNative.add(row.key); if (visibleThroughParents(row.key)) hiddenNativeCount++; }
        break;
      }
      current = parentRow;
    }
  }
  let selectedDeferred = 0;
  for (const key of deferred.keys()) if (selectedRun(key) && !needed.has(key) && visibleThroughParents(key)) selectedDeferred++;
  for (const key of needed) { addRun(deferred.get(key)); retained.push(rows.get(key)); }
  options.finishedSummary.hiddenFinished = selectedDeferred + hiddenNativeCount;
  retained.sort(compare);
  return [...active, ...retained.filter(row => !hiddenNative.has(row.key))];
}

/** Build indexes once per immutable render snapshot, rather than once per owner. */
export function indexAgentChildren(terminals, feeds, labelContract) {
  const { labels, kinds } = labelContract;
  const feedsBySession = new Map(), feedsByOwner = new Map(), byParent = new Map(), byOwner = new Map(), viewersBySession = new Map();
  for (const feed of feeds) {
    if (!feedsBySession.has(feed.sessionId)) feedsBySession.set(feed.sessionId, feed);
    if (!feedsByOwner.has(feed.owner.terminal.address)) feedsByOwner.set(feed.owner.terminal.address, feed);
  }
  for (const terminal of terminals) {
    if (!byParent.has(terminal.parent)) byParent.set(terminal.parent, []);
    byParent.get(terminal.parent).push(terminal);
    const owner = feedsBySession.get(terminal.labels[labels.session])?.owner.terminal.address;
    if (owner) { if (!byOwner.has(owner)) byOwner.set(owner, []); byOwner.get(owner).push(terminal); }
    if (terminal.labels[labels.kind] !== kinds.subagentViewer) continue;
    const session = terminal.labels[labels.session], run = terminal.labels[labels.run];
    if (!viewersBySession.has(session)) viewersBySession.set(session, new Map());
    const viewers = viewersBySession.get(session);
    if (!viewers.has(run)) viewers.set(run, terminal);
  }
  return { terminals, feeds, labelContract, feedsBySession, feedsByOwner, byParent, byOwner, viewersBySession, ownedRuns: new Map() };
}

/** Public terminal snapshots plus public session feeds; never reads a private job journal. */
export function projectAgentChildren(terminals, feeds, ownerAddress, labelContract, options = {}) {
  const { labels, kinds } = labelContract;
  const now = options.now ?? Date.now();
  const unavailable = new Set((options.machines ?? []).filter(machine => machine.layout === 'unavailable').map(machine => machine.name));
  const terminalMachine = t => t?.address?.includes('/') ? t.address.split('/')[0] : t?.labels?.[labels.machine] ?? null;
  const isUnreachable = t => unavailable.has(terminalMachine(t));
  const index = options.index?.terminals === terminals && options.index?.feeds === feeds && options.index?.labelContract === labelContract
    ? options.index : indexAgentChildren(terminals, feeds, labelContract);
  const { feedsBySession, byParent, byOwner, viewersBySession, ownedRuns } = index;
  const feed = index.feedsByOwner.get(ownerAddress);
  const runsFor = item => {
    if (!ownedRuns.has(item)) {
      const runs = new Map();
      for (const run of item.runs.rows) if (run.ownerSessionId === item.sessionId && !runs.has(run.id)) runs.set(run.id, run);
      ownedRuns.set(item, runs);
    }
    return ownedRuns.get(item);
  };
  const rows = new Map(), visited = new Set([ownerAddress]);
  const currentOwner = t => feedsBySession.get(t.labels[labels.session])?.owner.terminal.address;
  const sessionAction = (kind, key, sessionId, viewer) => {
    const current = feedsBySession.get(sessionId);
    const ownedRun = kind !== 'subagent' || current && runsFor(current).has(key);
    if (current?.lifecycle !== 'live' || !current.ipc || kind === 'subagent' && (now - current.updatedAt > FEED_DISCONNECT_MS || !ownedRun))
      return kind === 'subagent' && viewer?.state === 'live' ? { kind: 'peek', terminal: viewer.address } : null;
    const descriptor = { version: 1, sessionId: current.sessionId, generation: current.generation, ...current.ipc };
    const request = kind === 'remote' || kind === 'console' ? { op: 'openJob', jobId: key, generation: current.generation } : { op: 'openRun', runId: key, generation: current.generation };
    return { kind: 'ipc', descriptor, request };
  };
  const add = (t, depth) => {
    const kind = t.labels[labels.kind];
    if (kind === kinds.remoteObserver) return false;
    const sessionId = t.labels[labels.session], current = currentOwner(t);
    if (current && current !== ownerAddress) return false;
    const subagent = kind === kinds.subagentViewer, remote = isJob(t, labels, kinds), console = isConsole(t, labels, kinds);
    if (remote && t.state !== 'live') return false;
    const key = subagent ? t.labels[labels.run] : remote ? t.labels[labels.job] : console ? `console:${t.address}` : t.address;
    if (!key || rows.has(key) || (!remote && !subagent && !console && t.state !== 'live')) return true;
    const finish = t.state === 'finished';
    const finishedAt = t.finishedAt ?? t.finished_ms ?? null, exitCode = t.exitCode ?? t.exit_code ?? null;
    const run = feed ? runsFor(feed).get(t.labels[labels.run]) : null;
    let outcome = null, status = state(t);
    if (finish) {
      outcome = t.signal != null ? `signal ${t.signal}` : exitCode !== null ? `exit ${exitCode}` : t.reason ?? 'unknown';
      status = exitCode !== null || t.signal != null ? 'error' : 'unknown';
      if (exitCode === 0 && t.signal == null && t.reason === 'exited') status = 'done';
    } else if (subagent && !run) status = 'unknown';
    else if (feed?.lifecycle === 'live' && now - feed.updatedAt > FEED_DISCONNECT_MS && (remote || subagent || console)) status = 'disconnected';
    else if (remote && ['done', 'idle'].includes(status)) status = 'working';
    const unreachable = (remote || subagent || console) && isUnreachable(t);
    if (unreachable) status = 'unreachable';
    const rowKind = remote ? 'remote' : subagent ? 'subagent' : console ? 'console' : 'native';
    const machine = t.labels[labels.machine] ?? null;
    // hc only takes slug names; the readable name rides on a display-only label.
    const display = t.labels[labels.displayName ?? 'spider.display-name'];
    const name = console ? (machine || 'This computer') : display || (t.name ?? t.template ?? t.program?.name ?? key);
    const description = console ? `${run?.name ?? feed?.owner.name ?? 'Agent'} console on ${machine || 'This computer'}` : null;
    rows.set(key, {
      key, kind: rowKind, address: t.address, originalAddress: t.address,
      name, description, status, outcome, completeness: 'unknown', machine,
      parentKey: (rowKind === 'native' || rowKind === 'subagent') && depth > 0 ? t.parent : null,
      finishedAt: finish ? finishedAt : null, retained: finish, depth, terminal: t,
      action: unreachable ? null : remote || subagent || console ? sessionAction(rowKind, key, sessionId, subagent ? t : null) : { kind: 'peek', terminal: t.address },
    });
    return true;
  };
  const walk = (parent, depth) => {
    for (const t of byParent.get(parent) ?? []) {
      if (visited.has(t.address)) continue;
      visited.add(t.address); if (add(t, depth)) walk(t.address, depth + 1);
    }
  };
  walk(ownerAddress, 0);
  // Resumed sessions have a new verified owner; native parentage remains original.
  for (const t of byOwner.get(ownerAddress) ?? []) {
    const kind = t.labels[labels.kind];
    if (visited.has(t.address) || (!isJob(t, labels, kinds) && !isConsole(t, labels, kinds) && kind !== kinds.subagentViewer)) continue;
    visited.add(t.address); if (add(t, 0)) walk(t.address, 1);
  }
  const addRun = run => {
    const native = viewersBySession.get(feed.sessionId)?.get(run.id);
    const done = ['done', 'failed', 'cancelled'].includes(run.status);
    const action = sessionAction('subagent', run.id, feed.sessionId, native);
    const unreachable = isUnreachable(native ?? (run.viewer ? { address: run.viewer } : null)) && !(done && action?.kind === 'ipc');
    const status = unreachable ? 'unreachable' : run.status === 'running' ? (feed.lifecycle !== 'live' || now - feed.updatedAt > FEED_DISCONNECT_MS ? 'disconnected' : 'working') : run.status === 'failed' ? 'error' : run.status;
    const previous = rows.get(run.id);
    rows.set(run.id, {
      key: run.id, kind: 'subagent', address: run.viewer, originalAddress: native?.address ?? run.viewer,
      name: run.name ?? run.id, description: null, status, outcome: done ? run.status : null, completeness: 'unknown',
      machine: null, parentKey: previous?.parentKey ?? (native?.parent && native.parent !== ownerAddress ? native.parent : null),
      finishedAt: run.finishedAt, retained: done, depth: previous?.depth ?? 0, terminal: native ?? null,
      action: unreachable ? null : action,
    });
  };
  const limit = options.completedRows ?? 50;
  const deferred = options.finishedSummary && Number.isSafeInteger(limit) && limit >= 0 ? new Map() : null;
  for (const run of feed?.runs.rows ?? []) {
    if (run.ownerSessionId !== feed.sessionId) continue;
    if (deferred && ['done', 'failed', 'cancelled'].includes(run.status)) {
      rows.set(run.id, null); deferred.set(run.id, run);
    } else { deferred?.delete(run.id); addRun(run); }
  }
  const all = [];
  for (const row of rows.values()) if (row) all.push(row);
  // An unconfirmed run is not known to be finished. Keep its status visible,
  // but bound it like history without inventing a finish time or outcome.
  const uncertain = row => row.kind === 'subagent' && !row.retained && ['unknown', 'disconnected'].includes(row.status);
  const uncertainAt = row => row.status === 'disconnected' ? feed?.updatedAt : row.terminal?.created_ms;
  const age = (options.completedHours ?? 24) * 3600000;
  const candidates = all.filter(uncertain).filter(row => {
    const at = uncertainAt(row);
    return !Number.isFinite(at) || now - at <= age;
  }).sort((a, b) => (uncertainAt(b) ?? -Infinity) - (uncertainAt(a) ?? -Infinity) || a.key.localeCompare(b.key));
  const selectedUncertain = new Set(candidates.slice(0, limit));
  const bounded = all.filter(row => !uncertain(row) || selectedUncertain.has(row));
  const kept = deferred ? summarizeFinished(bounded, deferred, feed, viewersBySession, labels, now, options, addRun, rows)
    : [...bounded.filter(r => !r.retained), ...bounded.filter(r => r.retained && r.finishedAt !== null && now - r.finishedAt <= age && r.finishedAt <= now).sort((a, b) => b.finishedAt - a.finishedAt || a.key.localeCompare(b.key)).slice(0, limit)];
  if (options.finishedSummary && !deferred) options.finishedSummary.hiddenFinished = 0;
  const byKey = new Map(kept.map(row => [row.key, row]));
  const keyByAddress = new Map(kept.filter(row => row.originalAddress).map(row => [row.originalAddress, row.key]));
  const consoles = new Map();
  for (const row of kept) if (row.kind === 'console') {
    if (!consoles.has(row.machine)) consoles.set(row.machine, new Map());
    const runs = consoles.get(row.machine), runId = row.terminal.labels[labels.run] ?? null;
    if (!runs.has(runId)) runs.set(runId, row);
  }
  for (const row of kept) {
    if ((row.kind === 'native' || row.kind === 'subagent') && row.parentKey) row.parentKey = keyByAddress.get(row.parentKey) ?? row.parentKey;
    if (row.kind !== 'remote' && row.kind !== 'console') continue;
    const runId = row.terminal.labels[labels.run];
    const run = byKey.get(runId);
    row.parentKey = run?.kind === 'subagent' ? run.key : null;
    if (row.kind === 'remote' && row.machine) {
      const console = consoles.get(row.machine)?.get(runId ?? null);
      if (console) row.parentKey = console.key;
    }
  }
  // Remote terminals report no agent status, so a console is busy exactly when a command under it is running.
  const busyConsoles = new Set(kept.filter(row => row.kind === 'remote' && row.status === 'working').map(row => row.parentKey));
  for (const row of kept) if (row.kind === 'console' && row.status === 'idle' && busyConsoles.has(row.key)) row.status = 'working';
  const childrenByKey = new Map();
  for (const row of kept) {
    if (!childrenByKey.has(row.parentKey)) childrenByKey.set(row.parentKey, []);
    childrenByKey.get(row.parentKey).push(row);
  }
  const ordered = [], emitted = new Set();
  const emit = (row, depth) => {
    if (emitted.has(row.key)) return;
    emitted.add(row.key); row.depth = depth; ordered.push(row);
    for (const child of childrenByKey.get(row.key) ?? []) emit(child, depth + 1);
  };
  for (const row of kept) if (!row.parentKey || !byKey.has(row.parentKey)) { row.parentKey = null; emit(row, 0); }
  return ordered;
}

/** Keys contain only sidebar data, not heartbeat timestamps or revision counters. */
export function agentModelInputKey(input, now, completedHours, feedCache = new Map()) {
  const maxAge = completedHours * 3600000;
  const withinRetention = at => typeof at === 'number' ? [at <= now, now - at <= maxAge] : null;
  try {
    const used = new Set();
    const feeds = Array.isArray(input.feeds) ? input.feeds.map(feed => {
      if (!object(feed)) return feed;
      const stamp = input.feedStamps?.get(feed.sessionId);
      let cached = typeof stamp === 'string' ? feedCache.get(feed.sessionId) : null;
      if (!cached || cached.stamp !== stamp || cached.maxAge !== maxAge) {
        const rows = feed.runs?.rows;
        if (typeof stamp === 'string') {
          cached = { stamp, maxAge, rows: stamp, runs: Array.isArray(rows) ? rows : [], asOf: Infinity, deadline: -Infinity, age: 0 };
          feedCache.set(feed.sessionId, cached);
        } else {
          const times = [];
          const value = Array.isArray(rows) ? rows.map(run => {
            if (!object(run)) return run;
            if (typeof run.finishedAt === 'number' && Number.isFinite(run.finishedAt)) times.push(run.finishedAt);
            return [run.id, run.ownerSessionId, run.name, run.status, run.viewer, run.finishedAt];
          }) : rows;
          cached = { stamp, maxAge, rows: JSON.stringify(value), times, asOf: Infinity, deadline: -Infinity, age: null };
        }
      }
      used.add(feed.sessionId);
      if (now < cached.asOf || now >= cached.deadline) {
        let deadline = Infinity;
        const boundary = at => {
          if (at > now) deadline = Math.min(deadline, at);
          else if (at + maxAge >= now) deadline = Math.min(deadline, at + maxAge + 1);
        };
        if (cached.runs) {
          for (const run of cached.runs) if (typeof run?.finishedAt === 'number' && Number.isFinite(run.finishedAt)) boundary(run.finishedAt);
          cached.age++;
        } else cached.age = JSON.stringify(cached.times.map(at => { boundary(at); return withinRetention(at); }));
        cached.asOf = now; cached.deadline = deadline;
      }
      const stale = Number.isFinite(feed.updatedAt) ? now - feed.updatedAt > FEED_DISCONNECT_MS : feed.updatedAt;
      return [feed.sessionId, feed.generation, feed.owner, feed.lifecycle, feed.ipc, feed.status, feed.placement,
        stale, feed.lifecycle !== 'live' || stale === true ? feed.updatedAt : null, withinRetention(feed.updatedAt), cached.rows, cached.age];
    }) : input.feeds;
    for (const session of feedCache.keys()) if (!used.has(session)) feedCache.delete(session);
    const kindLabel = input.contract?.labels?.kind ?? 'spider.kind', viewerKind = input.contract?.kinds?.subagentViewer ?? 'subagent-viewer';
    const terminalAge = Array.isArray(input.terminals) ? input.terminals.map(t => object(t) && t.state === 'finished' ? withinRetention(t.finishedAt ?? t.finished_ms)
      : object(t) && t.state === 'live' && t.labels?.[kindLabel] === viewerKind ? withinRetention(t.created_ms) : null) : null;
    return JSON.stringify([input.agents, input.terminals, input.panes, input.spaces, input.machines, feeds, terminalAge,
      input.focus, input.connections, input.error, input.diagnostics, input.contract, input.configuredMachines, completedHours, input.completedRows]);
  } catch { return null; }
}

const modelProgram = value => value && [value.key, value.name, value.icon, value.tint, value.agent];
/** Only fields consumed by the row builders participate in notification and tree-cache equality. */
export function agentModelRowKey(rows) {
  try {
    return JSON.stringify(rows.map(row => [row.key, row.kind, row.address, row.originalAddress, row.name,
      row.description, row.status, row.outcome, row.completeness, row.finishedAt, row.retained, row.depth,
      row.parentKey, row.machine, row.action, row.terminal && [row.terminal.state, row.terminal.template, modelProgram(row.terminal.program)]]));
  } catch { return null; }
}
export function agentModelOutputKey(model) {
  try {
    const { snapshot, list, rows, parked, layouts, diagnostics, connections, error } = model;
    const owners = new Set(list.map(agent => agent.address)), labels = model.contract.labels;
    const agents = list.map(a => [a.address, a.pane, a.space, a.space_name, a.tab, a.title, a.name, a.status, a.pinned, a.focused, a.seq, modelProgram(a.program),
      a.navigation && [a.navigation.id, a.navigation.machine, a.navigation.action, a.navigation.disabledReason, a.navigation.generation, a.navigation.presentationId, a.navigation.expectedRevision]]);
    const terminals = snapshot.terminals.filter(t => owners.has(t.address)).map(t => [t.address, t.state,
      typeof t.status === 'string' ? t.status : t.status?.state, t.labels[labels.kind], t.labels[labels.machine], t.labels[labels.ownerTerminal], t.labels['herdr.pinned']]);
    const panes = snapshot.panes.map(p => [p.pane, p.terminal, p.tab, p.title, p.focused, modelProgram(p.program)]);
    const spaces = snapshot.spaces.map(s => [s.id, s.name, s.tabs.map(t => [t.id, t.name, t.named])]);
    const names = snapshot.feeds.filter(f => owners.has(f.owner.terminal.address)).map(f => [f.owner.terminal.address, f.owner.name]);
    return JSON.stringify([agents, terminals, panes, spaces, names, [...rows].map(([owner, value]) => [owner, model.rowKeys?.get(owner) ?? agentModelRowKey(value)]),
      [...(model.hiddenFinished ?? [])], parked, layouts.map(layout => [layout.name, layout.layout, layout.coreId]), [...diagnostics].sort(), connections, error]);
  } catch { return null; }
}

export function agentModelChildStats(rows, listed, ranks) {
  const consoleKeys = new Set(rows.filter(row => row.kind === 'console').map(row => row.key));
  const consoles = [], bots = [], states = [];
  let rank = 0;
  for (const row of rows) {
    if (row.kind === 'console' && row.status !== 'unreachable' && row.terminal?.state === 'live') consoles.push(row);
    if (row.retained || ['unreachable', 'unknown', 'disconnected'].includes(row.status)) continue;
    if (row.kind !== 'console' && !(row.kind === 'remote' && consoleKeys.has(row.parentKey))) bots.push(row);
    const status = listed.get(row.address) ?? row.status;
    const normalized = status === 'error' ? 'blocked' : status === 'done' ? 'idle' : status;
    states.push(normalized); rank = Math.max(rank, ranks[normalized] ?? 0);
  }
  return { consoles, bots, states, rank };
}

/** Map changed controls to their owners without scanning finished rows during render. */
export function agentModelTreeStates(model, folded, expandedConsoles, expandedGroups, shownFinished, subagentStates = new Map()) {
  const states = new Map();
  const add = (owner, type, key) => {
    if (!states.has(owner)) states.set(owner, []);
    states.get(owner).push([type, key]);
  };
  const fromIndex = (index, values, type) => {
    for (const key of values) for (const owner of index.get(key) ?? []) add(owner, type, key);
  };
  fromIndex(model.childOwners, folded, 'fold');
  fromIndex(model.childOwners, expandedConsoles, 'console');
  for (const [owner, state] of subagentStates) add(owner, 'subagent', state);
  fromIndex(model.groupOwners, expandedGroups, 'group');
  for (const owner of shownFinished) add(owner, 'finished', owner);
  for (const [owner, values] of states) states.set(owner, JSON.stringify(values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))));
  return states;
}

/** Hide jobs and their descendants inside collapsed consoles. */
export function selectAgentChildren(rows, expandedConsoles = []) {
  const byKey = new Map(rows.map(row => [row.key, row]));
  const expanded = new Set(expandedConsoles), hidden = new Set();
  for (const row of rows) {
    if (hidden.has(row.parentKey) || (byKey.get(row.parentKey)?.kind === 'console' && !expanded.has(row.parentKey))) hidden.add(row.key);
  }
  return rows.filter(row => !hidden.has(row.key));
}
