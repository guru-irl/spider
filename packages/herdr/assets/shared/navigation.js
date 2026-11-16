// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { filterTopLevelAgents, projectAgentChildren } from '../agents/children.js';
import { FEED_DISCONNECT_MS } from './feed.js';
import { projectPanePresentations } from './presentations.js';

const machineOfAddress = address => address?.includes('/') ? address.slice(0, address.indexOf('/')) : null;
const statusOf = terminal => typeof terminal?.status === 'string' ? terminal.status : terminal?.status?.state ?? 'idle';
const isProxy = (terminal, labels) => Boolean(terminal && !terminal.address.includes('/') && ['roam-proxy', 'pane-proxy'].includes(terminal.labels?.[labels.kind]));

function proxyMatches(terminal, feed, labels) {
  const values = terminal.labels;
  return isProxy(terminal, labels) && values[labels.session] === feed.sessionId
    && values[labels.ownerCore] === feed.owner.terminal.coreId
    && values[labels.ownerTerminal] === feed.owner.terminal.address;
}

function terminalMatches(terminal, feed, coreId, labels) {
  if (!terminal || terminal.state !== 'live') return false;
  if (isProxy(terminal, labels)) return proxyMatches(terminal, feed, labels);
  const values = terminal.labels;
  return terminal.address === feed.owner.terminal.address
    && (terminal.address.includes('/') || feed.owner.terminal.coreId === coreId)
    && (!values[labels.session] || values[labels.session] === feed.sessionId)
    && (!values[labels.ownerCore] || values[labels.ownerCore] === feed.owner.terminal.coreId)
    && (!values[labels.ownerTerminal] || values[labels.ownerTerminal] === feed.owner.terminal.terminalId || values[labels.ownerTerminal] === feed.owner.terminal.address);
}

function verifiedFeed(feed, snapshot) {
  if (!snapshot.coreId || feed.lifecycle !== 'live' || feed.owner.sessionId !== feed.sessionId
    || feed.owner.generation !== feed.generation || snapshot.now - feed.updatedAt > FEED_DISCONNECT_MS) return null;
  const owner = feed.owner.terminal;
  const machine = machineOfAddress(owner.address);
  const terminalId = machine ? owner.address.slice(machine.length + 1) : owner.address;
  if (terminalId !== owner.terminalId) return null;
  if (!machine && owner.coreId === snapshot.coreId) return feed;
  const candidates = snapshot.machines.filter(item => item.name && item.coreId === owner.coreId
    && (!machine || item.name === machine));
  if (candidates.length !== 1) return null;
  const address = `${candidates[0].name}/${terminalId}`;
  return { ...feed, owner: { ...feed.owner, terminal: { ...owner, address } } };
}

/** Resolve a name only from an owner associated with this terminal. */
export function sessionDisplayName(agent, terminal, feeds) {
  const feed = terminal && feeds.find(candidate => {
    if (candidate.owner.sessionId !== candidate.sessionId || candidate.owner.generation !== candidate.generation) return false;
    if (terminal.labels['spider.kind'] === 'roam-proxy') {
      return terminal.labels['spider.session'] === candidate.sessionId
        && terminal.labels['spider.owner-core'] === candidate.owner.terminal.coreId
        && terminal.labels['spider.owner-terminal'] === candidate.owner.terminal.address;
    }
    return candidate.owner.terminal.address === terminal.address
      && (!terminal.labels['spider.session'] || terminal.labels['spider.session'] === candidate.sessionId)
      && (!terminal.labels['spider.owner-core'] || terminal.labels['spider.owner-core'] === candidate.owner.terminal.coreId);
  });
  return feed?.owner.name || terminal?.labels?.['spider.display-name'] || agent.title || agent.program?.name || agent.address;
}

/** Keep finished pane inventory as source records until a sidebar owner is expanded. */
export function indexPaneNavigation(snapshot) {
  const sources = new Map();
  for (const row of snapshot.rows) {
    const prior = sources.get(row.sessionId);
    if (!prior || row.updatedAt > prior.updatedAt) sources.set(row.sessionId, row);
  }
  const rows = [], hidden = new Map();
  for (const row of sources.values()) {
    const seen = new Set(), children = [];
    let count = 0;
    for (const child of row.children) {
      if (seen.has(child.runId)) continue;
      seen.add(child.runId);
      if (['done', 'failed', 'cancelled'].includes(child.status)) count++;
      else children.push(child);
    }
    const consoles = new Map(row.consoles.map(console => [console.consoleId, console]));
    for (const console of consoles.values()) if (!console.target) count++;
    rows.push({ ...row, children });
    hidden.set(row.sessionId, count);
  }
  const content = [...sources.values()].map(({ updatedAt, ...row }) => row);
  return { snapshot: { ...snapshot, rows }, sources, hidden, key: JSON.stringify([snapshot.presentations, content]) };
}

