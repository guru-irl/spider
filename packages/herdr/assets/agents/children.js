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
const state = t => typeof t.status === 'string' ? t.status : t.status?.state ?? 'idle';
const isJob = (t, labels, kinds) => Boolean(t.labels[labels.job]) && [kinds.exec, kinds.execFile, kinds.batch].includes(t.labels[labels.kind]);
const isConsole = (t, labels, kinds) => t.labels[labels.kind] === kinds.remoteConsole && Boolean(t.labels[labels.machine]);

export function filterTopLevelAgents(agents, terminals, { labels, kinds }) {
  const hidden = new Set(terminals.filter(t => t.labels[labels.kind] === kinds.remoteObserver || t.labels[labels.kind] === kinds.subagentViewer || isJob(t, labels, kinds) || isConsole(t, labels, kinds)).map(t => t.address));
  return agents.filter(a => !hidden.has(a.address));
}

/** Public terminal snapshots plus public session feeds; never reads a private job journal. */
export function projectAgentChildren(terminals, feeds, ownerAddress, labelContract, options = {}) {
  const { labels, kinds } = labelContract;
  const now = options.now ?? Date.now();
  const feed = feeds.find(f => f.owner.terminal.address === ownerAddress);
  const rows = new Map(), visited = new Set([ownerAddress]);
  const currentOwner = t => feeds.find(f => f.sessionId === t.labels[labels.session])?.owner.terminal.address;
  const sessionAction = (kind, key, sessionId, viewer) => {
    const current = feeds.find(f => f.sessionId === sessionId);
    const ownedRun = kind !== 'subagent' || current?.runs.rows.some(run => run.id === key && run.ownerSessionId === sessionId);
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
    let outcome = null, status = state(t);
    if (finish) {
      outcome = t.signal != null ? `signal ${t.signal}` : exitCode !== null ? `exit ${exitCode}` : t.reason ?? 'unknown';
      status = exitCode !== null || t.signal != null ? 'error' : 'unknown';
      if (exitCode === 0 && t.signal == null && t.reason === 'exited') status = 'done';
    } else if (feed?.lifecycle === 'live' && now - feed.updatedAt > FEED_DISCONNECT_MS && (remote || subagent || console)) status = 'disconnected';
    else if (remote && ['done', 'idle'].includes(status)) status = 'working';
    const rowKind = remote ? 'remote' : subagent ? 'subagent' : console ? 'console' : 'native';
    const run = feed?.runs.rows.find(r => r.id === t.labels[labels.run] && r.ownerSessionId === feed.sessionId);
    const machine = t.labels[labels.machine] ?? null;
    // hc only takes slug names; the readable name rides on a display-only label.
    const display = t.labels[labels.displayName ?? 'spider.display-name'];
    const name = console ? `${run?.name ?? feed?.owner.name ?? 'Agent'} · ${machine}` : display || (t.name ?? t.template ?? t.program?.name ?? key);
    rows.set(key, {
      key, kind: rowKind, address: t.address, originalAddress: t.address,
      name, status, outcome, completeness: 'unknown', machine,
      parentKey: rowKind === 'native' && depth > 0 ? t.parent : null,
      finishedAt: finish ? finishedAt : null, retained: finish, depth, terminal: t,
      action: remote || subagent || console ? sessionAction(rowKind, key, sessionId, subagent ? t : null) : { kind: 'peek', terminal: t.address },
    });
    return true;
  };
  const walk = (parent, depth) => {
    for (const t of terminals.filter(t => t.parent === parent)) {
      if (visited.has(t.address)) continue;
      visited.add(t.address); if (add(t, depth)) walk(t.address, depth + 1);
    }
  };
  walk(ownerAddress, 0);
  // Resumed sessions have a new verified owner; native parentage remains original.
  for (const t of terminals) {
    const kind = t.labels[labels.kind];
    if (visited.has(t.address) || currentOwner(t) !== ownerAddress || (!isJob(t, labels, kinds) && !isConsole(t, labels, kinds) && kind !== kinds.subagentViewer)) continue;
    visited.add(t.address); if (add(t, 0)) walk(t.address, 1);
  }
  for (const run of feed?.runs.rows ?? []) {
    if (run.ownerSessionId !== feed.sessionId) continue;
    const native = terminals.find(t => t.labels[labels.kind] === kinds.subagentViewer && t.labels[labels.run] === run.id && t.labels[labels.session] === feed.sessionId);
    const done = ['done', 'failed', 'cancelled'].includes(run.status);
    const status = run.status === 'running' ? (now - feed.updatedAt > FEED_DISCONNECT_MS && feed.lifecycle === 'live' ? 'disconnected' : 'working') : run.status === 'failed' ? 'error' : run.status;
    const previous = rows.get(run.id);
    rows.set(run.id, {
      key: run.id, kind: 'subagent', address: run.viewer, originalAddress: native?.address ?? run.viewer,
      name: run.name ?? run.id, status, outcome: done ? run.status : null, completeness: 'unknown',
      machine: null, parentKey: null,
      finishedAt: run.finishedAt, retained: done, depth: previous?.depth ?? 0, terminal: native ?? null,
      action: sessionAction('subagent', run.id, feed.sessionId, native),
    });
  }
  const all = [...rows.values()];
  const finished = all.filter(r => r.retained && r.finishedAt !== null && now - r.finishedAt <= (options.completedHours ?? 24) * 3600000 && r.finishedAt <= now).sort((a, b) => b.finishedAt - a.finishedAt || a.key.localeCompare(b.key)).slice(0, options.completedRows ?? 50);
  const kept = [...all.filter(r => !r.retained), ...finished];
  const byKey = new Map(kept.map(row => [row.key, row]));
  const keyByAddress = new Map(kept.filter(row => row.originalAddress).map(row => [row.originalAddress, row.key]));
  for (const row of kept) {
    if (row.kind === 'native' && row.parentKey) row.parentKey = keyByAddress.get(row.parentKey) ?? row.parentKey;
    if (row.kind !== 'remote' && row.kind !== 'console') continue;
    const runId = row.terminal.labels[labels.run];
    const run = byKey.get(runId);
    row.parentKey = run?.kind === 'subagent' ? run.key : null;
    if (row.kind === 'remote' && row.machine) {
      const console = kept.find(c => c.kind === 'console' && c.machine === row.machine
        && (c.terminal.labels[labels.run] ?? null) === (runId ?? null));
      if (console) row.parentKey = console.key;
    }
  }
  // Remote terminals report no agent status, so a console is busy exactly when a command under it is running.
  for (const row of kept) {
    if (row.kind === 'console' && row.status === 'idle' && kept.some(job => job.kind === 'remote' && job.parentKey === row.key && job.status === 'working')) row.status = 'working';
  }
  const ordered = [], emitted = new Set();
  const emit = (row, depth) => {
    if (emitted.has(row.key)) return;
    emitted.add(row.key); row.depth = depth; ordered.push(row);
    for (const child of kept.filter(c => c.parentKey === row.key)) emit(child, depth + 1);
  };
  for (const row of kept) if (!row.parentKey || !byKey.has(row.parentKey)) { row.parentKey = null; emit(row, 0); }
  return ordered;
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
