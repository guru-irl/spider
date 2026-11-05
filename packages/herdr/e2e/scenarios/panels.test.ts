// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { identityAlive } from '../harness/resources.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerScenarios, storyId } from '../harness/scenario.js';
import type { ScenarioDefinition } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';
import { HarnessError } from '../harness/environment.js';
import { waitFor, deadline } from '../harness/wait.js';
import { spawnOwned, jsonLines } from '../harness/processes.js';
import { counterInput, appCalls, installPanelFixture, startPanelParent, mountPanel, tools, readFeed, waitFeed, waitNativeViewerRuns, activateChildAction, holdJob, coreRows } from '../fixtures/panel-inputs.js';
async function disconnectOwnedVia(suite: Suite): Promise<() => Promise<void>> {
    const directory = suite.ledger.read().viaDirectory;
    if (!directory || directory !== join(suite.root, 'via-processes')) throw new HarnessError('missing-prerequisite', 'disconnect requires the registered local destination transport');
    const wrapper = suite.ownPath(join(suite.root, 'bin/via-d')), original = await readFile(wrapper);
    const replacement = suite.ownPath(wrapper + '.disconnected');
    await writeFile(replacement, '#!/bin/sh\nprintf "fixture transport intentionally disconnected\\n" >&2\nexit 94\n', { mode: 0o700 });
    await rename(replacement, wrapper);
    const stopped: unknown[] = [];
    for (const name of await readdir(directory)) {
        if (!/^\d+\.json$/.test(name)) continue;
        const registration = JSON.parse(await readFile(suite.ownPath(join(directory, name)), 'utf8')) as { pid: number; start: string; child?: { pid: number; start: string } };
        for (const identity of [registration.child, registration]) if (identity && identityAlive(identity)) { process.kill(identity.pid, 'SIGTERM'); stopped.push(identity); }
    }
    await suite.evidence('disconnected-owned-via.json', { wrapper, directory, stopped });
    return async () => { await writeFile(replacement, original, { mode: 0o700 }); await rename(replacement, wrapper); };
}
async function nativeGate(suite: Suite): Promise<void> {
    if (suite.options.tier === 'app')
        await (await suite.app()).uiSnapshot();
}
const text = (ui: {
    nodes: readonly {
        text: string;
    }[];
}) => ui.nodes.map(n => n.text).join('\n');
const child = (name: string) => ({ agent: 'worker', name, model: 'e2e-fixture/scripted', thinking: 'off', task: `[[e2e:${name}]] Work inline. Do not start children.` });
// The panel re-reads feed snapshots (`node -e <reader> <feed root>`) whenever a session feed changes, so a click's count leaves those out.
const actionCommands = (panel: { commands: readonly { argv: readonly string[] }[] }) => panel.commands.filter(command => command.argv[0] !== '-e');
async function budgetCase(outer: Suite, threshold: '80' | '100'): Promise<void> {
    const { createSuite } = await import('../harness/suite.js');
    const suite = await createSuite({ tier: 'headless', story: storyId(`S41-${threshold}`) });
    try {
        const f = await installPanelFixture(suite), socket = suite.ownPath(join(suite.root, 'q.s')), config = suite.ownPath(join(suite.root, 'counter.json'));
        await writeFile(config, JSON.stringify({ root: suite.root, socket, body: counterInput(threshold), holdFirst: true, logPath: join(suite.root, 'counter-requests.jsonl') }), { mode: 0o600 });
        await writeFile(join(suite.directories.PI_CODING_AGENT_DIR, 'auth.json'), JSON.stringify({ 'github-copilot': { type: 'oauth', refresh: 'fixture-only-oauth', access: 'fixture-only-access', expires: 0 } }), { mode: 0o600 });
        const launcher = await readFile(suite.pi.launcher, 'utf8');
        if (launcher.split('\nexec ').length !== 2)
            throw new HarnessError('fixture-launcher-anchor', 'owned launcher needs one exec anchor');
        await writeFile(suite.pi.launcher, launcher.replace('\nexec ', `\nexport SPIDER_HERDR_E2E_COUNTER_SOCKET='${socket}'\nexec `), { mode: 0o700 });
        const server = spawnOwned(suite.ledger, { label: 'fixture-counter', command: process.execPath, args: [fileURLToPath(new URL('../fixtures/counter-server.mjs', import.meta.url)), config], env: { ...suite.env }, cwd: suite.root, stdio: 'pipe' });
        const observed: Record<string, unknown>[] = [];
        server.child.stdout!.on('data', jsonLines(value => observed.push(value as Record<string, unknown>), (_line, error) => { throw error; }));
        await waitFor('private counter socket ready', () => observed, rows => rows.some(r => r.type === 'counter-ready'), deadline(15000));
        const parent = await startPanelParent(f, 'budget-owner');
        await tools(f, parent, `budget-config-${threshold}`, [{ action: 'control', command: 'config', op: 'set', scope: 'global', key: 'usage.monthlyBudget', value: 100 }]);
        const panel = await mountPanel(f, 'spider-panel');
        try {
            await panel.host.waitForUi('panel subscribed before budget input', ui => ui.nodes.some(n => n.id === `session-${parent.sessionId}`), 20000);
            expect(panel.posts).toEqual([]);
            const second = await startPanelParent(f, 'budget-second');
            await tools(f, second, `budget-second-config-${threshold}`, [{ action: 'control', command: 'config', op: 'set', scope: 'global', key: 'usage.monthlyBudget', value: 100 }]);
            await tools(f, parent, `budget-poll-${threshold}`, [{ action: 'control', command: 'config', op: 'set', scope: 'global', key: 'usage.counter.poll', value: true }]);
            await waitFor('real usage worker requested first counter', () => observed, rows => rows.some(r => r.type === 'counter-request' && r.seq === 1), deadline(15000));
            server.child.stdin!.write('{"op":"release","seq":1}\n');
            await tools(f, second, `budget-second-poll-${threshold}`, [{ action: 'control', command: 'config', op: 'set', scope: 'global', key: 'usage.counter.poll', value: true }]);
            const secondFeed = await waitFeed(second, 'second real session observes shared account reading', feed => feed.pace.used === Number(threshold), 45000);
            const feed = await waitFeed(parent, 'real host computed budget threshold', feed => feed.pace.used === Number(threshold) && feed.pace.budget === 100, 45000);
            expect(feed.pace.remaining).toBe(100 - Number(threshold));
            const stable = `budget:${feed.pace.periodStart}:${threshold}`;
            expect(feed.notifications.filter(n => n.kind === 'budget')).toEqual([]);
            expect(secondFeed.notifications.filter(n => n.kind === 'budget')).toEqual([]);
            // Pace shows in the panel's bar; a budget crossing never posts a toast.
            await panel.refresh();
            await panel.host.waitForUi('panel reads the crossed budget', ui => ui.nodes.some(n => n.id === 'spider-pace'), 15000);
            expect(panel.posts.filter(p => p.action?.name?.includes(encodeURIComponent(stable)))).toEqual([]);
            expect(panel.posts).toEqual([]);
            expect(panel.actions.filter(a => a.name === 'pane.focus')).toEqual([]);
            await panel.close();
            const reloaded = await mountPanel(f, 'spider-panel');
            try {
                await reloaded.host.waitForUi('mod reload reads the selected native-space budget owner', ui => ui.nodes.some(n => n.id === `session-${second.sessionId}`), 20000);
                expect((await reloaded.host.uiSnapshot()).nodes.some(n => n.id === `session-${parent.sessionId}`)).toBe(false);
                expect(reloaded.posts).toEqual([]);
            }
            finally {
                await reloaded.close();
            }
            const logs = await readFile(join(suite.root, 'counter-requests.jsonl'), 'utf8');
            expect(logs).not.toContain('fixture-only-oauth');
            expect(logs).not.toContain('Authorization');
            await suite.evidence(`budget-${threshold}.json`, { feed, secondFeed, posts: panel.posts, requests: logs, projected: { status: 'retired by design', reason: 'The projected-budget case is covered by the host unit test, not the live UI story' } });
            await outer.evidence(`budget-${threshold}-evidence.json`, { path: suite.evidenceDirectory, cleanupProof: suite.cleanupProofPath });
        }
        finally {
            await panel.close();
            server.child.stdin!.end();
        }
    }
    finally {
        const proof = await suite.close();
        expect(proof.clean).toBe(true);
    }
}
export const scenarios: readonly ScenarioDefinition[] = [
    { id: storyId('S39'), title: 'real tools supply owned panel rows and unavailable account usage', tiers: ['headless', 'app'], async run(suite) {
            await nativeGate(suite);
            const f = await installPanelFixture(suite), parent = await startPanelParent(f);
            const triggerAt = new Date(Date.now() + 1800000).toISOString();
            const results = await tools(f, parent, 'panel-data', [
                { action: 'todo', op: 'add', text: 'Review the fixture output' },
                { action: 'schedule', name: 'fixture-future', at: triggerAt, prompt: 'Review fixture output' },
                { action: 'run', ...child('panel-child') },
                { action: 'remember', content: 'Fixture convention for this repository', category: 'convention', justification: 'Durable fixture convention for repository agents', auto: true },
                { action: 'remember', scope: 'global', content: 'Fixture convention shared by all fixture repositories', category: 'convention', justification: 'Durable fixture convention for every repository', auto: true },
            ], { 'panel-child': [{ steps: [{ text: 'real child work marker' }, { gate: 'panel-child-held' }] }, { steps: [{ text: 'real child result' }] }] });
            const gates = await suite.gates();
            await gates.ready('panel-child-held', deadline(30000));
            const second = await startPanelParent(f, 'panel-second'); await f.app.command('pane.focus',{terminal:parent.placement.terminal});
            const panel = await mountPanel(f, 'spider-panel');
            try {
                const feed = await waitFeed(parent, 'tools reached the public panel feed', feed => feed.todos.rows.some((t: any) => t.text === 'Review the fixture output') && feed.triggers.some((t: any) => t.name === 'fixture-future') && feed.runs.rows.some((r: any) => r.name === 'panel-child') && feed.approvals.length >= 2);
                await panel.host.waitForUi('owned session summary rendered', ui => ui.nodes.some(n => n.id === `session-${parent.sessionId}`), 20000);
                await panel.host.activate(`session-head-${parent.sessionId}`);
                const ui = await panel.host.waitForUi('actual tool summaries, todo and trigger rendered', ui => text(ui).includes('Review the fixture output') && text(ui).includes('fixture-future') && ui.nodes.some(node => JSON.stringify(node.attributes?.tooltip) === JSON.stringify(['1 live subagent'])), 20000);
                expect(feed.todos.rows.filter((t: any) => !t.done)).toHaveLength(1);
                expect(feed.todos.total).toBe(1);
                expect(feed.runs.total).toBe(1);
                expect(feed.runs.rows.filter((r: any) => r.status === 'running')).toHaveLength(1);
                expect(feed.runs.rows[0].id).toBe(results[2].run.id);
                expect(feed.triggers).toHaveLength(1);
                expect(feed.triggers[0]).toMatchObject({ name: 'fixture-future', nextAt: Date.parse(triggerAt), prompt: 'Review fixture output' });
                const shared = feed.approvals.find(row => row.scope === 'global')!;
                expect(shared).toBeDefined();
                const secondFeed = await waitFeed(second, 'shared global approval reaches the second actual feed', value => value.approvals.some(row => row.scope === shared.scope && row.repoKey === shared.repoKey && row.uuid === shared.uuid));
                expect(feed.owner.sessionId).toBe(parent.sessionId);
                expect(secondFeed.owner.sessionId).toBe(second.sessionId);
                expect(feed.owner.terminal.address).toBe(parent.pi.terminal);
                expect(secondFeed.owner.terminal.address).toBe(second.pi.terminal);
                expect(ui.nodes.some(node => node.id === `session-${second.sessionId}`)).toBe(false);
                const approvals = await panel.host.waitForUi('aggregate memory review count rendered once', value => value.nodes.some(node => node.id === 'need-memory' && node.text.trim() === `${feed.approvals.length} memories to review`), 20000);
                expect(approvals.nodes.filter(node => node.id === 'need-memory')).toHaveLength(1);
                await f.app.command('pane.focus', { terminal: second.pi.terminal }); await panel.refresh();
                const otherSpace = await panel.host.waitForUi('selected space owns only its own session row', value => value.nodes.some(node => node.id === `session-${second.sessionId}`) && !value.nodes.some(node => node.id === `session-${parent.sessionId}`), 20000);
                await f.app.command('pane.focus', { terminal: parent.pi.terminal }); await panel.refresh();
                await panel.host.waitForUi('returning to first space restores only its owner', value => value.nodes.some(node => node.id === `session-${parent.sessionId}`) && !value.nodes.some(node => node.id === `session-${second.sessionId}`), 20000);
                await suite.evidence('panel-scope-and-approvals.json', { feed, secondFeed, approvals, otherSpace, retired: [
                    { control: 'individual memory controls', reason: 'The panel uses one aggregate memory-review action' },
                    { control: 'multi-space grouping', reason: 'The panel uses the selected space, and both directions are checked' },
                ] });
                expect(feed.pace.used).toBeNull();
                expect(ui.nodes.find(node => node.id === 'spider-pace')?.text).toBe('Usage unavailable');
                expect(new Set(feed.approvals.map((a: any) => `${a.scope}:${a.repoKey}:${a.uuid}`)).size).toBe(feed.approvals.length);
                await suite.evidence('panel-data-and-render.json', { results, feed, ui });
            }
            finally {
                gates.release('panel-child-held');
                await panel.close();
            }
        } },
    { id: storyId('S40'), title: 'panel controls call real views without touching the owned draft', tiers: ['headless', 'app'], async run(suite) {
            await nativeGate(suite);
            const f = await installPanelFixture(suite), parent = await startPanelParent(f), panel = await mountPanel(f, 'spider-panel'), sidebar = await mountPanel(f, 'spider-agents'), gates = await suite.gates();
            try {
                await panel.host.waitForUi('real owner row', ui => ui.nodes.some(n => n.id === `session-${parent.sessionId}`), 20000);
                await panel.host.activate(`session-head-${parent.sessionId}`);
                const [created] = await tools(f, parent, 'view-run', [{ action: 'run', ...child('view-child') }], { 'view-child': [{ steps: [{ text: 'view child work' }, { gate: 'view-child-held' }] }, { steps: [{ text: 'view child result' }] }] });
                await gates.ready('view-child-held', deadline(30000));
                const feed = await waitFeed(parent, 'real view action run', feed => feed.runs.rows.some(row => row.id === created.run.id));
                const run = { ...feed.runs.rows.find(row => row.id === created.run.id)! };
                expect(run.ownerSessionId).toBe(parent.sessionId);
                await sidebar.refresh();
                await sidebar.host.waitForUi('real owned run rendered in Agents', ui => ui.nodes.some(node => node.id === `sub-${run.id}`), 20000);
                const viewers = (world: any) => world.spaces.flatMap((space: any) => space.tabs.flatMap((tab: any) => tab.terminals.filter((pane: any) => pane.terminal === run.viewer)));
                expect((await coreRows(suite)).filter(row => row.state === 'live' && row.labels['spider.kind'] === 'subagent-viewer' && row.labels['spider.run'] === run.id)).toEqual([]);
                await activateChildAction(sidebar, `sub-${run.id}`, { op: 'openRun', runId: run.id });
                run.viewer = (await waitNativeViewerRuns(suite, { ...feed, runs: { ...feed.runs, rows: [run] } }))[0].viewer;
                const beforeRun = await waitFor('explicit viewer placement before reuse', () => f.app.ls(), world => viewers(world).length === 1, deadline(20000), { reconcileMs: 250 });
                await activateChildAction(sidebar, `sub-${run.id}`, { op: 'openRun', runId: run.id });
                await activateChildAction(sidebar, `sub-${run.id}`, { op: 'openRun', runId: run.id });
                const afterRun = await f.app.ls() as any;
                expect(viewers(beforeRun)).toHaveLength(1);
                expect(viewers(afterRun)).toEqual(viewers(beforeRun));
                await suite.evidence('run-action-reuse.json', { run, beforeRun, afterRun, commands: sidebar.commands });
                await parent.pi.key('draft 界🙂');
                await parent.pi.key('\x1b[D');
                const draft = await parent.pi.draft();
                const offset = (await parent.pi.rawOutput()).length;
                const link = (await panel.host.uiSnapshot()).nodes.find(node => node.id === `view-${parent.sessionId}-todos`);
                expect(link?.text.trim()).toBe('All todos, runs and usage');
                const beforeEnabledClick = actionCommands(panel).length;
                await panel.host.activate(`view-${parent.sessionId}-todos`);
                // The link opens the in-panel session view; nothing is asked of pi.
                await panel.host.waitForUi('single panel link opens the in-panel session view', ui => ui.nodes.some(node => node.id === 'session-view-todos') && ui.nodes.some(node => node.id === 'session-back'), 15000);
                expect(actionCommands(panel)).toHaveLength(beforeEnabledClick);
                expect((await parent.pi.rawOutput()).length).toBe(offset);
                await panel.host.activate('session-back');
                await panel.host.waitForUi('back returns to the session list', ui => ui.nodes.some(node => node.id === `view-${parent.sessionId}-todos`), 15000);
                expect(await parent.pi.draft()).toBe(draft);
                await parent.pi.key('\x1b[27u');
                await parent.pi.key('X');
                expect(await waitFor('typed character proves the preserved multibyte cursor', () => parent.pi.draft(), value => value === 'draft 界X🙂', deadline(10000))).toBe('draft 界X🙂');
                await parent.pi.close();
                const retained = await panel.host.waitForUi('retained owner keeps its feed-backed view link', ui => ui.nodes.some(node => node.id === `view-${parent.sessionId}-todos`) && ui.nodes.some(node => JSON.stringify(node.attributes?.tooltip) === JSON.stringify(['closed: owner unavailable'])), 20000);
                const beforeClosedClick = actionCommands(panel).length, before = panel.actions.length;
                await panel.host.activate(`view-${parent.sessionId}-todos`);
                await panel.host.waitForUi('closed owner data still opens in the panel', ui => ui.nodes.some(node => node.id === 'session-view-todos'), 15000);
                expect(actionCommands(panel)).toHaveLength(beforeClosedClick);
                expect(panel.actions).toHaveLength(before);
                await suite.evidence('retained-owner-view.json', { retained, beforeClosedClick, beforeActions: before, beforeEnabledClick });
                await suite.evidence('panel-actions.json', { ui: await panel.host.uiSnapshot(), actions: panel.actions, run, retired: [
                    { control: 'panel run buttons', reason: 'Run actions are in Agents, where viewer reuse is checked' },
                    { control: 'separate agents/todos/usage/memory/triggers links', reason: 'The panel exposes one All todos, runs and usage link, and checks its view and draft preservation' },
                ] });
            }
            finally {
                gates.release('view-child-held');
                await sidebar.close(); await panel.close();
            }
        } },
    { id: storyId('S41'), title: 'real result and budget inputs never post duplicate notices', tiers: ['headless', 'app'], async run(suite) {
            await nativeGate(suite);
            const f = await installPanelFixture(suite), parent = await startPanelParent(f), gates = await suite.gates();
            const [historical] = await tools(f, parent, 'historical-notice', [{ action: 'run', ...child('historical-child') }], { 'historical-child': [{ steps: [{ text: 'historical child completed' }] }] });
            const history = await waitFeed(parent, 'actual historical result before first panel mount', feed => feed.runs.rows.some(row => row.id === historical.run.id && row.status === 'done'), 30000);
            const historicalIds = new Set(history.notifications.map(row => row.id));
            const panel = await mountPanel(f, 'spider-panel');
            let noticeHeld = false;
            try {
                await panel.host.waitForUi('notifications subscribed before child starts', ui => ui.nodes.some(n => n.id === `session-${parent.sessionId}`), 20000);
                expect(panel.posts).toEqual([]);
                await tools(f, parent, 'notice-child', [{ action: 'run', ...child('notice-work') }], { 'notice-work': [{ steps: [{ text: 'ESCALATION[warning]: fixture escalation\n' }, { gate: 'notice-held' }, { text: 'fixture child completed' }] }] });
                await gates.ready('notice-held', deadline(30000)); noticeHeld = true;
                const job = await holdJob(f, parent, 'notice-job');
                await writeFile(job.releasePath, 'release');
                gates.release('notice-held'); noticeHeld = false;
                const feed = await waitFeed(parent, 'real completed run', feed => feed.runs.rows.some(row => row.name === 'notice-work' && row.status === 'done'), 30000);
                await panel.refresh();
                expect(feed.runs.rows.find(row => row.name === 'notice-work')?.result).toContain('fixture child completed');
                expect(feed.notifications.filter(n => ['subagent-result', 'escalation', 'job-result', 'budget'].includes(n.kind))).toEqual([]);
                expect(panel.posts).toEqual([]);
                expect(feed.sessionId).toBe(parent.sessionId);
                expect(feed.owner.sessionId).toBe(parent.sessionId);
                expect(feed.owner.terminal.address).toBe(parent.pi.terminal);
                await panel.close();
                const reloaded = await mountPanel(f, 'spider-panel');
                try {
                    await reloaded.host.waitForUi('reloaded panel reads owner', ui => ui.nodes.some(n => n.id === `session-${parent.sessionId}`), 20000);
                    expect(reloaded.posts).toEqual([]);
                }
                finally {
                    await reloaded.close();
                }
                await suite.evidence('session-notifications.json', { history, historicalIds: [...historicalIds], feed, posts: panel.posts, projected: { status: 'retired by design', reason: 'The projected-budget case is covered by the host unit test, not the live UI story' } });
            }
            finally {
                if (noticeHeld) gates.release('notice-held');
                await panel.close();
            }
            await budgetCase(suite, '80');
            await budgetCase(suite, '100');
            await suite.evidence('projected-budget-retired.json', { status: 'retired by design', reason: 'The projected-budget case is covered by the host unit test. The 80 and 100 pace readings do not produce budget notifications' });
        } },
    { id: storyId('S42'), title: 'configured machines add no sidebar section or focus effects', tiers: ['headless', 'app'], run: async (suite) => {
        await nativeGate(suite);
        const f = await installPanelFixture(suite), parent = await startPanelParent(f), sidebar = await mountPanel(f, 'spider-agents');
        try {
            const configured = (f.config.machines as any[]).filter(m => !m.temporary);
            expect(configured.length).toBeGreaterThan(0);
            const before = await coreRows(suite), focusBefore = await f.app.status();
            const ui = await sidebar.host.waitForUi('owned agent appears without machine rows', ui => ui.nodes.some(node => node.id === `ag-${parent.pi.terminal}`), 20000);
            expect(ui.nodes.some(node => node.id === 'spider-machines' || node.id.startsWith('machine-row-'))).toBe(false);
            expect(ui.nodes.some(node => node.id.startsWith('agents-filter-') || node.id === 'agents-clear-filters')).toBe(false);
            expect(await coreRows(suite)).toEqual(before);
            expect(await f.app.status()).toEqual(focusBefore);
            expect(sidebar.actions).toEqual([]);
            await suite.evidence('machine-section-absent.json', { configured, ui, before, focusBefore, actions: sidebar.actions });
        } finally { await sidebar.close(); }
    } },
    { id: storyId('S43'), title: 'an unreachable destination creates no sidebar machine control or wake action', tiers: ['headless', 'app'], run: async (suite) => {
        await nativeGate(suite);
        const f = await installPanelFixture(suite), parent = await startPanelParent(f), sidebar = await mountPanel(f, 'spider-agents');
        let restore: (() => Promise<void>) | undefined;
        try {
            await sidebar.host.waitForUi('owned agent appears', ui => ui.nodes.some(node => node.id === `ag-${parent.pi.terminal}`), 20000);
            restore = await disconnectOwnedVia(suite);
            const before = await coreRows(suite), callsBefore = (await appCalls(suite)).length;
            const inventory = await waitFor('native inventory reports the unreachable destination', () => suite.hc(['machine', 'ls', '--json']), value => {
                const native = (value.json as any).machines.find((m: any) => m.name === suite.cores!.machine);
                return native?.state === 'unreachable' && String(native.why).includes('fixture transport intentionally disconnected');
            }, deadline(20000)).catch(async error => { await suite.evidence('disconnect-last-native-inventory.json', { error: String(error), last: error.details?.last }); throw error; });
            await sidebar.refresh();
            const ui = await sidebar.host.waitForUi('agent remains visible with no machine section', ui => ui.nodes.some(node => node.id === `ag-${parent.pi.terminal}`), 20000);
            expect(ui.nodes.some(node => node.id === 'spider-machines' || node.id.startsWith('machine-row-'))).toBe(false);
            expect(await coreRows(suite)).toEqual(before);
            expect((await appCalls(suite)).slice(callsBefore).filter(call => ['space.new', 'tab.new', 'terminal.new'].includes(call.name))).toEqual([]);
            expect(sidebar.commands.filter(command => command.argv.some(arg => arg.includes('/proc/') || arg.includes('lock')))).toEqual([]);
            await suite.evidence('machine-disconnect-no-sidebar.json', { inventory, ui, commands: sidebar.commands });
        } finally { await sidebar.close(); await restore?.(); }
    } },
    { id: storyId('S44'), title: 'machine shell action is not available', tiers: ['headless', 'app'], run: async (suite) => {
        await nativeGate(suite);const f=await installPanelFixture(suite),parent=await startPanelParent(f),sidebar=await mountPanel(f,'spider-agents'),panel=await mountPanel(f,'spider-panel');
        try {const left=await sidebar.host.uiSnapshot(),right=await panel.host.uiSnapshot();expect(f.installed.mods['spider-machines']).toBeUndefined();expect([...left.nodes,...right.nodes].some(node=>node.id.startsWith('open-shell-'))).toBe(false);await suite.evidence('S44-retired-by-design.json',{reason:'The machine shell action is absent. S42 checks that focus stays unchanged',left,right});}
        finally{await sidebar.close();await panel.close();}
    } },

];
registerScenarios(scenarios);
