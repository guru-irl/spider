// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile, writeFile, mkdir, appendFile, stat } from 'node:fs/promises';
import { watch, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { HERDR_LABELS, HERDR_KINDS, type SessionFeed, type RunSummary, type TerminalAddress } from '../../src/contracts.js';
import type { FreshInstallation } from './install-inputs.js';
import { cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { HarnessError } from '../harness/environment.js';
import { waitFor, deadline } from '../harness/wait.js';
import { writeScript } from '../harness/pi.js';
import type { InteractiveDriver } from '../harness/pi.js';
import type { Suite, AppDriver } from '../harness/suite.js';
import type { ScriptFile } from './scripted-provider.js';
import { createRenderHost } from '../harness/render-host.js';
import { createNativeRun, type NativeRunCall } from '../harness/native-run.js';
import { destinationRoot, destinationPath } from '../harness/destination.js';
import { readDestination, writeDestination } from './payloads/index.js';
import type { RenderHost } from '../harness/render-host.js';
export type PanelFixture = FreshInstallation;
interface NativeViewerTerminal { address: TerminalAddress; state: string; labels: Readonly<Record<string, string>> }
export function nativeViewerRuns(scope: { sessionId: string; coreId: string; terminal: string }, runs: readonly RunSummary[], rows: readonly NativeViewerTerminal[]): (RunSummary & { viewer: TerminalAddress })[] {
    return runs.flatMap(run => {
        const matches = rows.filter(row => row.state === 'live' && row.labels[HERDR_LABELS.kind] === HERDR_KINDS.subagentViewer
            && row.labels[HERDR_LABELS.run] === run.id && row.labels[HERDR_LABELS.session] === scope.sessionId
            && row.labels[HERDR_LABELS.ownerCore] === scope.coreId && row.labels[HERDR_LABELS.ownerTerminal] === scope.terminal);
        if (matches.length > 1) throw new HarnessError('duplicate-native-viewer', `duplicate native viewer for ${run.id}`);
        return matches.length ? [{ ...run, viewer: matches[0].address }] : [];
    });
}
export async function waitNativeViewerRuns(suite: Suite, feed: SessionFeed): Promise<(RunSummary & { viewer: TerminalAddress })[]> {
    const scope = { sessionId: feed.owner.sessionId, coreId: feed.owner.terminal.coreId, terminal: feed.owner.terminal.address };
    const actual = await waitFor('live exact-owner native viewers for every public run', async () => {
        const rows = await coreRows(suite); return { rows, runs: nativeViewerRuns(scope, feed.runs.rows, rows) };
    }, value => value.runs.length === feed.runs.rows.length, deadline(20000), { reconcileMs: 250 });
    await suite.evidence('native-viewer-observation.json', { scope, feed, ...actual });
    return actual.runs;
}
export async function installPanelFixture(suite: Suite): Promise<PanelFixture> {
    const specifier = './install-inputs.js';
    try {
        await stat(new URL('./install-inputs.ts', import.meta.url));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw error;
        throw new HarnessError('missing-prerequisite', 'Task 2 installFresh and real setup output are required for panel stories');
    }
    const module = await import(/* @vite-ignore */ specifier) as typeof import('./install-inputs.js');
    const settingsPath = suite.ownPath(join(suite.directories.HERDR_APP_HOME, 'settings.json'));
    const missing = async () => {
        try {
            await stat(settingsPath);
            return false;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
            return true;
        }
    };
    const absentBefore = await missing();
    try {
        return await module.installFresh(suite);
    }
    catch (error) {
        const result = error instanceof HarnessError && error.code === 'fresh-setup-failed' ? error.details as {
            exitCode?: unknown;
            stderr?: unknown;
        } | undefined : undefined;
        if (absentBefore && result?.exitCode === 1 && typeof result.stderr === 'string' && result.stderr.trim() === 'setup-failed: Unexpected end of JSON input' && await missing()) {
            await suite.evidence('product-8ea0c41-prerequisite.json', { error: String(error), result, settingsPath, absentBefore: true, absentAfter: true });
            throw new HarnessError('missing-prerequisite', 'awaiting product fix 8ea0c41', { cause: String(error), evidence: 'product-8ea0c41-prerequisite.json' });
        }
        throw error;
    }
}
export interface PanelParent {
    pi: InteractiveDriver;
    sessionId: string;
    feedPath: string;
    placement: Record<string, unknown>;
    parseFeed(text: string): SessionFeed | null;
}
export async function readFeed(parent: PanelParent): Promise<SessionFeed | null> {
    try {
        return parent.parseFeed(await readFile(parent.feedPath, 'utf8'));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return null;
        throw error;
    }
}
export async function waitFeed(parent: PanelParent, description: string, predicate: (feed: SessionFeed) => boolean, ms = 20000): Promise<SessionFeed> {
    const feed = await waitFor(description, () => readFeed(parent), feed => feed !== null && predicate(feed), deadline(ms), { reconcileMs: 250 });
    if (!feed)
        throw new HarnessError('feed-missing', description);
    return feed;
}
export async function startPanelParent(f: PanelFixture, name = 'owner'): Promise<PanelParent> {
    const s = f.suite, cwd = await s.project(name);
    const placement = await f.app.command('space.new', { name: `Workshop ${name}`, folder: cwd, argv: ['/bin/sh', '-c', 'printf main-ready; exec cat'] }) as Record<string, unknown>;
    const pi = await s.launchPi({ mode: 'interactive', cwd, args: ['--approve'], label: name, extraEnv: { PI_PROGRAM_STATUS: '1' } });
    if (pi.mode !== 'interactive')
        throw new HarnessError('wrong-mode', 'panel owner must have the real TUI');
    const started = await pi.waitEvent('session_start', e => e.mode === 'tui', deadline(20000));
    const kept = await f.app.command('terminal.keep', { terminal: pi.terminal, place: 'right' }) as Record<string, unknown>;
    if (typeof kept.tab !== 'string') throw new HarnessError('main-placement-failed', 'native keep did not identify the owner tab');
    placement.tab = kept.tab;
    placement.terminal = pi.terminal;
    placement.pane = kept.pane;
    await f.app.ls();
    const parserModule = pathToFileURL(join(f.installed.mods['spider-panel'], 'shared/feed.js')).href;
    const { parseFeed } = await import(/* @vite-ignore */ parserModule) as {
        parseFeed(text: string): SessionFeed | null;
    };
    const parent: PanelParent = { pi, parseFeed, sessionId: String(started.sessionId), feedPath: s.ownPath(join(s.directories.SPIDER_GLOBAL_ROOT, 'herdr/sessions', String(started.sessionId), 'session.json')), placement };
    await waitFeed(parent, 'real owner feed after native placement', feed => feed.owner.terminal.address === pi.terminal && Boolean(feed.ipc) && feed.placement !== null && feed.placement.spaceId === placement.space && feed.placement.tabId === placement.tab);
    await f.app.command('pane.focus', { terminal: pi.terminal });
    return parent;
}
export async function tools(f: PanelFixture, parent: PanelParent, name: string, calls: Record<string, unknown>[], children: ScriptFile['scripts'] = {}): Promise<any[]> {
    const previous = JSON.parse(await readFile(f.suite.pi.scriptPath, 'utf8')) as ScriptFile;
    const ids = calls.map((_call, index) => `${name}-${index}`);
    await writeScript(f.suite.pi.scriptPath, { story: f.suite.story, scripts: { ...previous.scripts, ...children, [name]: [
                { steps: calls.map((arguments_, index) => ({ tool: { id: ids[index], name: 'spider', arguments: arguments_ as any } })) }, { steps: [{ text: `${name}-settled` }] },
            ] } });
    await parent.pi.prompt(`[[e2e:${name}]]`);
    const results = [];
    for (const id of ids) {
        const observed = await parent.pi.toolResult(id, deadline(30000));
        await f.suite.evidence(`${id}.json`, observed);
        if (observed.isError)
            throw new HarnessError('real-tool-failed', JSON.stringify(observed.result));
        const result = observed.result as {
            details?: unknown;
        };
        results.push(result.details);
    }
    return results;
}
export interface MountedPanel {
    host: RenderHost;
    commands: {
        binary: string;
        argv: string[];
        exitCode: number;
    }[];
    corruptShellReply: {
        enabled: boolean;
    };
    suppressConsoleSnapshot: {
        enabled: boolean;
    };
    dispatch(actionName: string): void;
    posts: Record<string, any>[];
    actions: readonly NativeRunCall[];
    sampleFailure: {
        enabled: boolean;
    };
    refresh(): Promise<void>;
    close(): Promise<void>;
}
export async function activateChildAction(panel: MountedPanel, controlId: string, request: { op: 'openRun'; runId: string } | { op: 'openJob'; jobId: string }): Promise<void> {
    const before = panel.commands.length;
    const completed = () => panel.commands.slice(before).find(command => {
        const index = command.argv.indexOf('--request');
        if (index < 0) return false;
        const value: unknown = JSON.parse(command.argv[index + 1]);
        if (!value || typeof value !== 'object') return false;
        const observed = value as Record<string, unknown>;
        return observed.op === request.op && (request.op === 'openRun' ? observed.runId === request.runId : observed.jobId === request.jobId);
    });
    await waitFor(`real ${request.op} IPC completes for ${controlId}`, async () => {
        let actual = completed();
        if (!actual) {
            if (!(await panel.host.uiSnapshot()).nodes.some(node => node.id === controlId)) return false;
            await panel.host.activate(controlId); actual = completed();
        }
        if (actual && actual.exitCode !== 0) throw new HarnessError('panel-ipc-failed', `Actual ${request.op} exited ${actual.exitCode}`);
        return Boolean(actual);
    }, Boolean, deadline(20000), { reconcileMs: 250 });
}
function installedProps(layout: unknown, modId: string): Record<string, unknown> | undefined {
    if (!layout || typeof layout !== 'object')
        return;
    if (Array.isArray(layout)) {
        for (const child of layout) {
            const p = installedProps(child, modId);
            if (p)
                return p;
        }
        return;
    }
    const value = layout as Record<string, any>;
    if ((value.mod === modId || value.name === modId) && value.props?.modId === modId)
        return value.props;
    for (const child of Object.values(value)) {
        const p = installedProps(child, modId);
        if (p)
            return p;
    }
}
export async function mountPanel(f: PanelFixture, modId: string, syntheticProc = false, selectedProps?: Record<string, unknown>): Promise<MountedPanel> {
    const s = f.suite, directory = f.installed.mods[modId] ?? (selectedProps && /^spider-agents-[a-z0-9-]+$/.test(modId) ? s.ownPath(join(f.config.app.home, 'mods', modId)) : undefined), props = selectedProps ?? installedProps(f.installed.layout.value, modId);
    if (!directory || !props)
        throw new HarnessError('installed-props-missing', `actual installed ${modId} props are required`);
    const posts: Record<string, any>[] = [], watchers = new Set<ReturnType<typeof watch>>(), commandWaiters: ((command: string) => void)[] = [];
    const sampleFailure = { enabled: false }, corruptShellReply = { enabled: false }, suppressConsoleSnapshot = { enabled: false }, commands: MountedPanel['commands'] = [];
    const persistent = s.ownPath(join(s.root, 'ui-state'));
    mkdirSync(persistent, { recursive: true, mode: 0o700 });
    const statePath = (key: string) => join(persistent, createHash('sha256').update(key).digest('hex') + '.json');
    const readState = (key: string): unknown => {
        try {
            return JSON.parse(readFileSync(statePath(key), 'utf8'));
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                throw e;
            return undefined;
        }
    };
    const writeState = (key: string, value: unknown) => { const path = statePath(key), next = path + '.next'; writeFileSync(next, JSON.stringify(value), { mode: 0o600 }); renameSync(next, path); };
    let rootHost: RenderHost | undefined, overlay: RenderHost | undefined, closed = false;
    let world: any = { spaces: [] }, rows: any[] = [], inventory: any[] = [], status: any;
    const refresh = async () => {
        world = await f.app.ls();
        const raw = await s.hc(['ls', '--all', '--json']);
        if (raw.exitCode !== 0 || !Array.isArray((raw.json as any)?.terminals))
            throw new HarnessError('inventory-unavailable', raw.stderr);
        rows = [];
        rows = await Promise.all((raw.json as any).terminals.map(async (row: any) => {
            const got = await s.hc(['get', row.address, '--json']);
            if (got.exitCode !== 0) throw new HarnessError('terminal-unavailable', got.stderr);
            return got.json;
        }));
        const machines = await s.hc(['machine', 'ls', '--json']);
        if (machines.exitCode !== 0)
            throw new HarnessError('machines-unavailable', machines.stderr);
        inventory = (machines.json as any).machines;
        status = await f.app.status();
        await s.evidence(`native-${modId}-render-inputs.json`, { world, rows, inventory, status });
        rootHost?.invalidate();
    };
    await refresh();
    const nativeRun = createNativeRun((name, args) => f.app.command(name, args), refresh), actions = nativeRun.calls;
    const makeHost = (viewProps: Record<string, unknown>) => createRenderHost({ installedDirectory: s.ownPath(directory), props: viewProps,
        storage: { getItem: key => { const value = readState(`local:${modId}:${key}`); return typeof value === 'string' ? value : null; }, setItem: (key, value) => writeState(`local:${modId}:${key}`, value), removeItem: key => rmSync(statePath(`local:${modId}:${key}`), { force: true }) }, api: {
            exec: async (binary: string, argv: string[]) => {
                const result = await s.invoke(binary, argv, f.suite.env);
                commands.push({ binary, argv: [...argv], exitCode: result.exitCode });
                await refresh();
                if (corruptShellReply.enabled && ['space.new', 'tab.new'].includes(argv[1]) && argv[0] === 'do' && result.exitCode === 0) {
                    const malformed = JSON.parse(result.stdout);
                    delete malformed.terminal;
                    return { ...result, code: result.exitCode, stdout: JSON.stringify(malformed) };
                }
                return { ...result, code: result.exitCode };
            },
            hc: async (argv: string[]) => { const result = await s.hc(argv); return { ...result, code: result.exitCode }; },
            run: nativeRun.run,
            theme: () => ({ foreground: '#f8f8f2', dim: '#b4b4ba', muted: '#b4b4ba', hover: '#ffffff14', working: '#50fa7b' }),
            panes: () => world.spaces.flatMap((space: any) => space.tabs.flatMap((tab: any) => tab.terminals.map((pane: any) => ({ ...pane, space: space.id, tab: tab.id })))),
            spaces: () => world.spaces,
            terminals: () => suppressConsoleSnapshot.enabled ? rows.filter(row => row.labels['spider.kind'] !== 'remote-console') : rows,
            agents: () => world.spaces.flatMap((space: any) => space.tabs.flatMap((tab: any, index: number) => tab.terminals.flatMap((pane: any) => {
                const row = rows.find(r => r.address === pane.terminal);
                const state = typeof row?.status === 'string' ? row.status : row?.status?.state;
                if (typeof state !== 'string')
                    return [];
                return [{ address: row.address, pane: pane.pane, space: space.id, space_name: space.name, tab: tab.id, tab_index: index + 1, tab_name: tab.name, status: state, app: null, program: row.program ?? null, title: row.title ?? '', seq: row.status_ms ?? 0, focused: status.agent === row.address }];
            }))),
            focused: () => ({ ...status, pane: status.focused_pane, terminal: status.agent }),
            window: () => ({ platform: process.platform === 'darwin' ? 'macos' : 'linux' }), layout: () => f.installed.layout.value,
            setAgentOrder: (ids: string[]) => writeState('native-agent-order', ids),
            openOverlay: async (spec: Record<string, any>) => {
                if (spec.mod !== modId || spec.kind !== 'popup')
                    throw new HarnessError('unowned-overlay', 'only this installed sidebar popup is supported');
                if (overlay)
                    throw new HarnessError('overlay-already-open', 'close the owned popup first');
                await s.evidence(`${modId}-popup-props.json`, spec);
                overlay = await makeHost({ ...viewProps, ...spec.props, overlay: 'owned-popup' });
                return 'owned-popup';
            },
            closeOverlay: (id: string) => {
                if (id !== 'owned-popup' || !overlay)
                    throw new HarnessError('wrong-overlay', 'no matching owned popup');
                const prior = overlay;
                overlay = undefined;
                void prior.close();
                rootHost?.invalidate();
            },
            machines: () => inventory.map(m => ({ ...m, layout: m.state === 'connected' ? 'ready' : 'unavailable' })),
            readTextFile: async (path: string, options?: {
                on?: string;
            }) => {
                if (options?.on) {
                    if (options.on !== s.cores!.machine)
                        throw new HarnessError('wrong-machine', 'unowned file-read destination');
                    if (sampleFailure.enabled && path.startsWith('/proc/'))
                        throw new Error('synthetic sample read rejected');
                    if (syntheticProc && path === '/proc/loadavg')
                        return '1.25 2.50 3.75 1/100 1234\n';
                    if (syntheticProc && path === '/proc/meminfo')
                        return 'MemTotal: 8192 kB\nMemAvailable: 6144 kB\n';
                    if (!['/proc/loadavg', '/proc/meminfo'].includes(path))
                        s.ownPath(path);
                    const result = await s.hc(['file', 'read', '--json', '--on', options.on, path]);
                    if (result.exitCode !== 0) {
                        const error = new Error(result.stderr || result.stdout) as Error & {
                            code: string;
                        };
                        error.code = /not found|No such file/.test(error.message) ? 'ENOENT' : 'EACCES';
                        throw error;
                    }
                    if (typeof (result.json as any)?.text !== 'string')
                        throw new HarnessError('file-read-invalid', 'file read did not return text');
                    return (result.json as any).text;
                }
                return readFile(s.ownPath(path), 'utf8');
            },
            shared: (key: string) => readState(key), setShared: (key: string, value: unknown) => { writeState(key, value); rootHost?.invalidate(); },
            notify: (post: Record<string, any>) => { posts.push(structuredClone(post)); void appendFile(join(s.evidenceDirectory, 'notification-posts.jsonl'), JSON.stringify(post) + '\n'); },
            nextCommand: () => new Promise<string>(resolve => { commandWaiters.push(resolve); }),
            watchFolder: (path: string) => new Promise<void>((resolve, reject) => {
                try {
                    const w = watch(s.ownPath(path), { recursive: true }, () => { w.close(); watchers.delete(w); resolve(); });
                    watchers.add(w);
                    w.on('error', reject);
                }
                catch (e) {
                    reject(e);
                }
            }),
        }, dispose: () => {
            if (!closed)
                return;
            for (const w of watchers)
                w.close();
            watchers.clear();
            for (const waiter of commandWaiters)
                waiter('closed');
            commandWaiters.length = 0;
        } });
    rootHost = await makeHost(props);
    const active = () => overlay ?? rootHost!;
    const host: RenderHost = { invalidate: () => active().invalidate(), uiSnapshot: () => active().uiSnapshot(), activate: id => active().activate(id), mouse: (id, button) => active().mouse(id, button), key:(id,key)=>active().key(id,key), waitForUi: (d, p, t) => active().waitForUi(d, p, t), close: async () => {
            if (closed)
                return;
            closed = true;
            await overlay?.close();
            await rootHost!.close();
        } };
    await s.evidence(`${modId}-input-class.json`, { acceptance: 'fake-app render host', proc: syntheticProc ? 'synthetic external proc text' : 'actual filesystem', directory, props });
    return { host, posts, actions, commands, sampleFailure, corruptShellReply, suppressConsoleSnapshot, refresh: async () => { await nativeRun.flush(); await refresh(); }, close: async () => { try { await nativeRun.flush(); await s.evidence(`native-${modId}-run-actions.json`, actions); } finally { await host.close(); } }, dispatch: actionName => {
            const next = commandWaiters.shift();
            if (!next || !actionName.startsWith(`${modId}.`))
                throw new HarnessError('notice-action-unavailable', 'no owned notification listener for this action');
            next(actionName.slice(modId.length + 1));
        } };
}
export async function sidebarCopy(f: PanelFixture, modId: string): Promise<Record<string, unknown>> {
    const original = f.installed.mods['spider-agents'], sourceProps = installedProps(f.installed.layout.value, 'spider-agents');
    if (!original || !sourceProps || !/^spider-agents-[a-z0-9-]+$/.test(modId))
        throw new HarnessError('invalid-sidebar-copy', 'installed sidebar source and an owned copy ID are required');
    const directory = f.suite.ownPath(join(f.config.app.home, 'mods', modId));
    await cp(original, directory, { recursive: true, errorOnExist: true });
    const checked = await f.app.check(directory);
    if (checked.exitCode !== 0)
        throw new HarnessError('sidebar-copy-check-failed', checked.stderr);
    await f.suite.evidence(`${modId}-check.json`, checked);
    return { ...sourceProps, modId };
}
export async function appCalls(suite: Suite): Promise<{
    name: string;
    at: number;
    args: Record<string, unknown>;
    result: unknown;
}[]> {
    if (!suite.appConnection)
        throw new HarnessError('missing-adapter', 'owned app connection is required');
    const path = suite.ownPath(join(dirname(suite.appConnection.binary), 'app-calls.jsonl'));
    return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => {
        const row = JSON.parse(line);
        if (typeof row.name !== 'string' || !Number.isFinite(row.at) || !row.args || typeof row.args !== 'object')
            throw new HarnessError('invalid-app-trace', 'malformed actual app call');
        return row;
    });
}
export async function coreRows(suite: Suite): Promise<any[]> {
    const inventory = await suite.hc(['ls', '--all', '--json']);
    if (inventory.exitCode !== 0 || !Array.isArray((inventory.json as any)?.terminals))
        throw new HarnessError('inventory-invalid', 'actual terminal inventory required');
    return Promise.all((inventory.json as any).terminals.map(async (terminal: any) => {
        const result = await suite.hc(['get', terminal.address, '--json']);
        if (result.exitCode !== 0) throw new HarnessError('get-failed', result.stderr);
        return result.json;
    }));
}
export interface HeldJob {
    id: string;
    address: string;
    console: string;
    releasePath: string;
    result: any;
}
export async function payloadGate(suite: Suite, name: string): Promise<{
    code: string;
    ready: string;
    releasePath: string;
}> {
    const directory = destinationPath(suite, join(destinationRoot(suite), 'payload-gates'));
    if (suite.options.tier === 'remote') await writeDestination(suite, suite.cores!.machine, join(directory, 'input'), name);
    else await mkdir(directory, { recursive: true, mode: 0o700 });
    const ready = join(directory, `${name}-ready`), releasePath = join(directory, `${name}-release`);
    const code = `import('node:fs').then(fs=>{process.stdout.write('first-${name}\\n');for(let i=0;i<150;i++)process.stdout.write('output-${name}-'+i+'\\n');fs.writeFileSync(${JSON.stringify(ready)},'ready');const release=${JSON.stringify(releasePath)};const w=fs.watch(${JSON.stringify(directory)},()=>{if(fs.existsSync(release)){w.close();process.stdout.write('last-${name}\\n');process.exit(23);}});if(fs.existsSync(release)){w.close();process.stdout.write('last-${name}\\n');process.exit(23);}}).catch(error=>{console.error(error);process.exitCode=1});`;
    return { code, ready, releasePath };
}
export async function holdJob(f: PanelFixture, parent: PanelParent, name: string): Promise<HeldJob> {
    const { code, ready, releasePath } = await payloadGate(f.suite, name), on = f.suite.cores?.machine;
    if (!on)
        throw new HarnessError('missing-prerequisite', 'an explicitly owned execution destination is required');
    const [result] = await tools(f, parent, name, [{ action: 'exec', on, language: 'javascript', code, timeout: 100, background: true }]);
    if (!result?.remote?.jobId || typeof result.remote.address !== 'string')
        throw new HarnessError('job-handoff-missing', 'real exec did not return its remote job ID and address');
    await waitFor('real payload reached its file gate', async () => {
        if (f.suite.options.tier === 'remote') return readDestination(f.suite, on, ready);
        try {
            return await readFile(ready, 'utf8');
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                throw e;
            return null;
        }
    }, v => v === 'ready', deadline(20000), { reconcileMs: 250 });
    const terminals = await waitFor('actual execution console labels', () => coreRows(f.suite), rows => rows.some(row => row.labels['spider.kind'] === 'remote-console' && row.labels['spider.session'] === parent.sessionId && row.labels['spider.machine'] === result.remote.machine), deadline(20000), { reconcileMs: 250 });
    const console = terminals.find(row => row.labels['spider.kind'] === 'remote-console' && row.labels['spider.session'] === parent.sessionId && row.labels['spider.machine'] === result.remote.machine)!.address;
    return { id: result.remote.jobId, address: result.remote.address, console, releasePath, result };
}
export interface CounterInput {
    login: string;
    quota_reset_date: string;
    quota_snapshots: {
        premium_interactions: {
            credits_used: number;
            entitlement: number;
            remaining: number;
            token_based_billing: true;
        };
    };
}
export function counterInput(threshold: '80' | '100', now: number = Date.now()): CounterInput {
    const date = new Date(now);
    const reset = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    const used = threshold === '80' ? 80 : 100;
    return { login: 'fixture-account', quota_reset_date: reset, quota_snapshots: { premium_interactions: {
                credits_used: used, entitlement: 100, remaining: 100 - used, token_based_billing: true,
            } } };
}
