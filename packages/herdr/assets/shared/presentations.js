// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

const executionKey = target => JSON.stringify([target.coreId, target.terminalId, target.createdMs]);
const sameExecution = (a, b) => a && b && executionKey(a) === executionKey(b)
  && a.sessionId === b.sessionId && a.generation === b.generation;
const isLocalAddress = (address, localCoreId) => !address.includes('/') || localCoreId != null && address.startsWith(localCoreId + '/');
const machineLabel = (target, key, localCoreId) => {
  if (!target) return key === localCoreId ? 'This computer' : key;
  if (target.coreId === localCoreId) return 'This computer';
  if (target.alias) return target.alias;
  if (target.identityLabels['spider.machine']) return target.identityLabels['spider.machine'];
  return localCoreId == null ? 'This computer' : key || target.coreId;
};
const isVisible = presentation => presentation?.visibility === 'visible' && presentation.launch === 'acknowledged';
const newest = values => values.reduce((best, value) => !best || value.revision > best.revision ? value : best, null);
const excludedNativeKinds = new Set(['pane-proxy', 'roam-proxy', 'subagent-viewer', 'remote-console', 'exec', 'exec-file', 'exec_file', 'batch', 'job-observer', 'remote-observer']);

function base(kind, execution, presentation, input, fallbackMachine) {
  const visible = isVisible(presentation);
  const nativeLocal = execution && execution.alias === null && (input.localCoreId == null || execution.coreId === input.localCoreId);
  return {
    kind, presentationId: presentation?.id ?? null, sessionId: execution?.sessionId ?? null, generation: execution?.generation ?? null, machineKey: execution?.alias || execution?.coreId || null,
    runId: execution?.runId ?? null, consoleId: execution?.consoleId ?? null,
    execution, displayTerminal: visible ? presentation.mode === 'proxy' ? presentation.proxy : nativeLocal ? presentation.target.address : null : null,
    unavailableReason: presentation?.visibility === 'closing' ? 'closing' : null,
    space: visible ? presentation.slot?.space ?? null : null, tab: visible ? presentation.slot?.tab ?? null : null,
    name: execution?.name || (kind === 'terminal' ? 'Terminal' : 'Agent'),
    machineLabel: machineLabel(execution, fallbackMachine, input.localCoreId), status: 'unknown', cwd: execution?.cwd ?? null, children: [],
  };
}

