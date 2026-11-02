// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';
import { createSuite, type Suite } from '../harness/suite.js';
import { HarnessError } from '../harness/environment.js';
import { deadline, waitFor } from '../harness/wait.js';
import { runSetup, readInstalled } from '../harness/setup.js';
import { readObserved } from '../harness/pi.js';
import { identityAlive, identityOf } from '../harness/resources.js';
import { prepareInstallInputs, createNamedSession, startPlainSetup, readPresence, stopCreatedOwners, fingerprintInstallation, type NamedSession } from '../fixtures/install-inputs.js';

import type { readCutoverRecovery, SessionTab } from '../../src/spaces/setup.js';
type SavedSession = Awaited<ReturnType<typeof readCutoverRecovery>>['entries'][number];
type SavedGroup = Pick<SessionTab, 'space' | 'tab'> & { sessions: (Omit<SavedSession, 'placement'> & Pick<SessionTab, 'terminal'>)[] };
async function json(path: string) { return JSON.parse(await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; })); }
function sessionEntries(journal: { tabs?: (SavedSession | SavedGroup)[] }): SavedSession[] {
  return (journal.tabs ?? []).flatMap(tab => 'sessions' in tab ? tab.sessions.map(session => ({ ...session, placement: { space: tab.space, tab: tab.tab, terminal: session.terminal } })) : [tab]);
}
async function owners(suite: Suite, sessions: readonly NamedSession[]) {
  const present = await readPresence(suite);
  return present.filter(row => {
    if (row.kind !== 'top-level' || !sessions.some(s => s.sessionId === row.sessionId) || typeof row.pid !== 'number') return false;
    try { const identity = identityOf(row.pid); return identityAlive(identity); } catch { return false; }
  });
}
async function assertPlacement(suite: Suite, app: { ls(): Promise<unknown> }, groups: readonly { name: string; sessions: readonly NamedSession[] }[]) {
  const world = await app.ls() as { spaces: { name: string; tabs: { name: string; terminals: { terminal: string }[] }[] }[] };
  await suite.evidence('group-placement.json', world);
  assert.deepEqual(world.spaces.map(s => s.name), groups.map(g => g.name));
  const selected = groups.flatMap(group => group.sessions);
  const started = await waitFor('all cutover owners publish real pi session_start events', async () => { const value = { owners: await owners(suite, selected), events: await readObserved(suite.pi.observerDir) }; await suite.evidence('cutover-last-observation.json', value); return value; }, value => value.owners.length === selected.length && selected.every(session => { const owner = value.owners.find(owner => owner.sessionId === session.sessionId); return owner && value.events.some(event => event.type === 'session_start' && event.pid === owner.pid && event.sessionId === session.sessionId); }), deadline(15_000));
  await suite.evidence('cutover-owner-events.json', started);
  const addresses: string[] = [];
  for (const [index, group] of groups.entries()) {
    assert.deepEqual(world.spaces[index].tabs.map(t => t.name), [group.name]);
    const panes = world.spaces[index].tabs[0].terminals;
    assert.equal(panes.length, group.sessions.length);
    for (const session of group.sessions) {
      const owner = started.owners.find(owner => owner.sessionId === session.sessionId)!;
      const terminal = String(owner.hcAddress); addresses.push(terminal);
      assert.ok(panes.some(pane => pane.terminal === terminal), 'each selected owner must occupy the shared space tab');
      const event = started.events.find(event => event.type === 'session_start' && event.pid === owner.pid)!;
      assert.equal(event.cwd, session.cwd); assert.equal(event.mode, 'tui'); assert.equal(String(event.hcTerminal), terminal.split(':').at(-1));
      const feed = await json(join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr/sessions', session.sessionId, 'session.json'));
      assert.equal(feed.sessionId, session.sessionId); assert.equal(feed.owner.cwd, session.cwd); assert.equal(feed.owner.sessionFile, session.file); assert.equal(feed.owner.terminal.address, terminal);
      assert.ok((await readFile(session.file, 'utf8')).includes(`Original conversation ${session.marker}.`));
    }
  }
  assert.equal(new Set(addresses).size, addresses.length);
}
export const scenarios: readonly ScenarioDefinition[] = [
  { id: storyId('S08'), title: 'External four-group ordering cuts over thirteen real saved sessions', tiers: ['headless', 'app'],
    async run(original) {
      const install = async (raw: Suite, reversed: boolean) => {
        const { suite, config, app } = await prepareInstallInputs(raw);
        const shared = await suite.project('shared'); const groups: { name: string; sessions: NamedSession[] }[] = [];
        let serial = 0;
        for (const [group, count] of [4, 3, 3, 3].entries()) {
          const sessions: NamedSession[] = [];
          for (let i = 0; i < count; i++) {
            const marker = `group-${serial++}`;
            sessions.push(await createNamedSession(suite, `Session ${marker}`, serial <= 2 ? shared : await suite.project(marker), marker));
          }
          groups.push({ name: `Group ${group + 1}`, sessions });
        }
        const ordered = reversed ? [...groups].reverse().map(group => ({ ...group, sessions: [...group.sessions].reverse() })) : groups;
        config.spaces = ordered.map(group => ({ name: group.name, sessions: group.sessions.map(session => ({ name: session.name, sessionId: session.sessionId })) }));
        const selected = groups.flatMap(group => group.sessions);
        assert.equal((await owners(suite, selected)).length, 0, 'input sessions must be closed');
        const result = await runSetup(suite, config); await suite.evidence('cutover.json', result);
        if (result.exitCode !== 0) {
          const journal = await json(join(config.globalRoot, 'herdr/spaces/spaces.json'));
          for (const entry of sessionEntries(journal)) {
            const address = entry.placement.terminal;
            const state = await suite.hc(['get', address, '--json']);
            if ((state.json as { state?: string } | null)?.state === 'finished') {
              const screen = await suite.hc(['read', address, '--json', '--lines', '200']);
              await suite.evidence(`failed-${address}-terminal.json`, { state, screen });
            }
          }
        }
        assert.equal(result.exitCode, 0, result.stderr);
        await assertPlacement(suite, app, ordered);
        assert.equal((await owners(suite, selected)).length, 13);
        // The opposite order must fail the same placement assertion in each fresh installation.
        await assert.rejects(assertPlacement(suite, app, [...ordered].reverse()));
        return { suite, config, app, selected, configPath: result.configPath };
      };
      const first = await install(original, false);
      await stopCreatedOwners(first.suite, first.selected.map(session => session.sessionId));
      await waitFor('created owners have stopped before refusal control', () => owners(first.suite, first.selected), list => list.length === 0, deadline(15_000));
      first.config.spaces = [...first.config.spaces].reverse().map(group => ({ ...group, sessions: [...group.sessions].reverse() }));
      // Changing the caller-owned input is the stimulus, not an installer write.
      await writeFile(first.configPath, JSON.stringify(first.config, null, 2) + '\n', { mode: 0o600 });
      const bytes = async () => {
        const installed = await readInstalled(first.suite, first.configPath);
        return {
          managed: installed.files.map(({ path, sha256 }) => ({ path, sha256 })),
          runtimes: await Promise.all(installed.runtimes.map(async runtime => ({ ...runtime, sha256: createHash('sha256').update(await readFile(runtime.path)).digest('hex') }))),
          backups: (await fingerprintInstallation(first.suite, first.config)).filter(file => file.path.startsWith(join(first.config.globalRoot, 'herdr/setup/backups') + '/')).map(({ mtimeMs: _mtime, ...file }) => file),
        };
      };
      // The attempt journal is bookkeeping, not a managed installation target.
      const beforeFiles = await bytes(), beforePlacement = await first.app.ls();
      const refused = await runSetup(first.suite, first.configPath);
      const afterFiles = await bytes(), afterPlacement = await first.app.ls();
      await first.suite.evidence('changed-order-refusal.json', { refused, beforeFiles, afterFiles, beforePlacement, afterPlacement });
      assert.notEqual(refused.exitCode, 0); assert.match(refused.stderr, /^tab-owner-conflict:/);
      assert.deepEqual(afterFiles, beforeFiles, 'refused setup changed managed file bytes');
      const placement = (world: unknown) => {
        const stable = structuredClone(world) as { spaces: { tabs: { terminals: { status?: unknown }[] }[] }[] };
        // Late OSC status can settle after owner exit; it is not installed placement.
        for (const space of stable.spaces) for (const tab of space.tabs) for (const terminal of tab.terminals) delete terminal.status;
        return stable;
      };
      assert.deepEqual(placement(afterPlacement), placement(beforePlacement), 'refused setup changed terminal, tab or space identities');
      await original.close(); // No concurrent pi owners from the first installation affect the second.
      const second = await createSuite({ ...original.options, story: storyId('H-setup-order') });
      try {
        await install(second, true);
        await original.evidence('fresh-order-comparison.json', { firstRoot: original.root, secondRoot: second.root, secondEvidenceDirectory: second.evidenceDirectory });
      } finally {
        const proof = await second.close();
        await original.evidence('fresh-order-cleanup.json', proof);
        assert.ok(proof.clean, 'second fresh installation cleanup was not proved');
      }
    },
  },
  { id: storyId('S09'), title: 'Selected live and unknown real pi writers block a second owner', tiers: ['headless', 'app'],
    async run(original) {
      const { suite, config, app } = await prepareInstallInputs(original);
      const cwd = await suite.project('writers'); const selected = await createNamedSession(suite, 'Selected', cwd, 'selected');
      const other = await createNamedSession(suite, 'Unrelated writer', cwd, 'unrelated-writer');
      const unrelated = await suite.launchPi({ mode: 'rpc', cwd, args: ['--session', other.file] });
      const unrelatedStart = await unrelated.waitEvent('session_start', () => true, deadline(30_000));
      assert.equal(unrelatedStart.sessionId, other.sessionId);
      const unrelatedBytes = await readFile(other.file);
      const live = await suite.launchPi({ mode: 'rpc', cwd, args: ['--session', selected.file] }); await live.waitEvent('session_start', () => true, deadline(30_000));
      const unknownAgent = suite.ownPath(join(suite.root, 'unknown-agent')); await mkdir(unknownAgent, { recursive: true });
      const unknownSettings = join(unknownAgent, 'settings.json');
      const settings = { packages: [suite.pi.providerPath, suite.pi.observerPath], defaultProvider: 'e2e-fixture', defaultModel: 'scripted', defaultProjectTrust: 'never' };
      await writeFile(unknownSettings, JSON.stringify(settings), { mode: 0o600 });
      const unknown = await suite.launchPi({ mode: 'interactive', cwd, extraEnv: { PI_CODING_AGENT_DIR: unknownAgent } });
      await unknown.waitEvent('session_start', () => true, deadline(30_000));
      assert.equal((await readPresence(suite)).filter(p => p.pid === unknown.pid).length, 0, 'control pi must really lack spider presence');
      config.spaces = [{ name: 'Selected group', sessions: [{ file: selected.file }] }];
      const before = await app.ls(); const setup = await startPlainSetup(suite, config);
      const blocking = await waitFor('setup names selected live and unknown writers', async () => ({ text: await readFile(setup.stderr, 'utf8'), alive: identityAlive(setup.process.identity) }), value => !value.alive || value.text.includes(String(live.pid)) && value.text.includes(String(unknown.pid)), deadline(30_000));
      await suite.evidence('writer-blocking-phase.json', blocking);
      assert.ok(blocking.alive, blocking.text || 'setup exited instead of blocking live writers');
      assert.match(blocking.text, /Selected/);
      await suite.keepEvidence(setup.stderr, 'writer-block.txt');
      assert.deepEqual(await app.ls(), before); assert.equal((await owners(suite, [selected])).length, 1); assert.ok(identityAlive(unrelated.identity));
      await writeFile(unknownSettings, JSON.stringify({ ...settings, packages: [suite.packed.root, ...settings.packages] }), { mode: 0o600 });
      if (unknown.mode !== 'interactive') throw new Error('owned interactive unknown writer required');
      await unknown.prompt('/reload');
      await waitFor('real reload publishes formerly unknown presence', () => readPresence(suite), rows => rows.some(p => p.pid === unknown.pid), deadline(30_000));
      assert.equal((await owners(suite, [selected])).length, 1);
      const presenceDirectory = join(config.globalRoot, 'herdr/processes');
      const presenceFiles = await readdir(presenceDirectory);
      let corrupted: string | undefined, originalPresence: Buffer | undefined;
      for (const name of presenceFiles.filter(name => name.endsWith('.json'))) {
        const path = suite.ownPath(join(presenceDirectory, name)); const bytes = await readFile(path); const record = JSON.parse(bytes.toString());
        if (record.pid === unrelated.pid) {
          corrupted = path; originalPresence = bytes;
          await writeFile(path, JSON.stringify({ ...record, startIdentity: 'uncertain-fixture-start' }), { mode: 0o600 }); break;
        }
      }
      assert.ok(corrupted && originalPresence, 'uncertainty control needs the actual unrelated presence record');
      const offset = (await readFile(setup.stderr, 'utf8')).length;
      await live.close();
      const uncertain = await waitFor('uncertain owned writer blocks replacement after selected writer exits', async () => ({ text: (await readFile(setup.stderr, 'utf8')).slice(offset), alive: identityAlive(setup.process.identity), owners: await owners(suite, [selected]) }), value => !value.alive || value.text.includes(String(unrelated.pid)) && value.owners.length === 0, deadline(30_000));
      await suite.evidence('uncertain-writer-phase.json', uncertain);
      assert.ok(uncertain.alive, uncertain.text); assert.equal(uncertain.owners.length, 0); assert.deepEqual(await app.ls(), before);
      await writeFile(corrupted, originalPresence, { mode: 0o600 });
      await waitFor('setup exits after all selected and uncertain writers are released', () => identityAlive(setup.process.identity), alive => !alive, deadline(60_000));
      const exit = await setup.process.exited; const stderr = await readFile(setup.stderr, 'utf8'); await suite.evidence('writer-cutover-exit.json', { exit, stderr }); assert.equal(exit.code, 0, stderr);
      await waitFor('exactly one replacement owner is live', () => owners(suite, [selected]), rows => rows.length === 1 && rows[0].pid !== live.pid, deadline(30_000));
      assert.ok(identityAlive(unrelated.identity)); assert.ok(identityAlive(unknown.identity));
      assert.deepEqual(await readFile(other.file), unrelatedBytes);
      assert.equal((await readPresence(suite)).find(p => p.pid === unrelated.pid)?.sessionId, other.sessionId);
      assert.ok((await readFile(selected.file, 'utf8')).includes('Original conversation selected.'));
      await live.close(); await unrelated.close(); await unknown.close();
    },
  },
  { id: storyId('S10'), title: 'Interrupted allocation resumes with original backups and no duplicate owner', tiers: ['headless', 'app'],
    async run(original) {
      if (original.options.tier === 'app') await prepareInstallInputs(original); // named native prerequisite, no window
      const failures: unknown[] = [];
      for (const phase of ['intent', 'tab', 'owner'] as const) {
        const raw = await createSuite({ tier: 'headless', story: storyId(`H-setup-${phase}`) });
        try {
          const { suite, config, app } = await prepareInstallInputs(raw);
          const priorSettings = Buffer.from('{"layout":"main","theme":"prior","fixture":"original"}\n');
          await writeFile(join(config.app.home, 'settings.json'), priorSettings);
          const selected = await createNamedSession(suite, `Interrupted ${phase}`, await suite.project('interrupt'), `interrupt-${phase}`);
          config.spaces = [{ name: 'Interrupted group', sessions: [{ file: selected.file }] }];
          const setup = await startPlainSetup(suite, config); const journalPath = join(config.globalRoot, 'herdr/spaces/spaces.json');
          const outcome = await waitFor(`externally persisted setup ${phase}`, async () => ({ journal: await json(journalPath), alive: identityAlive(setup.process.identity), stderr: await readFile(setup.stderr, 'utf8') }), value => !value.alive || (phase === 'intent' ? value.journal.intents?.length > 0 : phase === 'tab' ? sessionEntries(value.journal).some(tab => tab.placement) : sessionEntries(value.journal).some(tab => tab.result)), deadline(60_000));
          await suite.evidence('interrupted-phase.json', outcome);
          assert.ok(outcome.alive, outcome.stderr || 'setup exited before allocation');
          const observed = outcome.journal;
          if (phase === 'owner') {
            const owner = sessionEntries(observed).find(tab => tab.result)?.result;
            assert.ok(owner); assert.equal(typeof owner.pid, 'number'); assert.equal(typeof owner.startIdentity, 'string');
            assert.equal(owner.sessionId, selected.sessionId); assert.equal(owner.sessionFile, selected.file); assert.equal(owner.cwd, selected.cwd);
            assert.ok(identityAlive(identityOf(owner.pid)), 'confirmed pi owner must actually be live at interruption');
          }
          assert.ok(identityAlive(setup.process.identity), 'setup must still be alive at the interruption');
          process.kill(-setup.process.identity.pid, 'SIGKILL'); await setup.process.exited;
          const originalJournal = await json(join(config.globalRoot, 'herdr/setup/journal.json'));
          const backups = await fingerprintInstallation(suite, config);
          const rerun = await runSetup(suite, config); await suite.evidence('resumed-setup.json', rerun); assert.equal(rerun.exitCode, 0, rerun.stderr);
          const recovered = await json(journalPath);
          assert.equal(recovered.tabs.length, 1); assert.equal(new Set(sessionEntries(recovered).map(t => t.target.file)).size, 1);
          if (sessionEntries(observed)[0]?.placement) {
            assert.equal(sessionEntries(recovered)[0].placement.tab, sessionEntries(observed)[0].placement.tab);
            assert.equal(sessionEntries(recovered)[0].placement.terminal, sessionEntries(observed)[0].placement.terminal);
          }
          assert.equal((await owners(suite, [selected])).length, 1);
          if (phase === 'owner') {
            const recoveredOwner = sessionEntries(recovered)[0].result, observedOwner = sessionEntries(observed)[0].result;
            assert.ok(recoveredOwner && observedOwner, 'both owner records must exist');
            assert.equal(recoveredOwner.pid, observedOwner.pid, 'recovery replaced the already-confirmed owner');
            assert.equal(recoveredOwner.startIdentity, observedOwner.startIdentity);
          }
          const current = await json(join(config.globalRoot, 'herdr/setup/journal.json'));
          const resumedFiles = await fingerprintInstallation(suite, config);
          for (const entry of originalJournal.entries ?? []) {
            const now = current.entries.find((e: { path: string }) => e.path === entry.path); assert.equal(now.before, entry.before); assert.equal(now.backup, entry.backup);
            if (entry.backup) {
              const original = backups.find(b => b.path === entry.backup); assert.ok(original, 'original backup must actually exist');
              assert.deepEqual(resumedFiles.find(b => b.path === entry.backup), original, 'recovery changed original backup bytes or mtime');
            }
          }
          const target = join(config.agentDirectory, 'themes/dracula-plus-glass.json'); await writeFile(target, 'concurrent target edit\n');
          const changed = await fingerprintInstallation(suite, config); const conflict = await runSetup(suite, config); await suite.evidence('concurrent-edit.json', conflict);
          assert.notEqual(conflict.exitCode, 0); assert.match(conflict.stderr, /managed-artifact-changed|concurrent-settings-edit|unowned-clone-collision|conflict/); assert.deepEqual(await fingerprintInstallation(suite, config), changed);
          await suite.evidence('recovered-app.json', { world: await app.ls() });
        } catch (error) { if (error instanceof HarnessError) throw error; failures.push(error); await raw.evidence('phase-failure.json', { error: String(error), stack: (error as Error).stack }); }
        finally { await raw.close(); }
      }
      if (failures.length) throw new AggregateError(failures, 'setup interruption phases failed');
    },
  },
];
