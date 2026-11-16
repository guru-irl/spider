// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { AppClient, AppPaneInspection, HcClient, OwnerPlacement, TerminalAddress } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { samePaneTarget } from './lifecycle.js';
import { paneAddress } from './codec.js';
import type { AppPaneCapabilities, FolderChoice, MachineChoice, PaneActionOutcome, PaneOpenIntent, PanePlacementStore, PanePresentation, PaneSlot, PaneTarget, PaneTargetLaunch } from './types.js';
export interface PaneOpenPorts {
  store: PanePlacementStore; hc: HcClient; app: (AppClient & AppPaneInspection) | null;
  placeholderMod: string;
  launchTarget(input: { machine: MachineChoice; program: PaneOpenIntent['program']; folder: FolderChoice; operationId: string }): Promise<PaneTarget>;
  launchProxy(presentation: PanePresentation): Promise<TerminalAddress>;
  awaitPresented(proxy: TerminalAddress, target: PaneTarget, slot: PaneSlot): Promise<OwnerPlacement>;
  findTargetLaunch(operationId: string, machine: MachineChoice): Promise<PaneTarget | null>;
  findProxy(presentation: PanePresentation): Promise<TerminalAddress | null>;
  readNativeTarget(address: TerminalAddress): Promise<PaneTarget>;
  validateTarget(target: PaneTarget, cause: 'open' | 'handoff' | 'close'): Promise<PaneTarget>;
  agentArgv(machine: MachineChoice, key: string): Promise<readonly string[]>;
  verifyPlaceholder(placement: OwnerPlacement, operationId: string): Promise<boolean>;
  findPlaceholder(operationId: string): Promise<OwnerPlacement | null>;
  appCapabilities(): Promise<AppPaneCapabilities>;
  /** Return true only after a non-interactive moved placeholder is behaviorally proved. */
  deferSourceView(source: OwnerPlacement, destination: PaneTarget): Promise<boolean>;
  /** Supplied only for a behaviorally proved explicit-target/no-focus placement path. */
  placeWithoutFocus?(address: TerminalAddress, slot: PaneSlot): Promise<OwnerPlacement>;
}
const outcome = (status: PaneActionOutcome['status'], reason: string, presentation: PanePresentation | null = null): PaneActionOutcome => ({ status, reason, presentation });
async function command(app: AppClient, name: string, args: Record<string, unknown>) {
  const reply = await app.command(name, args); if (reply.error) throw new HerdrError(reply.error.code, reply.error.message); return reply;
}
async function destination(intent: PaneOpenIntent, app: AppClient & AppPaneInspection) {
  const spaces = await app.listSpaces?.();
  const space = spaces?.find(s => s.id === intent.space && s.machine === null);
  if (!space) throw new HerdrError('space-unavailable', 'Captured local space is unavailable');
  if (intent.place !== 'tab') {
    const anchor = intent.anchor;
    if (!anchor || anchor.space !== intent.space || !space.tabs.some(t => t.id === anchor.tab) || !(await app.tabPanes(anchor)).some(p => p.pane === anchor.pane)) throw new HerdrError('anchor-unavailable', 'Captured split anchor is unavailable');
  }
}
async function reservePlaceholder(intent: PaneOpenIntent, ports: PaneOpenPorts): Promise<OwnerPlacement> {
  const app = ports.app!; await destination(intent, app);
  const props = { operationId: intent.operationId, presentationId: `pane-${intent.operationId}` };
  const reply = intent.place === 'tab'
    ? await command(app, 'tab.new', { space: intent.space, mod: ports.placeholderMod, props })
    : await command(app, 'pane.split', { pane: intent.anchor!.pane, direction: intent.place, mod: ports.placeholderMod, props });
  const tab = intent.place === 'tab' ? reply.tab : intent.anchor!.tab;
  if (!tab || !reply.pane) throw new HerdrError('placement-uncertain', 'Placeholder allocation has no observed placement');
  const p: OwnerPlacement = { space: intent.space, tab, pane: reply.pane };
  if (!await ports.verifyPlaceholder(p, intent.operationId)) throw new HerdrError('placement-uncertain', 'Placeholder identity is unproved'); return p;
}
async function updatePresentation(p: PanePresentation, fields: Partial<PanePresentation>, ports: PaneOpenPorts): Promise<PanePresentation> {
  let changed: PanePresentation | null = null;
  await ports.store.update(state => ({ ...state, presentations: state.presentations.map(current => {
    if (current.id !== p.id || current.revision !== p.revision || !samePaneTarget(current.target, p.target)) return current;
    changed = { ...current, ...fields, revision: current.revision + 1 }; return changed;
  }) }));
  if (!changed) throw new HerdrError('stale-presentation', 'Presentation changed before acknowledgment'); return changed;
}
async function verifyProxy(address: TerminalAddress, p: PanePresentation, ports: PaneOpenPorts) {
  const core = await ports.hc.identity();
  if (address.includes('/') && !address.startsWith(`${core.coreId}/`)) throw new HerdrError('proxy-identity', 'Presentation proxy is not on the selected local core');
  const terminal = await ports.hc.get(address); const labels = terminal.labels;
  if (terminal.address !== address || terminal.state !== 'live' || labels['spider.kind'] !== 'pane-proxy' || labels['spider.pane-id'] !== p.id || labels['spider.target-core'] !== p.target.coreId || labels['spider.target-terminal'] !== p.target.terminalId) throw new HerdrError('proxy-identity', 'Presentation proxy identity is unproved');
}
export async function presentProxy(p: PanePresentation, operationId: string, ports: PaneOpenPorts): Promise<PanePresentation> {
  const app = ports.app!; const proxy = p.proxy; if (!proxy || !p.slot) throw new HerdrError('unplaced-target', 'Target has no acknowledged presentation claim');
  await verifyProxy(proxy, p, ports);
  let placed: OwnerPlacement | null = null; try { placed = await app.ownerPlacement(proxy); } catch { /* A qualified unplaced proxy can be adopted. */ }
  if (placed && (placed.space !== p.slot.space || placed.tab !== p.slot.tab)) throw new HerdrError('placement-mismatch', 'Proxy is outside its captured tab');
  if (!placed) {
    if (!p.slot.pane || !await ports.verifyPlaceholder({ ...p.slot, pane: p.slot.pane }, operationId)) throw new HerdrError('placeholder-unavailable', 'Captured placeholder is unavailable');
    await command(app, 'pane.focus', { pane: p.slot.pane });
    const focus = await app.focusedPane();
    if (focus?.pane !== p.slot.pane || focus.tab !== p.slot.tab || focus.space !== p.slot.space) throw new HerdrError('focus-changed', 'Placeholder focus changed before adoption');
    await command(app, 'terminal.keep', { terminal: proxy, place: 'right' });
  }
  const actual = await ports.awaitPresented(proxy, p.target, p.slot);
  if (actual.space !== p.slot.space || actual.tab !== p.slot.tab) throw new HerdrError('placement-mismatch', 'Proxy acknowledgment is outside its captured tab');
  if (p.slot.pane && p.slot.pane !== actual.pane && await ports.verifyPlaceholder({ ...p.slot, pane: p.slot.pane }, operationId)) await command(app, 'pane.close', { pane: p.slot.pane });
  return updatePresentation(p, { slot: actual, visibility: 'visible', launch: 'acknowledged' }, ports);
}
async function checkedLaunch(target: PaneTarget, operationId: string, machine: MachineChoice, ports: PaneOpenPorts): Promise<PaneTarget> {
  const verified = await ports.validateTarget(target, 'open');
  if (!samePaneTarget(target, verified) || verified.coreId !== machine.coreId || verified.address !== `${verified.coreId}/${verified.terminalId}` || verified.createdMs <= 0 || verified.identityLabels['spider.pane-operation'] !== operationId || verified.kind !== 'terminal' && verified.generation === null) throw new HerdrError('launch-identity', 'Target launch identity is unproved');
  if (machine.alias !== null && ('herdr.space' in verified.identityLabels || 'herdr.tab' in verified.identityLabels)) throw new HerdrError('launch-identity', 'Remote target cannot carry Mac placement labels');
  return verified;
}
async function nativeLaunch(intent: PaneOpenIntent, machine: MachineChoice, folder: FolderChoice, ports: PaneOpenPorts, beforeLaunch?: () => Promise<void>): Promise<PaneTarget> {
  const app = ports.app!;
  const argv = intent.program.kind === 'agent' ? await ports.agentArgv(machine, intent.program.key) : null;
  await destination(intent, app);
  if (intent.place !== 'tab') {
    await command(app, 'pane.focus', { pane: intent.anchor!.pane });
    const focused = await app.focusedPane();
    if (!focused || focused.pane !== intent.anchor!.pane || focused.tab !== intent.anchor!.tab || focused.space !== intent.anchor!.space) throw new HerdrError('anchor-unavailable', 'Captured split anchor lost focus');
  }
  await beforeLaunch?.();
  const reply = intent.place === 'tab'
    ? await command(app, 'tab.new', { space: intent.space, ...(folder.cwd !== null ? { folder: folder.cwd } : {}), ...(argv ? { argv } : {}) })
    : await command(app, 'terminal.open', { place: intent.place, ...(folder.cwd !== null ? { folder: folder.cwd } : {}), ...(argv ? { argv } : {}) });
  if (!reply.terminal) throw new HerdrError('launch-uncertain', 'Native creation has no observed terminal');
  await ports.hc.setLabels(reply.terminal, { 'spider.pane-operation': intent.operationId });
  return checkedLaunch(await ports.readNativeTarget(reply.terminal), intent.operationId, machine, ports);
}
export async function openPane(input: { intent: PaneOpenIntent; machine: MachineChoice; folder: FolderChoice; beforeLaunch?: () => Promise<void> }, ports: PaneOpenPorts): Promise<PaneActionOutcome> {
  const { intent, machine, folder } = input; const operationId = intent.operationId;
  if (machine.state !== 'connected' || !machine.coreId) return outcome('refused', 'machine-unavailable');
  if (!ports.app) return outcome('pending', 'app-unavailable');
  try { await destination(intent, ports.app); } catch { return outcome('refused', 'destination-unavailable'); }
  const local = await ports.hc.identity(); const native = machine.coreId === local.coreId;
  let claimed = false; let launch: PaneTargetLaunch | null = null;
  try {
    await ports.store.update(state => {
      const previous = state.launches.find(l => l.operationId === operationId);
      if (previous) {
        if (previous.coreId !== machine.coreId || previous.machineKey !== machine.key || JSON.stringify(previous.intent) !== JSON.stringify(intent) || JSON.stringify(previous.folder) !== JSON.stringify(folder)) throw new HerdrError('operation-reused', 'Creation operation was reused for different input');
        launch = previous; return state;
      }
      claimed = true;
      launch = { operationId, coreId: machine.coreId!, machineKey: machine.key, intent, folder, state: 'claimed', target: null, failure: null };
      return { ...state, launches: [...state.launches, launch] };
    });
  } catch { return outcome('refused', 'operation-reused'); }
  const existing = (await ports.store.read()).presentations.find(p => p.id === `pane-${operationId}`);
  if (existing && (existing.visibility === 'closing' || existing.visibility === 'ended' || existing.visibility === 'parked')) return outcome('refused', 'presentation-not-visible', existing);
  let p: PanePresentation | null = existing ?? null;
  let slot: OwnerPlacement | null = null;
  try {
    let target = (launch as PaneTargetLaunch | null)?.target ?? null;
    if (!target) {
      if (!claimed) {
        target = await ports.findTargetLaunch(operationId, machine);
        if (!target) return outcome('pending', 'target-launch-uncertain', p);
        target = await checkedLaunch(target, operationId, machine, ports);
        if (!native) slot = await ports.findPlaceholder(operationId);
      } else if (native) target = await nativeLaunch(intent, machine, folder, ports, input.beforeLaunch);
      else { slot = await reservePlaceholder(intent, ports); await input.beforeLaunch?.(); target = await checkedLaunch(await ports.launchTarget({ machine, program: intent.program, folder, operationId }), operationId, machine, ports); }
      await ports.store.update(state => ({ ...state, launches: state.launches.map(l => l.operationId === operationId ? { ...l, state: 'observed', target, failure: null } : l) }));
    }
    if (!p) {
      if (native) slot = await ports.app.ownerPlacement(paneAddress(target.terminalId));
      else slot ??= await ports.findPlaceholder(operationId);
      if (!slot) return outcome('pending', 'unplaced-target');
      p = { id: `pane-${operationId}`, revision: 1, mode: native ? 'native' : 'proxy', role: intent.program.kind === 'agent' ? 'agent' : 'shell', target, proxy: null, slot, visibility: 'visible', launch: native ? 'acknowledged' : 'claimed', closeOperationId: null, conversion: null };
      let inserted = false; const candidate = p;
      const state = await ports.store.update(s => { if (s.presentations.some(item => item.id === candidate.id)) return s; inserted = true; return { ...s, presentations: [...s.presentations, candidate] }; });
      p = state.presentations.find(item => item.id === candidate.id)!;
      if (!native && inserted) {
        try {
          const proxy = await ports.launchProxy(p); await verifyProxy(proxy, p, ports);
          await ports.hc.setLabels(proxy, { 'herdr.space': slot.space, 'herdr.tab': slot.tab });
          p = await updatePresentation(p, { proxy, launch: 'acknowledged' }, ports);
        } catch { p = await updatePresentation(p, { launch: 'uncertain' }, ports); return outcome('pending', 'proxy-launch-uncertain', p); }
      }
    }
    if (native) {
      const actual = await ports.app.ownerPlacement(paneAddress(p.target.terminalId));
      if (actual.space !== intent.space || intent.anchor && actual.tab !== intent.anchor.tab) return outcome('pending', 'unplaced-target', p);
      return outcome('complete', 'native-presented', p);
    }
    if (!p.proxy) {
      const proxy = await ports.findProxy(p); if (!proxy) return outcome('pending', 'proxy-launch-uncertain', p);
      await verifyProxy(proxy, p, ports); p = await updatePresentation(p, { proxy, launch: 'acknowledged' }, ports);
    }
    return outcome('complete', 'proxy-presented', await presentProxy(p, operationId, ports));
  } catch (error) {
    if (error instanceof HerdrError && error.code === 'machine-changed') {
      await ports.store.update(state => ({ ...state, launches: state.launches.map(l => l.operationId === operationId && l.state !== 'observed' ? { ...l, state: 'not-started', failure: 'machine-changed' } : l) }));
      return outcome('refused', 'machine-changed', p);
    }
    if (!p) await ports.store.update(state => ({ ...state, launches: state.launches.map(l => l.operationId === operationId && l.state !== 'observed' ? { ...l, state: 'uncertain', failure: 'target-launch-uncertain' } : l) }));
    return outcome('pending', p ? 'unplaced-target' : 'target-launch-uncertain', p);
  }
}
export interface PaneScreen { text: string; complete: boolean; cols: number; rows: number }
export interface PanePresentedPorts {
  app: AppClient;
  readScreen(address: TerminalAddress, options: { lines: 0 }): Promise<PaneScreen>;
  clock(): number; delay(): Promise<void>; timeoutMs: number;
}
/** Compare complete, stable same-size screens in memory only, never persist their contents. */
export async function awaitPanePresented(proxy: TerminalAddress, target: PaneTarget, slot: PaneSlot, ports: PanePresentedPorts): Promise<OwnerPlacement> {
  const deadline = ports.clock() + ports.timeoutMs;
  for (;;) {
    const placement = await ports.app.ownerPlacement(proxy);
    if (placement.space !== slot.space || placement.tab !== slot.tab) throw new HerdrError('placement-mismatch', 'Presented view is outside its captured tab');
    const before = await ports.readScreen(target.address, { lines: 0 });
    const shown = await ports.readScreen(proxy, { lines: 0 });
    const after = await ports.readScreen(target.address, { lines: 0 });
    if ([before, shown, after].every(s => s.complete && s.cols >= 60 && s.rows >= 8 && s.cols === before.cols && s.rows === before.rows && s.text.trim().length > 0 && s.text === before.text)) return placement;
    if (ports.clock() >= deadline) throw new HerdrError('presentation-timeout', 'Destination screen acknowledgment is pending'); await ports.delay();
  }
}

