// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { randomBytes } from 'node:crypto';
import { assessSessionLiveness, recordedSessionLiveness } from '../sessions/lease.js';
import type { PresenceRecord } from '../sessions/presence.js';
import { join, isAbsolute } from 'node:path';
import type { AppClient, CoreIdentity, HerdrConfig, SessionFeed, SpaceId, TabId, TerminalAddress } from '../contracts.js';
import { HERDR_KINDS, HERDR_LABELS } from '../contracts.js';
import { duplicateSessionNotice, foreignPanesNotice, renamedSpaceNotice } from '../notices.js';
import { HerdrError } from '../client/parse.js';
import { canonicalSessionFile, readPrivateJson, writePrivateJson, withProcessLock, refuseExplicitExtensions } from '../sessions/registry.js';
import { discoverSessions, selectedProcessInventory, type SessionDiscoveryPorts, type ResolvedSession } from './discovery.js';
import { startCutover, type CutoverPorts, type LaunchedSession } from './cutover.js';
export interface LayoutSnapshot { spaces: { id: SpaceId; name: string; tabs: { id: TabId; name: string; ownerSessionId: string | null; terminal: TerminalAddress | null; terminals?: { terminal: TerminalAddress; ownerSessionId?: string | null }[] }[] }[] }
type LayoutTab = LayoutSnapshot['spaces'][number]['tabs'][number];
export function tabTerminals(tab: LayoutTab): readonly { terminal: TerminalAddress; ownerSessionId?: string | null }[] {
  return tab.terminals ?? (tab.terminal ? [{ terminal: tab.terminal, ownerSessionId: tab.ownerSessionId }] : []);
}
export interface SessionTab { space: SpaceId; tab: TabId; terminal: TerminalAddress }
export interface LeasedLauncherCommand { nodePath: string; cliPath: string; configPath: string }
export interface SpaceSetupPorts extends SessionDiscoveryPorts {
  journalRoot: string; app: AppClient; layoutSnapshot(): Promise<LayoutSnapshot>; coreIdentity(): Promise<CoreIdentity>;
  launcher: LeasedLauncherCommand;
  clock(): number; waitForChange(deadline: number, signal: AbortSignal): Promise<void>;
  reportLive: CutoverPorts['reportLive']; reportBlocked: CutoverPorts['reportBlocked']; notesDisabled(): Promise<boolean>;
  /** Reads the returned terminal's verified owner mapping/feed; does not open a session file. */
  verifyOwner(target: ResolvedSession, placement: SessionTab, signal?: AbortSignal): Promise<LaunchedSession>;
  terminalState?(placement: SessionTab): Promise<'live' | 'finished' | 'absent'>;
  terminalLabels?(terminal: TerminalAddress): Promise<Readonly<Record<string, string>>>;
  reportLayout?(message: string): void;
  /** Returns only a live feed with a current heartbeat. */
  liveSessionFeed?(target: ResolvedSession): Promise<SessionFeed | null>;
}
interface PaneMove { tab: TabId; anchor: TerminalAddress; direction: 'right' | 'down' }
interface JournalTab { target: ResolvedSession; placement: SessionTab; result: LaunchedSession | null; failure: string | null; label?: string; tabName?: string; pane?: PaneMove; manuallyMoved?: boolean }
interface TabIntent { target: ResolvedSession; label: string; tabName?: string; space: SpaceId | null; retired: TerminalAddress[]; pane?: PaneMove }
interface SpaceJournal { version: 1; spaces: { name: string; id: SpaceId; adopted: boolean }[]; tabs: JournalTab[]; intents?: TabIntent[]; retired?: SessionTab[]; focused: boolean }
export interface SpaceSetupOptions { signal?: AbortSignal; /** Repeatable CLI --adopt-existing-space names; authorizes append-only tabs, never adoption of a terminal. */ adoptExistingSpaces?: readonly string[] }
export interface SpaceSetupResult { launched: LaunchedSession[]; tabs: SessionTab[]; conflicts?: { sessionId: string; terminals: TerminalAddress[] }[] }
export function leasedLauncherArgv(target: ResolvedSession, options: LeasedLauncherCommand, agentDirectory: string): string[] {
  refuseExplicitExtensions(target.name ?? target.sessionId, target.extensionArguments);
  if (![options.nodePath, options.cliPath, options.configPath, agentDirectory, target.file, target.cwd].every(isAbsolute)) throw new HerdrError('launch-environment-invalid', 'Leased launcher paths must be absolute');
  // Herdr's app may have a different environment from the setup shell. Set pi's
  // directory before loading the CLI so its resume preflight sees the same path.
  const bootstrap = 'process.env.PI_CODING_AGENT_DIR=process.argv[1].slice("PI_CODING_AGENT_DIR=".length);process.argv.splice(1,2);import(require("node:url").pathToFileURL(process.argv[1]).href)';
  return [options.nodePath, '-e', bootstrap, `PI_CODING_AGENT_DIR=${agentDirectory}`, options.nodePath, options.cliPath, 'resume', '--config', options.configPath, '--file', target.file, '--session-id', target.sessionId, '--cwd', target.cwd, '--cutover'];
}
export async function allocateTab(app: AppClient, space: SpaceId, name: string, cwd: string, argv: readonly string[]): Promise<SessionTab> {
  const reply = await app.command('tab.new', { space, name, folder: cwd, argv });
  if (reply.error) throw new HerdrError(reply.error.code, reply.error.message);
  if (!reply.tab || !reply.terminal) throw new HerdrError('tab-allocation-unconfirmed', 'App did not return the new tab and terminal IDs');
  return { space, tab: reply.tab, terminal: reply.terminal };
}
/** Session order maps to stable split anchors. The first four use the familiar reading layout. */
function panePlan(count: number): { anchor: number; direction: 'right' | 'down' }[] {
  if (count <= 4) return [{ anchor: 0, direction: 'right' }, { anchor: 1, direction: 'down' }, { anchor: 0, direction: 'down' }].slice(0, Math.max(0, count - 1)) as { anchor: number; direction: 'right' | 'down' }[];
  const columns = Math.ceil(Math.sqrt(count)), base = Math.floor(count / columns), extra = count % columns;
  const plan: { anchor: number; direction: 'right' | 'down' }[] = [];
  for (let column = 1; column < columns; column++) plan.push({ anchor: column - 1, direction: 'right' });
  for (let column = 0; column < columns; column++) {
    let anchor = column;
    for (let row = 1; row < base + (column >= columns - extra ? 1 : 0); row++) { plan.push({ anchor, direction: 'down' }); anchor = plan.length; }
  }
  return plan;
}
function validateJournal(value: unknown): SpaceJournal {
  const saved = value as { version?: unknown; tabs?: unknown };
  if (saved?.version === 2) {
    const grouped = value as { tabs: { space: SpaceId; tab: TabId; name: string; sessions: { target: ResolvedSession; terminal: TerminalAddress; result: LaunchedSession | null; failure: string | null; label?: string; pane?: PaneMove; manuallyMoved?: boolean }[] }[] };
    if (!Array.isArray(grouped.tabs) || grouped.tabs.some(t => !t || typeof t.space !== 'string' || typeof t.tab !== 'string' || typeof t.name !== 'string' || !Array.isArray(t.sessions) || t.sessions.some(entry => !entry || typeof entry !== 'object'))) throw new HerdrError('invalid-space-journal', 'Setup tab groups are invalid');
    value = { ...saved, version: 1, tabs: grouped.tabs.flatMap(tab => tab.sessions.map(({ terminal, ...entry }) => ({ ...entry, tabName: tab.name, placement: { space: tab.space, tab: tab.tab, terminal } }))) };
  }
  const j = value as SpaceJournal;
  if (!j || j.version !== 1 || !Array.isArray(j.spaces) || !Array.isArray(j.tabs) || typeof j.focused !== 'boolean' || j.spaces.some(s => typeof s.name !== 'string' || typeof s.id !== 'string' || typeof s.adopted !== 'boolean') || j.tabs.some(t => !t.target || !isAbsolute(t.target.file) || !isAbsolute(t.target.cwd) || typeof t.target.sessionId !== 'string' || !Array.isArray(t.target.extensionArguments) || t.target.extensionArguments.length !== 0 || !t.placement || typeof t.placement.space !== 'string' || typeof t.placement.tab !== 'string' || typeof t.placement.terminal !== 'string' || !(t.result === null || t.result.sessionId === t.target.sessionId && typeof t.result.sessionFile === 'string' && isAbsolute(t.result.sessionFile) && typeof t.result.cwd === 'string' && isAbsolute(t.result.cwd)))) throw new HerdrError('invalid-space-journal', 'Setup journal is invalid');
  if (j.intents !== undefined && (!Array.isArray(j.intents) || j.intents.some(i => !i.target || !isAbsolute(i.target.file) || !isAbsolute(i.target.cwd) || typeof i.target.sessionId !== 'string' || typeof i.label !== 'string' || !(i.space === null || typeof i.space === 'string') || !Array.isArray(i.retired)))) throw new HerdrError('invalid-space-journal', 'Invalid allocation intent');
  if ([...j.tabs, ...(j.intents ?? [])].some(i => i.pane && (typeof i.pane.tab !== 'string' || typeof i.pane.anchor !== 'string' || !['right', 'down'].includes(i.pane.direction)))) throw new HerdrError('invalid-space-journal', 'Invalid pane allocation intent');
  if (j.tabs.some(t => t.manuallyMoved !== undefined && typeof t.manuallyMoved !== 'boolean')) throw new HerdrError('invalid-space-journal', 'Invalid manual move marker');
  const terminals = new Set(j.tabs.map(t => t.placement.terminal));
  if (terminals.size !== j.tabs.length) throw new HerdrError('invalid-space-journal', 'A terminal cannot belong to several journalled sessions');
  j.intents ??= []; j.retired ??= [];
  return j;
}
async function saveJournal(path: string, journal: SpaceJournal): Promise<void> {
  const tabs: { space: SpaceId; tab: TabId; name: string; sessions: { target: ResolvedSession; terminal: TerminalAddress; result: LaunchedSession | null; failure: string | null; label?: string; pane?: PaneMove; manuallyMoved?: boolean }[] }[] = [];
  for (const entry of journal.tabs) {
    let tab = tabs.find(tab => tab.space === entry.placement.space && tab.tab === entry.placement.tab);
    if (!tab) { tab = { space: entry.placement.space, tab: entry.placement.tab, name: entry.tabName ?? entry.target.name ?? entry.target.sessionId, sessions: [] }; tabs.push(tab); }
    tab.sessions.push({ target: entry.target, terminal: entry.placement.terminal, result: entry.result, failure: entry.failure, ...(entry.label ? { label: entry.label } : {}), ...(entry.pane ? { pane: entry.pane } : {}), ...(entry.manuallyMoved ? { manuallyMoved: true } : {}) });
  }
  await writePrivateJson(path, { ...journal, version: 2, tabs });
}
/** A moved terminal was already proved ours by its nonce-labelled allocation. */
function reconcileMoves(journal: SpaceJournal, snapshot: LayoutSnapshot): boolean {
  let changed = false;
  for (const entry of journal.tabs) if (entry.pane) {
    const matches = snapshot.spaces.flatMap(space => space.tabs.filter(tab => tabTerminals(tab).some(row => row.terminal === entry.placement.terminal)).map(tab => ({ space, tab })));
    if (matches.length > 1) throw new HerdrError('tab-owner-conflict', 'A session terminal appears in several tabs');
    const found = matches[0];
    if (found && found.space.id === entry.placement.space && found.tab.id === entry.pane.tab && found.tab.name === entry.target.spaceName) {
      entry.placement.tab = found.tab.id; delete entry.pane; changed = true;
    }
  }
  return changed;
}
/** Report renamed spaces and panes that are not spider auxiliary terminals. */
async function reportMergedLayout(journal: SpaceJournal, snapshot: LayoutSnapshot, ports: Pick<SpaceSetupPorts, 'terminalLabels' | 'reportLayout'>, previousNames = new Map<SpaceId, string>()): Promise<void> {
  if (!ports.reportLayout) return;
  const kinds: readonly string[] = [HERDR_KINDS.subagentViewer, HERDR_KINDS.remoteObserver, HERDR_KINDS.remoteConsole];
  for (const space of journal.spaces) {
    const entries = journal.tabs.filter(t => t.placement.space === space.id && !t.manuallyMoved);
    const actual = snapshot.spaces.find(s => s.id === space.id);
    if (!entries.length || !actual) continue;
    const previousName = previousNames.get(space.id) ?? space.name;
    if (actual.name !== previousName) ports.reportLayout(renamedSpaceNotice(previousName, actual.name));
    if (actual.tabs.length !== 1) continue;
    const tab = actual.tabs[0], expected = new Set(entries.map(t => t.placement.terminal));
    const foreign: TerminalAddress[] = [];
    for (const row of tabTerminals(tab).filter(row => !expected.has(row.terminal))) {
      let kind: string | undefined;
      try { kind = (await ports.terminalLabels?.(row.terminal))?.[HERDR_LABELS.kind]; } catch { /* Without labels, leave the pane alone and report it. */ }
      if (!kind || !kinds.includes(kind)) foreign.push(row.terminal);
    }
    if (foreign.length) ports.reportLayout(foreignPanesNotice(actual.name, tab.name, foreign));
  }
}
/** Adopt a merged tab without moving or recording any extra panes. Missing owners are checked separately. */
function reconcileMergedTabs(journal: SpaceJournal, snapshot: LayoutSnapshot, excluded: ReadonlySet<string> = new Set()): boolean {
  let changed = false;
  for (const space of journal.spaces) {
    const entries = journal.tabs.filter(t => t.placement.space === space.id && !t.manuallyMoved);
    if (!entries.length) continue;
    const actual = snapshot.spaces.find(s => s.id === space.id);
    const expected = new Set(entries.map(t => t.placement.terminal));
    if (actual?.tabs.length !== 1) continue;
    const tab = actual.tabs[0], inTab = tabTerminals(tab).filter(row => expected.has(row.terminal));
    if (!inTab.length || entries.some(entry => entry.label === tab.name)) continue;
    for (const terminal of expected) {
      const all = snapshot.spaces.flatMap(s => s.tabs).flatMap(tabTerminals).filter(row => row.terminal === terminal);
      if (all.length > 1) throw new HerdrError('tab-owner-conflict', 'A session terminal appears in several panes');
      if (all.length && !inTab.some(row => row.terminal === terminal)) throw new HerdrError('tab-owner-conflict', 'A session terminal moved to another tab');
    }
    for (const entry of entries) if (!excluded.has(entry.target.sessionId) && (entry.placement.tab !== tab.id || entry.tabName !== tab.name)) { entry.placement = { ...entry.placement, tab: tab.id }; entry.tabName = tab.name; changed = true; }
  }
  return changed;
}
async function reconcileRenamedSpaces(config: HerdrConfig, journal: SpaceJournal, snapshot: LayoutSnapshot): Promise<boolean> {
  let changed = false;
  for (const [spaceOrder, desired] of config.spaces.entries()) {
    if (journal.spaces.some(space => space.name === desired.name)) continue;
    const candidates: { recorded: SpaceJournal['spaces'][number]; ordered: JournalTab[] }[] = [];
    for (const recorded of journal.spaces) {
      if (config.spaces.some(space => space.name === recorded.name) || !snapshot.spaces.some(space => space.id === recorded.id)) continue;
      const entries = journal.tabs.filter(entry => entry.target.spaceName === recorded.name);
      if (entries.length !== desired.sessions.length || !entries.length) continue;
      const ordered: JournalTab[] = [];
      for (const selector of desired.sessions) {
        const file = 'file' in selector ? await canonicalSessionFile(selector.file) : null;
        const matching = entries.filter(entry => file !== null ? entry.target.file === file : 'name' in selector && entry.target.name === selector.name && (!selector.sessionId || entry.target.sessionId === selector.sessionId));
        if (matching.length !== 1 || ordered.includes(matching[0])) break;
        ordered.push(matching[0]);
      }
      if (ordered.length === entries.length) candidates.push({ recorded, ordered });
    }
    if (candidates.length !== 1) continue;
    const { recorded, ordered } = candidates[0], oldName = recorded.name; recorded.name = desired.name;
    for (const [sessionOrder, entry] of ordered.entries()) Object.assign(entry.target, { spaceName: desired.name, spaceOrder, sessionOrder });
    for (const intent of journal.intents ?? []) if (intent.target.spaceName === oldName) intent.target.spaceName = desired.name;
    changed = true;
  }
  return changed;
}
type LiveOwnershipPorts = Pick<SpaceSetupPorts, 'processInventory' | 'terminalState' | 'liveSessionFeed'>;
async function reconcileLiveOwners(journal: SpaceJournal, snapshot: LayoutSnapshot, ports?: LiveOwnershipPorts): Promise<{ confirmed: Map<string, LaunchedSession>; conflicts: NonNullable<SpaceSetupResult['conflicts']>; changed: boolean }> {
  const confirmed = new Map<string, LaunchedSession>(), conflicts: NonNullable<SpaceSetupResult['conflicts']> = [];
  let changed = false;
  if (!ports?.liveSessionFeed || !ports.terminalState) return { confirmed, conflicts, changed };
  const records = await ports.processInventory.presence.list();
  for (const entry of journal.tabs) {
    const live: PresenceRecord[] = [];
    for (const record of records.filter(record => record.kind === 'top-level' && record.sessionId === entry.target.sessionId && record.hcAddress)) {
      const process = await ports.processInventory.probe(record.pid);
      if (process.kind !== 'live' || process.startIdentity !== record.startIdentity) continue;
      if (await ports.terminalState({ ...entry.placement, terminal: record.hcAddress! }) !== 'live') continue;
      if (!live.some(other => other.hcAddress === record.hcAddress)) live.push(record);
    }
    if (live.length > 1) { conflicts.push({ sessionId: entry.target.sessionId, terminals: live.map(record => record.hcAddress!) }); continue; }
    if (!live.length) continue;
    const record = live[0], feed = await ports.liveSessionFeed(entry.target);
    if (!feed || feed.sessionId !== entry.target.sessionId || feed.owner.sessionId !== entry.target.sessionId || !feed.owner.sessionFile || !isAbsolute(feed.owner.sessionFile) || !isAbsolute(feed.owner.cwd) || feed.owner.terminal.address !== record.hcAddress || record.sessionFile !== feed.owner.sessionFile) continue;
    const found = snapshot.spaces.flatMap(space => space.tabs.filter(tab => tabTerminals(tab).some(row => row.terminal === record.hcAddress)).map(tab => ({ space, tab })));
    if (found.length > 1) throw new HerdrError('tab-owner-conflict', 'A session terminal appears in several panes');
    const placement = found[0] ? { space: found[0].space.id, tab: found[0].tab.id, terminal: record.hcAddress! } : { ...entry.placement, terminal: record.hcAddress! };
    const result = { pid: record.pid, startIdentity: record.startIdentity, sessionId: entry.target.sessionId, sessionFile: feed.owner.sessionFile, cwd: feed.owner.cwd };
    confirmed.set(entry.target.sessionId, result);
    if (entry.placement.terminal !== placement.terminal || entry.placement.space !== placement.space || entry.placement.tab !== placement.tab || entry.result?.pid !== result.pid || entry.result.startIdentity !== result.startIdentity || entry.result.sessionFile !== result.sessionFile || entry.result.cwd !== result.cwd) {
      entry.placement = placement; entry.result = result; entry.failure = null; delete entry.pane;
      if (found[0]) { entry.tabName = found[0].tab.name; if (found[0].space.id !== journal.spaces.find(space => space.name === entry.target.spaceName)?.id) entry.manuallyMoved = true; }
      changed = true;
    }
  }
  return { confirmed, conflicts, changed };
}
function adoptionNames(config: HerdrConfig, options: SpaceSetupOptions): ReadonlySet<string> {
  const requested = options.adoptExistingSpaces ?? [];
  if (!Array.isArray(requested) || requested.some(name => typeof name !== 'string' || !config.spaces.some(s => s.name === name))) throw new HerdrError('invalid-setup-options', 'Every --adopt-existing-space name must be a configured space');
  return new Set(requested);
}
async function readJournal(path: string): Promise<SpaceJournal> {
  const saved = await readPrivateJson(path); return saved === null ? { version: 1, spaces: [], tabs: [], intents: [], retired: [], focused: false } : validateJournal(saved);
}
/** Record an observed move without taking ownership of the destination tab. */
export async function recordSessionMove(journalRoot: string, owner: { sessionId: string; terminal: TerminalAddress }, observed: LayoutSnapshot | (() => Promise<LayoutSnapshot>)): Promise<boolean> {
  return withProcessLock(journalRoot, 'setup', async () => {
    const path = join(journalRoot, 'spaces.json'), journal = await readJournal(path);
    const entry = journal.tabs.find(t => t.target.sessionId === owner.sessionId && t.placement.terminal === owner.terminal);
    if (!entry) return false;
    const snapshot = typeof observed === 'function' ? await observed() : observed;
    const matches = snapshot.spaces.flatMap(space => space.tabs.flatMap(tab => tabTerminals(tab).filter(row => row.terminal === owner.terminal).map(row => ({ space, tab, row }))));
    if (matches.length !== 1 || matches[0].row.ownerSessionId && matches[0].row.ownerSessionId !== owner.sessionId) throw new HerdrError('tab-owner-conflict', 'Moved session has no unique observed pane');
    const { space, tab } = matches[0];
    if (entry.manuallyMoved && entry.placement.space === space.id && entry.placement.tab === tab.id && entry.tabName === tab.name) return true;
    entry.placement = { space: space.id, tab: tab.id, terminal: owner.terminal };
    entry.tabName = tab.name; entry.manuallyMoved = true; delete entry.pane;
    await saveJournal(path, journal);
    return true;
  });
}

