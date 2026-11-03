// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

/** Identify the clicked pane, not the currently focused pane. */
export function classifyPane(pane, terminal, feeds, contract, freshAfter) {
  if (!pane?.terminal) return { kind: 'mod' };
  const labels = terminal?.labels ?? {}, names = contract?.labels ?? {}, kinds = contract?.kinds ?? {};
  const feed = feeds.find(value => value.owner?.terminal?.address === pane.terminal)
    ?? feeds.find(value => value.sessionId === labels[names.session]);
  const descriptor = feed?.lifecycle === 'live' && feed.ipc && feed.updatedAt >= freshAfter
    ? { version: 1, sessionId: feed.sessionId, generation: feed.generation, ...feed.ipc } : null;
  const machine = pane.terminal.includes('/') ? pane.terminal.split('/')[0] : null;
  const base = { pane: true, terminal: pane.terminal, machine, descriptor, ownsSession: feed?.owner?.terminal?.address === pane.terminal };
  const kind = labels[names.kind];
  if (kind && kind === kinds.subagentViewer) {
    const key = labels[names.run], run = feed?.runs?.rows?.find(row => row.id === key);
    return { ...base, kind: 'subagent', key, active: Boolean(descriptor && run && !['done', 'failed', 'cancelled'].includes(run.status)) };
  }
  if (kind && [kinds.remoteObserver, kinds.exec, kinds.execFile, kinds.batch].includes(kind))
    return { ...base, kind: 'command', key: labels[names.job] };
  if (kind && kind === kinds.session || feed?.owner?.terminal?.address === pane.terminal || pane.program?.key === 'pi' || pane.app === 'pi')
    return { ...base, kind: 'session' };
  return { ...base, kind: 'terminal' };
}

/** Build the same menu for pane headers and child rows. */
export function menuItems(target, spaces, currentSpace, currentTab) {
  if (target.kind === 'mod') return [];
  const groups = spaces.filter(space => (space.machine ?? null) === (target.machine ?? null)).map(space => ({ id: space.id, name: space.name,
    tabs: space.tabs.filter(tab => tab.id !== currentTab).map(tab => ({ id: tab.id, name: tab.name })) }))
    .filter(space => space.tabs.length);
  groups.sort((a, b) => Number(b.id === currentSpace) - Number(a.id === currentSpace));
  const verb = target.pane === false ? 'Open' : 'Move';
  const unavailable = target.kind !== 'terminal' && target.descriptor === null && !target.unmanaged;
  const items = [
    { kind: 'action', id: 'new', label: `${verb} to new tab`, disabled: unavailable },
    { kind: 'tabs', id: 'tabs', label: `${verb} to tab`, groups, disabled: unavailable },
  ];
  // Parked rows are opened rather than moved.
  if (verb === 'Open') { items[0].label = 'Open in new tab'; items[1].label = 'Open in tab'; }
  if (target.kind === 'subagent' && target.pane) items.push({ kind: 'action', id: 'hide', label: 'Hide', disabled: unavailable });
  const label = { subagent: 'Kill subagent', command: 'Kill command', session: 'Kill session…', terminal: 'Kill terminal' }[target.kind];
  if (label) items.push({ kind: 'separator' }, { kind: 'action', id: 'kill', label, disabled: target.kind === 'subagent' && target.active === false || target.kind === 'command' && unavailable || target.kind === 'session' && (!target.descriptor || !target.ownsSession) });
  return items;
}

/** Check both supported setup journal formats without treating corrupt data as absence. */
export function journalOwnsTerminal(text, terminal) {
  if (text === null) return false;
  const journal = JSON.parse(text);
  if (!journal || ![1, 2].includes(journal.version) || !Array.isArray(journal.tabs)) throw new Error('Setup journal is unavailable');
  if (journal.version === 1) {
    if (journal.tabs.some(entry => typeof entry?.placement?.terminal !== 'string')) throw new Error('Setup journal is invalid');
    return journal.tabs.some(entry => entry.placement.terminal === terminal);
  }
  if (journal.tabs.some(tab => !Array.isArray(tab.sessions) || tab.sessions.some(entry => typeof entry?.terminal !== 'string'))) throw new Error('Setup journal is invalid');
  return journal.tabs.some(tab => tab.sessions.some(entry => entry.terminal === terminal));
}

/** A session controls its own panes; ordinary terminals have no owner endpoint. */
export async function moveTarget(target, destination, ports) {
  if (target.kind === 'terminal' || target.kind === 'session' && target.unmanaged) return ports.movePlain(target.terminal, destination);
  if (!target.descriptor) throw new Error('The owning session is unavailable');
  const generation = target.descriptor.generation;
  if (target.kind === 'subagent' && target.key) return ports.ipc(target.descriptor, { op: 'moveRun', runId: target.key, destination, generation });
  if (target.kind === 'command' && target.key) {
    let viewer = target.terminal;
    if (!viewer) {
      const reply = await ports.ipc(target.descriptor, { op: 'openJob', jobId: target.key, generation });
      if (reply?.op !== 'openJob' || typeof reply.viewer !== 'string' || !reply.viewer) throw new Error('The command observer is unavailable');
      viewer = reply.viewer;
    }
    return ports.ipc(target.descriptor, { op: 'moveJob', jobId: target.key, viewer, destination, generation });
  }
  if (target.kind === 'session') return ports.ipc(target.descriptor, { op: 'moveSession', destination, generation });
  throw new Error('The pane cannot be moved');
}

