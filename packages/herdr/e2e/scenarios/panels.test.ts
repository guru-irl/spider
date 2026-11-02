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
            const secondFeed = await waitFeed(second, 'second real session observes shared account reading', feed => feed.pace.used === Number(threshold) && feed.notifications.some(n => n.kind === 'budget'), 45000);
            const feed = await waitFeed(parent, 'real host computed budget threshold', feed => feed.pace.used === Number(threshold) && feed.pace.budget === 100 && feed.notifications.some((n: any) => n.kind === 'budget'), 45000);
            expect(feed.pace.remaining).toBe(100 - Number(threshold));
            const stable = `budget:${feed.pace.periodStart}:${threshold}`;
            await waitFor('one budget notification post', () => panel.posts, posts => posts.some(p => p.action?.name?.includes(encodeURIComponent(stable))), deadline(15000));
            expect(panel.posts.filter(p => p.action?.name?.includes(encodeURIComponent(stable)))).toHaveLength(1);
            expect(feed.notifications.find((n: any) => n.id === stable)).toMatchObject({ scope: 'shared', sessionId: null, ownerAddress: null, action: { kind: 'open-usage' } });
            expect(secondFeed.notifications.some(n => n.id === stable)).toBe(true);
            await f.app.command('pane.focus', { terminal: second.pi.terminal });
            const focusBefore = await f.app.status();
            const offsets = await Promise.all([parent.pi, second.pi].map(async (pi) => (await pi.rawOutput()).length)), notice = panel.posts.find(p => p.action?.name?.includes(encodeURIComponent(stable)))!;
            panel.dispatch(notice.action.name);
            await waitFor('shared notice opens a real usage view', () => Promise.all([parent.pi, second.pi].map(async (pi, i) => (await pi.rawOutput()).subarray(offsets[i]).toString())), values => values.some(value => /usage/i.test(value)), deadline(15000));
            expect(await f.app.status()).toMatchObject({ agent: (focusBefore as any).agent });
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
            await suite.evidence(`budget-${threshold}.json`, { feed, secondFeed, posts: panel.posts, requests: logs, projected: { status: 'retired by design', reason: 'UI round 3 projected-budget branch is covered by the host unit test, not the live UI story' } });
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
                    { control: 'individual memory controls', reason: 'UI round 3 replaced them with one aggregate memory-review action' },
                    { control: 'multi-space grouping', reason: 'UI round 3 scopes the panel to the selected native space; both directions are checked' },
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
                const run = (await waitNativeViewerRuns(suite, feed)).find(row => row.id === created.run.id)!;
                expect(run.ownerSessionId).toBe(parent.sessionId);
                await sidebar.refresh();
                await sidebar.host.waitForUi('real owned run rendered in Agents', ui => ui.nodes.some(node => node.id === `sub-${run.id}`), 20000);
                const viewers = (world: any) => world.spaces.flatMap((space: any) => space.tabs.flatMap((tab: any) => tab.terminals.filter((pane: any) => pane.terminal === run.viewer)));
                const beforeRun = await waitFor('actual automatic viewer placement before reuse', () => f.app.ls(), world => viewers(world).length === 1, deadline(20000), { reconcileMs: 250 });
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
                await waitFor('single panel link opens the actual Todos UI', async () => (await parent.pi.rawOutput()).subarray(offset), bytes => bytes.toString().toLowerCase().includes('todos'), deadline(15000));
                expect(actionCommands(panel)).toHaveLength(beforeEnabledClick + 1);
                expect(await parent.pi.draft()).toBe(draft);
                await parent.pi.key('\x1b[27u');
                await parent.pi.key('X');
                expect(await waitFor('typed character proves the preserved multibyte cursor', () => parent.pi.draft(), value => value === 'draft 界X🙂', deadline(10000))).toBe('draft 界X🙂');
                await parent.pi.close();
                const unavailable = await panel.host.waitForUi('retained owner disables its real view action', ui => ui.nodes.some(node => { const tooltip = node.attributes?.tooltip; return node.id === `view-${parent.sessionId}-todos` && Array.isArray(tooltip) && tooltip.length === 1 && tooltip[0] === 'closed: owner unavailable'; }), 20000);
                const beforeDisabledClick = actionCommands(panel).length, before = panel.actions.length;
                await panel.host.activate(`view-${parent.sessionId}-todos`);
                expect(actionCommands(panel)).toHaveLength(beforeDisabledClick);
                expect(panel.actions).toHaveLength(before);
                await suite.evidence('retained-owner-disabled-view.json', { unavailable, beforeDisabledClick, beforeActions: before, beforeEnabledClick, enabledRequestCount: beforeEnabledClick + 1 });
                await suite.evidence('panel-actions.json', { ui: await panel.host.uiSnapshot(), actions: panel.actions, run, retired: [
                    { control: 'panel run buttons', reason: 'UI round 3 puts run actions in Agents; actual viewer reuse is checked there' },
                    { control: 'separate agents/todos/usage/memory/triggers links', reason: 'UI round 3 exposes one All todos, runs and usage link; its real view and draft preservation are checked' },
                ] });
            }
            finally {
                gates.release('view-child-held');
                await sidebar.close(); await panel.close();
            }
        } },
    { id: storyId('S41'), title: 'real result and budget inputs produce one correctly scoped notification', tiers: ['headless', 'app'], async run(suite) {
            await nativeGate(suite);
            const f = await installPanelFixture(suite), parent = await startPanelParent(f), gates = await suite.gates();
            const [historical] = await tools(f, parent, 'historical-notice', [{ action: 'run', ...child('historical-child') }], { 'historical-child': [{ steps: [{ text: 'historical child completed' }] }] });
            const history = await waitFeed(parent, 'actual historical result before first panel mount', feed => feed.runs.rows.some(row => row.id === historical.run.id && row.status === 'done') && feed.notifications.some(row => row.kind === 'subagent-result'), 30000);
            const historicalIds = new Set(history.notifications.map(row => row.id));
            const panel = await mountPanel(f, 'spider-panel');
            let noticeHeld = false;
            try {
                await panel.host.waitForUi('notifications subscribed before child starts', ui => ui.nodes.some(n => n.id === `session-${parent.sessionId}`), 20000);
                expect(panel.posts).toEqual([]);
                await tools(f, parent, 'notice-child', [{ action: 'run', ...child('notice-work') }], { 'notice-work': [{ steps: [{ text: 'ESCALATION[warning]: fixture escalation' }, { gate: 'notice-held' }] }, { steps: [{ text: 'fixture child completed' }] }] });
                await gates.ready('notice-held', deadline(30000)); noticeHeld = true;
                const job = await holdJob(f, parent, 'notice-job');
                await writeFile(job.releasePath, 'release');
                gates.release('notice-held'); noticeHeld = false;
                const feed = await waitFeed(parent, 'real result, escalation, and job notifications', feed => ['subagent-result', 'escalation', 'job-result'].every(kind => feed.notifications.some(n => n.kind === kind)), 30000);
                await waitFor('result, escalation, and job posts', () => panel.posts, posts => posts.length >= 3, deadline(20000));
                for (const n of feed.notifications.filter(n => !historicalIds.has(n.id) && ['subagent-result', 'escalation', 'job-result'].includes(n.kind))) {
                    expect(n).toMatchObject({ scope: 'session', sessionId: parent.sessionId, ownerAddress: parent.pi.terminal });
                    expect(panel.posts.filter(p => p.action?.name?.includes(encodeURIComponent(n.id)))).toHaveLength(1);
                    await f.app.command('pane.focus', { terminal: parent.placement.terminal });
                    panel.dispatch(panel.posts.find(p => p.action?.name?.includes(encodeURIComponent(n.id)))!.action.name);
                    await waitFor('session notice focuses its actual owner', () => f.app.status(), value => (value as any).agent === parent.pi.terminal, deadline(10000));
                }
                await panel.close();
                const reloaded = await mountPanel(f, 'spider-panel');
                try {
                    await reloaded.host.waitForUi('reloaded panel reads owner', ui => ui.nodes.some(n => n.id === `session-${parent.sessionId}`), 20000);
                    expect(reloaded.posts).toEqual([]);
                }
                finally {
                    await reloaded.close();
                }
                await suite.evidence('session-notifications.json', { history, historicalIds: [...historicalIds], feed, posts: panel.posts, projected: { status: 'retired by design', reason: 'UI round 3 projected-budget branch is covered by the host unit test, not the live UI story' } });
            }
            finally {
                if (noticeHeld) gates.release('notice-held');
                await panel.close();
            }
            await budgetCase(suite, '80');
            await budgetCase(suite, '100');
            await suite.evidence('projected-budget-retired.json', { status: 'retired by design', reason: 'UI round 3 projected-budget branch is covered by the host unit test; actual 80/100 budget notifications remain required' });
        } },
    { id: storyId('S42'), title: 'global sidebar machine rows filter without terminal or focus effects', tiers: ['headless', 'app'], run: async (suite) => {
        await nativeGate(suite);const f=await installPanelFixture(suite),parent=await startPanelParent(f),sidebar=await mountPanel(f,'spider-agents');
        try {const configured=(f.config.machines as any[]).filter(m=>!m.temporary);const inventory=await suite.hc(['machine','ls','--json']);expect(inventory.exitCode).toBe(0);
            const expectedTip = (name: string): string => { const native=(inventory.json as any).machines.find((row:any)=>row.name===name)?.state; return `${native==='connected'?'Connected':native==='disconnected'?'Disconnected':'Stopped or unavailable'}. Show only this machine's jobs`; };
            const ui=await sidebar.host.waitForUi('every configured machine has its actual native status',ui=>configured.every(machine=>ui.nodes.some(node=>node.id===`machine-row-${machine.name}` && JSON.stringify(node.attributes?.tooltip)===JSON.stringify([expectedTip(machine.name)]))),20000);
            const before=await coreRows(suite),focusBefore=await f.app.status();for(const machine of configured){const matches=ui.nodes.filter(node=>node.id===`machine-row-${machine.name}`);expect(matches).toHaveLength(1);const native=(inventory.json as any).machines.find((row:any)=>row.name===machine.name)?.state;const expected=native==='connected'?'Connected':native==='disconnected'?'Disconnected':'Stopped or unavailable';expect(matches[0].attributes?.tooltip).toEqual([`${expected}. Show only this machine's jobs`]);if(expected==='Stopped or unavailable')expect(matches[0].attributes?.opacity).toEqual([0.5]);await sidebar.host.activate(`machine-row-${machine.name}`);expect(await coreRows(suite)).toEqual(before);expect(await f.app.status()).toEqual(focusBefore);await sidebar.host.activate(`machine-row-${machine.name}`);}
            await suite.evidence('machine-status-only.json',{configured,inventory,ui,before,focusBefore,actions:sidebar.actions,retired:'Lock, jobs, load, memory and shell action retired by design (UI round 3)'});
        } finally {await sidebar.close();}
    } },
    { id: storyId('S43'), title: 'unreachable sidebar state refresh has no machine wake or mutation', tiers: ['headless', 'app'], run: async (suite) => {
        await nativeGate(suite);const f=await installPanelFixture(suite),parent=await startPanelParent(f),sidebar=await mountPanel(f,'spider-agents');
        let restore: (() => Promise<void>) | undefined;
        try {await sidebar.host.waitForUi('configured owned destination shown',ui=>ui.nodes.some(node=>node.id===`machine-row-${suite.cores!.machine}`),20000);
            restore=await disconnectOwnedVia(suite);const before=await coreRows(suite),callsBefore=(await appCalls(suite)).length;
            const inventory=await waitFor('native inventory reports the unreachable destination',()=>suite.hc(['machine','ls','--json']),value=>{const native=(value.json as any).machines.find((m:any)=>m.name===suite.cores!.machine);return native?.state==='unreachable' && String(native.why).includes('fixture transport intentionally disconnected');},deadline(20000)).catch(async error=>{ await suite.evidence('disconnect-last-native-inventory.json', { error: String(error), last: error.details?.last }); throw error; });
            await sidebar.refresh();const ui=await sidebar.host.waitForUi('actual unreachable status reaches the installed sidebar',ui=>ui.nodes.some(node=>node.id===`machine-row-${suite.cores!.machine}` && JSON.stringify(node.attributes?.tooltip)===JSON.stringify(["Stopped or unavailable. Show only this machine's jobs"])),20000);const rows=ui.nodes.filter(node=>node.id===`machine-row-${suite.cores!.machine}`);expect(rows).toHaveLength(1);expect(rows[0].attributes?.tooltip).toEqual(["Stopped or unavailable. Show only this machine's jobs"]);expect(await coreRows(suite)).toEqual(before);expect((await appCalls(suite)).slice(callsBefore).filter(call=>['space.new','tab.new','terminal.new'].includes(call.name))).toEqual([]);
            expect(sidebar.commands.filter(command=>command.argv.some(arg=>arg.includes('/proc/')||arg.includes('lock')))).toEqual([]);
            await suite.evidence('machine-disconnect-status.json',{inventory,ui,commands:sidebar.commands,retired:'Sample staleness retired with metrics (UI round 3)'});
        } finally {await sidebar.close();await restore?.();}
    } },
    { id: storyId('S44'), title: 'machine shell action retired by design (UI round 3)', tiers: ['headless', 'app'], run: async (suite) => {
        await nativeGate(suite);const f=await installPanelFixture(suite),parent=await startPanelParent(f),sidebar=await mountPanel(f,'spider-agents'),panel=await mountPanel(f,'spider-panel');
        try {const left=await sidebar.host.uiSnapshot(),right=await panel.host.uiSnapshot();expect(f.installed.mods['spider-machines']).toBeUndefined();expect([...left.nodes,...right.nodes].some(node=>node.id.startsWith('open-shell-'))).toBe(false);await suite.evidence('S44-retired-by-design.json',{reason:'No machine shell action exists after UI round 3; no-guessed-focus check moved to S42',left,right});}
        finally{await sidebar.close();await panel.close();}
    } },

];
registerScenarios(scenarios);