/** The execution home's retirement is external; this operation only replaces its Mac view. */
export async function convertNativePresentation(input: { presentation: PanePresentation; destination: PaneTarget; source: OwnerPlacement | null; sourceFocused: boolean }, ports: PaneOpenPorts): Promise<PaneActionOutcome> {
  let p = (await ports.store.read()).presentations.find(item => item.id === input.presentation.id) ?? null;
  if (!p || p.revision !== input.presentation.revision || !samePaneTarget(p.target, input.presentation.target)) return outcome('refused', 'stale-presentation', p);
  if (p.visibility === 'closing' || p.visibility === 'ended') return outcome('refused', 'Session changed. Close again.', p);
  const destination = input.destination;
  try {
    if (destination.createdMs <= 0 || !Object.keys(destination.identityLabels).length || destination.kind !== 'terminal' && destination.generation === null || !samePaneTarget(destination, await ports.validateTarget(destination, 'handoff'))) return outcome('refused', 'readiness-unverified', p);
  } catch { return outcome('pending', 'readiness-unavailable', p); }
  const local = await ports.hc.identity(); const native = destination.coreId === local.coreId;
  const source = p.conversion?.source ?? input.source;
  if (p.slot && (!source || p.slot.space !== source.space || p.slot.tab !== source.tab)) return outcome('refused', 'captured-slot-changed', p);
  if (samePaneTarget(p.target, destination) && p.mode === (native ? 'native' : 'proxy') && !p.conversion) return outcome('complete', 'already-presented', p);
  if (p.mode === 'proxy' && !native) {
    p = await updatePresentation(p, { target: destination, conversion: null }, ports);
    if (p.visibility === 'parked' || !ports.app || !p.proxy || !p.slot) return outcome(p.visibility === 'parked' ? 'complete' : 'pending', 'proxy-retargeted', p);
    try { await ports.awaitPresented(p.proxy, destination, p.slot); return outcome('complete', 'proxy-retargeted', p); }
    catch { return outcome('pending', 'destination-screen-pending', p); }
  }
  if (p.visibility === 'parked') {
    p = await updatePresentation(p, { target: destination, mode: native ? 'native' : 'proxy', proxy: null, launch: 'none', conversion: null }, ports);
    return outcome('complete', 'parked-binding-updated', p);
  }
  if (!source) return outcome('pending', 'source-view-unavailable', p);
  let focused = false; let noFocus = false;
  if (ports.app) {
    const current = await ports.app.focusedPane(); focused = current?.space === source.space && current.tab === source.tab && current.pane === source.pane;
    const caps = await ports.appCapabilities(); noFocus = caps.noFocusConversion && caps.explicitTargetSwap && !!ports.placeWithoutFocus;
  }
  const conversion: PanePresentation['conversion'] = { state: 'waiting-focus', source, sourceFocused: focused, destination };
  if (!p.conversion || p.conversion.state !== 'waiting-focus' || !samePaneTarget(p.conversion.destination, destination) || p.conversion.sourceFocused !== focused) p = await updatePresentation(p, { conversion }, ports);
  if (!ports.app) return outcome('pending', 'app-unavailable', p);
  if (!focused && !noFocus) {
    let proved = false;
    try { proved = await ports.deferSourceView(source, destination); } catch { /* Unsupported remains unproved. */ }
    return outcome('pending', proved ? 'waiting-focus' : 'waiting-focus-placeholder-unproved', p);
  }
  const app = ports.app; const original = input.presentation;
  const oldDisplay = original.mode === 'native' ? paneAddress(original.target.terminalId) : original.proxy;
  if (!oldDisplay) return outcome('pending', 'source-view-unavailable', p);
  try {
    const oldPlacement = await app.ownerPlacement(oldDisplay);
    if (oldPlacement.space !== source.space || oldPlacement.tab !== source.tab || oldPlacement.pane !== source.pane) return outcome('pending', 'source-view-unavailable', p);
    let replacement: TerminalAddress;
    if (native) replacement = paneAddress(destination.terminalId);
    else {
      const desired = { ...p, target: destination, mode: 'proxy' as const, conversion: null };
      if (!p.proxy) {
        if (p.launch === 'claimed' || p.launch === 'uncertain') {
          const recovered = await ports.findProxy(desired); if (!recovered) return outcome('pending', 'conversion-proxy-uncertain', p);
          await verifyProxy(recovered, desired, ports); p = await updatePresentation(p, { proxy: recovered, launch: 'acknowledged' }, ports);
        } else {
          p = await updatePresentation(p, { launch: 'claimed' }, ports);
          try {
            const proxy = await ports.launchProxy({ ...p, target: destination, mode: 'proxy', conversion: null });
            await verifyProxy(proxy, { ...p, target: destination }, ports);
            p = await updatePresentation(p, { proxy, launch: 'acknowledged' }, ports);
          } catch { p = await updatePresentation(p, { launch: 'uncertain' }, ports); return outcome('pending', 'conversion-proxy-uncertain', p); }
        }
      }
      replacement = p.proxy!;
    }
    const slot: PaneSlot = { space: source.space, tab: source.tab, pane: source.pane };
    let placed: OwnerPlacement | null = null; try { placed = await app.ownerPlacement(replacement); } catch { /* Adopt the real terminal, never relaunch it. */ }
    if (placed && (placed.space !== slot.space || placed.tab !== slot.tab)) return outcome('pending', 'replacement-outside-captured-tab', p);
    if (!placed) {
      if (noFocus && !focused) await ports.placeWithoutFocus!(replacement, slot);
      else {
        const current = await app.focusedPane();
        if (!current || current.space !== source.space || current.tab !== source.tab || current.pane !== source.pane) return outcome('pending', 'focus-changed', p);
        await command(app, 'terminal.keep', { terminal: replacement, place: 'right' });
      }
    }
    const actual = await ports.awaitPresented(replacement, destination, slot);
    if (actual.space !== source.space || actual.tab !== source.tab) return outcome('pending', 'replacement-outside-captured-tab', p);
    // Publish the acknowledged binding before retiring the old proxy. Its watcher then exits
    // rather than treating a deliberate handoff as an unexplained process close.
    p = await updatePresentation(p, { target: destination, mode: native ? 'native' : 'proxy', proxy: native ? null : replacement, slot: actual, launch: 'acknowledged', conversion: null }, ports);
    if (original.mode === 'native') {
      const stillSource = await ports.readNativeTarget(oldDisplay);
      if (!samePaneTarget(stillSource, original.target)) return outcome('pending', 'source-retirement-unverified', p);
      await command(app, 'terminal.park', { terminal: oldDisplay });
      return outcome('complete', 'native-view-converted', p);
    }
    await command(app, 'terminal.park', { terminal: oldDisplay });
    if ((await app.tabTerminals(source)).includes(oldDisplay)) return outcome('pending', 'old-proxy-removal-pending', p);
    await verifyProxy(oldDisplay, original, ports);
    await ports.hc.kill(oldDisplay);
    return outcome('complete', 'native-view-converted', p);
  } catch { return outcome('pending', 'conversion-pending', p); }
}
