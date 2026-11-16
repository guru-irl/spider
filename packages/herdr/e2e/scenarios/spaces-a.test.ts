// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerScenarios, storyId, type ScenarioDefinition } from '../harness/scenario.js';
import { type Suite, type AppDriver } from '../harness/suite.js';
import { AppBoundaryError, type NativeAppOwnership } from '../harness/app.js';
import { HarnessError } from '../harness/environment.js';
import { waitFor, deadline } from '../harness/wait.js';
import { identityAlive } from '../harness/resources.js';
import { stageSpacesAFiles } from '../fixtures/spaces-a-inputs.js';
import { loadSpacesAFiles, replaySpacesARecipe } from '../../src/__tests__/spaces-a-fixture.js';
import { installationConfig } from '../fixtures/install-inputs.js';
import { writeScript, type InteractiveDriver } from '../harness/pi.js';
import { HerdrLabelContract, type SessionFeed } from '../../src/contracts.js';
import { parseFeed } from '../../assets/shared/feed.js';
import { parseHerdrConfig } from '../../src/config.js';
import { runtimeInstallPath } from '../../src/setup/installer.js';
import { buildGlassLayout } from '../../src/look/layout.js';
import { projectNotifications, notificationBadge, notificationText } from '../../assets/mods/spider/data.js';
import type { ScriptFile } from '../fixtures/scripted-provider.js';
import keys from '../../assets/keys.json' with { type: 'json' };
import layoutEdits from '../../assets/look/layout-edits.json' with { type: 'json' };

