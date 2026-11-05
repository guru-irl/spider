// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { paneBounds, type PaneTree } from '../harness/pane-geometry.js';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { assertSocketPath } from '../harness/environment.js';
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
async function shrinkOwner(suite: Suite, terminal: string): Promise<{ cols: number; rows: number }> {
    const socket = assertSocketPath(suite.root, join(suite.root, 'size.s'));
    const log = suite.ownPath(join(suite.root, 'size-attacher.raw'));
    const broker = fileURLToPath(new URL('../harness/pty-broker.py', import.meta.url));
    const result = await suite.hc(['run', '--json', '--bg', '--no-notify', '--outlive-parent', '--no-parent', '--', '/usr/bin/python3', broker, '--socket', socket, '--log', log, '--cols', '59', '--rows', '7', '--', suite.cores!.wrapper, 'attach', terminal]);
    expect(result.exitCode, result.stderr).toBe(0);
    const address = (result.json as { address: string }).address;
    expect(address).toBeTruthy(); suite.ledger.update(l => l.terminals.push({ side: 'local', address }));
    await waitFor('owned size attacher', async () => stat(socket).then(value => value.isSocket(), () => false), Boolean, deadline(10000));
    const hello = await new Promise<{ pid: number; brokerPid: number; terminal: string }>((resolve, reject) => {
        const connection = connect(socket); let text = '';
        connection.setTimeout(10000, () => connection.destroy(new Error('size attacher deadline')));
        connection.on('connect', () => connection.write('{"op":"hello"}\n'));
        connection.on('data', bytes => { text += bytes; if (text.includes('\n')) { connection.destroy(); resolve(JSON.parse(text.split('\n')[0])); } });
        connection.on('error', reject);
    });
    expect(hello.terminal).toBe(address);
    suite.ledger.update(l => { for (const pid of [hello.pid, hello.brokerPid]) l.processes.push({ ...identityOf(pid), label: 'size-attacher', group: false }); });
    return await waitFor('core reports the smaller owner terminal', async () => {
        const observed = await suite.hc(['get', terminal, '--json']);
        if (observed.exitCode !== 0) throw new Error('owner size unavailable');
        const row = observed.json as { cols: number; rows: number }; return { cols: row.cols, rows: row.rows };
    }, value => value.cols === 59 && value.rows === 7, deadline(10000), { reconcileMs: 100 });
}
async function assertUserOpenSlots(suite: Suite): Promise<void> {
    await nativeGate(suite);
    const f = await installPanelFixture(suite), parent = await startPanelParent(f), main = placed(await f.app.ls()), gates = await suite.gates();
    const names = ['slots-a', 'slots-b', 'slots-c'], identities = new Map<string, ReturnType<typeof identityOf>>();
    await tools(f, parent, 'slots', [{ action: 'run', tasks: names.map(request) }], Object.fromEntries(names.map(name => [name, held(name)])) as any);
    let sidebar: Awaited<ReturnType<typeof mountPanel>> | undefined;
    let smallSize: { cols: number; rows: number } | undefined;
    try {
        for (const name of names) { const ready = await gates.ready(`held-${name}`, deadline(30000)); identities.set(name, identityOf(ready.pid)); }
        const feed = await waitFeed(parent, 'three running public children', value => value.runs.rows.length === 3), runs = feed.runs.rows.map(run => ({ ...run }));
        expect((await coreRows(suite)).filter(row => row.state === 'live' && row.labels['spider.kind'] === 'subagent-viewer')).toEqual([]);
        const automatic = placed(await f.app.ls());
        expect(automatic, 'automatic-viewers-stay-absent').toEqual(main);
        const dimensions = (await coreRows(suite)).find(row => row.address === parent.pi.terminal);
        expect(dimensions.cols).toBeGreaterThanOrEqual(161); expect(dimensions.rows).toBeGreaterThanOrEqual(45);
        sidebar = await mountPanel(f, 'spider-agents');
        const openedRuns = [] as typeof runs;
        let callsBefore = 0, actionsBefore = 0;
        for (const run of runs) {
            const before = placed(await f.app.ls());
            if (openedRuns.length === 2) {
                expect(openedRuns.filter(previous => before.some(pane => pane.terminal === previous.viewer))).toHaveLength(2);
                expect(before.some(pane => pane.terminal === run.viewer)).toBe(false);
                expect(run.status).toBe('running');
                callsBefore = (await appCalls(suite)).length; actionsBefore = sidebar.actions.length;
                smallSize = await shrinkOwner(suite, parent.pi.terminal);
            }
            await sidebar.host.waitForUi('actual parked child action', ui => ui.nodes.some(node => node.id === `sub-${run.id}`), 20000);
            await activateChildAction(sidebar, `sub-${run.id}`, { op: 'openRun', runId: run.id });
            [run.viewer] = (await waitNativeViewerRuns(suite, { ...feed, runs: { ...feed.runs, rows: [run] } })).map(row => row.viewer);
            const after = await waitFor('viewer is placed', async () => placed(await f.app.ls()), panes => panes.some(pane => pane.terminal === run.viewer), deadline(20000), { reconcileMs: 250 });
            expect(after.filter(pane => openedRuns.some(previous => previous.viewer === pane.terminal)), 'user-open-preserves-existing-aux-panes').toEqual(before.filter(pane => openedRuns.some(previous => previous.viewer === pane.terminal)));
            expect(mainOnly(main, after)).toEqual(main);
            const target = after.find(pane => pane.terminal === run.viewer)!;
            if (openedRuns.length < 2) expect(target.tab).toBe(parent.placement.tab);
            else {
                const world = await f.app.ls() as any, space = world.spaces.find((space: any) => space.id === parent.placement.space);
                const ownerIndex = space.tabs.findIndex((tab: any) => tab.id === parent.placement.tab);
                expect(target.tab, 'small-owner-opens-after-owner-tab').not.toBe(parent.placement.tab);
                expect(space.tabs[ownerIndex + 1]).toMatchObject({ id: target.tab, name: run.name });
            }
            expect(await f.app.status()).toMatchObject({ tab: target.tab, agent: run.viewer });
            openedRuns.push(run);
        }
        const after = placed(await f.app.ls());
        expect(runs.filter(run => after.some(pane => pane.terminal === run.viewer))).toHaveLength(3);
        const ownerTab = (await f.app.ls() as any).spaces.flatMap((space: any) => space.tabs).find((tab: any) => tab.id === parent.placement.tab);
        let root: PaneTree | undefined = ownerTab.root;
        if (!root) {
            const reply = await suite.cores!.hc(['connect'], 'local', { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'doc.get', params: { name: 'herdr-app' } }) + '\n' });
            expect(reply.exitCode, reply.stderr).toBe(0);
            root = (reply.json as any).result.value.spaces.find((space: any) => space.id === parent.placement.space)?.tabs.find((tab: any) => tab.id === parent.placement.tab)?.root;
        }
        expect(root, 'reported-owner-tab-split-tree').toBeDefined();
        const boxes = paneBounds(root!);
        const box = (terminal: string) => boxes.find(box => box.id === after.find(pane => pane.terminal === terminal)!.pane)!;
        const ownerBox = box(parent.pi.terminal), firstBox = box(runs[0].viewer!), secondBox = box(runs[1].viewer!);
        expect(firstBox.y, 'first-viewer-is-below-owner').toBeCloseTo(ownerBox.y + ownerBox.height);
        expect(firstBox.x).toBeCloseTo(ownerBox.x);
        expect(secondBox.y, 'second-viewer-shares-the-lower-row').toBeCloseTo(firstBox.y);
        expect(secondBox.x, 'second-viewer-is-to-the-right').toBeCloseTo(firstBox.x + firstBox.width);
        await suite.evidence('viewer-split-tree.json', { root, ownerBox, firstBox, secondBox });
        const fallback = after.find(pane => pane.terminal === runs[2].viewer)!;
        await activateChildAction(sidebar, `sub-${runs[2].id}`, { op: 'openRun', runId: runs[2].id });
        expect(placed(await f.app.ls())).toEqual(after);
        expect(await f.app.status()).toMatchObject({ tab: fallback.tab, agent: runs[2].viewer });
        expect((await coreRows(suite)).filter(row => row.state === 'live' && row.labels['spider.kind'] === 'subagent-viewer' && row.labels['spider.run'] === runs[2].id)).toHaveLength(1);
        const existingAux = after.filter(pane => runs.slice(0, 2).some(run => run.viewer === pane.terminal));
        const evictionCalls = (await appCalls(suite)).slice(callsBefore).filter(call => call.name === 'terminal.park' && existingAux.some(pane => pane.terminal === call.args.terminal) || call.name === 'pane.close' && existingAux.some(pane => pane.pane === call.args.pane) || call.name === 'tab.close' && existingAux.some(pane => pane.tab === call.args.id));
        expect(evictionCalls).toEqual([]);
        await sidebar.refresh();
        await suite.evidence('native-run-actions.json', sidebar.actions);
        expect(sidebar.actions.every(action => action.state !== 'pending')).toBe(true);
        const unsupported = sidebar.actions.slice(actionsBefore).filter(action => action.state === 'failed');
        const openRequests = sidebar.commands.filter(command => {
            const index = command.argv.indexOf('--request');
            if (index < 0) return false;
            const value = JSON.parse(command.argv[index + 1]);
            return value.op === 'openRun' && value.runId === runs[2].id;
        });
        expect(openRequests.map(command => command.exitCode)).toEqual([0, 0]);
        for (const action of unsupported) expect(action).toMatchObject({ name: 'terminal.peek', args: { terminal: runs[2].viewer }, state: 'failed', error: { code: 'app-error', message: 'unplaced terminal peek requires a native overlay' } });
        const last = after.find(pane => pane.terminal === runs[2].viewer)!;
        await f.app.command('tab.close', { id: last.tab });
        const retained = await waitFeed(parent, 'closing the viewer leaves the actual child running', value => value.runs.rows.some(run => run.id === runs[2].id && run.status === 'running'));
        expect(identityAlive(identities.get(runs[2].name!)!)).toBe(true);
        const closed = placed(await f.app.ls());
        expect(closed.some(pane => pane.terminal === runs[2].viewer)).toBe(false);
        expect(closed.filter(pane => runs.slice(0, 2).some(run => run.viewer === pane.terminal))).toEqual(after.filter(pane => runs.slice(0, 2).some(run => run.viewer === pane.terminal)));
        expect(mainOnly(main, closed)).toEqual(main);
        await suite.evidence('user-open-placement.json', { feed, retained, main, automatic, after, closed, evictionCalls, smallSize, splitTree: root, dimensions: { cols: dimensions.cols, rows: dimensions.rows } });

    } finally { for (const name of names) gates.release(`held-${name}`); await sidebar?.close(); }
}