/** Never kill a subagent or command by killing its read-only viewer. */
export async function killTarget(target, ports) {
  if (target.kind === 'subagent' || target.kind === 'command') {
    if (!target.descriptor || !target.key) throw new Error('The owning session is unavailable');
    const request = target.kind === 'subagent'
      ? { op: 'killRun', runId: target.key, generation: target.descriptor.generation }
      : { op: 'killJob', jobId: target.key, generation: target.descriptor.generation };
    await ports.ipc(target.descriptor, request);
  } else if (target.kind === 'session') {
    if (!target.descriptor || !target.ownsSession) throw new Error('This session is unavailable. Reopen it and try again.');
    ports.confirm({ title: 'Kill session?', detail: 'This stops the session and its subagents.', target });
  } else if (target.kind === 'terminal') {
    if (target.ownsSession) await stopSessionTarget(target, ports);
    else ports.run('terminal.kill', { terminal: target.terminal });
  }
}

/** The endpoint stops only its own session, never a supplied terminal or session ID. */
export async function stopSessionTarget(target, ports) {
  if (!target.descriptor || !target.ownsSession) throw new Error('This session is unavailable. Reopen it and try again.');
  await ports.ipc(target.descriptor, { op: 'killSession', generation: target.descriptor.generation });
}

/** Move an existing or parked terminal using Herdr's observable pane state. */
export async function moveTerminal(terminal, destination, ports) {
  const deadline = ports.now() + (ports.timeoutMs ?? 10000);
  const command = async (name, args) => {
    const reply = await ports.run(name, args);
    if (reply?.error) {
      const error = new Error(reply.error.message ?? 'Herdr command failed');
      error.code = 'app-rejected'; throw error;
    }
  };
  const wait = async (predicate, until = deadline) => {
    for (;;) {
      const value = await ports.placement(terminal);
      if (predicate(value)) return value;
      if (ports.now() >= until) throw new Error('Herdr did not confirm the pane move');
      await ports.sleep(50);
    }
  };
  const previous = await ports.placement(terminal);
  let placeholder = null;
  if (ports.adopt && destination.kind === 'new') {
    const space = destination.space ?? previous?.space;
    if (!space || !ports.createTab) throw new Error('The target space is unavailable');
    placeholder = await ports.createTab(space);
    destination = { kind: 'tab', space: placeholder.space, tab: placeholder.tab };
  }
  const targetExists = async tab => ports.tabExists ? ports.tabExists(tab) : Boolean(await ports.targetPane(tab));
  if (destination.kind === 'tab') {
    if (previous?.tab === destination.tab) {
      await command('pane.focus', { terminal });
      return previous;
    }
    if (!placeholder && !await targetExists(destination.tab)) throw new Error('The target tab is unavailable');
  }
  if (previous) {
    try { await command('terminal.park', { terminal }); }
    catch (error) {
      if (placeholder && error?.code === 'app-rejected') await command('pane.close', { pane: placeholder.pane });
      throw error;
    }
    await wait(placement => placement === null);
    await ports.changed(null);
  }
  if (destination.kind === 'hide') return null;
  try {
    if (ports.adopt && destination.kind === 'tab') {
      if (!placeholder && !await targetExists(destination.tab)) throw new Error('The target tab is unavailable');
      await ports.adopt(terminal, { space: destination.space, tab: destination.tab });
    } else {
      if (destination.kind === 'tab') {
        const pane = await ports.targetPane(destination.tab);
        if (!pane) throw new Error('The target tab has no pane');
        await command('pane.focus', { pane });
      }
      await command('terminal.keep', { terminal, place: destination.kind === 'new' ? 'tab' : 'right' });
    }
    const matches = value => value !== null && (ports.placementMatches ? ports.placementMatches(value)
      : destination.kind === 'tab' ? value.tab === destination.tab : !previous || value.tab !== previous.tab);
    const placement = await wait(matches);
    await ports.changed(placement);
    if (placeholder) await command('pane.close', { pane: placeholder.pane });
    await command('pane.focus', { terminal });
    return placement;
  } catch (error) {
    let placement = await ports.placement(terminal);
    if (placement && ports.placementMatches && !ports.placementMatches(placement)) placement = null;
    if (!placement && previous && ports.adopt) {
      try {
        await ports.adopt(terminal, { space: previous.space, tab: previous.tab });
        placement = await wait(value => value !== null && value.space === previous.space && value.tab === previous.tab, ports.now() + (ports.timeoutMs ?? 10000));
        await ports.changed(placement);
      } catch { throw new Error('The move failed and the original pane could not be restored'); }
    }
    if (placement) {
      if (placeholder && placement.tab !== placeholder.tab) await command('pane.close', { pane: placeholder.pane });
      await command('pane.focus', { terminal });
    }
    throw error;
  }
}
