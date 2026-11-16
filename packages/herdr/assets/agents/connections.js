// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

export function machineRebuilt(machine) {
  return machine?.state === 'unreachable' && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? '');
}

export function machineConnection(machine, snapshot) {
  const state = snapshot?.find(entry => entry.name === machine)?.state;
  if (state === 'connected') return 'connected';
  if (state === 'needs_login' || state === 'needs-login') return 'needs-login';
  if (state === 'disconnected' || state === 'unreachable' || state === 'stopped') return 'disconnected';
  return 'unknown';
}

const JOURNAL = 'machines.reconnecting';
const validMachine = machine => machine && typeof machine.name === 'string' && machine.name.length > 0;
const machineList = value => Array.isArray(value?.machines) && value.machines.every(validMachine) ? value.machines : null;

export function createMachineConnections({ hc, storage, notify }) {
  let inventory = [], snapshot = [], coreId = null, serial = 0, closed = false;
  const repairs = new Map(), pending = new Map();
  try {
    const saved = JSON.parse(storage.getItem(JOURNAL) ?? '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [name, state] of Object.entries(saved)) {
        if (validMachine(state?.machine) && state.machine.name === name && typeof state.machine.target === 'string' && state.machine.target) {
          repairs.set(name, { machine: state.machine, removed: state.removed === true, busy: false, error: typeof state.error === 'string' ? state.error : null });
        }
      }
    }
  } catch {}
  const changed = () => { if (!closed) notify(); };
  const save = () => storage.setItem(JOURNAL, JSON.stringify(Object.fromEntries(repairs)));
  const read = async args => {
    try {
      const result = await hc(args);
      if (result.code !== 0) return null;
      return JSON.parse(result.stdout);
    } catch { return null; }
  };
  const refresh = async () => {
    if (closed) return;
    const generation = ++serial;
    const [local, remote] = await Promise.all([read(['server', 'status', '--json']), read(['machine', 'ls', '--json'])]);
    if (closed || generation !== serial) return;
    coreId = typeof local?.core?.id === 'string' && local.core.id ? local.core.id : null;
    const observed = machineList(remote);
    if (observed) inventory = [...new Map(observed.map(machine => [machine.name, machine])).values()];
    snapshot = [
      ...(coreId ? [{ name: null, state: 'connected' }] : []),
      ...(observed ?? []).map(machine => ({ name: machine.name, state: machine.state })),
    ];
    changed();
  };
  const ask = async args => {
    const result = await hc([...args, '--json']);
    if (result.code === 0) return;
    let message;
    try { message = JSON.parse(result.stdout || result.stderr).error?.message; } catch {}
    throw new Error(message || result.stderr || result.stdout || "Couldn't connect.");
  };
  const reconnect = async name => {
    if (closed || !name) return;
    if (pending.has(name)) return pending.get(name);
    const machine = repairs.get(name)?.machine ?? inventory.find(item => item.name === name);
    if (!machine || typeof machine.target !== 'string' || !machine.target) return;
    const state = repairs.get(name) ?? { machine, removed: false, busy: false, error: null };
    repairs.set(name, state);
    state.busy = true;
    state.error = null;
    save();
    changed();
    const task = (async () => {
      try {
        if (!state.removed) {
          try { await ask(['machine', 'rm', name]); }
          catch (error) {
            const current = machineList(await read(['machine', 'ls', '--json']));
            if (!current || current.some(item => item.name === name)) throw error;
          }
          state.removed = true;
          save();
        }
        const args = ['machine', 'add'];
        if (machine.via) args.push('--via', machine.target);
        else args.push(machine.target);
        args.push('--name', name);
        if (machine.session) args.push('--session', machine.session);
        if (machine.temporary) args.push('--temp');
        await ask(args);
        repairs.delete(name);
      } catch (error) {
        state.error = String(error?.message ?? error);
        state.busy = false;
      }
      save();
      changed();
      await refresh();
    })();
    pending.set(name, task);
    try { await task; } finally { pending.delete(name); }
  };
  return {
    get machines() {
      const known = new Map(inventory.map(machine => [machine.name, machine]));
      for (const [name, state] of repairs) if (!known.has(name)) known.set(name, state.machine);
      return [...known.values()];
    },
    get snapshot() { return snapshot; },
    get coreId() { return coreId; },
    repair: name => repairs.get(name) ?? null,
    refresh,
    reconnect,
    close() { closed = true; serial++; },
  };
}