/** No effects, focus decisions, sort preferences or fold state live in this projection. */
export function projectPanePresentations(input) {
  const presentationsById = new Map();
  for (const presentation of input.presentations) {
    const prior = presentationsById.get(presentation.id);
    if (!prior || presentation.revision > prior.revision) presentationsById.set(presentation.id, presentation);
  }
  const presentations = [...presentationsById.values()];
  const agents = new Map();
  for (const agent of input.agents) {
    const previous = agents.get(agent.sessionId);
    if (!previous || agent.updatedAt > previous.updatedAt) agents.set(agent.sessionId, agent);
  }
  const rows = [], knownAddresses = new Set(), knownSessions = new Set(agents.keys());
  const coverTarget = target => {
    if (!target) return;
    knownAddresses.add(target.address); knownAddresses.add(`${target.coreId}/${target.terminalId}`);
    if (target.alias) knownAddresses.add(`${target.alias}/${target.terminalId}`);
    else if (target.coreId === input.localCoreId || !target.address.includes('/')) knownAddresses.add(target.terminalId);
  };
  for (const presentation of presentations) {
    coverTarget(presentation.target);
    if (presentation.proxy) knownAddresses.add(presentation.proxy);
    if (presentation.target.sessionId) knownSessions.add(presentation.target.sessionId);
  }
  for (const agent of agents.values()) {
    coverTarget(agent.target);
    if (agent.owner) knownAddresses.add(agent.owner.terminal.address);
  }
  const presentationFor = target => newest(presentations.filter(presentation => sameExecution(presentation.target, target)));
  const nativeFor = target => input.native.find(fact => isLocalAddress(fact.address, input.localCoreId)
    && (fact.address === target.address || fact.address === target.terminalId || fact.address === `${target.coreId}/${target.terminalId}`)
    && (!fact.labels['spider.session'] || fact.labels['spider.session'] === target.sessionId));
  const rowBySession = new Map();
  for (const agent of agents.values()) {
    const presentation = agent.target && presentationFor(agent.target);
    const row = base('session', agent.target, presentation, input, agent.machineKey);
    row.sessionId = agent.sessionId; row.name = agent.name || agent.target?.name || 'Agent'; row.status = agent.status;
    row.unavailableReason = agent.unavailableReason ?? row.unavailableReason;
    if (agent.unavailableReason) { row.execution = null; row.displayTerminal = null; row.space = null; row.tab = null; }
    else if (!presentation && agent.target.alias === null && (input.localCoreId == null || agent.target.coreId === input.localCoreId)) {
      const fact = nativeFor(agent.target);
      if (fact) { row.displayTerminal = fact.address; row.space = fact.space; row.tab = fact.tab; knownAddresses.add(fact.address); }
    }
    rows.push(row); rowBySession.set(agent.sessionId, row);
    if (agent.unavailableReason) continue;
    const childIds = new Set();
    for (const child of agent.children) {
      if (childIds.has(child.runId)) continue; childIds.add(child.runId);
      const view = newest(presentations.filter(presentation => presentation.role === 'subagent' && presentation.target.sessionId === agent.sessionId
        && presentation.target.generation === agent.generation && presentation.target.runId === child.runId));
      const entry = base('subagent', view?.target ?? null, view, input, row.machineLabel);
      entry.sessionId = agent.sessionId; entry.runId = child.runId; entry.name = child.name || view?.target.name || 'Subagent'; entry.status = child.status;
      entry.space = row.space; if (entry.tab === null || view?.slot?.space !== row.space) entry.tab = row.tab;
      row.children.push(entry);
    }
    const consoles = new Map(agent.consoles.map(console => [console.consoleId, console]));
    for (const view of presentations) if (view.role === 'console' && view.visibility !== 'ended' && view.target.sessionId === agent.sessionId
      && view.target.generation === agent.generation && view.target.consoleId && !consoles.has(view.target.consoleId)) consoles.set(view.target.consoleId, { consoleId: view.target.consoleId, machineKey: view.target.alias || view.target.coreId, name: view.target.name, target: view.target });
    for (const console of consoles.values()) {
      const target = console.target, view = target ? presentationFor(target) : null;
      const entry = base('console', target, view, input, console.machineKey);
      entry.name = console.name || 'Console'; entry.generation = agent.generation; entry.machineKey = console.machineKey; entry.consoleId = console.consoleId; entry.sessionId = agent.sessionId;
      entry.status = target ? 'open' : 'retained, not open'; entry.space = row.space;
      if (entry.tab === null || view?.slot?.space !== row.space) entry.tab = row.tab;
      row.children.push(entry); coverTarget(target);
    }
  }
  const tracked = new Map();
  for (const presentation of presentations) {
    if (presentation.visibility === 'ended' || presentation.role !== 'shell' && presentation.role !== 'agent') continue;
    if (presentation.role === 'agent' && rowBySession.has(presentation.target.sessionId)) continue;
    const id = presentation.role === 'agent' ? `session:${presentation.target.sessionId}` : executionKey(presentation.target);
    const prior = tracked.get(id);
    if (!prior || presentation.revision > prior.revision) tracked.set(id, presentation);
  }
  for (const presentation of tracked.values()) {
    const row = base(presentation.role === 'shell' ? 'terminal' : 'session', presentation.target, presentation, input, null);
    if (presentation.role === 'shell') row.name = 'Terminal';
    else { row.status = 'unavailable'; row.unavailableReason = 'source-unavailable'; }
    rows.push(row);
  }
  for (const fact of input.native) {
    if (!fact.isAgent || !isLocalAddress(fact.address, input.localCoreId) || knownAddresses.has(fact.address)
      || excludedNativeKinds.has(fact.labels['spider.kind']) || fact.labels['spider.session'] && knownSessions.has(fact.labels['spider.session'])) continue;
    const row = base('session', null, null, input, 'This computer');
    row.sessionId = fact.labels['spider.session'] ?? null; row.name = fact.name || 'Agent'; row.displayTerminal = fact.address;
    row.space = fact.space; row.tab = fact.tab; row.status = 'unknown'; rows.push(row);
    knownAddresses.add(fact.address); if (row.sessionId) knownSessions.add(row.sessionId);
  }
  return rows;
}
