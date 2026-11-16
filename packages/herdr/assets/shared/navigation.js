// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { filterTopLevelAgents, projectAgentChildren } from '../agents/children.js';
import { FEED_DISCONNECT_MS } from './feed.js';

const machineOfAddress = address => address?.includes('/') ? address.slice(0, address.indexOf('/')) : null;
const statusOf = terminal => typeof terminal?.status === 'string' ? terminal.status : terminal?.status?.state ?? 'idle';
const isProxy = (terminal, labels) => terminal?.labels?.[labels.kind] === 'roam-proxy';

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

/** Use public snapshots and current feed capabilities to produce one row per identity. */
export function projectNavigation(snapshot) {
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
    const proxy = matches.find(terminal => isProxy(terminal, labels) && agents.has(terminal.address));
    const shown = proxy ?? ownerTerminal;
    if (!shown) return;
    const visibleAgent = agents.get(shown.address);
    const pane = paneFor(shown.address)?.pane ?? visibleAgent?.pane ?? null;
    const machine = machineFor(proxy ?? ownerTerminal ?? shown);
    const id = `session:${feed.sessionId}`;
    const fallback = visibleAgent ?? { address: shown.address, title: '', program: { name: '' } };
    const action = !available(machine) ? null : pane ? { kind: 'focus', pane } : feed.ipc ? {
      kind: 'ipc', descriptor: { version: 1, sessionId: feed.sessionId, generation: feed.generation, ...feed.ipc },
      request: { op: 'openSession', generation: feed.generation, destination: snapshot.destination },
    } : null;
    const space = visibleAgent?.space ?? feed.placement?.spaceId ?? null;
    const tab = visibleAgent?.tab ?? feed.placement?.tabId ?? null;
    const target = { id, kind: 'agent', ownerId: null, sessionId: feed.sessionId, terminal: feed.owner.terminal.address,
      pane, space, tab, name: sessionDisplayName(fallback, shown, [feed]), path: feed.owner.cwd,
      status: feed.status.effective ?? visibleAgent?.status ?? statusOf(shown), machine, retained: false, action };
    claimedSessions.add(feed.sessionId);
    for (const match of matches) claimedAgents.add(match.address);
    targets.push(target);

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
      if (ownerAvailable && childAvailable && childPane) childAction = { kind: 'focus', pane: childPane };
      else if (ownerAvailable && (childAvailable || savedRun) && child.action?.kind === 'ipc') childAction = child.action;
      else if (ownerAvailable && childAvailable && child.action?.kind === 'peek') childAction = { kind: 'keep', terminal: child.action.terminal };
      targets.push({ id: childId, kind: child.kind === 'native' ? 'agent' : child.kind, ownerId: parentId, sessionId: feed.sessionId,
        terminal: address, pane: childPane, space, tab,
        name: child.kind === 'console' ? `${parent.name} console` : nativeAgent ? sessionDisplayName(nativeAgent, child.terminal, []) : child.name,
        path: feed.owner.cwd, status: child.status === 'unreachable' ? statusOf(child.terminal) : child.status,
        machine: childMachine, retained: child.retained, action: childAction,
        ...(!ownerAvailable ? { disabledReason: `Owner on ${machine ?? 'This computer'} is unreachable` } : {}) });
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
    if (isProxy(terminal, labels)) continue;
    const machine = machineFor(terminal) ?? machineOfAddress(agent.address);
    const pane = paneFor(agent.address)?.pane ?? agent.pane ?? null;
    targets.push({ id: `agent:${agent.address}`, kind: 'agent', ownerId: null, sessionId: null, terminal: agent.address,
      pane, space: agent.space ?? null, tab: agent.tab ?? null, name: sessionDisplayName(agent, terminal ?? null, []),
      path: paneFor(agent.address)?.cwd ?? null, status: agent.status, machine, retained: false,
      action: pane && available(machine) ? { kind: 'focus', pane } : null });
  }
  return targets;
}
