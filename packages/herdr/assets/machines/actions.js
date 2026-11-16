// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

export function capturePaneIntent(facts, place) {
  const anchor = facts.focusedPlacement;
  return {
    operationId: facts.operationId,
    space: facts.space,
    place,
    anchor: anchor ? { space: anchor.space, tab: anchor.tab, pane: anchor.pane } : null,
    program: { kind: 'shell' },
  };
}

export function openMachinePicker(input, ports) {
  const facts = ports.facts();
  const menu = input.program === 'menu';
  const source = menu ? capturePaneIntent(facts, input.place) : input;
  const intent = { ...source, anchor: source.anchor ? { ...source.anchor } : null, program: { ...source.program } };
  const target = facts.focused?.target ?? facts.nativeTarget;
  const preferred = target ? facts.machines.find(row => row.coreId === target.coreId) : facts.machines.find(row => row.alias === null);
  ports.openOverlay('spider-machine-picker', { continuation: menu ? 'menu' : intent.program.kind, machineKey: preferred?.key ?? null, intent });
}

const ticketKey = 'spider.machine-tickets';
const now = store => store.now ? store.now() : Date.now();
const operationId = () => Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

export function openPickerFromHost(input, host) {
  const focus = host.focused?.() ?? {};
  const panes = host.panes(), spaces = host.spaces();
  const pane = panes.find(row => row.pane === (input.pane ?? focus.pane));
  const space = spaces.find(row => row.machine === null && (input.space ? row.id === input.space :
    input.pane ? row.tabs?.some(tab => tab.id === pane?.tab) : row.id === focus.space))
    ?? (!input.space && !input.pane ? spaces.find(row => row.machine === null && row.active) : null);
  if (!space || (input.place !== 'tab' && (!pane || !space.tabs?.some(tab => tab.id === pane.tab)))) {
    host.notify({ title: 'The original pane is unavailable', level: 'warning' }); return;
  }
  const anchor = pane && space.tabs?.some(tab => tab.id === pane.tab) ? { space: space.id, tab: pane.tab, pane: pane.pane } : null;
  const facts = { operationId: operationId(), space: space.id, focused: null, nativeTarget: null, focusedPlacement: anchor, machines: [] };
  const intent = input.program === 'menu' ? { place: input.place, program: 'menu' } :
    { operationId: facts.operationId, space: facts.space, place: input.place, anchor, program: input.program };
  openMachinePicker(intent, { facts: () => facts, config: {}, openOverlay: (mod, props) =>
    host.openOverlay({ mod, kind: 'dialog', width: 440, height: 480, frame: 'none', props }) });
}

export function issueMenuTicket(intent, machine, store) {
  const token = operationId();
  const ticket = { token, operationId: intent.operationId };
  const entries = store.shared(ticketKey) ?? {};
  const live = Object.fromEntries(Object.entries(entries).filter(([, value]) => value?.expires > now(store)));
  live[token] = { ...ticket, intent: { ...intent, anchor: intent.anchor ? { ...intent.anchor } : null, program: { ...intent.program } },
    machineKey: machine.key, alias: machine.alias, coreId: machine.coreId, machineId: machine.machineId, expires: now(store) + 60000 };
  store.setShared(ticketKey, live);
  return ticket;
}

export function peekMenuTicket(ticket, store) {
  if (!ticket || typeof ticket.token !== 'string' || typeof ticket.operationId !== 'string') return null;
  const value = store.shared(ticketKey)?.[ticket.token];
  if (!value || value.operationId !== ticket.operationId || value.intent?.operationId !== ticket.operationId || value.expires <= now(store)) return null;
  return value;
}

export function consumeMenuTicket(ticket, store) {
  const value = peekMenuTicket(ticket, store);
  if (!value) return null;
  const entries = { ...store.shared(ticketKey) };
  delete entries[ticket.token];
  store.setShared(ticketKey, entries);
  return value;
}

export async function chooseMenuProgram(ticket, program, space, host) {
  if (!ticket) { openPickerFromHost({ place: 'tab', program, space }, host); return; }
  const selected = consumeMenuTicket(ticket, host);
  if (!selected) { host.notify({ title: 'Machine selection expired', level: 'warning' }); return; }
  try {
    const destination = host.spaces().find(row => row.machine === null && row.id === selected.intent.space);
    if (!destination || (selected.intent.anchor && !destination.tabs?.some(tab => tab.id === selected.intent.anchor.tab))) throw new Error('The original pane is unavailable');
    const content = await host.readTextFile(`${host.appHome()}/mods/spider-machine-picker/config.json`);
    const config = content ? JSON.parse(content) : null;
    const absolute = value => typeof value === 'string' && (/^\//.test(value) || /^[a-zA-Z]:[\\/]/.test(value)) && !value.includes('\0');
    if (!config || config.version !== 1 || config.checkMode || !absolute(config.nodePath) || !absolute(config.cliPath)) throw new Error('Machine picker is not configured');
    const request = async body => {
      const result = await host.exec(config.nodePath, [config.cliPath, 'panes', 'request', '--json', JSON.stringify(body)], { timeout: 5000 });
      if (result.code !== 0) throw new Error('Machine information is unavailable');
      return JSON.parse(result.stdout);
    };
    const snapshot = await request({ version: 1, op: 'snapshot', operationId: operationId() });
    const machine = snapshot?.version === 1 && snapshot.kind === 'snapshot' && Array.isArray(snapshot.machines)
      ? snapshot.machines.find(row => row.key === selected.machineKey) : null;
    if (!machine || machine.state !== 'connected' || machine.coreId !== selected.coreId || machine.machineId !== selected.machineId) throw new Error('Machine is unreachable');
    const intent = { ...selected.intent, program: { ...program } };
    const reply = await request({ version: 1, op: 'open', operationId: intent.operationId, intent, machineKey: selected.machineKey, coreId: selected.coreId, machineId: selected.machineId });
    if (reply?.version !== 1 || reply.kind !== 'outcome' || reply.outcome?.status === 'refused') throw new Error(reply?.outcome?.reason || 'Could not open terminal');
  } catch (error) { host.notify({ title: String(error?.message ?? 'Could not open terminal'), level: 'warning' }); }
}

export function selectMachine(rows, filter, preferredKey) {
  const query = filter.trim().toLocaleLowerCase();
  const available = rows.filter(row => row.state === 'connected' && row.coreId && row.enabled !== false &&
    `${row.alias ?? 'This computer'} ${row.label}`.toLocaleLowerCase().includes(query));
  return available.find(row => row.key === preferredKey)?.key ?? available[0]?.key ?? null;
}