/** Read-only ownership evidence for installer reconciliation and tab-only rollback. */
export async function readCutoverRecovery(journalRoot: string, snapshot?: LayoutSnapshot, config?: HerdrConfig, ports?: LiveOwnershipPorts): Promise<{ layoutAdoptionNeeded?: boolean; conflicts?: NonNullable<SpaceSetupResult['conflicts']>; createdTabs: SessionTab[]; entries: { target: ResolvedSession; placement: SessionTab; result: LaunchedSession | null; label?: string; tabName?: string; manuallyMoved?: boolean; confirmedLive?: boolean }[]; pendingIntents?: TabIntent[]; recoveredCutover: SpaceSetupResult | null }> {
  const journal = await readJournal(join(journalRoot, 'spaces.json'));
  let layoutAdoptionNeeded = false; let confirmed = new Map<string, LaunchedSession>(); let conflicts: NonNullable<SpaceSetupResult['conflicts']> = [];
  if (snapshot) {
    const renamed = config ? await reconcileRenamedSpaces(config, journal, snapshot) : false;
    const live = await reconcileLiveOwners(journal, snapshot, ports); confirmed = live.confirmed; conflicts = live.conflicts;
    const recovered = reconcileIntents(journal, snapshot), moved = reconcileMoves(journal, snapshot), merged = reconcileMergedTabs(journal, snapshot, new Set(live.conflicts.map(conflict => conflict.sessionId)));
    const missing = journal.tabs.some(entry => !entry.manuallyMoved && !snapshot.spaces.find(space => space.id === entry.placement.space)?.tabs.find(tab => tab.id === entry.placement.tab && tabTerminals(tab).some(row => row.terminal === entry.placement.terminal)));
    layoutAdoptionNeeded = renamed || live.changed || live.conflicts.length > 0 || recovered || moved || merged || missing || journal.tabs.some(entry => Boolean(entry.pane));
  }
  const entries = journal.tabs.map(({ target, placement, result, label, tabName, manuallyMoved }) => ({ target, placement, result, ...(label ? { label } : {}), ...(tabName ? { tabName } : {}), ...(manuallyMoved ? { manuallyMoved } : {}), ...(confirmed.has(target.sessionId) ? { confirmedLive: true } : {}) }));
  const createdTabs = entries.map(entry => entry.placement);
  return { ...(layoutAdoptionNeeded ? { layoutAdoptionNeeded: true } : {}), ...(conflicts.length ? { conflicts } : {}), createdTabs, entries, ...(journal.intents?.length ? { pendingIntents: journal.intents } : {}), recoveredCutover: entries.length && entries.every(entry => entry.result !== null) ? { launched: entries.map(entry => entry.result!), tabs: createdTabs } : null };
}
/** Recover a lost app reply from the unique allocation label, before considering space collisions. */
function reconcileIntents(journal: SpaceJournal, snapshot: LayoutSnapshot): boolean {
  const spaces = journal.spaces.filter(recorded => snapshot.spaces.some(space => space.id === recorded.id || space.name === recorded.name));
  let changed = spaces.length !== journal.spaces.length;
  // Retain the tab's terminal/process evidence even when its surrounding space is gone.
  journal.spaces = spaces;
  for (const intent of [...(journal.intents ?? [])]) {
    const matches = snapshot.spaces.flatMap(space => space.tabs.filter(tab => tab.name === intent.label).map(tab => ({ space, tab })));
    if (matches.length > 1) throw new HerdrError('tab-owner-conflict', 'Allocation label is not unique');
    if (!matches.length) continue;
    const { space, tab } = matches[0];
    if (space.name !== intent.target.spaceName || intent.space !== null && space.id !== intent.space || !tab.terminal || tab.ownerSessionId !== null && tab.ownerSessionId !== intent.target.sessionId) throw new HerdrError('tab-owner-conflict', 'Allocation label has a different owner');
    const placement = { space: space.id, tab: tab.id, terminal: tab.terminal };
    if (!journal.spaces.some(s => s.id === space.id)) journal.spaces.push({ name: space.name, id: space.id, adopted: false });
    journal.tabs.push({ target: intent.target, placement, result: null, label: intent.label, ...(intent.pane ? { pane: intent.pane } : {}), ...(intent.tabName ? { tabName: intent.tabName } : {}), failure: intent.retired.includes(tab.terminal) ? 'terminal-not-fresh' : null });
    journal.intents = journal.intents!.filter(i => i !== intent); changed = true;
  }
  return changed;
}
/** Called only after the owning rollback has closed the tabs and re-read the layout. */
export async function forgetCutoverTabs(journalRoot: string, placements: readonly SessionTab[], snapshot: LayoutSnapshot): Promise<void> {
  await withProcessLock(journalRoot, 'setup', async () => {
    const path = join(journalRoot, 'spaces.json'), journal = await readJournal(path);
    reconcileIntents(journal, snapshot);
    for (const placement of placements) {
      const entry = journal.tabs.find(t => t.placement.terminal === placement.terminal);
      const present = entry?.manuallyMoved
        ? snapshot.spaces.some(space => space.tabs.some(tab => tabTerminals(tab).some(row => row.terminal === placement.terminal)))
        : snapshot.spaces.some(space => space.tabs.some(tab => tab.id === placement.tab));
      if (present) throw new HerdrError('cutover-tab-still-exists', 'A rollback terminal or tab is still present');
    }
    journal.tabs = journal.tabs.filter(entry => !placements.some(p => p.space === entry.placement.space && p.terminal === entry.placement.terminal));
    journal.retired = [...(journal.retired ?? []), ...placements];
    journal.intents = []; journal.focused = false;
    // Keep an existing empty space under its recorded ownership; forget only spaces that have disappeared.
    journal.spaces = journal.spaces.filter(space => snapshot.spaces.some(s => s.id === space.id));
    await saveJournal(path, journal);
  });
}
function checkExistingSpaces(config: HerdrConfig, journal: SpaceJournal, snapshot: LayoutSnapshot, adopt: ReadonlySet<string>): SpaceJournal['spaces'] {
  const conflicts: LayoutSnapshot['spaces'] = []; const additions: SpaceJournal['spaces'] = [];
  for (const desired of config.spaces) {
    const recorded = journal.spaces.find(s => s.name === desired.name);
    const matches = recorded ? snapshot.spaces.filter(s => s.id === recorded.id) : snapshot.spaces.filter(s => s.name === desired.name);
    if (recorded && matches.length !== 1) throw new HerdrError('space-owner-conflict', 'Journalled space was replaced');
    if (adopt.has(desired.name) && matches.length === 0) throw new HerdrError('space-adoption-missing', `No existing space matches ${JSON.stringify(desired.name)}`);
    if (!recorded && matches.length && (!adopt.has(desired.name) || matches.length !== 1)) { conflicts.push(...matches); continue; }
    if (adopt.has(desired.name) && !recorded) additions.push({ name: desired.name, id: matches[0].id, adopted: true });
  }
  if (conflicts.length) throw new HerdrError('space-name-conflict', `Unowned same-name spaces conflict: ${JSON.stringify(conflicts)}. Opt in with --adopt-existing-space <name> to only add new tabs; duplicate space names must first be resolved by hand.`, { conflicts });
  return additions;
}
async function preflightState(config: HerdrConfig, ports: Pick<SpaceSetupPorts, 'journalRoot' | 'layoutSnapshot'>, adopt: ReadonlySet<string>): Promise<void> {
  const journal = await readJournal(join(ports.journalRoot, 'spaces.json')), snapshot = await ports.layoutSnapshot();
  await reconcileRenamedSpaces(config, journal, snapshot);
  reconcileIntents(journal, snapshot); checkExistingSpaces(config, journal, snapshot, adopt);
}
/** Read-only: call before the installer writes backups, configuration, assets, or lock files. */
export async function preflightSpaces(config: HerdrConfig, ports: Pick<SpaceSetupPorts, 'journalRoot' | 'layoutSnapshot'>, options: SpaceSetupOptions = {}): Promise<void> {
  await preflightState(config, ports, adoptionNames(config, options));
}
export async function setupSpaces(config: HerdrConfig, ports: SpaceSetupPorts, options: SpaceSetupOptions = {}): Promise<SpaceSetupResult> {
  const adopt = adoptionNames(config, options); await preflightState(config, ports, adopt);
  return withProcessLock(ports.journalRoot, 'setup', async () => {
    const path = join(ports.journalRoot, 'spaces.json');
    const journal = await readJournal(path);
    const save = () => saveJournal(path, journal);
    const initialSnapshot = await ports.layoutSnapshot();
    const previousNames = new Map(journal.spaces.map(space => [space.id, space.name]));
    const renamed = await reconcileRenamedSpaces(config, journal, initialSnapshot);
    const { confirmed, conflicts, changed: ownersChanged } = await reconcileLiveOwners(journal, initialSnapshot, ports);
    const replacementAnchors = new Map<string, { space: SpaceId; tab: TabId; terminal: TerminalAddress; name: string }>();
    for (const conflict of conflicts) ports.reportBlocked(duplicateSessionNotice(conflict.sessionId, conflict.terminals));
    await reportMergedLayout(journal, initialSnapshot, ports, previousNames);
    const excluded = new Set(conflicts.map(conflict => conflict.sessionId));
    const recoveredIntents = reconcileIntents(journal, initialSnapshot), moved = reconcileMoves(journal, initialSnapshot), merged = reconcileMergedTabs(journal, initialSnapshot, excluded);
    if (renamed || ownersChanged || recoveredIntents || moved || merged) await save();
    async function preflight(recordAdoption: boolean): Promise<void> {
      const additions = checkExistingSpaces(config, journal, await ports.layoutSnapshot(), adopt);
      if (recordAdoption) {
        let changed = additions.length > 0; journal.spaces.push(...additions);
        for (const space of journal.spaces) if (adopt.has(space.name) && !space.adopted) { space.adopted = true; changed = true; }
        if (changed) await save();
      }
    }
    await preflight(false);
    async function finishMove(entry: JournalTab): Promise<void> {
      const move = entry.pane; if (!move) return;
      const anchor = await ports.app.ownerPlacement(move.anchor);
      if (anchor.tab !== move.tab || anchor.space !== entry.placement.space) throw new HerdrError('tab-owner-conflict', 'Pane destination moved');
      const current = async () => ports.app.ownerPlacement(entry.placement.terminal).catch(error => { if (error instanceof HerdrError && error.code === 'owner-unplaced') return null; throw error; });
      let placement = await current();
      if (placement && (placement.space !== entry.placement.space || placement.tab !== entry.placement.tab && placement.tab !== move.tab)) throw new HerdrError('tab-owner-conflict', 'Allocated terminal moved to an unrelated tab');
      const command = async (name: string, args: Record<string, unknown>) => { const reply = await ports.app.command(name, args); if (reply.error) throw new HerdrError(reply.error.code, reply.error.message); };
      if (placement?.tab !== move.tab) {
        const deadline = ports.clock() + 30_000, signal = options.signal ?? new AbortController().signal;
        if (placement) {
          await command('terminal.park', { terminal: entry.placement.terminal });
          while ((placement = await current()) !== null) {
            if (signal.aborted) throw new HerdrError('aborted', 'Cutover aborted');
            if (ports.clock() >= deadline) throw new HerdrError('pane-placement-timeout', 'App did not park the new terminal');
            await ports.waitForChange(deadline, signal);
          }
        }
        for (;;) {
          if (signal.aborted) throw new HerdrError('aborted', 'Cutover aborted');
          const liveAnchor = await ports.app.ownerPlacement(move.anchor);
          if (liveAnchor.tab !== move.tab || liveAnchor.space !== anchor.space) throw new HerdrError('tab-owner-conflict', 'Pane destination moved');
          await command('pane.focus', { terminal: move.anchor });
          const reply = await ports.app.command('terminal.keep', { terminal: entry.placement.terminal, place: move.direction });
          if (!reply.error) break;
          if (reply.error.code !== 'app-error' || !/^no running terminal\b/i.test(reply.error.message)) throw new HerdrError(reply.error.code, reply.error.message);
          const state = await ports.terminalState?.(entry.placement);
          if (state === 'finished' || state === 'absent') throw new HerdrError('owner-terminal-finished', 'The parked session terminal is no longer running');
          if (ports.clock() >= deadline) throw new HerdrError('pane-placement-timeout', 'App did not recognize the parked session terminal');
          await ports.waitForChange(deadline, signal);
        }
        await ports.app.awaitPane(entry.placement.terminal, anchor, { signal: options.signal, timeoutMs: Math.max(1, deadline - ports.clock()) });
      }
      entry.placement.tab = move.tab; delete entry.pane; entry.failure = null; await save();
    }
    async function checkRecorded(entry: JournalTab): Promise<LaunchedSession | null> {
      const snapshot = await ports.layoutSnapshot(); const space = snapshot.spaces.find(s => s.id === entry.placement.space); const tab = space?.tabs.find(t => t.id === entry.placement.tab);
      const row = tab && tabTerminals(tab).find(t => t.terminal === entry.placement.terminal);
      if (tab && (!space || !entry.manuallyMoved && tab.name !== (entry.tabName ?? entry.target.name ?? entry.target.sessionId) && tab.name !== entry.label || row?.ownerSessionId && row.ownerSessionId !== entry.target.sessionId)) throw new HerdrError('tab-owner-conflict', 'Journalled tab no longer has its recorded owner identity');
      if (tab && !row && !entry.pane && snapshot.spaces.some(s => s.tabs.some(t => tabTerminals(t).some(r => r.terminal === entry.placement.terminal)))) throw new HerdrError('tab-owner-conflict', 'A session terminal moved to another tab');
      try {
        if (!tab && !entry.pane || tab && !row && !entry.pane && await ports.terminalState?.(entry.placement) !== 'live' || entry.failure === 'terminal-not-fresh') throw new HerdrError('owner-activation-unconfirmed', 'Recorded terminal must be retired');
        let current = confirmed.get(entry.target.sessionId);
        if (current) {
          const process = await ports.processInventory.probe(current.pid), feed = await ports.liveSessionFeed!(entry.target);
          const records = await ports.processInventory.presence.list();
          const present = records.some(record => record.kind === 'top-level' && record.pid === current!.pid && record.startIdentity === current!.startIdentity && record.sessionId === current!.sessionId && record.sessionFile === current!.sessionFile && record.hcAddress === entry.placement.terminal);
          if (process.kind !== 'live' || process.startIdentity !== current.startIdentity || await ports.terminalState!(entry.placement) !== 'live' || !present || !feed || feed.sessionId !== current.sessionId || feed.owner.terminal.address !== entry.placement.terminal || feed.owner.sessionFile !== current.sessionFile || feed.owner.cwd !== current.cwd) { confirmed.delete(entry.target.sessionId); current = undefined; }
        }
        const result = current ?? await ports.verifyOwner(entry.target, entry.placement, options.signal);
        if (result.sessionId !== entry.target.sessionId || !current && (result.sessionFile !== entry.target.file || result.cwd !== entry.target.cwd)) throw new HerdrError('session-owner-mismatch', 'New tab did not publish the exact session ID, file and cwd');
        if (!entry.result || entry.result.pid !== result.pid || entry.result.startIdentity !== result.startIdentity) { entry.result = result; entry.failure = null; await save(); }
        if (tab && !row && !entry.pane && !entry.manuallyMoved) {
          const anchor = journal.tabs.find(other => other !== entry && other.placement.space === entry.placement.space && other.placement.tab === tab.id && tabTerminals(tab).some(value => value.terminal === other.placement.terminal));
          if (!anchor) throw new HerdrError('tab-owner-conflict', 'The space tab has no session pane to anchor the parked session');
          entry.pane = { tab: tab.id, anchor: anchor.placement.terminal, direction: 'down' }; await save();
        }
        if (entry.pane) await finishMove(entry);
        else if (!entry.manuallyMoved && tab && tab.name === entry.label) { const reply = await ports.app.command('tab.rename', { id: tab.id, name: entry.tabName ?? entry.target.name ?? entry.target.sessionId }); if (reply.error) throw new HerdrError(reply.error.code, reply.error.message); }
        return result;
      } catch (error) {
        if (options.signal?.aborted) throw new HerdrError('aborted', 'Cutover aborted');
        const state = await ports.terminalState?.(entry.placement) ?? 'live';
        const inventory = selectedProcessInventory(config, ports.processInventory, [{ file: entry.target.file, sessionId: entry.target.sessionId }]);
        const live = await assessSessionLiveness(entry.target.file, inventory), sameId = await recordedSessionLiveness(entry.target.file, inventory, entry.target.sessionId);
        const process = entry.result ? await ports.processInventory.probe(entry.result.pid) : null;
        if (error instanceof HerdrError && error.code === 'owner-session-switched' && live.kind === 'free' && sameId.kind === 'free' && tab && row && !entry.manuallyMoved) {
          replacementAnchors.set(entry.target.file, { space: entry.placement.space, tab: tab.id, terminal: entry.placement.terminal, name: tab.name });
          const desired = config.spaces[entry.target.spaceOrder];
          if ((desired.layout ?? config.layout ?? 'panes') === 'panes' && !journal.intents!.some(intent => intent.target.file === entry.target.file)) {
            const currentCore = await ports.coreIdentity(), mappings = await ports.registry.list();
            const retired = mappings.filter(mapping => mapping.owner.terminal.coreId === currentCore.coreId && mapping.owner.terminal.socket === currentCore.socket && mapping.owner.terminal.sessionNamespace === currentCore.sessionNamespace).map(mapping => mapping.owner.terminal.address);
            journal.intents!.push({ target: entry.target, space: entry.placement.space, tabName: tab.name, label: `${entry.target.name ?? entry.target.sessionId} [spider:${randomBytes(16).toString('hex')}]`, retired: [...new Set([...retired, ...(journal.retired ?? []).map(placement => placement.terminal), entry.placement.terminal])], pane: { tab: tab.id, anchor: entry.placement.terminal, direction: 'down' } });
          }
          ports.reportLayout?.(foreignPanesNotice(space!.name, tab.name, [entry.placement.terminal]));
          journal.retired!.push(entry.placement); journal.tabs = journal.tabs.filter(t => t !== entry); await save(); return null;
        }
        if (state !== 'live' && live.kind === 'free' && sameId.kind === 'free' && (!process || process.kind === 'absent' || process.kind === 'live' && process.startIdentity !== entry.result!.startIdentity)) {
          if (tab && row && !entry.manuallyMoved) { const shared = tabTerminals(tab).length > 1; const reply = await ports.app.command(shared ? 'pane.close' : 'tab.close', shared ? { pane: (await ports.app.ownerPlacement(entry.placement.terminal)).pane } : { id: entry.placement.tab }); if (reply.error) throw new HerdrError(reply.error.code, reply.error.message); }
          journal.retired!.push(entry.placement); journal.tabs = journal.tabs.filter(t => t !== entry); journal.focused = false; await save(); return null;
        }
        if (entry.result !== null) throw error; return null;
      }
    }
    const manifest = await discoverSessions(config, ports);
    const cutover = await startCutover(manifest, {
      ...ports, signal: options.signal, excludeFiles: new Set(journal.tabs.filter(entry => excluded.has(entry.target.sessionId)).map(entry => entry.target.file)),
      beforeLaunch: () => preflight(true),
      async alreadyLaunched(target) {
        const entry = journal.tabs.find(t => t.target.file === target.file); if (!entry) return null;
        if (entry.target.spaceName !== target.spaceName || entry.target.spaceOrder !== target.spaceOrder || entry.target.sessionOrder !== target.sessionOrder || target.sessionId !== null && entry.target.sessionId !== target.sessionId || target.cwd !== null && entry.target.cwd !== target.cwd) throw new HerdrError('tab-owner-conflict', 'Session selection changed since tab allocation');
        return checkRecorded(entry);
      },
      async launchLeasedSession(target) {
        let entry = journal.tabs.find(t => t.target.file === target.file);
        if (entry && (entry.target.sessionId !== target.sessionId || entry.target.spaceName !== target.spaceName || entry.target.cwd !== target.cwd)) throw new HerdrError('tab-owner-conflict', 'Session selection changed since tab allocation');
        if (!entry) {
          const desiredSpace = config.spaces[target.spaceOrder];
          const previousInSpace = journal.tabs.filter(t => t.target.spaceName === target.spaceName);
          const hint = replacementAnchors.get(target.file);
          const paneMode = (desiredSpace.layout ?? config.layout ?? 'panes') === 'panes'
            && previousInSpace.every(t => t.tabName === target.spaceName || t.tabName !== (t.target.name ?? t.target.sessionId) && t.placement.tab === previousInSpace[0].placement.tab);
          const tabName = paneMode ? previousInSpace[0]?.tabName ?? hint?.name ?? target.spaceName : target.name ?? target.sessionId;
          const snapshot = await ports.layoutSnapshot(); const recordedSpace = journal.spaces.find(s => s.name === target.spaceName);
          if (!recordedSpace && snapshot.spaces.some(s => s.name === target.spaceName)) throw new HerdrError('space-name-conflict', 'An unrelated space already has the configured name');
          const previous = await ports.registry.list(); const currentCore = await ports.coreIdentity();
          const latest = previous.filter(m => m.owner.sessionFile === target.file).sort((a, b) => b.recordedAt - a.recordedAt)[0];
          refuseExplicitExtensions(target.name ?? target.sessionId, latest?.environment.extensionArguments ?? []);
          const retired = new Set(previous.filter(m => m.owner.terminal.coreId === currentCore.coreId && m.owner.terminal.socket === currentCore.socket && m.owner.terminal.sessionNamespace === currentCore.sessionNamespace).map(m => m.owner.terminal.address));
          for (const placement of journal.retired ?? []) retired.add(placement.terminal);
          let intent = journal.intents!.find(i => i.target.file === target.file);
          if (!intent) {
            intent = { target, tabName, label: `${target.name ?? target.sessionId} [spider:${randomBytes(16).toString('hex')}]`, space: recordedSpace?.id ?? null, retired: [...retired] };
            if (paneMode && (previousInSpace.length || hint)) {
              const step = panePlan(desiredSpace.sessions.length)[Math.max(0, target.sessionOrder - 1)];
              const placed = previousInSpace.filter(t => snapshot.spaces.find(s => s.id === t.placement.space)?.tabs.some(tab => tab.id === t.placement.tab && tabTerminals(tab).some(row => row.terminal === t.placement.terminal)));
              const anchor = placed.find(t => t.target.sessionOrder === step?.anchor) ?? placed[0];
              const destination = anchor ? { space: anchor.placement.space, tab: anchor.placement.tab, terminal: anchor.placement.terminal } : hint;
              const tab = destination && snapshot.spaces.find(s => s.id === destination.space)?.tabs.find(t => t.id === destination.tab && tabTerminals(t).some(row => row.terminal === destination.terminal));
              if (!destination || !tab || tab.name !== tabName) throw new HerdrError('tab-owner-conflict', 'Pane destination is not the recorded space tab');
              intent.pane = { tab: tab.id, anchor: destination.terminal, direction: step?.direction ?? 'down' };
            }
            journal.intents!.push(intent); await save();
          }
          let placement: SessionTab;
          const argv = leasedLauncherArgv(target, ports.launcher, config.agentDirectory);
          if (!recordedSpace) {
            const reply = await ports.app.command('space.new', { name: target.spaceName, folder: target.cwd, tab: intent.label, argv });
            if (reply.error) throw new HerdrError(reply.error.code, reply.error.message);
            if (!reply.space || !reply.tab || !reply.terminal) throw new HerdrError('space-allocation-unconfirmed', 'App did not return space, tab and terminal IDs');
            placement = { space: reply.space, tab: reply.tab, terminal: reply.terminal }; journal.spaces.push({ name: target.spaceName, id: reply.space, adopted: false });
          } else {
            const space = snapshot.spaces.find(s => s.id === recordedSpace.id);
            if (!space) throw new HerdrError('space-owner-conflict', 'Journalled space was replaced');
            if (!intent.pane && !recordedSpace.adopted && space.tabs.some(t => t.name === (target.name ?? target.sessionId))) throw new HerdrError('tab-name-conflict', 'An unrelated tab already has the selected name');
            placement = await allocateTab(ports.app, recordedSpace.id, intent.label, target.cwd, argv);
          }
          entry = { target, placement, result: null, failure: retired.has(placement.terminal) ? 'terminal-not-fresh' : null, label: intent.label, tabName: intent.tabName ?? tabName, ...(intent.pane ? { pane: intent.pane } : {}) };
          journal.tabs.push(entry); journal.intents = journal.intents!.filter(i => i !== intent); await save();
          if (entry.failure) throw new HerdrError('terminal-not-fresh', 'Cutover must use a fresh terminal; a retired address can still have a cached note task');
        }
        try {
          const result = await ports.verifyOwner(target, entry.placement, options.signal);
          if (result.sessionId !== target.sessionId || result.sessionFile !== target.file || result.cwd !== target.cwd) throw new HerdrError('session-owner-mismatch', 'New tab did not publish the exact session ID, file and cwd');
          entry.result = result; entry.failure = null; await save();
          if (entry.pane) await finishMove(entry);
          const snapshot = await ports.layoutSnapshot(); const tab = snapshot.spaces.flatMap(s => s.tabs).find(t => t.id === entry!.placement.tab);
          if (tab?.name !== entry.tabName) { const reply = await ports.app.command('tab.rename', { id: entry.placement.tab, name: entry.tabName ?? target.name ?? target.sessionId }); if (reply.error) throw new HerdrError(reply.error.code, reply.error.message); }
          return result;
        } catch (error) { entry.failure = error instanceof Error ? error.message.slice(0, 200) : 'Launch verification failed'; await save(); throw error; }
      },
    });
    // Focus only after all owners are verified, once. An unchanged retry performs no writes or focus changes.
    if (!journal.focused && journal.tabs.length) {
      const first = journal.tabs.reduce((a, b) => a.target.spaceOrder < b.target.spaceOrder ? a : b);
      const reply = await ports.app.command('space.select', { id: first.placement.space }); if (reply.error) throw new HerdrError(reply.error.code, reply.error.message);
      journal.focused = true; await save();
    }
    return { launched: cutover.launched, tabs: [...journal.tabs].sort((a, b) => a.target.spaceOrder - b.target.spaceOrder || a.target.sessionOrder - b.target.sessionOrder).map(t => t.placement), ...(conflicts.length ? { conflicts } : {}) };
  }, { timeoutMs: 1000 }).catch(error => {
    if (error instanceof HerdrError && error.code === 'lock-occupied') throw new HerdrError('setup-occupied', 'Another cutover owns the setup lock');
    throw error;
  });
}
