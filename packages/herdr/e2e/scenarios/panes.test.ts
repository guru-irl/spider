// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerScenarios, storyId } from '../harness/scenario.js';
import type { ScenarioDefinition } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';
import { writeDestination } from '../fixtures/payloads/index.js';
async function releasePayloadGate(suite: Suite, path: string): Promise<void> {
    if (suite.options.tier === 'remote') await writeDestination(suite, suite.cores!.machine, path, 'release');
    else await writeFile(path, 'release');
}
import { waitFor, deadline } from '../harness/wait.js';
import { createSuite } from '../harness/suite.js';
import { identityOf, identityAlive } from '../harness/resources.js';
import { packedControl, requireCaughtControl } from '../controls/packed.js';
import { installPanelFixture, startPanelParent, mountPanel, tools, holdJob, sidebarCopy, coreRows, waitFeed, waitNativeViewerRuns, activateChildAction, appCalls, payloadGate } from '../fixtures/panel-inputs.js';
async function nativeGate(suite: Suite): Promise<void> {
    if (suite.options.tier === 'app')
        await (await suite.app()).uiSnapshot();
}
const request = (name: string) => ({ agent: 'worker', name, model: 'e2e-fixture/scripted', thinking: 'off', task: `[[e2e:${name}]] Work inline. No children.` });
const held = (name: string) => [{ steps: [{ text: `work-${name}` }, { gate: `held-${name}` }] }, { steps: [{ text: `result-${name}` }] }];
const placed = (world: any) => world.spaces.flatMap((space: any) => space.tabs.flatMap((tab: any) => tab.terminals.map((pane: any) => ({ space: space.id, tab: tab.id, pane: pane.pane, terminal: pane.terminal }))));
const mainOnly = (main: ReturnType<typeof placed>, observed: ReturnType<typeof placed>) => observed.filter((pane: any) => main.some((original: any) => original.terminal === pane.terminal));
async function receipt(job: any): Promise<any> {
    return waitFor('real payload exit receipt', async () => {
        try {
            return JSON.parse(await readFile(job.result.backgroundJob.receipt, 'utf8'));
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                throw e;
            return null;
        }
    }, value => value?.exitCode === 23, deadline(20000), { reconcileMs: 250 });
}
async function select(panel: any, kind: 'machine' | 'agent', id: string): Promise<void> {
    const target = `agent-filter-${kind}-${id}`;
    await waitFor(`actual ${kind} choice ${id} is available`, async () => {
        await panel.host.activate(`agents-filter-${kind}`);
        const ui = await panel.host.uiSnapshot(), available = ui.nodes.some((node: { id: string }) => node.id === target);
        if (!available) await panel.host.activate(`agent-filter-${kind}-all`);
        return available;
    }, Boolean, deadline(20000), { reconcileMs: 250 });
    await panel.host.activate(target);
}
async function assertUserOpenSlots(suite: Suite): Promise<void> {
    await nativeGate(suite);
    const f = await installPanelFixture(suite), parent = await startPanelParent(f), main = placed(await f.app.ls()), gates = await suite.gates();
    const names = ['slots-a', 'slots-b', 'slots-c'], identities = new Map<string, ReturnType<typeof identityOf>>();
    await tools(f, parent, 'slots', [{ action: 'run', tasks: names.map(request) }], Object.fromEntries(names.map(name => [name, held(name)])) as any);
    let sidebar: Awaited<ReturnType<typeof mountPanel>> | undefined;
    try {
        for (const name of names) { const ready = await gates.ready(`held-${name}`, deadline(30000)); identities.set(name, identityOf(ready.pid)); }
        const feed = await waitFeed(parent, 'three running public children', feed => feed.runs.rows.length === 3), runs = await waitNativeViewerRuns(suite, feed);
        const before = await waitFor('exactly two automatic slots are acknowledged', async () => placed(await f.app.ls()), panes => runs.filter(run => panes.some((pane: any) => pane.terminal === run.viewer)).length === 2, deadline(20000), { reconcileMs: 250 });
        const displayed = runs.filter(run => before.some((pane: any) => pane.terminal === run.viewer)), parked = runs.filter(run => !before.some((pane: any) => pane.terminal === run.viewer));
        expect(displayed).toHaveLength(2); expect(parked).toHaveLength(1); expect(parked[0].status).toBe('running');
        const existingAux = before.filter((pane: any) => displayed.some(run => run.viewer === pane.terminal)), callsBefore = (await appCalls(suite)).length;
        sidebar = await mountPanel(f, 'spider-agents');
        await sidebar.host.waitForUi('actual parked child action', ui => ui.nodes.some(node => node.id === `sub-${parked[0].id}`), 20000);
        await activateChildAction(sidebar, `sub-${parked[0].id}`, { op: 'openRun', runId: parked[0].id });
        const opened = await f.app.ls() as any, after = placed(opened), newPane = after.find((pane: any) => pane.terminal === parked[0].viewer);
        expect(newPane).toBeDefined(); expect(newPane.tab).not.toBe(parent.placement.tab);
        const newTab = opened.spaces.flatMap((space: any) => space.tabs).find((tab: any) => tab.id === newPane.tab);
        expect(newTab.name).toBe(parked[0].name);
        expect(await f.app.status()).toMatchObject({ tab: newPane.tab, agent: parked[0].viewer });
        expect(after.filter((pane: any) => displayed.some(run => run.viewer === pane.terminal)), 'user-open-preserves-existing-aux-panes').toEqual(existingAux);
        expect(runs.filter(run => after.some((pane: any) => pane.terminal === run.viewer))).toHaveLength(3);
        expect(mainOnly(main, after)).toEqual(main);
        const evictionCalls = (await appCalls(suite)).slice(callsBefore).filter(call => call.name === 'terminal.park' && before.some((pane: any) => pane.terminal === call.args.terminal) || call.name === 'pane.close' && before.some((pane: any) => pane.pane === call.args.pane) || call.name === 'tab.close' && before.some((pane: any) => pane.tab === call.args.id));
        expect(evictionCalls).toEqual([]);
        await activateChildAction(sidebar, `sub-${parked[0].id}`, { op: 'openRun', runId: parked[0].id });
        const reused = placed(await f.app.ls()); expect(reused).toEqual(after);
        expect(await f.app.status()).toMatchObject({ tab: newPane.tab, agent: parked[0].viewer });
        expect((await coreRows(suite)).filter(row => row.state === 'live' && row.labels['spider.kind'] === 'subagent-viewer' && row.labels['spider.run'] === parked[0].id)).toHaveLength(1);
        await sidebar.refresh();
        await suite.evidence('native-run-actions.json', sidebar.actions);
        expect(sidebar.actions.every(action => action.state !== 'pending')).toBe(true);
        const unsupported = sidebar.actions.filter(action => action.state === 'failed');
        expect(unsupported.length).toBeGreaterThan(0);
        for (const action of unsupported) {
            expect(action).toMatchObject({ name: 'terminal.peek', args: { terminal: parked[0].viewer }, state: 'failed', error: { code: 'app-error', message: 'unplaced terminal peek requires a native overlay' } });
        }
        await f.app.command('tab.close', { id: newPane.tab });
        const retained = await waitFeed(parent, 'closing the view tab leaves the actual child running', value => value.runs.rows.some(run => run.id === parked[0].id && run.status === 'running'));
        expect(identityAlive(identities.get(parked[0].name!)!)).toBe(true);
        const closed = placed(await f.app.ls()); expect(closed.some((pane: any) => pane.terminal === parked[0].viewer)).toBe(false);
        expect(closed.filter((pane: any) => displayed.some(run => run.viewer === pane.terminal))).toEqual(existingAux);
        expect(mainOnly(main, closed)).toEqual(main);
        await suite.evidence('user-open-new-tab.json', { feed, retained, main, before, after, reused, closed, newTab, evictionCalls, counts: { automaticBefore: 2, visibleAfterOpen: 3, originalAuxAfterOpen: 2, visibleAfterClose: 2 }, superseded: 'Eviction superseded by user ruling 2026-11-02 00:22; placement.ts:134. Old expected surviving auxiliaries 1; required now 2 in unchanged panes.' });
    } finally { for (const name of names) gates.release(`held-${name}`); await sidebar?.close(); }
}
async function assertEvictionIsCaught(suite: Suite): Promise<void> {
    const from = 'if (explicit && displayed(g).length >= limit) return keepInTab(s, viewer, displayOptions, viewerLabels[HERDR_LABELS.displayName]);';
    const to = 'if (explicit && displayed(g).length >= limit) { const victim = displayed(g).sort((a, b) => a.displayedAt - b.displayedAt)[0]; if (victim?.reservation) await release(victim.reservation); return keepInTab(s, viewer, displayOptions, viewerLabels[HERDR_LABELS.displayName]); }';
    const control = packedControl({ packedRoot: suite.packed.root, destination: suite.ownPath(join(suite.root, 'evicting-packed')), kind: 'view-eviction', mutation: { operation: 'replace', file: 'dist/extension.js', from, to } });
    const caught = await requireCaughtControl(control, async packedRoot => {
        const childSuite = await createSuite({ tier: 'headless', story: storyId('H-s35-eviction') });
        let failure: unknown;
        try {
            const path = join(childSuite.directories.PI_CODING_AGENT_DIR, 'settings.json'), settings = JSON.parse(await readFile(path, 'utf8')) as { packages: string[] };
            settings.packages = settings.packages.map(value => value === childSuite.packed.root ? packedRoot : value); await writeFile(path, JSON.stringify(settings));
            await assertUserOpenSlots({ ...childSuite, get appConnection() { return childSuite.appConnection; }, packed: { ...childSuite.packed, root: packedRoot as Suite['packed']['root'], extension: join(packedRoot, 'dist/extension.js') as Suite['packed']['extension'] } });
        } catch (error) { failure = error; }
        const proof = await childSuite.close(); if (!proof.clean) throw new Error('eviction control cleanup not proved');
        if (failure) throw failure;
    }, /user-open-preserves-existing-aux-panes/);
    await suite.evidence('evicting-placement-control.json', { control, caught });
}

