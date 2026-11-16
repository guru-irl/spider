// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

const addressMachine = address => {
  const slash = address?.indexOf('/') ?? -1;
  return slash > 0 && slash < address.length - 1 ? address.slice(0, slash) : null;
};

export function agentMachine(agent, terminals, contract, terminalIndex) {
  if (agent.navigation) return agent.navigation.machine;
  const labels = (terminalIndex ? terminalIndex.get(agent.address) : terminals.find(terminal => terminal.address === agent.address))?.labels;
  if (['roam-proxy', 'pane-proxy'].includes(labels?.[contract.labels.kind])) {
    return labels[contract.labels.machine] || addressMachine(labels[contract.labels.ownerTerminal]) || addressMachine(agent.address);
  }
  return addressMachine(agent.address);
}

export function groupAgentsByMachine(agents, terminals, contract, knownMachines, terminalIndex) {
  const groups = new Map();
  const addMachine = machine => {
    if (!groups.has(machine)) groups.set(machine, {
      id: `machine:${machine ?? ''}`, machine, label: machine ?? 'This computer', members: [],
    });
    return groups.get(machine);
  };
  addMachine(null);
  for (const { name } of knownMachines) addMachine(name);
  for (const agent of agents) addMachine(agentMachine(agent, terminals, contract, terminalIndex)).members.push(agent);
  const ordered = [...groups.values()].sort((a, b) => a.machine === null ? -1 : b.machine === null ? 1 : a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : 0);
  for (const group of ordered) {
    group.members = [...group.members.filter(agent => agent.pinned), ...group.members.filter(agent => !agent.pinned)];
  }
  return ordered;
}

export function machineGroupCounts(children) {
  const consoleKeys = new Set(children.filter(row => row.kind === 'console').map(row => row.key));
  let subagents = 0, consoles = 0;
  for (const row of children) {
    if (row.retained || row.status === 'unreachable') continue;
    if (row.kind === 'console') {
      if (row.terminal?.state === 'live') consoles++;
    } else if (row.kind !== 'remote' || !consoleKeys.has(row.parentKey)) subagents++;
  }
  return { subagents, consoles };
}