async function assertEvictionIsCaught(suite: Suite): Promise<void> {
    const from = 'if (explicit && s.kind === "subagent" && displayOptions.ownerRelative) return await showBelowOwner(s, viewer, displayOptions, viewerLabels[HERDR_LABELS.displayName], changed);';
    const to = 'if (explicit && s.kind === "subagent" && displayOptions.ownerRelative) { const victim = [...slots.values()].find(value => value.owner.sessionId === s.owner.sessionId && value.reservation); if (victim?.reservation) await release(victim.reservation); return await showBelowOwner(s, viewer, displayOptions, viewerLabels[HERDR_LABELS.displayName], changed); }';
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
            expect((await coreRows(suite)).filter(row => row.state === 'live' && row.labels['spider.kind'] === 'subagent-viewer')).toEqual([]);
            const automatic = placed(await f.app.ls());
            expect(main.length).toBeGreaterThanOrEqual(2);
            expect(mainOnly(main, automatic), 'main-pane-layout-preserved').toEqual(main);
            expect(automatic, 'automatic-viewers-stay-absent').toEqual(main);
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
    { id: storyId('S35'), title: 'automatic viewers stay absent; user opens arrange them below the owner without eviction', tiers: ['headless', 'app'], async run(suite) { await assertUserOpenSlots(suite); await assertEvictionIsCaught(suite); } },
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
                const run = { ...feed.runs.rows.find(r => r.id === created.run.id)! };
                expect((await coreRows(suite)).filter(row => row.state === 'live' && row.labels['spider.kind'] === 'subagent-viewer' && row.labels['spider.run'] === run.id)).toEqual([]);
                expect(run.ownerSessionId).toBe(parent.sessionId);
                expect(ui.nodes.filter(n => n.id === `sub-${run.id}`)).toHaveLength(1);
                expect(ui.nodes.some(n => n.id === `ag-${job.address}` || n.id === `ag-${job.console}` || n.id === `ag-${run.viewer}`)).toBe(false);
                await sidebar.host.activate(`fold-left-${parent.pi.terminal}`);
                const folded = await sidebar.host.waitForUi('left chevron folds the running children', value => value.nodes.some(n => n.id === `fold-${parent.pi.terminal}`) && !value.nodes.some(n => n.id === `sub-${run.id}`), 20000);
                expect(folded.nodes.some(n => n.id === `fold-left-${parent.pi.terminal}`)).toBe(true);
                await sidebar.host.activate(`fold-${parent.pi.terminal}`);
                await sidebar.host.waitForUi('running count pill unfolds the children', value => value.nodes.some(n => n.id === `sub-${run.id}`), 20000);
                const ownedRows = await coreRows(suite);
                for (const [address, kind, key] of [[job.address, 'exec', job.id], [job.console, 'remote-console', null]]) {
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
                run.viewer = (await waitNativeViewerRuns(suite, { ...feed, runs: { ...feed.runs, rows: [run] } }))[0].viewer;
                const launched = (await coreRows(suite)).find(row => row.address === run.viewer);
                expect(launched.labels).toMatchObject({ 'spider.kind': 'subagent-viewer', 'spider.run': run.id, 'spider.session': parent.sessionId, 'spider.owner-core': feed.owner.terminal.coreId, 'spider.owner-terminal': parent.pi.terminal });
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
            const [a, b] = feed.runs.rows;
            expect((await coreRows(suite)).filter(row => row.state === 'live' && row.labels['spider.kind'] === 'subagent-viewer')).toEqual([]);
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