export const scenarios: readonly ScenarioDefinition[] = [
    { id: storyId('S34'), title: 'main identities survive automatic and explicitly opened auxiliary views', tiers: ['headless', 'app'], async run(suite) {
            await nativeGate(suite);
            const f = await installPanelFixture(suite), parent = await startPanelParent(f), main = placed(await f.app.ls()), originalStatus = await f.app.status(), records = (await suite.cores!.records()).length, gates = await suite.gates();
            await tools(f, parent, 'main-preservation', [{ action: 'run', tasks: ['main-a', 'main-b', 'main-c'].map(request) }], Object.fromEntries(['main-a', 'main-b', 'main-c'].map(name => [name, held(name)])) as any);
            for (const name of ['main-a', 'main-b', 'main-c'])
                await gates.ready(`held-${name}`, deadline(30000));
            const feed = await waitFeed(parent, 'three actual runs reached the public feed', feed => feed.runs.rows.length === 3);
            await waitNativeViewerRuns(suite, feed);
            const automatic = placed(await f.app.ls());
            expect(main.length).toBeGreaterThanOrEqual(2);
            expect(mainOnly(main, automatic), 'main-pane-layout-preserved').toEqual(main);
            expect(await f.app.status(), 'main-pane-focus-preserved').toMatchObject({ agent: (originalStatus as any).agent });
            const job = await holdJob(f, parent, 'main-job'), sidebar = await mountPanel(f, 'spider-agents');
            try {
                await sidebar.host.waitForUi('actual console fold control', ui => ui.nodes.some(n => n.id === `console-fold-console:${job.console}`), 20000);
                await sidebar.host.activate(`console-fold-console:${job.console}`);
                await sidebar.host.waitForUi('live job action in actual sidebar', ui => ui.nodes.some(n => n.id === `sub-${job.id}`), 20000);
                await activateChildAction(sidebar, `sub-${job.id}`, { op: 'openJob', jobId: job.id });
                await sidebar.host.waitForUi('console action in actual sidebar', ui => ui.nodes.some(n => n.id === `sub-console:${job.console}`), 20000);
                await activateChildAction(sidebar, `sub-console:${job.console}`, { op: 'openJob', jobId: `console:${job.console}` });
                const after = placed(await f.app.ls());
                expect(mainOnly(main, after), 'main-pane-layout-preserved').toEqual(main);
                const writes = (await suite.cores!.records()).slice(records).filter(r => ['label', 'keep', 'kill', 'rm', 'keys', 'send'].includes(r.argv[0]) && main.some((p: any) => p.terminal === r.argv[1]));
                expect(writes).toEqual([]);
                await suite.evidence('main-identities.json', { main, automatic, after, originalStatus, feed, appCalls: sidebar.commands, mainTargetedMutations: writes, nativeGeometry: { status: 'blocked', code: 'P2-native-rendered-ui' } });
            }
            finally {
                await writeFile(job.releasePath, 'release');
                for (const name of ['main-a', 'main-b', 'main-c'])
                    gates.release(`held-${name}`);
                await sidebar.close();
            }
        } },
    { id: storyId('S35'), title: 'automatic viewers park; user opens focus or create a named tab without eviction', tiers: ['headless', 'app'], async run(suite) { await assertUserOpenSlots(suite); await assertEvictionIsCaught(suite); } },
    { id: storyId('S36'), title: 'a read-only command observer can close and reopen complete output without cancelling its job', tiers: ['headless', 'remote', 'app'], async run(suite) {
            await nativeGate(suite);
            const f = await installPanelFixture(suite), parent = await startPanelParent(f), job = await holdJob(f, parent, 'observer-job'), sidebar = await mountPanel(f, 'spider-agents');
            try {
                await sidebar.host.waitForUi('console fold is rendered', ui => ui.nodes.some(n => n.id === `console-fold-console:${job.console}`), 20000);
                await sidebar.host.activate(`console-fold-console:${job.console}`);
                await sidebar.host.waitForUi('live command row', ui => ui.nodes.some(n => n.id === `sub-${job.id}`), 20000);
                await activateChildAction(sidebar, `sub-${job.id}`, { op: 'openJob', jobId: job.id });
                const observer = await waitFor('actual read-only observer terminal', () => coreRows(suite), rows => rows.some(r => r.labels['spider.kind'] === 'remote-observer' && r.labels['spider.job'] === job.id), deadline(20000), { reconcileMs: 250 });
                const row = observer.find(r => r.labels['spider.kind'] === 'remote-observer' && r.labels['spider.job'] === job.id), pane = placed(await f.app.ls()).find((p: any) => p.terminal === row.address);
                expect(pane).toBeDefined();
                await f.app.command('pane.close', { pane: pane.pane });
                expect((await suite.hc(['get', job.address, '--json'])).json).toMatchObject({ state: 'live' });
                await releasePayloadGate(suite, job.releasePath);
                const exit = await receipt(job);
                expect(exit.exitCode).toBe(23);
                // A user click from the last native snapshot is still sent through the real endpoint.
                // The endpoint must serve retained output even when that job completed meanwhile.
                await activateChildAction(sidebar, `sub-${job.id}`, { op: 'openJob', jobId: job.id });
                const reopened = await waitFor('reopened retained output viewer', () => coreRows(suite), rows => rows.some(r => r.state === 'live' && r.labels['spider.kind'] === 'remote-observer' && r.labels['spider.job'] === job.id && r.address !== row.address), deadline(20000), { reconcileMs: 250 });
                const live = reopened.find(r => r.state === 'live' && r.labels['spider.kind'] === 'remote-observer' && r.labels['spider.job'] === job.id && r.address !== row.address)!;
                const read = await suite.hc(['read', live.address, '--lines', '1000']);
                expect(read.exitCode).toBe(0);
                for (const marker of ['first-observer-job', 'output-observer-job-0', 'output-observer-job-149', 'last-observer-job'])
                    expect(read.stdout).toContain(marker);
                expect((await suite.hc(['get', job.address, '--json'])).json).toMatchObject({ state: 'finished', exit_code: 23 });
                await suite.evidence('observer-lifetime.json', { job, observer: row, reopened: live, exit, read, actualAppCalls: sidebar.commands, render: await sidebar.host.uiSnapshot() });
            }
            finally {
                await releasePayloadGate(suite, job.releasePath);
                await sidebar.close();
            }
        } },
    { id: storyId('S37'), title: 'the installed tree owns each run and nests console work without observer duplicates', tiers: ['headless', 'app'], async run(suite) {
            await nativeGate(suite);
            const f = await installPanelFixture(suite), parent = await startPanelParent(f), gates = await suite.gates();
            const [created] = await tools(f, parent, 'tree-run', [{ action: 'run', ...request('tree-child') }], { 'tree-child': held('tree-child') } as any);
            await gates.ready('held-tree-child', deadline(30000));
            const job = await holdJob(f, parent, 'tree-job'), sidebar = await mountPanel(f, 'spider-agents');
            let childHeld = true;
            try {
                sidebar.suppressConsoleSnapshot.enabled = true;
                await sidebar.refresh();
                const before = await sidebar.host.waitForUi('live job remains before native console discovery', ui => ui.nodes.some(n => n.id === `sub-${job.id}`), 20000);
                expect(before.nodes.filter(n => n.id === `sub-${job.id}`)).toHaveLength(1);
                sidebar.suppressConsoleSnapshot.enabled = false;
                await sidebar.refresh();
                const ui = await sidebar.host.waitForUi('actual console row after discovery', ui => ui.nodes.some(n => n.id === `sub-console:${job.console}`), 20000);
                const feed = await waitFeed(parent, 'exact owned run summary', feed => feed.runs.rows.some((r: any) => r.id === created.run.id));
                const run = (await waitNativeViewerRuns(suite, feed)).find(r => r.id === created.run.id)!;
                expect(run.ownerSessionId).toBe(parent.sessionId);
                expect(ui.nodes.filter(n => n.id === `sub-${run.id}`)).toHaveLength(1);
                expect(ui.nodes.some(n => n.id === `ag-${job.address}` || n.id === `ag-${job.console}` || n.id === `ag-${run.viewer}`)).toBe(false);
                const ownedRows = await coreRows(suite);
                for (const [address, kind, key] of [[run.viewer, 'subagent-viewer', run.id], [job.address, 'exec', job.id], [job.console, 'remote-console', null]]) {
                    const row = ownedRows.find(row => row.address === address);
                    expect(row).toBeDefined();
                    expect(row.labels).toMatchObject({ 'spider.kind': kind, 'spider.session': parent.sessionId, 'spider.owner-core': feed.owner.terminal.coreId, 'spider.owner-terminal': parent.pi.terminal });
                    if (key)
                        expect(row.labels[kind === 'subagent-viewer' ? 'spider.run' : 'spider.job']).toBe(key);
                }
                await sidebar.host.activate(`console-fold-console:${job.console}`);
                await sidebar.host.waitForUi('expanded console preserves live job', ui => ui.nodes.some(n => n.id === `sub-${job.id}`), 20000);
                await activateChildAction(sidebar, `sub-${job.id}`, { op: 'openJob', jobId: job.id });
                expect(sidebar.commands.some(c => c.argv.some(arg => arg.includes('openJob') && arg.includes(job.id)))).toBe(true);
                const afterObserver = await sidebar.host.uiSnapshot(), observers = (await coreRows(suite)).filter(row => row.labels['spider.kind'] === 'remote-observer');
                expect(observers.length).toBeGreaterThan(0);
                for (const row of observers)
                    expect(afterObserver.nodes.some(n => n.id === `ag-${row.address}`)).toBe(false);
                await activateChildAction(sidebar, `sub-console:${job.console}`, { op: 'openJob', jobId: `console:${job.console}` });
                expect(sidebar.commands.some(c => c.argv.some(arg => arg.includes('openJob') && arg.includes(`console:${job.console}`)))).toBe(true);
                await activateChildAction(sidebar, `sub-${run.id}`, { op: 'openRun', runId: run.id });
                expect(sidebar.commands.some(c => c.argv.some(arg => arg.includes('openRun') && arg.includes(run.id)))).toBe(true);
                await writeFile(job.releasePath, 'release');
                await receipt(job);
                gates.release('held-tree-child'); childHeld = false;
                await waitFeed(parent, 'retained run completed', feed => feed.runs.rows.some((r: any) => r.id === run.id && r.status === 'done'), 30000);
                await sidebar.refresh();
                const ended = await sidebar.host.waitForUi('completed job disappears while console and retained run remain', ui => !ui.nodes.some(n => n.id === `sub-${job.id}`) && ui.nodes.some(n => n.id === `sub-console:${job.console}`) && ui.nodes.some(n => n.id === `sub-${run.id}`), 20000);
                await suite.evidence('agents-tree.json', { before, ui, afterObserver, ended, feed, ownedRows, terminals: await coreRows(suite), appCalls: sidebar.commands, laggingSnapshot: 'console omitted at the native-read boundary only' });
            }
            finally {
                if (childHeld) gates.release('held-tree-child');
                await writeFile(job.releasePath, 'release');
                await sidebar.close();
            }
        } },
    { id: storyId('S38'), title: 'real filter controls keep sidebar copies independent and use IDs for duplicate names', tiers: ['headless', 'app'], async run(suite) {
            await nativeGate(suite);
            const f = await installPanelFixture(suite), parent = await startPanelParent(f), gates = await suite.gates();
            const [created] = await tools(f, parent, 'filter-runs', [{ action: 'run', tasks: [{ ...request('filter-a'), name: 'Duplicate' }, { ...request('filter-b'), name: 'Duplicate' }] }], { 'filter-a': held('filter-a'), 'filter-b': held('filter-b') } as any);
            for (const name of ['filter-a', 'filter-b'])
                await gates.ready(`held-${name}`, deadline(30000));
            const feed = await waitFeed(parent, 'two actual duplicate-named runs', feed => feed.runs.rows.length === 2);
            const [a, b] = await waitNativeViewerRuns(suite, feed);
            expect(a.name).toBe('Duplicate');
            expect(b.name).toBe('Duplicate');
            expect(a.id).not.toBe(b.id);
            const job = await holdJob(f, parent, 'filter-job');
            const propsA = await sidebarCopy(f, 'spider-agents-a'), propsB = await sidebarCopy(f, 'spider-agents-b');
            let copyA = await mountPanel(f, 'spider-agents-a', false, propsA), copyB = await mountPanel(f, 'spider-agents-b', false, propsB);
            try {
                for (const panel of [copyA, copyB])
                    await panel.host.waitForUi('actual duplicate run rows', ui => ui.nodes.some(n => n.id === `sub-${a.id}`) && ui.nodes.some(n => n.id === `sub-${b.id}`), 20000);
                const duplicateOptions = (ui: Awaited<ReturnType<typeof copyA.host.uiSnapshot>>) => ui.nodes.filter(n => n.id.startsWith('agent-filter-agent-run:') && n.text.includes('Duplicate'));
                const options = await waitFor('actual duplicate filter choices after async feed loading', async () => {
                    await copyA.host.activate('agents-filter-agent');
                    const ui = await copyA.host.uiSnapshot();
                    if (duplicateOptions(ui).length !== 2) await copyA.host.activate('agent-filter-agent-all');
                    return ui;
                }, ui => duplicateOptions(ui).length === 2, deadline(20000), { reconcileMs: 250 });
                expect(duplicateOptions(options)).toHaveLength(2);
                await copyA.host.activate(`agent-filter-agent-run:${a.id}`);
                await select(copyB, 'agent', `run:${b.id}`);
                expect((await copyA.host.uiSnapshot()).nodes.some(n => n.id === `sub-${a.id}`)).toBe(true);
                expect((await copyA.host.uiSnapshot()).nodes.some(n => n.id === `sub-${b.id}`)).toBe(false);
                expect((await copyB.host.uiSnapshot()).nodes.some(n => n.id === `sub-${b.id}`)).toBe(true);
                expect((await copyB.host.uiSnapshot()).nodes.some(n => n.id === `sub-${a.id}`)).toBe(false);
                await copyA.close();
                await copyB.close();
                copyA = await mountPanel(f, 'spider-agents-a', false, propsA);
                copyB = await mountPanel(f, 'spider-agents-b', false, propsB);
                await copyA.host.waitForUi('copy A filter persisted after real mod reload', ui => ui.nodes.some(n => n.id === `sub-${a.id}`) && !ui.nodes.some(n => n.id === `sub-${b.id}`), 20000);
                await copyB.host.waitForUi('copy B filter persisted independently', ui => ui.nodes.some(n => n.id === `sub-${b.id}`) && !ui.nodes.some(n => n.id === `sub-${a.id}`), 20000);
                await select(copyA, 'agent', 'all');
                await copyA.host.activate('agents-filter-machine');
                const machineOptions = await copyA.host.uiSnapshot();
                expect(machineOptions.nodes.some(n => n.id === `agent-filter-machine-${suite.cores!.machine}`)).toBe(true);
                expect(machineOptions.nodes.some(n => n.id === 'agent-filter-machine-all')).toBe(true);
                await copyA.host.activate(`agent-filter-machine-${suite.cores!.machine}`);
                const intersection = await copyA.host.uiSnapshot();
                expect(intersection.nodes.some(n => n.id === `ag-${parent.pi.terminal}`)).toBe(true);
                expect(intersection.nodes.some(n => n.id === `sub-${a.id}` || n.id === `sub-${b.id}`)).toBe(false);
                await select(copyA, 'agent', `session:${parent.sessionId}`);
                await copyA.host.waitForUi('matching remote console ancestor', ui => ui.nodes.some(n => n.id === `sub-console:${job.console}`) && ui.nodes.some(n => n.id === `ag-${parent.pi.terminal}`), 20000);
                await copyA.host.activate(`console-fold-console:${job.console}`);
                const combined = await copyA.host.waitForUi('matching live job under its console', ui => ui.nodes.some(n => n.id === `sub-${job.id}`), 20000);
                expect(combined.nodes.some(n => n.id === `sub-${a.id}` || n.id === `sub-${b.id}`)).toBe(false);
                expect((await copyB.host.uiSnapshot()).nodes.some(n => n.id === `sub-${b.id}`)).toBe(true);
                expect((await copyB.host.uiSnapshot()).nodes.some(n => n.id === `sub-console:${job.console}`)).toBe(false);
                await copyA.close();
                await copyB.close();
                copyA = await mountPanel(f, 'spider-agents-a', false, propsA);
                copyB = await mountPanel(f, 'spider-agents-b', false, propsB);
                const combinedReload = await copyA.host.waitForUi('combined filter survives mod reload', ui => ui.nodes.some(n => n.id === `sub-console:${job.console}`) && !ui.nodes.some(n => n.id === `sub-${a.id}` || n.id === `sub-${b.id}`), 20000);
                await copyB.host.waitForUi('other copy remains on its independent run filter', ui => ui.nodes.some(n => n.id === `sub-${b.id}`) && !ui.nodes.some(n => n.id === `sub-${a.id}` || n.id === `sub-console:${job.console}`), 20000);
                await select(copyA, 'machine', 'all');
                await select(copyA, 'agent', 'all');
                const resetA = await copyA.host.waitForUi('All machines and All agents restore both runs', ui => ui.nodes.some(n => n.id === `sub-${a.id}`) && ui.nodes.some(n => n.id === `sub-${b.id}`), 20000);
                expect((await copyB.host.uiSnapshot()).nodes.some(n => n.id === `sub-${a.id}`)).toBe(false);
                await select(copyB, 'machine', 'all');
                await select(copyB, 'agent', 'all');
                const resetB = await copyB.host.waitForUi('second copy independently resets both selectors', ui => ui.nodes.some(n => n.id === `sub-${a.id}`) && ui.nodes.some(n => n.id === `sub-${b.id}`), 20000);
                await suite.evidence('independent-filters.json', { created, feed, options, machineOptions, intersection, combined, combinedReload, resetA, resetB, terminals: await coreRows(suite) });
            }
            finally {
                await writeFile(job.releasePath, 'release');
                for (const name of ['filter-a', 'filter-b'])
                    gates.release(`held-${name}`);
                await copyA.close();
                await copyB.close();
            }
        } },
];
registerScenarios(scenarios);
