// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { installFresh, prepareInstallInputs, fingerprintInstallation, installPromptObserver, createNamedSession, readPresence, stopCreatedOwners } from '../fixtures/install-inputs.js';
import { runSetup, readInstalled } from '../harness/setup.js';
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';
import { waitFor, deadline } from '../harness/wait.js';
import { identityAlive, identityOf } from '../harness/resources.js';
import { readObserved } from '../harness/pi.js';
import { createHash } from 'node:crypto';
import type { Suite } from '../harness/suite.js';

async function templateCommand(suite: Suite, path: string): Promise<{ bytes: Buffer; command: string; argv: string[] }> {
  const bytes = await readFile(path), command = bytes.toString('utf8').match(/^command:\s*(.+)$/m);
  assert.ok(command, 'generated role template must contain its command');
  const split = await suite.invoke('python3', ['-c', 'import json,shlex,sys; print(json.dumps(shlex.split(sys.argv[1])))', command[1]], suite.env);
  assert.equal(split.exitCode, 0, split.stderr);
  const argv: unknown = JSON.parse(split.stdout); assert.ok(Array.isArray(argv) && argv.every(value => typeof value === 'string'));
  return { bytes, command: command[1], argv };
}


export const scenarios: readonly ScenarioDefinition[] = [
  { id: storyId('H-setup-adopt'), title: 'Setup plans adoption and backs up explicit replacements without disturbing sessions', tiers: ['headless'],
    async run(original) {
      const { suite, config } = await installFresh(original);
      const configPath = join(config.globalRoot, 'herdr/config.json');
      const invoke = (...flags: string[]) => suite.invoke(process.execPath, [suite.packed.cli, 'setup', '--config', configPath, ...flags], suite.env);
      const journalPath = join(config.globalRoot, 'herdr/setup/journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      const path = join(config.app.home, 'mods/spider-panel/main.js'), originalBytes = await readFile(path);
      const entry = journal.entries.find((entry: { path: string }) => entry.path === path); assert.ok(entry);
      journal.entries = journal.entries.filter((entry: { path: string }) => entry.path !== path);
      await writeFile(journalPath, JSON.stringify(journal));
      const before = await fingerprintInstallation(suite, config);
      const plan = await invoke('--dry-run'); await suite.evidence('adopt-plan.json', plan);
      assert.equal(plan.exitCode, 0, plan.stderr); assert.ok(plan.stdout.includes(`adopt ${path}`));
      assert.deepEqual(await fingerprintInstallation(suite, config), before);
      const adopt = await invoke(); assert.equal(adopt.exitCode, 0, adopt.stderr); assert.match(adopt.stdout, /0 file writes/);
      const adopted = JSON.parse(await readFile(journalPath, 'utf8')).entries.find((entry: { path: string }) => entry.path === path);
      assert.ok(adopted); assert.deepEqual(await readFile(adopted.backup), originalBytes);
      const edited = Buffer.concat([originalBytes, Buffer.from('\n// local preference\n')]); await writeFile(path, edited);
      const refused = await invoke(); assert.notEqual(refused.exitCode, 0); assert.ok(refused.stderr.includes(path)); assert.match(refused.stderr, /--replace-changed/);
      const replacePlan = await invoke('--dry-run'); assert.notEqual(replacePlan.exitCode, 0); assert.ok(replacePlan.stdout.includes(`replace ${path}`)); assert.deepEqual(await readFile(path), edited);
      const replace = await invoke('--replace-changed'); await suite.evidence('replace.json', replace); assert.equal(replace.exitCode, 0, replace.stderr);
      const replacement = JSON.parse(await readFile(journalPath, 'utf8')).entries.find((entry: { path: string }) => entry.path === path);
      assert.deepEqual(await readFile(replacement.backup), edited); assert.deepEqual(await readFile(path), originalBytes);
      const settled = await fingerprintInstallation(suite, config), twice = await invoke(); assert.equal(twice.exitCode, 0, twice.stderr); assert.match(twice.stdout, /0 file writes/); assert.deepEqual(await fingerprintInstallation(suite, config), settled);
    },
  },
  { id: storyId('H-setup-replace'), title: 'Setup restores a parked session to its own tab without another writer or empty tab', tiers: ['headless'],
    async run(original) {
      const { suite, config, app } = await prepareInstallInputs(original);
      const cwd = await suite.project('parked');
      const first = await createNamedSession(suite, 'First', cwd, 'first');
      const second = await createNamedSession(suite, 'Second', cwd, 'second');
      config.layout = 'tabs'; config.spaces = [{ name: 'Work', sessions: [{ file: first.file }, { file: second.file }] }];
      const initial = await runSetup(suite, config); assert.equal(initial.exitCode, 0, initial.stderr);
      const selectedOwners = async () => (await readPresence(suite)).filter(row => row.kind === 'top-level' && [first.sessionId, second.sessionId].includes(String(row.sessionId))).map(row => ({ sessionId: row.sessionId, pid: Number(row.pid), startIdentity: row.startIdentity, terminal: String(row.hcAddress) })).sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId)));
      const owners = await selectedOwners(); assert.equal(owners.length, 2);
      const owner = owners.find(row => row.sessionId === second.sessionId)!;
      assert.ok(identityAlive(identityOf(owner.pid)));
      await app.command('terminal.park', { terminal: owner.terminal });
      type World = { spaces: { id: string; tabs: { id: string; name: string; terminals: { terminal: string; pane: string }[] }[] }[] };
      const world = () => app.ls() as Promise<World>;
      await waitFor('second session is parked while its process stays live', world, value => !value.spaces.flatMap(space => space.tabs).some(tab => tab.terminals.some(row => row.terminal === owner.terminal)), deadline(10000));
      const restored = await runSetup(suite, initial.configPath); await suite.evidence('parked-setup.json', restored);
      assert.equal(restored.exitCode, 0, restored.stderr);
      const placed = await world(), tabs = placed.spaces[0].tabs;
      assert.deepEqual(tabs.map(tab => tab.name), ['First', 'Second']);
      assert.deepEqual(tabs.map(tab => tab.terminals.map(row => row.terminal)), [owners.filter(row => row.sessionId === first.sessionId).map(row => row.terminal), [owner.terminal]]);
      assert.ok(identityAlive(identityOf(owner.pid)));
      assert.deepEqual(await selectedOwners(), owners);
      const stable = (value: World) => value.spaces.map(space => ({ id: space.id, tabs: space.tabs.map(tab => ({ id: tab.id, name: tab.name, terminals: tab.terminals.map(row => ({ terminal: row.terminal, pane: row.pane })) })) }));
      const files = await fingerprintInstallation(suite, config), starts = (await readObserved(suite.pi.observerDir)).filter(row => row.type === 'session_start' && [first.sessionId, second.sessionId].includes(String(row.sessionId)));
      const calls = (await suite.cores!.records()).length;
      const repeated = await runSetup(suite, initial.configPath); assert.equal(repeated.exitCode, 0, repeated.stderr);
      assert.deepEqual(stable(await world()), stable(placed));
      assert.deepEqual(await fingerprintInstallation(suite, config), files);
      assert.deepEqual(await selectedOwners(), owners);
      assert.deepEqual((await readObserved(suite.pi.observerDir)).filter(row => row.type === 'session_start' && [first.sessionId, second.sessionId].includes(String(row.sessionId))), starts);
      assert.equal((await suite.cores!.records()).slice(calls).filter(call => ['keep', 'label', 'kill', 'rm'].includes(call.argv[0]) && owners.some(owner => owner.terminal === call.argv[1])).length, 0);
      await suite.evidence('parked-repeat.json', { placed, repeated, owners });
    },
  },
  { id: storyId('S06'), title: 'A second setup only probes each runtime root without writes, uploads or focus changes', tiers: ['headless', 'app'],
    async run(original) {
      const { suite, config, app } = await installFresh(original);
      const before = await fingerprintInstallation(suite, config); const world = await app.ls(); const status = await app.status();
      const calls = (await suite.cores!.records()).length;
      // A changed owned byte must make this comparison fail.
      assert.throws(() => assert.deepEqual([...before.slice(1)], before));
      const result = await runSetup(suite, config); await suite.evidence('second-setup.json', result);
      const after = await fingerprintInstallation(suite, config); await suite.evidence('second-fingerprints.json', { before, after });
      assert.equal(result.exitCode, 0, result.stderr); assert.match(result.stdout, /0 file writes, 0 visible probes/);
      assert.deepEqual(after, before); assert.deepEqual(await app.ls(), world); assert.deepEqual(await app.status(), status);
      const secondCalls = (await suite.cores!.records()).slice(calls); await suite.evidence('second-hc-calls.json', secondCalls);
      assert.equal(secondCalls.filter(c => c.argv[0] === 'file' && c.argv[1] === 'write').length, 0);
      const launches = secondCalls.filter(c => c.argv[0] === 'run');
      assert.equal(launches.length, config.machines.length, 'unchanged setup must launch exactly one live root probe per machine');
      for (const machine of config.machines) {
        const probes = launches.filter(call => call.argv[call.argv.indexOf('--on') + 1] === machine.name);
        assert.equal(probes.length, 1, `one root probe required for ${machine.name}`);
        assert.ok(probes[0].argv.includes('--probe'), 'the only launch must be the runtime root probe');
        assert.equal(probes[0].argv.at(-1), machine.runtime.directory);
      }
      assert.ok(launches.every(call => !call.argv.includes('--version') && !call.argv.includes('--install')), 'unchanged setup must skip Node checks and runtime bootstrap');
      const rc = await readFile(config.shellRc, 'utf8'); assert.equal(rc.split('# spider:resume:start').length - 1, 1);
    },
  },
  { id: storyId('S11'), title: 'Rollback restores owned bytes while preserving unrelated content and tabs', tiers: ['headless', 'app'],
    async run(original) {
      const { suite, config, app } = await prepareInstallInputs(original);
      const selected = await createNamedSession(suite, 'Rollback owner', await suite.project('rollback-owner'), 'rollback-owner');
      config.spaces = [{ name: 'Owned rollback group', sessions: [{ file: selected.file }] }];
      const prior = new Map<string, Buffer>([
        [join(config.app.home, 'settings.json'), Buffer.from('{"theme":"prior","layout":"main","font_size":15}\n')],
        [join(config.app.home, 'keys.json'), Buffer.from('{"terminal":{"ctrl-v":"paste-image"},"global":{"fixture":"unchanged"}}\n')],
        [config.shellRc, Buffer.from('# prior shell rc\n')],
        [config.core.config, Buffer.from('notes = true\nscrollback = 2000\n')],
      ]);
      for (const [path, bytes] of prior) await writeFile(path, bytes);
      await mkdir(join(config.app.home, 'themes'), { recursive: true }); await writeFile(join(config.app.home, 'themes/prior.json'), '{}');
      const result = await runSetup(suite, config); await suite.evidence('setup-prior.json', result);
      if (result.stderr.includes('setup-verification-failed')) await suite.evidence('failed-setup-doctor.json', await suite.invoke(process.execPath, [suite.packed.cli, 'doctor', '--config', result.configPath], suite.env));
      assert.equal(result.exitCode, 0, result.stderr);
      const unrelated = await app.command('space.new', { name: 'Unrelated', folder: await suite.project('unrelated'), argv: ['/bin/sh'] });
      await suite.evidence('unrelated-tab.json', { reply: unrelated });
      assert.ok(unrelated && typeof unrelated === 'object' && 'space' in unrelated && 'tab' in unrelated && 'terminal' in unrelated, 'unrelated tab needs real returned IDs');
      const live = await waitFor('exactly one real setup-created rollback owner', async () => (await readPresence(suite)).filter(row => {
        if (row.sessionId !== selected.sessionId || typeof row.pid !== 'number' || row.kind !== 'top-level') return false;
        try { return identityAlive(identityOf(row.pid)); } catch { return false; }
      }), rows => rows.length === 1, deadline(15_000));
      assert.equal(typeof live[0].pid, 'number'); const identity = identityOf(Number(live[0].pid));
      await stopCreatedOwners(suite, [selected.sessionId]);
      await waitFor('created rollback owner has actually quit', () => identityAlive(identity), alive => !alive, deadline(15_000));
      const settingsPath = join(config.app.home, 'settings.json'); const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
      await writeFile(settingsPath, JSON.stringify({ ...settings, unrelated: 'survives' }));
      const rc = await readFile(config.shellRc, 'utf8'); await writeFile(config.shellRc, rc + '# unrelated rc addition\n');
      const rollback = async () => suite.invoke(process.execPath, [suite.packed.cli, 'rollback', '--config', join(config.globalRoot, 'herdr/config.json')], suite.env);
      // An owned edit is refused per file; every other matching managed part is restored.
      const rollbackInput = await readInstalled(suite);
      const themePath = join(config.agentDirectory, 'themes/dracula-plus-glass.json'); const theme = await readFile(themePath);
      await writeFile(themePath, Buffer.concat([theme, Buffer.from('\nchanged-owned-content\n')]));
      const editedTheme = await readFile(themePath);
      const refused = await rollback(); await suite.evidence('rollback-refused.json', refused);
      assert.deepEqual(await readFile(themePath), editedTheme, 'the refused theme must be byte-identical');
      assert.ok(refused.stderr.includes(themePath), 'partial rollback must name the refused theme');
      const matching: { path: string; expected: string | null; actual: string | null }[] = [];
      assert.ok(Array.isArray(rollbackInput.journal.entries), 'rollback journal must contain entries');
      for (const entry of rollbackInput.journal.entries) {
        assert.ok(entry && typeof entry.path === 'string' && (entry.before === null || typeof entry.before === 'string'), 'invalid rollback journal entry');
        if (entry.path === themePath || entry.managed || entry.terminalKeys) continue;
        const bytes = await readFile(entry.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        const actual = bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
        matching.push({ path: entry.path, expected: entry.before, actual });
        assert.equal(actual, entry.before, `matching rollback file was not restored: ${entry.path}`);
      }
      const partialSettings = JSON.parse(await readFile(settingsPath, 'utf8'));
      assert.equal(partialSettings.theme, 'prior'); assert.equal(partialSettings.layout, 'main'); assert.equal(partialSettings.unrelated, 'survives');
      assert.equal(await readFile(config.shellRc, 'utf8'), '# prior shell rc\n# unrelated rc addition\n');
      assert.deepEqual(await readFile(config.core.config), prior.get(config.core.config));
      const partialKeys = JSON.parse(await readFile(join(config.app.home, 'keys.json'), 'utf8'));
      assert.equal(partialKeys.terminal['ctrl-v'], 'paste-image'); assert.equal(partialKeys.global.fixture, 'unchanged');
      await suite.evidence('partial-rollback-matching-files.json', { matching, partialSettings, partialKeys, editedThemeRetained: true });
      assert.notEqual(refused.exitCode, 0, 'a per-file refusal must exit nonzero');
      await writeFile(themePath, theme);
      const restored = await rollback(); await suite.evidence('rollback.json', restored); assert.equal(restored.exitCode, 0, restored.stderr);
      const restoredSettings = JSON.parse(await readFile(settingsPath, 'utf8'));
      assert.equal(restoredSettings.theme, 'prior'); assert.equal(restoredSettings.layout, 'main'); assert.equal(restoredSettings.unrelated, 'survives');
      assert.equal(await readFile(config.shellRc, 'utf8'), '# prior shell rc\n# unrelated rc addition\n');
      assert.deepEqual(await readFile(config.core.config), prior.get(config.core.config));
      assert.equal(JSON.parse(await readFile(join(config.app.home, 'keys.json'), 'utf8')).terminal['ctrl-v'], 'paste-image');
      const hook = await lstat(join(config.globalRoot, 'herdr/resume.sh')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!hook) assert.ok(!(await readFile(config.shellRc, 'utf8')).includes('resume.sh'));
      const restoredWorld = await app.ls() as { spaces: { id: string; name: string; tabs: { id: string; terminals: { terminal: string }[] }[] }[] };
      await suite.evidence('rollback-world.json', restoredWorld);
      assert.ok(!restoredWorld.spaces.some(space => space.name === 'Owned rollback group'), 'matching setup-created structures must be removed');
      const retained = restoredWorld.spaces.find(space => space.id === unrelated.space);
      assert.ok(retained, 'unrelated space ID was lost');
      const retainedTab = retained.tabs.find(tab => tab.id === unrelated.tab); assert.ok(retainedTab, 'unrelated tab ID was lost');
      assert.ok(retainedTab.terminals.some(terminal => terminal.terminal === unrelated.terminal), 'unrelated terminal ID was lost');
      const after = await fingerprintInstallation(suite, config); const twice = await rollback(); await suite.evidence('rollback-twice.json', twice);
      assert.equal(twice.exitCode, 0, twice.stderr); assert.deepEqual(await fingerprintInstallation(suite, config), after);
    },
  },
  { id: storyId('S12'), title: 'Empty role templates launch real interactive pi with external model and thinking defaults', tiers: ['headless', 'app'],
    async run(original) {
      await installPromptObserver(original);
      const { suite, config, installed } = await installFresh(original);
      const initialPids = new Set((await readObserved(suite.pi.observerDir)).map(e => e.pid));
      const log = join(suite.root, 'install-events.jsonl');
      for (const [role, thinking] of [['reviewer', 'high'], ['worker', 'high'], ['watcher', 'low']] as const) {
        const source = await readFile(installed.templates.find(p => p.endsWith(`spider-${role}.md`))!, 'utf8');
        assert.equal(source.slice(source.indexOf('\n---', 4) + 4).trim(), '', 'a role body must never become first-message paste');
        const launch = await suite.hc(['run', '--bg', '--no-notify', '--keep', '--json', `spider-${role}`]); await suite.evidence(`role-${role}.json`, launch);
        assert.equal(launch.exitCode, 0, launch.stderr);
        const events = await waitFor(`real ${role} pi reaches interactive session_start`, () => readObserved(suite.pi.observerDir), events => events.some(e => e.type === 'session_start' && !initialPids.has(e.pid)), deadline(30_000));
        const start = events.find(e => e.type === 'session_start' && !initialPids.has(e.pid))!; initialPids.add(start.pid);
        assert.equal(start.mode, 'tui'); assert.equal(start.model, 'e2e-fixture/scripted'); assert.ok(start.hcTerminal); assert.notEqual(start.subagentChild, '1');
        const metadata = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).find(e => e.pid === start.pid && e.type === 'role-start');
        assert.equal(metadata.thinking, thinking);
        const address = (launch.json as { address: string }).address;
        const screen = await suite.hc(['read', address, '--json', '--lines', '100']); await suite.evidence(`role-${role}-screen.json`, screen);
        assert.equal(events.filter(e => e.pid === start.pid && e.type === 'tool_execution_start').length, 0);
        const transcript = typeof start.sessionFile === 'string' ? await readFile(start.sessionFile, 'utf8').catch(() => '') : '';
        assert.equal(transcript.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(e => e.type === 'message' && e.message?.role === 'user').length, 0);
        await suite.hc(['kill', address, '--json']); await suite.hc(['rm', address, '--json']);
      }
      const defaultsPath = join(config.globalRoot, 'config.json'); const defaults = JSON.parse(await readFile(defaultsPath, 'utf8'));
      await writeFile(defaultsPath, JSON.stringify({ ...defaults, 'models.defaults': { worker: 'e2e-fixture/scripted:low', reviewer: 'e2e-fixture/scripted:high', watcher: 'e2e-fixture/scripted:off' } }));
      const regenerated = await runSetup(suite, config); await suite.evidence('roles-regenerated.json', regenerated);
      if (regenerated.stderr.includes('setup-verification-failed')) await suite.evidence('roles-regenerated-doctor.json', await suite.invoke(process.execPath, [suite.packed.cli, 'doctor', '--config', regenerated.configPath], suite.env));
      assert.equal(regenerated.exitCode, 0, regenerated.stderr);
      const templates = (await readInstalled(suite)).templates;
      const workerPath = templates.find(p => p.endsWith('spider-worker.md'))!;
      const { bytes: workerBytes, command, argv } = await templateCommand(suite, workerPath);
      assert.equal(argv.filter(value => value === '--thinking').length, 1);
      assert.equal(argv[argv.indexOf('--thinking') + 1], 'low');
      await suite.evidence('regenerated-worker-command-argv.json', { command, argv });
      const before = await fingerprintInstallation(suite, config);
      await writeFile(defaultsPath, JSON.stringify({ ...defaults, 'models.defaults': { worker: 'unavailable.invalid/missing:high', reviewer: 'e2e-fixture/scripted:high', watcher: 'e2e-fixture/scripted:off' } }));
      const unavailable = await runSetup(suite, config); await suite.evidence('role-unavailable.json', unavailable);
      // Setup must reject unresolved roles before writes; lenient activation policy is not the setup contract.
      assert.notEqual(unavailable.exitCode, 0); assert.match(unavailable.stderr, /role-unresolved/);
      assert.deepEqual(await readFile(workerPath), workerBytes, 'unavailable worker must retain its exact last-good template');
      const after = await fingerprintInstallation(suite, config);
      assert.deepEqual(after.filter(f => f.path !== defaultsPath), before.filter(f => f.path !== defaultsPath));
      assert.equal((await readdir(join(config.globalRoot, 'herdr/instructions'))).length, 3);
      for (const installed of after.filter(file => file.path !== defaultsPath && file.sha256 !== null)) {
        assert.doesNotMatch(await readFile(installed.path, 'utf8'), /unavailable\.invalid/, `no unavailable model may enter installed file ${installed.path}`);
      }
      // Explicitly malformed/unavailable external input, never a fabricated installed model.
      const missingDefaults = { ...defaults }; delete missingDefaults['models.defaults'];
      await writeFile(defaultsPath, JSON.stringify(missingDefaults));
      const catalogPath = suite.ownPath(join(config.agentDirectory, 'models.json'));
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
      assert.ok(catalog.providers && typeof catalog.providers === 'object');
      const originalRoleBytes = new Map(await Promise.all(templates.map(async path => [path, await readFile(path)] as const)));
      const originalModelRefs = new Set<string>();
      const providers = Object.entries(catalog.providers); assert.ok(providers.length > 0, 'missing-model control needs the actual supplied catalog');
      for (const [providerName, provider] of providers) {
        assert.ok(provider && typeof provider === 'object' && 'models' in provider && Array.isArray(provider.models));
        for (const model of provider.models) { assert.ok(model && typeof model.id === 'string'); originalModelRefs.add(`${providerName}/${model.id}`); }
        provider.models = [];
      }
      await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
      const missingBefore = await fingerprintInstallation(suite, config);
      const missing = await runSetup(suite, config); await suite.evidence('role-missing.json', missing);
      // The empty supplied catalog is a hard setup refusal, with every last-good installed byte retained.
      assert.notEqual(missing.exitCode, 0, missing.stderr); assert.match(missing.stderr, /catalog-unavailable/);
      const observedRoles = [];
      for (const [path, bytes] of originalRoleBytes) {
        const actual = await templateCommand(suite, path);
        assert.deepEqual(actual.bytes, bytes, `empty catalog must preserve exact role template ${path}`);
        assert.equal(actual.argv.filter(value => value === '--model').length, 1);
        assert.ok(originalModelRefs.has(actual.argv[actual.argv.indexOf('--model') + 1]), 'retained role must name a model from the original supplied catalog, never an invented model');
        observedRoles.push({ path, argv: actual.argv, sha256: createHash('sha256').update(actual.bytes).digest('hex') });
      }
      assert.deepEqual(await fingerprintInstallation(suite, config), missingBefore);
      assert.equal((await readdir(join(config.globalRoot, 'herdr/instructions'))).length, 3);
      await suite.evidence('empty-catalog-retained-roles.json', { originalModelRefs: [...originalModelRefs], observedRoles, refusal: missing.stderr });
    },
  },
];