/** Use public snapshots and current feed capabilities to produce one row per identity. */
export function projectNavigation(snapshot) {
  if (snapshot.paneSnapshot) return presentedNavigation(snapshot);
  const { labels } = snapshot.contract;
  const feeds = snapshot.feeds.map(feed => verifiedFeed(feed, snapshot)).filter(Boolean);
  const top = filterTopLevelAgents(snapshot.agents, snapshot.terminals, snapshot.contract);
  const agents = new Map(top.map(agent => [agent.address, agent]));
  const terminals = new Map(snapshot.terminals.map(terminal => [terminal.address, terminal]));
  const unavailable = new Set(snapshot.machines.filter(machine => machine.layout === 'unavailable').map(machine => machine.name));
  const targets = [], claimedSessions = new Set(), claimedAgents = new Set();
  const available = machine => !unavailable.has(machine);
  const paneFor = address => snapshot.panes.find(pane => pane.terminal === address) ?? null;
  const machineFor = terminal => isProxy(terminal, labels)
    ? terminal.labels[labels.machine] || machineOfAddress(terminal.labels[labels.ownerTerminal])
    : machineOfAddress(terminal?.address);

  function addSession(feed) {
    if (claimedSessions.has(feed.sessionId)) return;
    const matches = snapshot.terminals.filter(terminal => terminalMatches(terminal, feed, snapshot.coreId, labels));
    const ownerTerminal = matches.find(terminal => !isProxy(terminal, labels));
    const proxy = matches.find(terminal => isProxy(terminal, labels) && (agents.has(terminal.address) || paneFor(terminal.address)));
    const shown = proxy ?? ownerTerminal;
    if (!shown) return;
    const visibleAgent = agents.get(shown.address);
    const pane = paneFor(shown.address)?.pane ?? visibleAgent?.pane ?? null;
    const machine = machineFor(proxy ?? ownerTerminal ?? shown);
    const id = `session:${feed.sessionId}`;
    const fallback = visibleAgent ?? { address: shown.address, title: '', program: { name: '' } };
    const localPane = pane && !pane.includes('/') ? pane : null;
    const action = proxy && localPane ? { kind: 'focus', pane: localPane } : machine ? { kind: 'pane', request: { op: 'open-existing', sessionId: feed.sessionId, generation: feed.generation, slot: null } } : !available(machine) ? null : localPane ? { kind: 'focus', pane: localPane } : feed.ipc ? {
      kind: 'ipc', descriptor: { version: 1, sessionId: feed.sessionId, generation: feed.generation, ...feed.ipc },
      request: { op: 'openSession', generation: feed.generation, destination: snapshot.destination },
    } : null;
    const proxyPane = proxy && paneFor(proxy.address);
    const proxySpace = proxyPane && snapshot.spaces.find(item => item.tabs.some(tab => tab.id === proxyPane.tab));
    const space = visibleAgent?.space ?? proxySpace?.id ?? feed.placement?.spaceId ?? null;
    const tab = visibleAgent?.tab ?? proxyPane?.tab ?? feed.placement?.tabId ?? null;
    const target = { id, kind: 'agent', ownerId: null, sessionId: feed.sessionId, terminal: feed.owner.terminal.address,
      pane, space, tab, name: sessionDisplayName(fallback, shown, [feed]), path: feed.owner.cwd,
      status: feed.status.effective ?? visibleAgent?.status ?? statusOf(shown), machine, retained: false, action,
      ...(!action ? { disabledReason: !available(machine) ? `Owner on ${machine ?? 'This computer'} is unreachable` : 'Owning session unavailable' } : {}) };
    claimedSessions.add(feed.sessionId);
    for (const match of matches) claimedAgents.add(match.address);
    targets.push(target);
    if (snapshot.includeChildren === false) return;

    const children = projectAgentChildren(snapshot.terminals, [feed], feed.owner.terminal.address, snapshot.contract,
      { now: snapshot.now, completedHours: snapshot.completedHours, completedRows: snapshot.completedRows, machines: snapshot.machines });
    const childIds = new Map();
    for (const child of children) {
      if (child.kind !== 'subagent' && child.kind !== 'console' && child.kind !== 'native') continue;
      const address = child.originalAddress ?? child.address;
      const nativeAgent = child.kind === 'native' ? agents.get(address) : null;
      if (child.kind === 'native' && (!nativeAgent || feeds.some(other => other.sessionId !== feed.sessionId
        && terminalMatches(child.terminal, other, snapshot.coreId, labels)))) continue;
      const runId = child.kind === 'subagent' ? child.key : child.terminal?.labels?.[labels.run] ?? null;
      const childId = child.kind === 'subagent' ? `run:${feed.sessionId}:${child.key}`
        : child.kind === 'native' ? `agent:${address}` : `console:${feed.sessionId}:${runId ?? ''}:${address}`;
      childIds.set(child.key, childId);
      if (nativeAgent) claimedAgents.add(address);
      const parentId = child.parentKey ? childIds.get(child.parentKey) ?? id : id;
      const parent = targets.find(item => item.id === parentId) ?? target;
      const childMachine = child.machine ?? machineOfAddress(address);
      const childPane = paneFor(address)?.pane ?? nativeAgent?.pane ?? null;
      const childAvailable = available(childMachine), ownerAvailable = available(machine);
      const savedRun = child.kind === 'subagent' && child.retained && child.action?.kind === 'ipc' && ownerAvailable;
      let childAction = null;
      if (ownerAvailable && childAvailable && !address?.includes('/') && childPane && !childPane.includes('/')) childAction = { kind: 'focus', pane: childPane };
      else if (ownerAvailable && machine && child.kind === 'subagent') childAction = { kind: 'pane', request: { op: 'open-auxiliary', sessionId: feed.sessionId, generation: feed.generation, view: { kind: 'subagent', runId: child.key } } };
      else if (!machine && ownerAvailable && (childAvailable || savedRun) && child.action?.kind === 'ipc') childAction = child.action;
      targets.push({ id: childId, kind: child.kind === 'native' ? 'agent' : child.kind, ownerId: parentId, sessionId: feed.sessionId,
        terminal: address, pane: childPane, space, tab,
        name: child.kind === 'console' ? `${parent.name} console` : nativeAgent ? sessionDisplayName(nativeAgent, child.terminal, []) : child.name,
        path: feed.owner.cwd, status: child.status === 'unreachable' ? statusOf(child.terminal) : child.status,
        machine: childMachine, retained: child.retained, action: childAction,
        ...(!childAction ? { disabledReason: !ownerAvailable ? `Owner on ${machine ?? 'This computer'} is unreachable` : !childAvailable ? `Machine ${childMachine ?? 'This computer'} is unreachable` : 'Owning session unavailable' } : {}) });
    }
  }

  for (const agent of top) {
    const terminal = terminals.get(agent.address);
    const feed = feeds.find(candidate => terminalMatches(terminal, candidate, snapshot.coreId, labels));
    if (feed) addSession(feed);
  }
  for (const feed of feeds) addSession(feed);
  for (const agent of top) {
    if (claimedAgents.has(agent.address)) continue;
    const terminal = terminals.get(agent.address);
    const machine = machineFor(terminal) ?? machineOfAddress(agent.address);
    const pane = paneFor(agent.address)?.pane ?? agent.pane ?? null;
    targets.push({ id: `agent:${agent.address}`, kind: 'agent', ownerId: null, sessionId: null, terminal: agent.address,
      pane, space: agent.space ?? null, tab: agent.tab ?? null, name: sessionDisplayName(agent, terminal ?? null, []),
      path: paneFor(agent.address)?.cwd ?? null, status: agent.status, machine, retained: false,
      action: pane && !pane.includes('/') && (isProxy(terminal, labels) || !machine && available(machine)) ? { kind: 'focus', pane } : null });
    claimedAgents.add(agent.address);
  }
  for (const terminal of snapshot.terminals) {
    if (!isProxy(terminal, labels) || terminal.state !== 'live' || claimedAgents.has(terminal.address)) continue;
    const pane = paneFor(terminal.address);
    if (!pane || pane.pane.includes('/')) continue;
    const space = snapshot.spaces.find(item => item.tabs.some(tab => tab.id === pane.tab));
    const fallback = { address: terminal.address, title: '', program: { name: '' } };
    targets.push({ id: `agent:${terminal.address}`, kind: 'agent', ownerId: null, sessionId: null, terminal: terminal.address,
      pane: pane.pane, space: space?.id ?? null, tab: pane.tab, name: sessionDisplayName(fallback, terminal, []),
      path: pane.cwd, status: statusOf(terminal), machine: machineFor(terminal), retained: false, action: { kind: 'focus', pane: pane.pane } });
  }
  return targets;
}