async function configureNativeFixture(suite: Suite, owned: NativeAppOwnership, baseline: boolean, setupProbe: boolean) {
  if (!owned || !suite.appConnection || !suite.cores) throw new HarnessError('missing-prerequisite', 'An owned native app and isolated cores are required');
  const version = owned.release;
  if (version !== '0.1.13' && version !== '0.1.16') throw new HarnessError('missing-prerequisite', 'The native release is not certified');
  const assets = join(suite.packed.root, 'packages/herdr/assets');
  const staged = await stageSpacesAFiles(owned.appHome, version, assets);
  await suite.keepEvidence(staged.manifest, 'composed-manifest.tsv');
  if (baseline) {
    const current = replaySpacesARecipe(version, loadSpacesAFiles(version));
    for (const mod of ['agents', 'spaces']) for (const file of ['main.js', 'mod.json']) await writeFile(join(owned.appHome, 'mods', `spider-${mod}`, file), current[mod]![file]!);
    await suite.evidence('baseline-sidebar.json', { version, recipe: 'retained pre-A', changed: ['agents', 'spaces'] });
  }
  Object.assign(suite.pi.env, suite.appConnection.env); Object.assign(suite.cores.local.env, suite.appConnection.env);
  const config = installationConfig(suite, owned.binary);
  config.app.home = owned.appHome; config.notifications = { sound: true };
  const runtime = await readFile(suite.packed.remoteRuntime);
  await mkdir(join(suite.root, 'r'), { recursive: true, mode: 0o700 });
  await writeFile(suite.ownPath(runtimeInstallPath(join(suite.root, 'r'), runtime)), runtime, { mode: 0o700 });
  config.machines = parseHerdrConfig({ ...config, machines: [...config.machines, { ...config.machines[0], name: 'box-2.invalid' }] }).machines;
  const configPath = suite.ownPath(join(config.globalRoot, 'herdr/config.json'));
  await mkdir(join(config.globalRoot, 'herdr/sessions'), { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const globalConfig = join(config.globalRoot, 'config.json');
  const global = JSON.parse(await readFile(globalConfig, 'utf8'));
  await writeFile(globalConfig, JSON.stringify({ ...global, 'herdr.enabled': true, 'herdr.config': configPath }), { mode: 0o600 });
  const nativeDirectory = join(suite.root, 'native-processes');
  await mkdir(nativeDirectory, { mode: 0o700 });
  suite.ledger.update(value => { value.nativeProcessDirectory = nativeDirectory; });
  const nodePath = join(suite.root, 'native-node.mjs');
  await writeFile(nodePath, `#!${process.execPath}\n` + await readFile(new URL('../fixtures/native-node.mjs', import.meta.url), 'utf8'), { mode: 0o700 });
  await writeFile(join(suite.root, 'native-node.json'), JSON.stringify({ ledger: suite.ledger.path, nodePath: process.execPath, feedRoot: join(config.globalRoot, 'herdr'), directory: nativeDirectory }), { mode: 0o600 });
  const baseProps = { feedRoot: join(config.globalRoot, 'herdr'), cliPath: suite.packed.cli, nodePath, appBinary: owned.binary,
    configPath, labelContract: HerdrLabelContract, fonts: { body: 'Google Sans Flex', labels: 'Google Sans Flex', paths: 'JetBrains Mono' },
    machines: config.machines, retention: config.limits, notifications: { sound: true } };
  const modProps = Object.fromEntries(['agents', 'spaces', 'pane', 'tabs', 'spider', 'chrome'].map(kind => [kind, { ...baseProps, modId: kind === 'spider' ? 'spider-panel' : `spider-${kind}` }]));
  await writeFile(join(owned.appHome, 'mods/spider-picker/config.json'), JSON.stringify({ ...baseProps, modId: 'spider-picker', version: 1 }), { mode: 0o600 });
  if (setupProbe) {
    const target = join(owned.appHome, 'mods/spider-agents/main.js');
    const proof = join(suite.root, 'agents-setup-probe.json');
    let source = await readFile(target, 'utf8');
    const hook = `this.spiderSetupProbe = async () => {
      const env = await exec("/bin/sh", ["-c", "printf '%s\\\\n' \\\"$HOME\\\" \\\"$SPIDER_GLOBAL_ROOT\\\" \\\"$PI_CODING_AGENT_DIR\\\" \\\"$PATH\\\"; command -v hc; hc --version"]);
      const version = await hc(["--version"]);
      const value = { at: Date.now(), renders: this.spiderProbeRenders ?? 0, feedRoot: spiderProps().feedRoot, feedError: this.spiderFeedError ?? null,
        loading: this.spiderLoading, watching: this.spiderWatching, feeds: (this.spiderFeeds ?? []).map(feed => ({ sessionId: feed.sessionId, name: feed.owner.name, core: feed.owner.terminal.coreId, placement: feed.placement })),
        sort: shared("agents.sort"), window: window(), hcVersion: version, env,
        groups: shared("agents.sort") === "machine" ? groupAgentsByMachine(filterTopLevelAgents(agents(), terminals(), spiderProps().labelContract), terminals(), spiderProps().labelContract, [...(spiderProps().machines ?? []), ...machines(), ...(this.spiderConnections?.machines ?? [])]).map(group => ({ id: group.id, label: group.label, machine: group.machine, members: group.members.map(agent => agent.address) })) : [],
        foldedMachines: [...(this.foldedMachines ?? [])], expandedConsoleGroups: [...(this.expandedConsoleGroups ?? [])],
        owners: filterTopLevelAgents(agents(), terminals(), spiderProps().labelContract).map(agent => ({ address: agent.address, tree: this.tree(terminals(), agent.address).map(item => item.group ? { group: item.group } : { kind: item.t.kind, key: item.t.key, parentKey: item.t.parentKey, status: item.t.status, retained: item.t.retained, action: { kind: item.t.action?.kind, op: item.t.action?.request?.op, jobId: item.t.action?.request?.jobId, runId: item.t.action?.request?.runId } }) })),
        parked: this.parkedSessions().map(target => ({ sessionId: target.sessionId, terminal: target.terminal, name: target.name, machine: target.machine, action: target.action?.request?.op })),
        coreId: this.spiderConnections?.coreId, connections: this.spiderConnections?.snapshot,
        spaces: spaces().map(space => ({ id: space.id, name: space.name, machine: space.machine })),
        agents: agents().map(agent => ({ address: agent.address, title: agent.title, titleType: typeof agent.title })) };
      await exec(spiderProps().nodePath, ["-e", "require('node:fs').writeFileSync(process.argv[1],process.argv[2])", ${JSON.stringify(proof)}, JSON.stringify(value)]);
    };\n`;
    const anchor = '    this.spiderFeedTimer = cx.timer;';
    if (!source.includes(anchor)) throw new Error('diagnostic init anchor missing');
    source = source.replace(anchor, hook + anchor).replace('render(cx) {', 'render(cx) { this.spiderProbeRenders = (this.spiderProbeRenders ?? 0) + 1;');
    source = source.replace('else if (command === "sort-machine") setShared("agents.sort", "machine");', 'else if (command === "sort-machine") { setShared("agents.sort", "machine"); cx.spawn(async cx => { await this.spiderSetupProbe(); cx.notify(); }); }');
    source = source.replace('else if (command === "sort-space") setShared("agents.sort", "grouped");', 'else if (command === "sort-space") { setShared("agents.sort", "grouped"); cx.spawn(async cx => { await this.spiderSetupProbe(); cx.notify(); }); }');
    source = source.replace('if (key) this.toggleCurrentConsoleGroup(key);', 'if (key) this.toggleCurrentConsoleGroup(key); cx.spawn(async cx => { await this.spiderSetupProbe(); cx.notify(); });');
    await writeFile(target, source);
  }
  const stock = JSON.parse(await readFile(join(owned.appHome, 'layouts/main.json'), 'utf8'));
  const layout = buildGlassLayout(stock, { agents: 'spider-agents', spaces: 'spider-spaces', pane: 'spider-pane', tabs: 'spider-tabs', spider: 'spider-panel', chrome: 'spider-chrome', bodyFont: 'Google Sans Flex', props: modProps });
  Object.assign(layout, (layoutEdits as any).spacesA?.[version]?.root ?? {});
  await writeFile(join(owned.appHome, 'layouts/spider-glass.json'), JSON.stringify(layout));
  await mkdir(join(owned.appHome, 'themes'), { recursive: true });
  await copyFile(join(assets, 'themes/spider-glass.json'), join(owned.appHome, 'themes/spider-glass.json'));
  const nativeKeys = JSON.parse(await readFile(join(owned.appHome, 'keys.json'), 'utf8'));
  for (const [section, values] of Object.entries(keys)) Object.assign(nativeKeys[section] ??= {}, values);
  await writeFile(join(owned.appHome, 'keys.json'), JSON.stringify(nativeKeys));
  return { owned, config, configPath, baseProps, layout, nativeKeys };
}

async function nativeFixture(suite: Suite, baseline = false, setupProbe = false) {
  let prepared: Awaited<ReturnType<typeof configureNativeFixture>> | undefined;
  suite.beforeNativeLaunch = async owned => { prepared = await configureNativeFixture(suite, owned, baseline, !baseline && (setupProbe || owned.release === '0.1.13')); };
  const app = await suite.app();
  if (!prepared) throw new HarnessError('missing-prerequisite', 'Pre-launch native staging did not run');
  const { owned } = prepared;
  await writeFile(join(owned.appHome, 'keys.json'), JSON.stringify(prepared.nativeKeys));
  const nativeKeys = JSON.parse(await readFile(join(owned.appHome, 'keys.json'), 'utf8'));
  expect(nativeKeys).toEqual(prepared.nativeKeys);
  const version = owned.release;
  await app.command('layout.switch', { name: 'spider-glass' });
  if (!baseline) await app.command('spider-agents.sort-machine', {});
  expect(await app.status()).toMatchObject({ errors: [], layout: 'spider-glass' });
  expect(nativeKeys.global['cmd-shift-w']).toBe('pane.close');
  expect(nativeKeys.global['cmd-n']).toEqual({ command: 'space.new', args: { machine: '' } });
  expect(nativeKeys.global['cmd-p']).toBe('mod.open:spider-picker');
  expect(nativeKeys['layout:spider-glass']['cmd-shift-e']).toBe('spider-pane.park');
  const commands = await app.command('commands', {}) as { commands: { name: string }[] };
  for (const name of ['terminal.park', 'pane.close', 'mod.open']) expect(commands.commands.some(command => command.name === name)).toBe(true);
  await suite.evidence('native-keys-and-commands.json', { version, keys: nativeKeys, commands });
  return { app, ...prepared };
}

async function shotText(suite: Suite, app: AppDriver, name: string): Promise<string[]> {
  if (suite.nativeAppOwnership?.release === '0.1.13' && process.env.SPIDER_SPACES_A_SCREENSHOTS_013 !== '1') throw new HarnessError('missing-prerequisite', '0.1.13 screenshots: pending, screen locked');
  const file = suite.ownPath(join(suite.root, `${name}.png`));
  await app.shot(file); await suite.keepEvidence(file);
  const result = await suite.invoke('/usr/bin/swift', [fileURLToPath(new URL('../fixtures/window-text.swift', import.meta.url)), file]);
  if (result.exitCode !== 0) throw new HarnessError('missing-prerequisite', `Owned screenshot text could not be read: ${result.stderr}`);
  const text = JSON.parse(result.stdout) as string[];
  await suite.evidence(`${name}-text.json`, text);
  return text;
}
async function nativeViewState(suite: Suite, app: AppDriver, predicate: (value: Record<string, any>) => boolean, command = 'spider-agents.sort-machine'): Promise<Record<string, any>> {
  const after = Date.now();
  const value = await waitFor('command-driven native View state', async () => {
    await app.command(command, {});
    return JSON.parse(await readFile(join(suite.root, 'agents-setup-probe.json'), 'utf8').catch(() => '{}')) as Record<string, any>;
  }, value => value.at >= after && predicate(value), deadline(20000));
  await suite.evidence(`view-state-${command.split(':')[0]}.json`, value);
  return value;
}
const panes = (world: any): any[] => world.spaces.flatMap((space: any) => space.tabs.flatMap((tab: any) => tab.terminals.map((pane: any) => ({ ...pane, space: space.id, tab: tab.id }))));
async function primary(suite: Suite, fixture: Awaited<ReturnType<typeof nativeFixture>>, side: 'local' | 'dest' = 'local') {
  const cwd = await suite.project('writer');
  const local = await fixture.app.command('space.new', { name: side === 'local' ? 'Work' : 'Remote', machine: side === 'local' ? '' : 'dest.invalid', folder: cwd, argv: ['/bin/sh', '-c', 'printf local-ready; exec cat'] }) as any;
  const pi = await suite.launchPi({ mode: 'interactive', side, cwd, args: ['--approve'], label: 'Writer', extraEnv: { ...(side === 'dest' ? { XDG_STATE_HOME: suite.cores!.dest.env.XDG_STATE_HOME, XDG_CONFIG_HOME: suite.cores!.dest.env.XDG_CONFIG_HOME } : {}), PI_PROGRAM_STATUS: '1' } }) as InteractiveDriver;
  const started = await pi.waitEvent('session_start', event => event.mode === 'tui', deadline(20000));
  const address = side === 'local' ? pi.terminal : `dest.invalid/${pi.terminal}`;
  await fixture.app.command('terminal.keep', { terminal: address, place: 'right' });
  await suite.hc(['label', pi.terminal, `${HerdrLabelContract.labels.displayName}=Writer`, '--json'], side);
  const placed = await waitFor('owned primary pane', () => fixture.app.ls(), world => panes(world).some(pane => pane.terminal === address), deadline(20000));
  const pane = panes(placed).find(pane => pane.terminal === address);
  suite.registerNativeTarget?.('pane', pane.pane); suite.registerNativeTarget?.('terminal', address); suite.registerNativeTarget?.('session', String(started.sessionId));
  await pi.prompt('/name Writer');
  const feedPath = join(fixture.config.globalRoot, 'herdr/sessions', String(started.sessionId), 'session.json');
  const feed = await waitFor('authenticated primary feed', async () => parseFeed(await readFile(feedPath, 'utf8').catch(() => '')), value => Boolean(value?.ipc && value.owner.name === 'Writer' && value.owner.terminal.address === pi.terminal), deadline(20000));
  if (!feed) throw new HarnessError('missing-prerequisite', 'The primary did not publish its endpoint');
  return { pi, address, feed, feedPath, local, pane };
}

async function toolCalls(suite: Suite, owner: Awaited<ReturnType<typeof primary>>, marker: string, calls: Record<string, any>[], childScripts: ScriptFile['scripts'] = {}): Promise<void> {
  const previous = JSON.parse(await readFile(suite.pi.scriptPath, 'utf8'));
  const ids = calls.map((_call, index) => `${marker}-${index}`);
  await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: { ...previous.scripts, ...childScripts, [marker]: [{ steps: calls.map((arguments_, index) => ({ tool: { id: ids[index], name: 'spider', arguments: arguments_ } })) }, { steps: [{ text: 'fixture settled' }] }] } });
  await owner.pi.prompt(`[[e2e:${marker}]]`);
  for (const id of ids) {
    const result = await owner.pi.toolResult(id, deadline(30000));
    await suite.evidence(`${id}.json`, result); expect(result.isError).toBe(false);
  }
}

