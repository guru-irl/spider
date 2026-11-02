// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
type PlacedPane = { space: string; tab: string; pane: string; terminal: string };
const placed = (world: any): PlacedPane[] => world.spaces.flatMap((space: any) => space.tabs.flatMap((tab: any) => tab.terminals.map((pane: any) => ({ space: space.id, tab: tab.id, pane: pane.pane, terminal: pane.terminal }))));
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
async function assertUserOpenSlots(suite: Suite): Promise<void> {
    await nativeGate(suite);
    const f = await installPanelFixture(suite), parent = await startPanelParent(f), main = placed(await f.app.ls()), gates = await suite.gates();
    const names = ['slots-a', 'slots-b', 'slots-c'], identities = new Map<string, ReturnType<typeof identityOf>>();
    await tools(f, parent, 'slots', [{ action: 'run', tasks: names.map(request) }], Object.fromEntries(names.map(name => [name, held(name)])) as any);
    let sidebar: Awaited<ReturnType<typeof mountPanel>> | undefined;
    try {
        for (const name of names) { const ready = await gates.ready(`held-${name}`, deadline(30000)); identities.set(name, identityOf(ready.pid)); }
        const feed = await waitFeed(parent, 'three running public children', feed => feed.runs.rows.length === 3), runs = await waitNativeViewerRuns(suite, feed);
        const automatic = placed(await f.app.ls());
        expect(automatic, 'automatic-viewers-stay-parked').toEqual(main);
        sidebar = await mountPanel(f, 'spider-agents');
        for (const run of runs.slice(0, 2)) {
            await sidebar.host.waitForUi('actual parked child action', ui => ui.nodes.some(node => node.id === `sub-${run.id}`), 20000);
            await activateChildAction(sidebar, `sub-${run.id}`, { op: 'openRun', runId: run.id });
        }
        const before = await waitFor('two user-requested slots are acknowledged', async () => placed(await f.app.ls()), panes => runs.filter(run => panes.some((pane: any) => pane.terminal === run.viewer)).length === 2, deadline(20000), { reconcileMs: 250 });
        const displayed = runs.filter(run => before.some((pane: any) => pane.terminal === run.viewer)), parked = runs.filter(run => !before.some((pane: any) => pane.terminal === run.viewer));
        expect(displayed).toHaveLength(2); expect(parked).toHaveLength(1); expect(parked[0].status).toBe('running');
        const existingAux = before.filter((pane: any) => displayed.some(run => run.viewer === pane.terminal)), callsBefore = (await appCalls(suite)).length;
        const actionsBeforeOverflow = sidebar.actions.length;
        await sidebar.host.waitForUi('actual parked child action', ui => ui.nodes.some(node => node.id === `sub-${parked[0].id}`), 20000);
        await activateChildAction(sidebar, `sub-${parked[0].id}`, { op: 'openRun', runId: parked[0].id });
        const opened = await f.app.ls() as any, after = placed(opened), newPane = after.find((pane: any) => pane.terminal === parked[0].viewer);
        expect(newPane).toBeDefined(); if (!newPane) throw new Error('Opened viewer pane is missing');
        expect(newPane.tab).not.toBe(parent.placement.tab);
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
        const unsupported = sidebar.actions.slice(actionsBeforeOverflow).filter(action => action.state === 'failed');
        const openRequests = sidebar.commands.filter(command => {
            const index = command.argv.indexOf('--request');
            if (index < 0) return false;
            const request = JSON.parse(command.argv[index + 1]);
            return request.op === 'openRun' && request.runId === parked[0].id;
        });
        expect(openRequests.map(command => command.exitCode)).toEqual([0, 0]);
        for (const action of unsupported) {
            expect(action).toMatchObject({ name: 'terminal.peek', args: { terminal: parked[0].viewer }, state: 'failed', error: { code: 'app-error', message: 'unplaced terminal peek requires a native overlay' } });
        }
        await f.app.command('tab.close', { id: newPane.tab });
        const retained = await waitFeed(parent, 'closing the view tab leaves the actual child running', value => value.runs.rows.some(run => run.id === parked[0].id && run.status === 'running'));
        expect(identityAlive(identities.get(parked[0].name!)!)).toBe(true);
        const closed = placed(await f.app.ls()); expect(closed.some((pane: any) => pane.terminal === parked[0].viewer)).toBe(false);
        expect(closed.filter((pane: any) => displayed.some(run => run.viewer === pane.terminal))).toEqual(existingAux);
        expect(mainOnly(main, closed)).toEqual(main);
        await suite.evidence('user-open-new-tab.json', { feed, retained, main, automatic, before, after, reused, closed, newTab, evictionCalls, counts: { automaticBefore: 0, visibleBeforeOverflow: 2, visibleAfterOpen: 3, originalAuxAfterOpen: 2, visibleAfterClose: 2 }, superseded: 'Eviction superseded by user ruling 2026-11-02 00:22; placement.ts:134. Old expected surviving auxiliaries 1; required now 2 in unchanged panes.' });
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
            expect(automatic, 'automatic-viewers-stay-parked').toEqual(main);
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
                if (!pane) throw new Error('Observer pane is missing');
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
                await sidebar.host.activate(`fold-left-${parent.pi.terminal}`);
                const folded = await sidebar.host.waitForUi('left chevron folds the running children', value => value.nodes.some(n => n.id === `fold-${parent.pi.terminal}`) && !value.nodes.some(n => n.id === `sub-${run.id}`), 20000);
                expect(folded.nodes.some(n => n.id === `fold-left-${parent.pi.terminal}`)).toBe(true);
                await sidebar.host.activate(`fold-${parent.pi.terminal}`);
                await sidebar.host.waitForUi('running count pill unfolds the children', value => value.nodes.some(n => n.id === `sub-${run.id}`), 20000);
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
                expect(placed(await f.app.ls()).some(row => row.terminal === run.viewer)).toBe(false);
                await sidebar.refresh();
                await sidebar.host.mouse(`sub-${run.id}`, 'right');
                const parkedMenu = await waitFor('parked viewer menu', () => sidebar.host.uiSnapshot(), ui => ui.nodes.some(node => node.id === 'move-new'), deadline(15000));
                expect(parkedMenu.nodes.some(node => node.text.includes('Open in new tab'))).toBe(true);
                await suite.evidence('parked-viewer-menu.json', { parkedMenu, feed, viewer: run.viewer });
                await sidebar.host.activate('move-new');
                const openedView = await waitFor('parked viewer opened in its tab', async () => placed(await f.app.ls()), rows => rows.some(row => row.terminal === run.viewer), deadline(20000));
                expect(openedView.find(row => row.terminal === run.viewer)?.tab).not.toBe(parent.placement.tab);
                expect(await f.app.status()).toMatchObject({ agent: run.viewer });
                await sidebar.refresh();
                await activateChildAction(sidebar, `sub-${run.id}`, { op: 'openRun', runId: run.id });
                expect(sidebar.commands.some(c => c.argv.some(arg => arg.includes('openRun') && arg.includes(run.id)))).toBe(true);
                const ownerPane = placed(await f.app.ls()).find(row => row.terminal === parent.pi.terminal);
                if (!ownerPane) throw new Error('Owner pane is unavailable');
                const target = await f.app.command('tab.new', { space: ownerPane.space, name: 'Move target' }) as { tab: string };
                await sidebar.refresh();
                await sidebar.host.mouse(`sub-${run.id}`, 'right');
                const menu = await waitFor('subagent move menu', () => sidebar.host.uiSnapshot(), ui => ui.nodes.some(node => node.id === 'move-tabs'), deadline(15000));
                expect(menu.nodes.some(node => node.text.includes('Move to tab'))).toBe(true);
                await sidebar.host.activate('move-tabs');
                await sidebar.host.waitForUi('target tab in menu', ui => ui.nodes.some(node => node.id === `move-tab-${target.tab}`), 15000);
                await sidebar.host.activate(`move-tab-${target.tab}`);
                const moved = await waitFor('viewer moved to chosen tab', async () => placed(await f.app.ls()), rows => rows.some(row => row.terminal === run.viewer && row.tab === target.tab), deadline(20000));
                expect(moved.find(row => row.terminal === run.viewer)?.tab).toBe(target.tab);
                expect(await f.app.status()).toMatchObject({ agent: run.viewer });
                await sidebar.refresh();
                await sidebar.host.mouse(`sub-${run.id}`, 'right');
                await waitFor('viewer menu after first move', () => sidebar.host.uiSnapshot(), ui => ui.nodes.some(node => node.id === 'move-new'), deadline(15000));
                await sidebar.host.activate('move-new');
                const movedAgain = await waitFor('viewer moved to a new tab', async () => placed(await f.app.ls()), rows => rows.some(row => row.terminal === run.viewer && row.tab !== target.tab), deadline(20000));
                expect(movedAgain.find(row => row.terminal === run.viewer)?.tab).not.toBe(target.tab);
                expect(await f.app.status()).toMatchObject({ agent: run.viewer });
                await writeFile(job.releasePath, 'release');
                await receipt(job);
                gates.release('held-tree-child'); childHeld = false;
                await waitFeed(parent, 'retained run completed', feed => feed.runs.rows.some((r: any) => r.id === run.id && r.status === 'done'), 30000);
                await sidebar.refresh();
                const ended = await sidebar.host.waitForUi('completed job disappears and retained run is hidden', ui => !ui.nodes.some(n => n.id === `sub-${job.id}` || n.id === `sub-${run.id}`) && ui.nodes.some(n => n.id === `sub-console:${job.console}`) && ui.nodes.some(n => n.id === `finished-toggle-${parent.pi.terminal}` && n.text.includes('1 finished')), 20000);
                await sidebar.host.activate(`finished-toggle-${parent.pi.terminal}`);
                const shown = await sidebar.host.waitForUi('finished toggle reveals retained run', ui => ui.nodes.some(n => n.id === `sub-${run.id}`) && ui.nodes.some(n => n.id === `finished-toggle-${parent.pi.terminal}` && n.text.includes('Hide finished')), 20000);
                await sidebar.host.activate(`finished-toggle-${parent.pi.terminal}`);
                const hidden = await sidebar.host.waitForUi('finished toggle hides retained run again', ui => !ui.nodes.some(n => n.id === `sub-${run.id}`) && ui.nodes.some(n => n.id === `finished-toggle-${parent.pi.terminal}` && n.text.includes('1 finished')), 20000);
                await suite.evidence('agents-tree.json', { before, ui, folded, afterObserver, ended, shown, hidden, feed, ownedRows, terminals: await coreRows(suite), appCalls: sidebar.commands, laggingSnapshot: 'console omitted at the native-read boundary only' });
            }
            finally {
                if (childHeld) gates.release('held-tree-child');
                await writeFile(job.releasePath, 'release');
                await sidebar.close();
            }
        } },
    { id: storyId('S38'), title: 'old sidebar filters do not hide duplicate-named runs or remote jobs', tiers: ['headless', 'app'], async run(suite) {
            await nativeGate(suite);
            const f = await installPanelFixture(suite), parent = await startPanelParent(f), gates = await suite.gates();
            const [created] = await tools(f, parent, 'filter-runs', [{ action: 'run', tasks: [{ ...request('filter-a'), name: 'Duplicate' }, { ...request('filter-b'), name: 'Duplicate' }] }], { 'filter-a': held('filter-a'), 'filter-b': held('filter-b') } as any);
            for (const name of ['filter-a', 'filter-b']) await gates.ready(`held-${name}`, deadline(30000));
            const feed = await waitFeed(parent, 'two actual duplicate-named runs', feed => feed.runs.rows.length === 2);
            const [a, b] = await waitNativeViewerRuns(suite, feed);
            expect(a.name).toBe('Duplicate'); expect(b.name).toBe('Duplicate'); expect(a.id).not.toBe(b.id);
            const job = await holdJob(f, parent, 'filter-job');
            const propsA = await sidebarCopy(f, 'spider-agents-a'), propsB = await sidebarCopy(f, 'spider-agents-b');
            const stateDir = suite.ownPath(join(suite.root, 'ui-state'));
            await mkdir(stateDir, { recursive: true, mode: 0o700 });
            const seed = async (id: string, value: unknown) => {
                const key = `spider.agents.filters/${id}`;
                const file = suite.ownPath(join(stateDir, createHash('sha256').update(key).digest('hex') + '.json'));
                await writeFile(file, JSON.stringify(value), { mode: 0o600 });
            };
            await seed('spider-agents-a', { machine: null, agent: `run:${a.id}` });
            await seed('spider-agents-b', { machine: 'other.invalid', agent: `run:${b.id}` });
            let copyA = await mountPanel(f, 'spider-agents-a', false, propsA), copyB = await mountPanel(f, 'spider-agents-b', false, propsB);
            try {
                const observe = async (panel: typeof copyA) => {
                    const ui = await panel.host.waitForUi('both runs and the remote console remain visible', ui =>
                        ui.nodes.some(n => n.id === `sub-${a.id}`) && ui.nodes.some(n => n.id === `sub-${b.id}`) && ui.nodes.some(n => n.id === `sub-console:${job.console}`), 20000);
                    expect(ui.nodes.filter(n => n.id === `sub-${a.id}` || n.id === `sub-${b.id}`)).toHaveLength(2);
                    expect(ui.nodes.some(n => n.id.startsWith('agents-filter-') || n.id === 'agents-clear-filters' || n.id.startsWith('machine-row-'))).toBe(false);
                    await panel.host.activate(`console-fold-console:${job.console}`);
                    const expanded = await panel.host.waitForUi('remote job appears when its console expands', ui => ui.nodes.some(n => n.id === `sub-${job.id}`), 20000);
                    expect(expanded.nodes.some(n => n.id === `sub-${a.id}`)).toBe(true);
                    expect(expanded.nodes.some(n => n.id === `sub-${b.id}`)).toBe(true);
                    return { ui, expanded };
                };
                const firstA = await observe(copyA), firstB = await observe(copyB);
                await copyA.close(); await copyB.close();
                copyA = await mountPanel(f, 'spider-agents-a', false, propsA);
                copyB = await mountPanel(f, 'spider-agents-b', false, propsB);
                const reloadA = await observe(copyA), reloadB = await observe(copyB);
                await suite.evidence('unfiltered-sidebar-copies.json', { created, feed, firstA, firstB, reloadA, reloadB, terminals: await coreRows(suite) });
            } finally {
                await writeFile(job.releasePath, 'release');
                for (const name of ['filter-a', 'filter-b']) gates.release(`held-${name}`);
                await copyA.close(); await copyB.close();
            }
        } },
];
registerScenarios(scenarios);