function presentedNavigation(snapshot) {
  const service = snapshot.paneSnapshot;
  const native = snapshot.agents.filter(agent => !agent.address.includes('/')).map(agent => {
    const terminal = snapshot.terminals.find(value => value.address === agent.address);
    const pane = snapshot.panes.find(value => value.terminal === agent.address);
    const space = snapshot.spaces.find(value => (value.machine ?? null) === null && value.tabs.some(tab => tab.id === (pane?.tab ?? agent.tab)));
    return { address: agent.address, name: sessionDisplayName(agent, terminal, snapshot.feeds), isAgent: true,
      labels: terminal?.labels ?? {}, space: space?.id ?? null, tab: pane?.tab ?? agent.tab ?? null };
  });
  const projected = projectPanePresentations({ agents: service.rows, presentations: service.presentations, native, localCoreId: snapshot.coreId,
    includeChildren: snapshot.includeChildren, includeRetained: snapshot.includeRetained });
  const targets = [];
  function add(row, parent = null) {
    const source = service.rows.find(value => value.sessionId === row.sessionId);
    const p = row.presentationId && service.presentations.find(value => value.id === row.presentationId);
    const display = row.displayTerminal?.startsWith(snapshot.coreId + '/') ? row.displayTerminal.slice(snapshot.coreId.length + 1) : row.displayTerminal;
    const pane = display && !display.includes('/') ? snapshot.panes.find(value => value.terminal === display) : null;
    const fallback = display && !display.includes('/') ? snapshot.agents.find(value => value.address === display) : null;
    const paneId = pane?.pane ?? fallback?.pane ?? null;
    const generation = row.generation ?? parent?.generation ?? source?.generation;
    const id = row.kind === 'subagent' ? `run:${row.sessionId}:${row.runId}` : row.kind === 'console' ? `console:${row.sessionId}:${row.consoleId}`
      : row.sessionId ? `session:${row.sessionId}` : p ? `presentation:${p.id}` : `agent:${row.displayTerminal}`;
    let action = null;
    if (!row.unavailableReason) {
      if (paneId && !paneId.includes('/')) action = { kind: 'focus', pane: paneId };
      else if (row.kind === 'subagent' && generation) action = { kind: 'pane', request: { op: 'open-auxiliary', sessionId: row.sessionId, generation, view: { kind: 'subagent', runId: row.runId } } };
      else if (row.kind === 'console' && generation) action = { kind: 'pane', request: { op: 'open-auxiliary', sessionId: row.sessionId, generation, view: { kind: 'console', consoleId: row.consoleId, machineKey: row.machineKey } } };
      else if (row.sessionId && generation) action = { kind: 'pane', request: { op: 'open-existing', sessionId: row.sessionId, generation, slot: p ? null : snapshot.destination ? { ...snapshot.destination, pane: null } : null } };
      else if (p?.role === 'shell') action = { kind: 'pane', request: { op: 'open-existing', presentationId: p.id, expectedRevision: p.revision,
        targetIncarnation: { coreId: p.target.coreId, terminalId: p.target.terminalId, createdMs: p.target.createdMs } } };
    }
    const target = { id, kind: row.kind === 'session' ? 'agent' : row.kind, ownerId: parent?.id ?? null, sessionId: row.sessionId,
      generation, presentationId: p?.id ?? null, expectedRevision: p?.revision ?? null,
      terminal: row.execution?.address ?? row.displayTerminal, pane: paneId, space: row.space, tab: row.tab, name: row.name, path: row.cwd,
      status: row.status, machine: row.machineLabel === 'This computer' ? null : row.machineLabel,
      retained: row.kind === 'subagent' && ['done', 'failed', 'cancelled'].includes(row.status), action,
      disabledReason: row.unavailableReason === 'not-in-hc' ? 'Not in an hc terminal' : row.unavailableReason || (!action ? 'Owning session unavailable' : undefined) };
    targets.push(target);
    for (const child of row.children) add(child, target);
  }
  for (const row of projected) add(row);
  return targets;
}

/** Adapt the shared rows to the native sidebar's sorting and fold model. */
export function navigationAgents(snapshot, targets = projectNavigation({ ...snapshot, includeChildren: false })) {
  return targets.filter(target => target.ownerId === null && target.kind === 'agent').map(target => {
    const native = snapshot.agents.find(agent => agent.address === target.terminal || agent.pane === target.pane && target.pane);
    return { ...native, address: target.terminal ?? target.id, pane: target.pane, space: target.space, tab: target.tab,
      space_name: snapshot.spaces.find(space => space.id === target.space)?.name ?? 'Unplaced', title: target.name,
      program: native?.program ?? { name: 'pi' }, status: target.status, focused: native?.focused ?? false, pinned: native?.pinned ?? false, navigation: target };
  });
}