export const scenarios: readonly ScenarioDefinition[] = [
  { id: storyId('H-spaces-a-numeric-title'), title: 'An agent reporting a numeric title loads without losing its native identity', tiers: ['app'], async run(suite) {
    const fixture = await nativeFixture(suite, false, true);
    const created = await fixture.app.command('space.new', { name: 'Numeric', machine: '', argv: ['/bin/sh', '-c', "printf '\\033]0;42\\007\\033]7501;state=working:app=pi:msg=NDI=\\033\\\\'; exec /bin/sleep 60"] }) as any;
    const state = await nativeViewState(suite, fixture.app, value => value.agents?.some((agent: any) => agent.address === created.terminal && String(agent.title) === '42'));
    const actual = state.agents.find((agent: any) => agent.address === created.terminal);
    expect(state.groups.flatMap((group: any) => group.members)).toContain(created.terminal);
    expect(await fixture.app.status()).toMatchObject({ errors: [] });
    await suite.evidence('numeric-title.json', { terminal: created.terminal, title: actual.title, type: actual.titleType, groups: state.groups });
    if (fixture.owned.release === '0.1.16') {
      const text = await shotText(suite, fixture.app, 'numeric-title'); expect(text.join(' ')).toContain('Numeric');
    }
  } },
  { id: storyId('H-spaces-a-setup-probe'), title: 'The native Agents feed source and first-render waits match the owned parent fixture', tiers: ['app'], async run(suite) {
    const fixture = await nativeFixture(suite, false, true);
    const owner = await primary(suite, fixture), after = Date.now();
    try {
      const value = await waitFor('fresh native setup probe', async () => {
        await fixture.app.command('spider-agents.sort-machine', {});
        return JSON.parse(await readFile(join(suite.root, 'agents-setup-probe.json'), 'utf8').catch(() => '{}'));
      }, value => value.at >= after && value.feeds?.some((feed: any) => feed.sessionId === owner.feed.sessionId), deadline(20000));
      await suite.evidence('agents-setup-probe.json', value);
      expect(value.feeds).toContainEqual(expect.objectContaining({ sessionId: owner.feed.sessionId, name: 'Writer' }));
      if (fixture.owned.release === '0.1.16') await shotText(suite, fixture.app, 'setup-machine-sidebar');
    } finally {
      const directory = suite.ledger.read().nativeProcessDirectory!;
      const records = [];
      for (const file of await (await import('node:fs/promises')).readdir(directory)) if (file.endsWith('.json')) {
        const record = JSON.parse(await readFile(join(directory, file), 'utf8'));
        records.push({ ...record, aliveBeforeCleanup: identityAlive(record), stderr: await readFile(record.stderrPath, 'utf8').catch(() => '') });
      }
      await suite.evidence('native-reader-starts.json', records);
      const snapshots = [];
      for (const file of await (await import('node:fs/promises')).readdir(join(fixture.config.globalRoot, 'herdr/readers')).catch(() => [])) if (file.endsWith('.json')) {
        const registration = JSON.parse(await readFile(join(fixture.config.globalRoot, 'herdr/readers', file), 'utf8'));
        if (!records.some(record => record.pid === registration.pid && record.aliveBeforeCleanup)) continue;
        const response = await fetch(`http://127.0.0.1:${registration.port}/snapshot`, { method: 'POST', headers: { authorization: `Bearer ${registration.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ known: {} }) });
        const snapshot = await response.json() as any;
        snapshots.push({ status: response.status, entries: snapshot.entries?.length, errors: snapshot.errors, feeds: snapshot.changes?.map((row: any) => ({ sessionId: row.feed.sessionId, name: row.feed.owner.name })) });
      }
      await suite.evidence('owned-reader-snapshots.json', snapshots);
      await suite.keepEvidence(join(suite.root, 'agents-setup-probe.json')).catch(() => undefined);
      await suite.evidence('native-status-after-probe.json', { status: await fixture.app.status() });
      await suite.keepEvidence(owner.feedPath, 'fixture-session.json');
    }
  } },
  { id: storyId('H-spaces-a-baseline-sidebar'), title: 'The pre-A sidebar paints an allocated local space under the same native setup', tiers: ['app'], async run(suite) {
    const fixture = await nativeFixture(suite, true);
    await fixture.app.command('space.new', { name: 'Work', machine: '', argv: ['/bin/sh', '-c', 'exec cat'] });
    await suite.evidence('baseline-native-world.json', { status: await fixture.app.status(), world: await fixture.app.ls() });
    const text = await waitFor('pre-A local space rendered in owned window', () => shotText(suite, fixture.app, 'pre-a-sidebar'), lines => lines.join(' ').includes('Work'), deadline(20000));
    expect(text.join(' ')).toContain('Work');
  } },
  { id: storyId('H-spaces-a-clipboard'), title: 'The native context writes a canary and restores all clipboard representations', tiers: ['app'], async run(suite) {
    const fixture = await nativeFixture(suite);
    await writeFile(join(fixture.owned.appHome, 'mods/spider-panel/mod.json'), await readFile(join(fixture.owned.appHome, 'mods/spider-agents/mod.json')));
    await writeFile(join(fixture.owned.appHome, 'mods/spider-panel/main.js'), 'import { View, div } from "gpui-kit"; import { nextCommand } from "herdr"; export default class extends View { init(_props, cx) { cx.spawn(async cx => { for (;;) { const command = await nextCommand(); if (command === "refresh") { cx.write_to_clipboard("spider-native-clipboard-canary"); cx.notify(); } } }); } render() { return div().child("Clipboard probe"); } }');
    await fixture.app.command('layout.show', { id: 'panel' });
    await fixture.app.command('layout.select', { stack: 'panel-body', child: 'spider' });
    if (fixture.owned.release === '0.1.16') await shotText(suite, fixture.app, 'clipboard-probe');
    const result = await suite.invoke('/usr/bin/swift', [fileURLToPath(new URL('../fixtures/clipboard-check.swift', import.meta.url)), fixture.owned.binary], fixture.owned.env);
    expect(result.exitCode, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout); await suite.evidence('clipboard-receipt.json', receipt);
    expect(receipt).toMatchObject({ exitCode: 0, wrote: true, restored: true });
    expect(await fixture.app.status()).toMatchObject({ errors: [] });
  } },
  { id: storyId('H-spaces-a-sidebar'), title: 'Machine grouping includes this computer and idle machines in a flat local sidebar', tiers: ['app'], async run(suite) {
    const fixture = await nativeFixture(suite);
    await fixture.app.command('space.new', { name: 'Work', machine: '', argv: ['/bin/sh', '-c', 'exec cat'] });
    await fixture.app.command('spider-agents.sort-machine', {});
    await suite.evidence('native-world-after-dispatch.json', { status: await fixture.app.status(), world: await fixture.app.ls() });
    if (fixture.owned.release === '0.1.13') {
      const machine = await nativeViewState(suite, fixture.app, value => value.sort === 'machine' && value.groups?.length >= 3);
      expect(machine.groups.map((group: any) => group.label)).toEqual(expect.arrayContaining(['This computer', 'box-2.invalid', 'dest.invalid']));
      expect(machine.spaces).toContainEqual(expect.objectContaining({ name: 'Work', machine: null }));
      const grouped = await nativeViewState(suite, fixture.app, value => value.sort === 'grouped', 'spider-agents.sort-space');
      expect(grouped.groups).toEqual([]);
      await suite.evidence('screenshots-pending.json', { reason: '0.1.13 screenshots: pending, screen locked' });
      return;
    }
    const text = await waitFor('machine headings rendered in the owned window', async () => {
      await fixture.app.command('spider-agents.sort-machine', {});
      return shotText(suite, fixture.app, 'machine-sidebar');
    }, lines => lines.join(' ').includes('box-2.invalid'), deadline(45000));
    expect(text.join(' ')).toContain('This computer');
    expect(text.join(' ')).toContain('box-2.invalid');
    expect(text.join(' ')).toContain('Work');
    await fixture.app.command('spider-agents.sort-space', {});
    const grouped = await waitFor('space grouping rendered in the owned window', async () => {
      await fixture.app.command('spider-agents.sort-space', {});
      return shotText(suite, fixture.app, 'space-sidebar');
    }, lines => !lines.join(' ').includes('box-2.invalid'), deadline(20000));
    expect(grouped.join(' ')).not.toContain('box-2.invalid');
    expect(await fixture.app.status()).toMatchObject({ errors: [] });
  } },
  { id: storyId('H-spaces-a-picker'), title: 'The installed Go to overlay renders named local targets', tiers: ['app'], async run(suite) {
    const fixture = await nativeFixture(suite), owner = await primary(suite, fixture);
    await fixture.app.command('mod.open', { name: 'spider-picker' });
    if (fixture.owned.release === '0.1.13') {
      const status = await fixture.app.status();
      expect(status).toMatchObject({ errors: [], overlays: expect.arrayContaining(['spider-picker']) });
      await suite.evidence('go-to-api.json', { status, owner: { sessionId: owner.feed.sessionId, name: owner.feed.owner.name } });
      return;
    }
    const text = await shotText(suite, fixture.app, 'go-to');
    expect(text.join(' ')).toContain('Go to'); expect(text.join(' ')).toContain('Work');
    expect(text.join(' ')).toContain('Writer');
    expect(await fixture.app.status()).toMatchObject({ errors: [] });
  } },
  { id: storyId('H-spaces-a-park'), title: 'Dotted Send back and authenticated sidebar activation preserve the primary process', tiers: ['app'], async run(suite) {
    const fixture = await nativeFixture(suite, false, true), owner = await primary(suite, fixture);
    await nativeViewState(suite, fixture.app, value => value.feeds?.some((feed: any) => feed.sessionId === owner.feed.sessionId));
    const before = owner.pi.identity;
    await fixture.app.command('pane.focus', { terminal: owner.address });
    await fixture.app.command('spider-pane.park', {});
    await waitFor('primary pane removed', () => fixture.app.ls(), world => !panes(world).some(pane => pane.terminal === owner.address), deadline(20000));
    expect(identityAlive(before)).toBe(true);
    expect((await suite.hc(['get', owner.address, '--json'])).json).toMatchObject({ state: 'live' });
    const parked = await nativeViewState(suite, fixture.app, value => value.parked?.some((target: any) => target.sessionId === owner.feed.sessionId));
    expect(parked.parked).toContainEqual(expect.objectContaining({ sessionId: owner.feed.sessionId, terminal: owner.address, name: 'Writer', action: 'openSession' }));
    if (fixture.owned.release === '0.1.16') await shotText(suite, fixture.app, 'parked-primary');
    const reopened = await waitFor('same primary restored by sidebar action', async () => {
      await fixture.app.command(`spider-agents.activate-session:${encodeURIComponent(owner.feed.sessionId)}`, {});
      return fixture.app.ls();
    }, world => panes(world).some(pane => pane.terminal === owner.address), deadline(20000));
    expect(identityAlive(before)).toBe(true);
    expect(owner.pi.pid).toBe(before.pid);
    await suite.evidence('primary-round-trip.json', { before, terminal: owner.address, reopened });
    if (fixture.owned.release === '0.1.16') await shotText(suite, fixture.app, 'reopened-primary');

  } },
  { id: storyId('H-spaces-a-remote-park'), title: 'Send back and sidebar activation preserve the own-machine remote primary process', tiers: ['app'], async run(suite) {
    const fixture = await nativeFixture(suite, false, true), owner = await primary(suite, fixture, 'dest');
    await nativeViewState(suite, fixture.app, value => value.feeds?.some((feed: any) => feed.sessionId === owner.feed.sessionId));
    const before = owner.pi.identity;
    await fixture.app.command('pane.focus', { terminal: owner.address });
    await fixture.app.command('spider-pane.park', {});
    await waitFor('primary pane removed', () => fixture.app.ls(), world => !panes(world).some(pane => pane.terminal === owner.address), deadline(20000));
    expect(identityAlive(before)).toBe(true);
    expect((await suite.hc(['get', owner.address, '--json'])).json).toMatchObject({ state: 'live' });
    const parked = await nativeViewState(suite, fixture.app, value => value.parked?.some((target: any) => target.sessionId === owner.feed.sessionId));
    expect(parked.parked).toContainEqual(expect.objectContaining({ sessionId: owner.feed.sessionId, terminal: owner.address, name: 'Writer', action: 'openSession' }));
    if (fixture.owned.release === '0.1.16') await shotText(suite, fixture.app, 'parked-primary');
    const reopened = await waitFor('same primary restored by sidebar action', async () => {
      await fixture.app.command(`spider-agents.activate-session:${encodeURIComponent(owner.feed.sessionId)}`, {});
      return fixture.app.ls();
    }, world => panes(world).some(pane => pane.terminal === owner.address), deadline(20000));
    expect(identityAlive(before)).toBe(true);
    expect(owner.pi.pid).toBe(before.pid);
    await suite.evidence('primary-round-trip.json', { before, terminal: owner.address, reopened });
    if (fixture.owned.release === '0.1.16') await shotText(suite, fixture.app, 'reopened-primary');

  } },
  { id: storyId('H-spaces-a-consoles'), title: 'One owner console group opens without hiding sibling subagents', tiers: ['app'], async run(suite) {
    const fixture = await nativeFixture(suite, false, true), owner = await primary(suite, fixture);
    await fixture.app.command('space.new', { name: 'Remote', machine: 'dest.invalid', argv: ['/bin/sh', '-c', 'printf remote-ready; exec cat'] });
    const child = await suite.hc(['run', '--bg', '--json', '--no-notify', '--parent', owner.address, '/bin/sh', '-c', "printf '\\033]7501;state=working:app=pi:msg=Q2hpbGQ=\\033\\\\'; exec /bin/sleep 60"]);
    expect(child.exitCode).toBe(0);
    await toolCalls(suite, owner, 'consoles', [1, 2].map(index => ({ action: 'exec', on: 'dest.invalid', language: 'shell', code: `printf 'console ${index} ready\\n'; /bin/sleep 60`, background: true })));
    const collapsed = await nativeViewState(suite, fixture.app, value => value.owners?.some((item: any) => item.address === owner.address && item.tree.some((row: any) => row.group?.count === 2)));
    const ownerTree = (value: Record<string, any>) => value.owners.find((item: any) => item.address === owner.address).tree as any[];
    const group = ownerTree(collapsed).find(row => row.group)?.group;
    expect(group).toMatchObject({ count: 2, expanded: false });
    expect(ownerTree(collapsed).filter(row => row.kind === 'console')).toHaveLength(0);
    expect(ownerTree(collapsed).filter(row => row.kind === 'native')).toHaveLength(1);
    suite.registerNativeTarget?.('console-group', group.key);
    const command = `spider-agents.console-group-toggle:${encodeURIComponent(group.key)}`;
    await fixture.app.command(command, {});
    const expanded = await nativeViewState(suite, fixture.app, value => ownerTree(value).some(row => row.group?.expanded === true));
    expect(ownerTree(expanded).filter(row => row.kind === 'console')).toHaveLength(2);
    expect(ownerTree(expanded).filter(row => row.kind === 'native')).toHaveLength(1);
    for (const row of ownerTree(expanded).filter(row => row.kind === 'console')) expect(row.action).toMatchObject({ kind: 'ipc', op: 'openJob' });
    if (fixture.owned.release === '0.1.16') await shotText(suite, fixture.app, 'expanded-consoles');
    await fixture.app.command(command, {});
    const folded = await nativeViewState(suite, fixture.app, value => ownerTree(value).some(row => row.group?.expanded === false));
    expect(ownerTree(folded).filter(row => row.kind === 'console')).toHaveLength(0);
    expect(ownerTree(folded).filter(row => row.kind === 'native')).toHaveLength(1);
    if (fixture.owned.release === '0.1.16') await shotText(suite, fixture.app, 'folded-consoles');
    await suite.evidence('console-ipc-and-fold-state.json', { group, collapsed, expanded, folded });
  } },
  { id: storyId('H-spaces-a-notifications'), title: 'Intentional parent and child arrivals retain dismissal and quiet native policy', tiers: ['app'], async run(suite) {
    const fixture = await nativeFixture(suite), owner = await primary(suite, fixture);
    await fixture.app.command('layout.show', { id: 'panel' });
    await fixture.app.command('layout.select', { stack: 'panel-body', child: 'spider' });
    await toolCalls(suite, owner, 'notices', [
      { action: 'notify', message: 'Choose a fix', urgency: 'attention' },
      { action: 'run', agent: 'worker', name: 'notice-child', model: 'e2e-fixture/scripted', thinking: 'off', task: '[[e2e:child-notice]] Work inline. Do not start children.' },
    ], { 'child-notice': [{ steps: [{ tool: { id: 'child-notice', name: 'spider', arguments: { action: 'notify', message: 'Child choose a fix', urgency: 'attention' } } }] }, { steps: [{ text: 'fixture child complete' }] }] });
    const feed = await waitFor('real parent and child intentional notices', async () => parseFeed(await readFile(owner.feedPath, 'utf8')), value => Boolean(value?.notifications.some(notice => notice.kind === 'intentional' && notice.body === 'Choose a fix') && value.notifications.some(notice => notice.kind === 'intentional' && notice.body === 'Child choose a fix' && notice.runId)), deadline(20000));
    if (!feed) throw new HarnessError('missing-prerequisite', 'Intentional parent and child feeds were not published');
    const notices = projectNotifications([feed], Date.now());
    expect(notificationBadge(notices, new Map())).toBe(2);
    expect(notices.map(notificationText).join(' ')).toContain('Choose a fix');
    const settings = JSON.parse(await readFile(join(fixture.owned.appHome, 'settings.json'), 'utf8'));
    expect(settings.sounds.enabled).toBe(false);
    await suite.evidence('intentional-notice-state.json', { notices, badge: 2, nativeSoundEnabled: settings.sounds.enabled, screenshot: fixture.owned.release === '0.1.13' ? 'pending, screen locked' : 'captured' });
    await fixture.app.command('spider-panel.refresh', {});
    if (fixture.owned.release === '0.1.16') {
      const text = await shotText(suite, fixture.app, 'intentional-notice'); expect(text.join(' ')).toContain('Choose a fix');
    }
    try { await fixture.app.activate(`notification-dismiss:${notices[0]!.key}`); }
    catch (error) {
      if (error instanceof AppBoundaryError && error.code === 'P2-native-rendered-ui') throw new HarnessError('missing-prerequisite', 'Owned native notification dismissal input is unavailable', { cause: error.message });
      throw error;
    }
  } },
];
registerScenarios(scenarios);
