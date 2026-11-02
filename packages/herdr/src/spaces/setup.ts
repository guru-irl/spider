// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { randomBytes } from 'node:crypto';
import { assessSessionLiveness } from '../sessions/lease.js';
import { join, isAbsolute } from 'node:path';
import type { AppClient, CoreIdentity, HerdrConfig, SpaceId, TabId, TerminalAddress } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { readPrivateJson, writePrivateJson, withProcessLock, refuseExplicitExtensions } from '../sessions/registry.js';
import { discoverSessions, selectedProcessInventory, type SessionDiscoveryPorts, type ResolvedSession } from './discovery.js';
import { startCutover, type CutoverPorts, type LaunchedSession } from './cutover.js';
export interface LayoutSnapshot { spaces: { id: SpaceId; name: string; tabs: { id: TabId; name: string; ownerSessionId: string | null; terminal: TerminalAddress | null }[] }[] }
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
}
interface JournalTab { target: ResolvedSession; placement: SessionTab; result: LaunchedSession | null; failure: string | null; label?: string }
interface TabIntent { target: ResolvedSession; label: string; space: SpaceId | null; retired: TerminalAddress[] }
interface SpaceJournal { version: 1; spaces: { name: string; id: SpaceId; adopted: boolean }[]; tabs: JournalTab[]; intents?: TabIntent[]; retired?: SessionTab[]; focused: boolean }
export interface SpaceSetupOptions { signal?: AbortSignal; /** Repeatable CLI --adopt-existing-space names; authorizes append-only tabs, never adoption of a terminal. */ adoptExistingSpaces?: readonly string[] }
export interface SpaceSetupResult { launched: LaunchedSession[]; tabs: SessionTab[] }
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
function validateJournal(value: unknown): SpaceJournal {
  const j = value as SpaceJournal;
  if (!j || j.version !== 1 || !Array.isArray(j.spaces) || !Array.isArray(j.tabs) || typeof j.focused !== 'boolean' || j.spaces.some(s => typeof s.name !== 'string' || typeof s.id !== 'string' || typeof s.adopted !== 'boolean') || j.tabs.some(t => !t.target || !isAbsolute(t.target.file) || !isAbsolute(t.target.cwd) || typeof t.target.sessionId !== 'string' || !Array.isArray(t.target.extensionArguments) || t.target.extensionArguments.length !== 0 || !t.placement || typeof t.placement.space !== 'string' || typeof t.placement.tab !== 'string' || typeof t.placement.terminal !== 'string' || !(t.result === null || t.result.sessionId === t.target.sessionId && t.result.sessionFile === t.target.file && t.result.cwd === t.target.cwd))) throw new HerdrError('invalid-space-journal', 'Setup journal is invalid');
  if (j.intents !== undefined && (!Array.isArray(j.intents) || j.intents.some(i => !i.target || !isAbsolute(i.target.file) || !isAbsolute(i.target.cwd) || typeof i.target.sessionId !== 'string' || typeof i.label !== 'string' || !(i.space === null || typeof i.space === 'string') || !Array.isArray(i.retired)))) throw new HerdrError('invalid-space-journal', 'Invalid allocation intent');
  j.intents ??= []; j.retired ??= [];
  return j;
}
function adoptionNames(config: HerdrConfig, options: SpaceSetupOptions): ReadonlySet<string> {
  const requested = options.adoptExistingSpaces ?? [];
  if (!Array.isArray(requested) || requested.some(name => typeof name !== 'string' || !config.spaces.some(s => s.name === name))) throw new HerdrError('invalid-setup-options', 'Every --adopt-existing-space name must be a configured space');
  return new Set(requested);
}
async function readJournal(path: string): Promise<SpaceJournal> {
  const saved = await readPrivateJson(path); return saved === null ? { version: 1, spaces: [], tabs: [], intents: [], retired: [], focused: false } : validateJournal(saved);
}
/** Read-only ownership evidence for installer reconciliation and tab-only rollback. */
export async function readCutoverRecovery(journalRoot: string, snapshot?: LayoutSnapshot): Promise<{ createdTabs: SessionTab[]; entries: { target: ResolvedSession; placement: SessionTab; result: LaunchedSession | null; label?: string }[]; pendingIntents?: TabIntent[]; recoveredCutover: SpaceSetupResult | null }> {
  const journal = await readJournal(join(journalRoot, 'spaces.json'));
  if (snapshot) reconcileIntents(journal, snapshot);
  const entries = journal.tabs.map(({ target, placement, result, label }) => ({ target, placement, result, ...(label ? { label } : {}) }));
  const createdTabs = entries.map(entry => entry.placement);
  return { createdTabs, entries, ...(journal.intents?.length ? { pendingIntents: journal.intents } : {}), recoveredCutover: entries.length && entries.every(entry => entry.result !== null) ? { launched: entries.map(entry => entry.result!), tabs: createdTabs } : null };
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
    journal.tabs.push({ target: intent.target, placement, result: null, label: intent.label, failure: intent.retired.includes(tab.terminal) ? 'terminal-not-fresh' : null });
    journal.intents = journal.intents!.filter(i => i !== intent); changed = true;
  }
  return changed;
}
/** Called only after the owning rollback has closed the tabs and re-read the layout. */
export async function forgetCutoverTabs(journalRoot: string, placements: readonly SessionTab[], snapshot: LayoutSnapshot): Promise<void> {
  await withProcessLock(journalRoot, 'setup', async () => {
    const path = join(journalRoot, 'spaces.json'), journal = await readJournal(path);
    reconcileIntents(journal, snapshot);
    for (const placement of placements) if (snapshot.spaces.some(space => space.tabs.some(tab => tab.id === placement.tab))) throw new HerdrError('cutover-tab-still-exists', 'A rollback tab has not been closed');
    journal.tabs = journal.tabs.filter(entry => !placements.some(p => p.space === entry.placement.space && p.tab === entry.placement.tab && p.terminal === entry.placement.terminal));
    journal.retired = [...(journal.retired ?? []), ...placements];
    journal.intents = []; journal.focused = false;
    // Keep an existing empty space under its recorded ownership; forget only spaces that have disappeared.
    journal.spaces = journal.spaces.filter(space => snapshot.spaces.some(s => s.id === space.id && s.name === space.name));
    await writePrivateJson(path, journal);
  });
}
function checkExistingSpaces(config: HerdrConfig, journal: SpaceJournal, snapshot: LayoutSnapshot, adopt: ReadonlySet<string>): SpaceJournal['spaces'] {
  const conflicts: LayoutSnapshot['spaces'] = []; const additions: SpaceJournal['spaces'] = [];
  for (const desired of config.spaces) {
    const recorded = journal.spaces.find(s => s.name === desired.name);
    const matches = recorded ? snapshot.spaces.filter(s => s.id === recorded.id && s.name === recorded.name) : snapshot.spaces.filter(s => s.name === desired.name);
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
    const save = () => writePrivateJson(path, journal);
    if (reconcileIntents(journal, await ports.layoutSnapshot())) await save();
    async function preflight(recordAdoption: boolean): Promise<void> {
      const additions = checkExistingSpaces(config, journal, await ports.layoutSnapshot(), adopt);
      if (recordAdoption) {
        let changed = additions.length > 0; journal.spaces.push(...additions);
        for (const space of journal.spaces) if (adopt.has(space.name) && !space.adopted) { space.adopted = true; changed = true; }
        if (changed) await save();
      }
    }
    await preflight(false);
    async function checkRecorded(entry: JournalTab): Promise<LaunchedSession | null> {
      const snapshot = await ports.layoutSnapshot(); const space = snapshot.spaces.find(s => s.id === entry.placement.space); const tab = space?.tabs.find(t => t.id === entry.placement.tab);
      if (tab && (!space || space.name !== entry.target.spaceName || tab.name !== (entry.target.name ?? entry.target.sessionId) && tab.name !== entry.label || tab.terminal !== entry.placement.terminal || tab.ownerSessionId !== null && tab.ownerSessionId !== entry.target.sessionId)) throw new HerdrError('tab-owner-conflict', 'Journalled tab no longer has its recorded owner identity');
      try {
        if (!tab || entry.failure === 'terminal-not-fresh') throw new HerdrError('owner-activation-unconfirmed', 'Recorded terminal must be retired');
        const result = await ports.verifyOwner(entry.target, entry.placement, options.signal);
        if (result.sessionId !== entry.target.sessionId || result.sessionFile !== entry.target.file || result.cwd !== entry.target.cwd) throw new HerdrError('session-owner-mismatch', 'New tab did not publish the exact session ID, file and cwd');
        if (!entry.result || entry.result.pid !== result.pid || entry.result.startIdentity !== result.startIdentity) { entry.result = result; entry.failure = null; await save(); }
        if (tab.name === entry.label) { const reply = await ports.app.command('tab.rename', { id: tab.id, name: entry.target.name ?? entry.target.sessionId }); if (reply.error) throw new HerdrError(reply.error.code, reply.error.message); }
        return result;
      } catch (error) {
        if (options.signal?.aborted) throw new HerdrError('aborted', 'Cutover aborted');
        const state = await ports.terminalState?.(entry.placement) ?? 'live', live = await assessSessionLiveness(entry.target.file, selectedProcessInventory(config, ports.processInventory));
        const process = entry.result ? await ports.processInventory.probe(entry.result.pid) : null;
        if (state !== 'live' && live.kind === 'free' && (!process || process.kind === 'absent' || process.kind === 'live' && process.startIdentity !== entry.result!.startIdentity)) {
          if (tab) { const reply = await ports.app.command('tab.close', { id: entry.placement.tab }); if (reply.error) throw new HerdrError(reply.error.code, reply.error.message); }
          journal.retired!.push(entry.placement); journal.tabs = journal.tabs.filter(t => t !== entry); journal.focused = false; await save(); return null;
        }
        if (entry.result !== null) throw error; return null;
      }
    }
    const manifest = await discoverSessions(config, ports);
    const cutover = await startCutover(manifest, {
      ...ports, signal: options.signal,
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
          const snapshot = await ports.layoutSnapshot(); const recordedSpace = journal.spaces.find(s => s.name === target.spaceName);
          if (!recordedSpace && snapshot.spaces.some(s => s.name === target.spaceName)) throw new HerdrError('space-name-conflict', 'An unrelated space already has the configured name');
          const previous = await ports.registry.list(); const currentCore = await ports.coreIdentity();
          const latest = previous.filter(m => m.owner.sessionFile === target.file).sort((a, b) => b.recordedAt - a.recordedAt)[0];
          refuseExplicitExtensions(target.name ?? target.sessionId, latest?.environment.extensionArguments ?? []);
          const retired = new Set(previous.filter(m => m.owner.terminal.coreId === currentCore.coreId && m.owner.terminal.socket === currentCore.socket && m.owner.terminal.sessionNamespace === currentCore.sessionNamespace).map(m => m.owner.terminal.address));
          for (const placement of journal.retired ?? []) retired.add(placement.terminal);
          let intent = journal.intents!.find(i => i.target.file === target.file);
          if (!intent) {
            intent = { target, label: `${target.name ?? target.sessionId} [spider:${randomBytes(16).toString('hex')}]`, space: recordedSpace?.id ?? null, retired: [...retired] };
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
            if (!space || space.name !== target.spaceName) throw new HerdrError('space-owner-conflict', 'Journalled space was replaced');
            if (!recordedSpace.adopted && space.tabs.some(t => t.name === (target.name ?? target.sessionId))) throw new HerdrError('tab-name-conflict', 'An unrelated tab already has the selected name');
            placement = await allocateTab(ports.app, recordedSpace.id, intent.label, target.cwd, argv);
          }
          entry = { target, placement, result: null, failure: retired.has(placement.terminal) ? 'terminal-not-fresh' : null, label: intent.label };
          journal.tabs.push(entry); journal.intents = journal.intents!.filter(i => i !== intent); await save();
          if (entry.failure) throw new HerdrError('terminal-not-fresh', 'Cutover must use a fresh terminal; a retired address can still have a cached note task');
        }
        try {
          const result = await ports.verifyOwner(target, entry.placement, options.signal);
          if (result.sessionId !== target.sessionId || result.sessionFile !== target.file || result.cwd !== target.cwd) throw new HerdrError('session-owner-mismatch', 'New tab did not publish the exact session ID, file and cwd');
          entry.result = result; entry.failure = null; await save();
          const reply = await ports.app.command('tab.rename', { id: entry.placement.tab, name: target.name ?? target.sessionId }); if (reply.error) throw new HerdrError(reply.error.code, reply.error.message);
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
    return { launched: cutover.launched, tabs: journal.tabs.map(t => t.placement) };
  }, { timeoutMs: 1000 }).catch(error => {
    if (error instanceof HerdrError && error.code === 'lock-occupied') throw new HerdrError('setup-occupied', 'Another cutover owns the setup lock');
    throw error;
  });
}
