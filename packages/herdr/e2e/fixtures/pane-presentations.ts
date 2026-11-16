// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createServer, createConnection } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { existsSync, appendFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { InteractiveDriver } from '../harness/pi.js';
import type { PaneAgentRow } from '../../src/panes/types.js';
import { HarnessError, assertSocketPath } from '../harness/environment.js';
import { spawnOwned } from '../harness/processes.js';
import { deadline, waitFor } from '../harness/wait.js';
import type { Suite, Tier } from '../harness/suite.js';
import { runHc, type Side } from '../harness/hc.js';
import { identityOf } from '../harness/resources.js';
import { parseHerdrConfig } from '../../src/config.js';
import { parsePaneServiceReply, parsePaneTerminal } from '../../src/panes/codec.js';
import type { PaneOpenIntent, PanePresentation, PaneServiceRequest, PaneServiceSnapshot, PaneServiceReply, PlacementState } from '../../src/panes/types.js';
import { HerdrLabelContract, type OwnerPlacement } from '../../src/contracts.js';

interface AppPane { id: string; mod?: string; props?: Record<string, unknown> }
interface AppTab { id: string; name: string; panes: AppPane[]; terminals: { pane: string; terminal: string }[] }
interface AppSpace { id: string; name: string; machine: null; tabs: AppTab[] }
export interface PresentationDocument { spaces: AppSpace[]; recent: never[] }
type AppReply = Record<string, any>;
type AppCall = (name: string, args: Record<string, any>) => Promise<AppReply>;

/** A synthetic app owns placement only. All execution and terminal state come from its selected core. */
export function createPresentationApp(hc: (args: readonly string[]) => Promise<AppReply>): AppCall {
  let next = 0, selected: { space: string; tab: string; focused_pane: string } | null = null;
  const spaces: AppSpace[] = [];
  const neighbors = new Map<string, Record<string, string>>();
  const proxyDisplays = new Set<string>();
  const reverse: Record<string, string> = { up: 'down', down: 'up', left: 'right', right: 'left' };
  const link = (anchor: string, pane: string, direction: string) => {
    const before = neighbors.get(anchor) ?? {}, opposite = reverse[direction];
    const next = before[direction];
    neighbors.set(pane, { [opposite]: anchor, ...(next ? { [direction]: next } : {}) });
    if (next) neighbors.get(next)![opposite] = pane;
    before[direction] = pane; neighbors.set(anchor, before);
  };
  const fresh = (prefix: string) => `${prefix}${++next}`;
  const tabFor = (id: string) => spaces.flatMap(space => space.tabs).find(tab => tab.id === id);
  const locate = (id: string) => {
    for (const space of spaces) for (const tab of space.tabs) {
      const pane = tab.panes.find(pane => pane.id === id);
      if (pane) return { space: space.id, tab: tab.id, focused_pane: pane.id };
    }
    throw new Error('unknown owned pane');
  };
  const erase = (id: string) => {
    const edges = neighbors.get(id) ?? {};
    for (const [direction, adjacent] of Object.entries(edges)) {
      const links = neighbors.get(adjacent), opposite = reverse[direction], next = edges[opposite];
      if (links?.[opposite] === id) { if (next) links[opposite] = next; else delete links[opposite]; }
    }
    neighbors.delete(id);
    for (const space of spaces) for (const tab of space.tabs) {
      for (const row of tab.terminals) if (row.pane === id) proxyDisplays.delete(row.terminal);
      tab.panes = tab.panes.filter(pane => pane.id !== id);
      tab.terminals = tab.terminals.filter(pane => pane.pane !== id);
    }
    if (selected?.focused_pane === id) {
      const tab = tabFor(selected.tab), first = tab?.panes[0];
      selected = first ? { ...selected, focused_pane: first.id } : null;
    }
  };
  const dispatch: AppCall = async (name, args) => {
    if (name === 'commands') return { commands: [
      { name: 'tab.new', args: [{ name: 'space', required: false }, { name: 'mod', required: false }, { name: 'props', required: false }] },
      { name: 'pane.split', args: [{ name: 'pane', required: true }, { name: 'direction', required: true }, { name: 'mod', required: false }, { name: 'props', required: false }] },
    ] };
    if (name === 'ls') {
      // Supported apps adopt labelled live terminals into a fresh pane, preserving focus:
      // herdrdev/herdr-app v0.1.16 src/window.rs, reconcile/start_adoption/adopt.
      const fallbackTabs = spaces.flatMap(space => space.tabs.filter(tab => tab.panes.some(pane => pane.mod === 'pane')).map(tab => ({ space, tab })));
      if (fallbackTabs.length || proxyDisplays.size) {
        const inventory = await hc(['ls', '--json']);
        if (!Array.isArray(inventory.terminals)) throw new Error('owned core inventory is unavailable');
        // window.rs checked_closed removes a pane only on a proved exit or kill.
        for (const address of [...proxyDisplays]) {
          const listed = inventory.terminals.find(row => row.address === address);
          if (listed && listed.state !== 'finished') continue;
          const proof = await hc(['get', address, '--json']);
          if (proof.address !== address || proof.state !== 'finished' || !['exited', 'killed'].includes(proof.reason)) continue;
          const pane = spaces.flatMap(space => space.tabs).flatMap(tab => tab.terminals).find(row => row.terminal === address)?.pane;
          if (pane) erase(pane);
        }
        for (const row of inventory.terminals) {
          if (!fallbackTabs.length || typeof row.address !== 'string' || row.address.includes('/') || row.state !== 'live') continue;
          if (spaces.some(space => space.tabs.some(tab => tab.terminals.some(item => item.terminal === row.address)))) continue;
          const proof = await hc(['get', row.address, '--json']);
          if (proof.address !== row.address || proof.state !== 'live') continue;
          const destination = fallbackTabs.find(({ space, tab }) => proof.labels?.['herdr.space'] === space.id && proof.labels?.['herdr.tab'] === tab.id);
          if (!destination) continue;
          const pane = { id: fresh('pane') }, anchor = destination.tab.panes.at(-1)!;
          link(anchor.id, pane.id, 'right'); destination.tab.panes.push(pane);
          destination.tab.terminals.push({ pane: pane.id, terminal: row.address });
          if (proof.labels?.['spider.kind'] === 'pane-proxy') proxyDisplays.add(row.address);
        }
      }
      return structuredClone({ spaces, recent: [] });
    }
    if (name === 'status') return { ...selected, errors: [], layout: 'synthetic-presentations' };
    if (name === 'space.new' || name === 'tab.new') {
      if (args.machine) throw new Error('only local app spaces are supported');
      const space = name === 'space.new' ? { id: fresh('sp'), name: String(args.name ?? 'Work'), machine: null, tabs: [] } as AppSpace : spaces.find(space => space.id === (args.space ?? selected?.space));
      if (!space) throw new Error('unknown owned space');
      const tab: AppTab = { id: fresh('tab'), name: String(args.name ?? 'Work'), panes: [], terminals: [] };
      const pane: AppPane = { id: fresh('pane'), ...(args.mod ? { mod: args.mod, props: structuredClone(args.props ?? {}) } : {}) };
      let terminal: string | undefined;
      if (!args.mod) {
        terminal = (await hc(['run', '--bg', '--no-notify', '--outlive-parent', '--json', ...(args.folder ? ['--cwd', args.folder] : []), ...(args.argv ? ['--', ...args.argv] : [])])).address;
        if (!terminal || terminal.includes('/')) throw new Error('execution terminal is not local');
        tab.terminals.push({ pane: pane.id, terminal });
      }
      tab.panes.push(pane); space.tabs.push(tab); if (name === 'space.new') spaces.push(space);
      selected = { space: space.id, tab: tab.id, focused_pane: pane.id };
      return { space: space.id, tab: tab.id, pane: pane.id, ...(terminal ? { terminal } : {}) };
    }
    if (name === 'pane.split') {
      if (!args.mod || !['right', 'down'].includes(args.direction)) throw new Error('only explicit mod splits are supported');
      const anchor = locate(args.pane), tab = tabFor(anchor.tab)!;
      const pane = { id: fresh('pane'), mod: String(args.mod), props: structuredClone(args.props ?? {}) };
      link(anchor.focused_pane, pane.id, args.direction);
      tab.panes.push(pane); selected = { ...anchor, focused_pane: pane.id }; return { pane: pane.id };
    }
    if (name === 'pane.go') {
      if (!selected || !reverse[args.direction]) throw new Error('an owned pane and direction are required');
      const adjacent = neighbors.get(selected.focused_pane)?.[args.direction];
      if (adjacent) selected = locate(adjacent);
      return { pane: selected.focused_pane };
    }
    if (name === 'pane.focus') {
      const id = args.pane ?? spaces.flatMap(space => space.tabs).flatMap(tab => tab.terminals).find(row => row.terminal === args.terminal)?.pane;
      selected = locate(String(id)); return { ok: true };
    }
    if (name === 'terminal.keep') {
      const address = String(args.terminal);
      if (address.includes('/')) throw new Error('only local presentation terminals can enter app panes');
      const target = await hc(['get', address, '--json']);
      if (target.state !== 'live') throw new Error('presentation is not live');
      if (target.labels?.['spider.kind'] === 'pane-proxy') proxyDisplays.add(address);
      const existing = spaces.flatMap(space => space.tabs).flatMap(tab => tab.terminals).find(row => row.terminal === address);
      if (existing) { selected = locate(existing.pane); return { pane: existing.pane }; }
      if (!selected) throw new Error('no selected owned tab');
      const tab = tabFor(selected.tab)!, pane = { id: fresh('pane') };
      if (!['right', 'down'].includes(args.place)) throw new Error('an explicit synthetic split direction is required');
      link(selected.focused_pane, pane.id, args.place);
      tab.panes.push(pane); tab.terminals.push({ pane: pane.id, terminal: address });
      selected = { ...selected, focused_pane: pane.id };
      return { pane: pane.id, tab: tab.id, terminal: address };
    }
    if (name === 'terminal.park') {
      const row = spaces.flatMap(space => space.tabs).flatMap(tab => tab.terminals).find(row => row.terminal === args.terminal);
      if (row) erase(row.pane); return { ok: true };
    }
    if (name === 'pane.close') {
      const id = String(args.pane ?? selected?.focused_pane);
      locate(id);
      const row = spaces.flatMap(space => space.tabs).flatMap(tab => tab.terminals).find(row => row.pane === id);
      if (row) await hc(['kill', row.terminal, '--json']);
      erase(id); return { ok: true };
    }
    if (name === 'tab.move') {
      const space = spaces.find(space => space.tabs.some(tab => tab.id === args.id));
      if (!space || !Number.isInteger(args.index) || args.index < 1 || args.index > space.tabs.length) throw new Error('an owned tab and valid index are required');
      const [tab] = space.tabs.splice(space.tabs.findIndex(tab => tab.id === args.id), 1);
      space.tabs.splice(args.index - 1, 0, tab); return { ok: true };
    }
    if (name === 'tab.close' || name === 'space.close') {
      const tabs = name === 'tab.close' ? [tabFor(String(args.id))].filter(Boolean) as AppTab[] : spaces.find(space => space.id === args.id)?.tabs ?? [];
      if (!tabs.length || args.confirmed !== true) throw new Error('explicit owned close confirmation required');
      for (const tab of tabs) for (const row of [...tab.terminals]) await hc(['kill', row.terminal, '--json']);
      for (const space of spaces) space.tabs = space.tabs.filter(tab => !tabs.includes(tab));
      if (name === 'space.close') spaces.splice(spaces.findIndex(space => space.id === args.id), 1);
      selected = null; return { ok: true };
    }
    throw new Error(`unsupported presentation app command: ${name}`);
  };
  let tail = Promise.resolve();
  return (name, args) => {
    const result = tail.then(() => dispatch(name, args)); tail = result.then(() => {}, () => {}); return result;
  };
}

export function presentationRows(world: PresentationDocument): { space: string; tab: string; pane: string; terminal: string }[] {
  return world.spaces.flatMap(space => space.tabs.flatMap(tab => tab.terminals.map(row => ({ space: space.id, tab: tab.id, ...row }))));
}
export function stableTerminal(row: Record<string, any>): Record<string, unknown> {
  return { address: row.address, state: row.state, created_ms: row.created_ms, pid: row.pid, labels: row.labels,
    cwd: row.foreground?.cwd ?? row.cwd ?? null, foregroundPid: row.foreground?.pid ?? null, cols: row.cols, rows: row.rows };
}
export function requirePaneHeadless(tier: Tier): void {
  if (tier !== 'headless') throw new HarnessError('missing-prerequisite', 'missing-prerequisite: B native keyboard, mouse, clipboard and deferred placeholder observations require the isolated app checklist');
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function presentationAppCommand(argv: readonly string[]): { name: string; args: Record<string, unknown> } {
  const name = argv[0] === 'do' ? argv[1]! : argv[0]!, args: Record<string, unknown> = {};
  if (argv[0] === 'do') for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i]!.replace(/^--/, ''), value = argv[i + 1]!;
    args[key] = ['props', 'argv', 'confirmed', 'focus', 'index'].includes(key) ? JSON.parse(value) : value;
  }
  return { name, args };
}

/** This process is an external app boundary, not a substitute for the packed pane service. */
export async function presentationAppMain(descriptor: string, argv: readonly string[]): Promise<void> {
  const input = JSON.parse(await readFile(descriptor, 'utf8')) as { socket: string; hc: string; env: Record<string, string>; trace: string };
  if (argv[0] !== 'serve') {
    const { name, args } = presentationAppCommand(argv);
    const result = await appSocket(input.socket, { name, args });
    process.stdout.write(JSON.stringify(result) + '\n'); return;
  }
  const call = createPresentationApp(async args => {
    const result = await promisify(execFile)(input.hc, [...args], { env: input.env, timeout: 5000, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout);
  });
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let bytes = ''; socket.setTimeout(5000, () => socket.destroy());
    socket.on('data', chunk => {
      bytes += chunk.toString(); if (Buffer.byteLength(bytes) > 1024 * 1024) { socket.destroy(); return; }
      if (!bytes.includes('\n')) return;
      const { name, args } = JSON.parse(bytes.slice(0, bytes.indexOf('\n')));
      socket.removeAllListeners('data');
      void call(name, args).then(result => {
        appendFileSync(input.trace, JSON.stringify({ at: Date.now(), name, args, result }) + '\n', { mode: 0o600 });
        socket.end(JSON.stringify(result) + '\n');
      }, error => socket.end(JSON.stringify({ error: String(error.message) }) + '\n'));
    });
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(input.socket, ok); });
  await chmod(input.socket, 0o600);
  await new Promise<void>(ok => { process.once('SIGTERM', ok); process.once('SIGINT', ok); });
  for (const socket of sockets) socket.destroy(); await new Promise<void>(ok => server.close(() => ok()));
}
export function appSocket(socketPath: string, request: object): Promise<AppReply> {
  return new Promise((ok, fail) => {
    const socket = createConnection(socketPath); let data = '';
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => { data += chunk.toString(); if (!data.includes('\n')) return; socket.destroy();
      try { const result = JSON.parse(data.slice(0, data.indexOf('\n'))); if (result.error) fail(new Error(result.error)); else ok(result); } catch (error) { fail(error); }
    });
    socket.on('error', fail); socket.setTimeout(5000, () => { socket.destroy(); fail(new Error('presentation app deadline')); });
  });
}

export interface PaneFixture {
  suite: Suite; env: Record<string, string>; remoteEnv: Record<string, string>; cli: string; packageRoot: string;
  stateRoot: string; bindingRoot: string; faultFile: string; app: AppCall; anchor: OwnerPlacement; unrelated: Record<string, unknown>;
  request(request: PaneServiceRequest): Promise<PaneServiceReply>;
  snapshot(): Promise<PaneServiceSnapshot>;
  open(place?: PaneOpenIntent['place'], machineKey?: string, program?: PaneOpenIntent['program']): Promise<PanePresentation>;
  current(id: string): Promise<PanePresentation>;
  state(): Promise<PlacementState>;
  terminal(address: string, side?: Side): Promise<Record<string, any>>;
  screen(address: string, side?: Side): Promise<string>;
  send(address: string, text: string, side?: Side): Promise<void>;
  assertUnrelated(): Promise<{ before: Record<string, unknown>; after: Record<string, unknown> }>;
  evidence(name: string): Promise<void>;
}

/** A failed attach is a stream loss. The wrapper never changes source identity or invents a target. */
const faultTransport = String.raw`
import {spawn} from 'node:child_process';import{readFileSync,appendFileSync}from'node:fs';
const input=JSON.parse(readFileSync(process.argv[2],'utf8')),args=process.argv.slice(3);
const remote=args.some(value=>value.startsWith(input.remote+'/'));
const down=()=>{try{return JSON.parse(readFileSync(input.fault,'utf8')).disconnected===true}catch{return false}};
appendFileSync(input.trace,JSON.stringify({at:Date.now(),argv:args})+'\n',{mode:0o600});
if(remote&&down()){process.stderr.write('synthetic link unavailable\n');process.exit(1)}
let fault={};try{fault=JSON.parse(readFileSync(input.fault,'utf8'))}catch{}
if(args[0]==='run'&&args.includes(input.viewer)&&fault.viewerLaunchFailed){process.stderr.write(JSON.stringify({error:{kind:'cannot_spawn',message:'synthetic viewer spawn unavailable'}})+'\n');process.exit(1)}
const capture=['get','exec','run','ls','read','rm'].includes(args[0]),output={stdout:'',stderr:''};
const child=spawn(input.hc,args,{env:process.env,stdio:capture?['inherit','pipe','pipe']:'inherit'});
if(capture)for(const stream of ['stdout','stderr'])child[stream].on('data',bytes=>{process[stream].write(bytes);if(output[stream].length<1048576)output[stream]+=bytes.toString()});
const timer=args[0]==='attach'&&remote?setInterval(()=>{if(down())child.kill('SIGTERM')},25):null;
for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>child.kill(signal));
child.once('close',(code)=>{if(timer)clearInterval(timer);if(capture)appendFileSync(input.trace,JSON.stringify({at:Date.now(),argv:args,exitCode:code,...output})+'\n',{mode:0o600});process.exit(code??1)});
`;

export async function preparePanePresentations(suite: Suite, options: { disconnectedChoice?: boolean } = {}): Promise<PaneFixture> {
  requirePaneHeadless(suite.options.tier);
  const cores = suite.cores; if (!cores) throw new HarnessError('missing-prerequisite', 'B stories require two independently owned cores');
  if (cores.local.coreId === cores.dest.coreId || cores.local.socket === cores.dest.socket) throw new Error('independent source cores required');
  // Copy before staging a content-addressed endpoint. The runner's packed artifact remains read-only.
  const packageRoot = suite.ownPath(join(suite.root, 'pkg')); await cp(suite.packed.root, packageRoot, { recursive: true, verbatimSymlinks: true });
  const cli = join(packageRoot, 'dist/herdr/cli.mjs');
  for (const entry of ['cli.mjs', 'pane-endpoint.mjs']) {
    const original = createHash('sha256').update(await readFile(join(suite.packed.root, 'dist/herdr', entry))).digest('hex');
    const copy = createHash('sha256').update(await readFile(join(packageRoot, 'dist/herdr', entry))).digest('hex');
    if (original !== copy) throw new Error('packed pane entry changed during copy');
    await suite.evidence(`packed-${entry}.json`, { entry, sha256: copy });
  }
  const bin = join(suite.root, 'bin'), faultFile = join(suite.root, 'link.json'), faultDescriptor = join(suite.root, 'link-descriptor.json');
  const hc = join(bin, 'pane-hc'), transport = join(bin, 'pane-hc.mjs');
  await writeFile(faultFile, JSON.stringify({ disconnected: false }), { mode: 0o600 });
  await writeFile(transport, faultTransport, { mode: 0o600 });
  await writeFile(faultDescriptor, JSON.stringify({ hc: cores.wrapper, remote: cores.dest.coreId, fault: faultFile, trace: join(suite.root, 'pane-hc.jsonl'), viewer: join(packageRoot, 'dist/herdr/viewer.mjs') }), { mode: 0o600 });
  await writeFile(hc, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(transport)} ${quote(faultDescriptor)} "$@"\n`, { mode: 0o700 });
  const global = suite.directories.SPIDER_GLOBAL_ROOT, remoteRoot = join(suite.root, 'remote');
  await mkdir(join(remoteRoot, 'herdr'), { recursive: true, mode: 0o700 });
  await mkdir(join(global, 'herdr'), { recursive: true, mode: 0o700 });
  const remoteEnv = { ...cores.dest.env, SPIDER_GLOBAL_ROOT: remoteRoot, HC_SOCKET: cores.dest.socket };
  const originalPi = join(bin, 'pane-pi-base');
  await writeFile(originalPi, await readFile(suite.pi.launcher), { mode: 0o700 });
  await writeFile(suite.pi.launcher, `#!/bin/sh\nif [ "$HC_SESSION" = ${quote(cores.dest.namespace)} ]; then SPIDER_GLOBAL_ROOT=${quote(remoteRoot)}; export SPIDER_GLOBAL_ROOT; fi\nexec ${quote(originalPi)} "$@"\n`, { mode: 0o700 });
  const sourceShell = join(bin, 'source-shell');
  await writeFile(sourceShell, '#!/bin/sh\nif [ "$1" = -lc ]; then shift; code=$1; shift; exec /bin/sh -c "$code" "$@"; fi\nexec /bin/sh "$@"\n', { mode: 0o700 });
  const sourceNode = join(bin, 'source-node');
  await writeFile(sourceNode, `#!/bin/sh\n${Object.entries({ ...remoteEnv, SHELL: sourceShell }).map(([key, value]) => `${key}=${quote(value)}; export ${key}`).join('\n')}\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o700 });
  const socket = assertSocketPath(suite.root, join(suite.root, 'pa.s')), appDescriptor = join(suite.root, 'pane-app.json');
  const appBinary = join(bin, 'pane-app'), appModule = join(suite.root, 'pane-app.mjs');
  const appEntry = join(suite.root, 'pane-app-entry.ts');
  await writeFile(appEntry, `import {presentationAppMain} from ${JSON.stringify(fileURLToPath(import.meta.url))};await presentationAppMain(process.argv[2],process.argv.slice(3));`, { mode: 0o600 });
  const { build } = await import('vite');
  await build({ configFile: false, logLevel: 'silent', build: { write: true, emptyOutDir: false, outDir: suite.root,
    lib: { entry: appEntry, formats: ['es'], fileName: () => 'pane-app.mjs' }, rolldownOptions: { external: id => id.startsWith('node:'), treeshake: { moduleSideEffects: false } } } });
  await writeFile(appBinary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(appModule)} ${quote(appDescriptor)} "$@"\n`, { mode: 0o700 });
  const env = { ...cores.local.env, HC_SOCKET: cores.local.socket, SPIDER_GLOBAL_ROOT: global };
  await writeFile(appDescriptor, JSON.stringify({ socket, hc, env, trace: join(suite.root, 'pane-app-calls.jsonl') }), { mode: 0o600 });
  spawnOwned(suite.ledger, { label: 'presentation-app', command: process.execPath, args: [appModule, appDescriptor, 'serve'], env, cwd: suite.root, stdio: { log: join(suite.root, 'pane-app.log') } });
  await waitFor('owned presentation app socket', () => existsSync(socket), Boolean, deadline(5000));
  const app: AppCall = (name, args) => appSocket(socket, { name, args });
  const base = { enabled: true, core: { binary: hc, config: join(suite.directories.XDG_CONFIG_HOME, 'herdr-core/config.toml') },
    agentDirectory: suite.directories.PI_CODING_AGENT_DIR, globalRoot: global, shellRc: join(suite.root, 'shellrc'), spaces: [], machines: [],
    limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 } };
  const config = parseHerdrConfig({ ...base, app: { binary: appBinary, home: suite.directories.HERDR_APP_HOME }, machines: [
    { name: cores.machine, nodePath: sourceNode, aliases: [], runtime: { directory: join(suite.root, 'runtime'), cwd: null, commands: { shell: ['/bin/sh'] } } },
    ...(options.disconnectedChoice ? [{ name: 'box-2.invalid', nodePath: sourceNode, aliases: [], runtime: { directory: join(suite.root, 'unreachable-runtime'), cwd: null, commands: { shell: ['/bin/sh'] } } }] : []),
  ] });
  const remoteConfig = parseHerdrConfig({ ...base, mode: 'core-only', globalRoot: remoteRoot, machines: [] });
  await writeFile(join(global, 'herdr/config.json'), JSON.stringify(config), { mode: 0o600 });
  await writeFile(join(remoteRoot, 'herdr/config.json'), JSON.stringify(remoteConfig), { mode: 0o600 });
  const previous = JSON.parse(await readFile(join(global, 'config.json'), 'utf8'));
  await writeFile(join(global, 'config.json'), JSON.stringify({ ...previous, 'herdr.enabled': true }), { mode: 0o600 });
  await writeFile(join(remoteRoot, 'config.json'), JSON.stringify({ ...previous, 'herdr.enabled': true }), { mode: 0o600 });
  Object.assign(suite.pi.env, env);
  const endpoint = join(packageRoot, 'dist/herdr/pane-endpoint.mjs'), bytes = await readFile(endpoint), digest = createHash('sha256').update(bytes).digest('hex');
  const staged = `pane-endpoint-${digest}.mjs`; await writeFile(join(packageRoot, 'dist/herdr', staged), bytes, { mode: 0o600 });
  for (const root of [global, remoteRoot]) await writeFile(join(root, 'herdr/installation.json'), JSON.stringify({ version: 1, packageRoot, endpoint: { file: staged, digest, protocol: 1 } }), { mode: 0o600 });
  const cwd = await suite.project('panes');
  const created = await app('space.new', { name: 'Work', folder: cwd, argv: ['/bin/sh', '-c', 'printf unrelated-ready; exec cat'] });
  suite.ledger.update(value => { value.terminals.push({ side: 'local', address: created.terminal }); });
  const stateRoot = join(global, 'roam/placement'), bindingRoot = join(global, 'herdr/panes');
  const anchor = { space: created.space, tab: created.tab, pane: created.pane } as OwnerPlacement;
  const terminal = async (address: string, side: Side = 'local') => {
    const result = await suite.hc(['get', address, '--json'], side); if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
    return result.json as Record<string, any>;
  };
  const unrelated = stableTerminal(await waitFor('unrelated program reaches its foreground identity', () => terminal(created.terminal),
    row => row.foreground?.pid === row.pid && row.foreground?.argv?.[0]?.split('/').at(-1) === 'cat', deadline(5000)));
  const requestOnce = async (value: PaneServiceRequest) => {
    const result = await suite.invoke(process.execPath, [cli, 'panes', 'request', '--json', JSON.stringify(value)], env);
    await suite.evidence(`request-${value.operationId}.json`, result);
    if (result.exitCode !== 0) throw new Error(`packed pane request: ${result.stderr || result.stdout}`);
    return parsePaneServiceReply(JSON.parse(result.stdout));
  };
  const request = async (value: PaneServiceRequest) => {
    const reply = await requestOnce(value);
    if (reply.kind !== 'outcome' || reply.outcome.reason !== 'operation-in-progress') return reply;
    return waitFor('packed operation finishes under its original ID', () => requestOnce(value), reply => reply.kind !== 'outcome' || reply.outcome.reason !== 'operation-in-progress', deadline(20000));
  };
  const snapshot = async () => { const reply = await request({ version: 1, op: 'snapshot', operationId: randomUUID() }); if (reply.kind !== 'snapshot') throw new Error('expected pane snapshot'); return reply; };
  const fixture: PaneFixture = { suite, env, remoteEnv, cli, packageRoot, stateRoot, bindingRoot, faultFile, app, anchor, unrelated, request, snapshot,
    async state() { try { return JSON.parse(await readFile(join(stateRoot, 'roam-placement.json'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return { version: 2, revision: 0, presentations: [], slots: [], attempts: [], choices: [], launches: [] }; } },
    async current(id) { const p = (await fixture.state()).presentations.find(p => p.id === id); if (!p) throw new Error(`missing presentation ${id}`); return p; },
    async open(place = 'tab', machineKey = cores.machine, program = { kind: 'shell' }) {
      const machine = (await snapshot()).machines.find(row => row.key === machineKey);
      if (!machine?.coreId) throw new Error(`chosen machine unavailable: ${machineKey}`);
      const operationId = randomUUID(), intent: PaneOpenIntent = { operationId, space: anchor.space, place, anchor: place === 'tab' ? null : anchor, program };
      const value: PaneServiceRequest = { version: 1, op: 'open', operationId, intent, machineKey, coreId: machine.coreId, machineId: machine.machineId };
      const result = await request(value);
      if (result.kind !== 'outcome' || result.outcome.status !== 'complete' || !result.outcome.presentation) throw new Error(`creation was not acknowledged: ${JSON.stringify(result)}`);
      const p = result.outcome.presentation;
      suite.ledger.update(value => { value.terminals.push({ side: machine.alias === null ? 'local' : 'dest', address: p.target.terminalId }); if (p.proxy) value.terminals.push({ side: 'local', address: p.proxy }); });
      return p;
    }, terminal,
    async screen(address, side = 'local') { const result = await suite.hc(['read', address, '--lines', '100', '--json'], side); if (result.exitCode !== 0) throw new Error(result.stderr); return String((result.json as { text?: string }).text ?? result.stdout); },
    async send(address, text, side = 'local') { const result = await suite.hc(['send', '--json', '--force', address, text], side); if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout); },
    async assertUnrelated() { return { before: unrelated, after: stableTerminal(await terminal(created.terminal)) }; },
    async evidence(name) { await suite.evidence(name, { state: await fixture.state(), snapshot: await snapshot(), layout: await app('ls', {}), cores: { local: cores.local.coreId, remote: cores.dest.coreId }, unrelated: await fixture.assertUnrelated() }); },
  };
  const runtime = await readFile(join(packageRoot, 'dist/herdr/remote-runtime.mjs'));
  const runtimeName = `runtime-${createHash('sha256').update(runtime).digest('hex')}.mjs`;
  await mkdir(join(suite.root, 'runtime'), { mode: 0o700 });
  // Match the installed runtime path without changing the product's launch command.
  const { runtimeInstallPath } = await import('../../src/setup/installer.js');
  await writeFile(runtimeInstallPath(join(suite.root, 'runtime'), runtime), runtime, { mode: 0o700 });
  await suite.evidence('source-runtime.json', { sha256: createHash('sha256').update(runtime).digest('hex'), name: runtimeName });
  await snapshot(); return fixture;
}

export function targetFacts(row: Record<string, any>): import('../../src/panes/types.js').PaneTerminalFacts { return parsePaneTerminal(row); }

export async function paneHeaderFunctions(packageRoot: string): Promise<any> {
  const source = (await readFile(join(packageRoot, 'packages/herdr/assets/pane/machine.js'), 'utf8')).replace(/^import .*;\s*$/gm, '').replace(/export /g, '');
  return new Function(`${source}; return {panePresentation,paneMachineFact,resolvePaneHeaderFacts};`)();
}
export async function paneActionFunctions(packageRoot: string): Promise<any> {
  const { panePresentation } = await paneHeaderFunctions(packageRoot);
  const source = (await readFile(join(packageRoot, 'packages/herdr/assets/pane/actions.js'), 'utf8')).replace(/^import .*;\s*$/gm, '').replace(/export /g, '');
  return new Function('panePresentation', `${source}; return {handlePaneCommand,paneActionPorts};`)(panePresentation);
}

export async function paneNavigation(f: PaneFixture): Promise<any[]> {
  const root = join(f.packageRoot, 'packages/herdr/assets');
  const feed = await import(/* @vite-ignore */ pathToFileURL(join(root, 'shared/feed.js')).href);
  const projection = await import(/* @vite-ignore */ pathToFileURL(join(root, 'shared/presentations.js')).href);
  const childrenSource = (await readFile(join(root, 'agents/children.js'), 'utf8')).replace(/^import .*;\s*$/gm, '').replace(/export /g, '');
  const children = new Function('FEED_DISCONNECT_MS', `${childrenSource}; return {filterTopLevelAgents,projectAgentChildren};`)(feed.FEED_DISCONNECT_MS);
  const source = (await readFile(join(root, 'shared/navigation.js'), 'utf8')).replace(/^import .*;\s*$/gm, '').replace(/export /g, '');
  const project = new Function('api', `const {filterTopLevelAgents,projectAgentChildren,FEED_DISCONNECT_MS,projectPanePresentations}=api; ${source}; return projectNavigation;`)({ ...children, ...projection, ...feed });
  const paneSnapshot = await f.snapshot(), layout = await f.app('ls', {}) as PresentationDocument, status = await f.app('status', {});
  const spaces = layout.spaces.map((space, index) => ({ ...space, index, active: status.space === space.id, tabs: space.tabs.map(tab => ({ ...tab, active: tab.id === status.tab, status: null })) }));
  return project({ coreId: f.suite.cores!.local.coreId, destination: f.anchor, agents: [], terminals: [], panes: presentationRows(layout), spaces,
    feeds: [], machines: [], contract: HerdrLabelContract, now: Date.now(), completedHours: 24, completedRows: 50, paneSnapshot });
}

export interface PaneOwner { pi: InteractiveDriver; row: Extract<PaneAgentRow, { unavailableReason: null }>; feed: Record<string, any>; file: string }
export async function launchPaneOwner(f: PaneFixture, side: Side, resume?: string): Promise<PaneOwner> {
  const cwd = await f.suite.project(`owner-${side}-${randomUUID().slice(0, 6)}`);
  const result = await f.suite.launchPi({ mode: 'interactive', side, cwd, label: `owner-${side}`, args: ['--approve', ...(resume ? ['--session', resume] : [])], extraEnv: side === 'dest' ? f.remoteEnv : f.env });
  if (result.mode !== 'interactive') throw new Error('an interactive owner is required');
  const start = await result.waitEvent('session_start', event => event.mode === 'tui', deadline(20000));
  const labelled = await f.suite.hc(['label', result.terminal, `spider.e2e-owner=${start.sessionId}`, '--json'], side);
  if (labelled.exitCode !== 0) throw new Error(labelled.stderr || labelled.stdout);
  const global = (side === 'dest' ? f.remoteEnv : f.env).SPIDER_GLOBAL_ROOT!;
  const feed = await waitFor('source owner publishes authenticated feed', async () => {
    try { return JSON.parse(await readFile(join(global, 'herdr/sessions', String(start.sessionId), 'session.json'), 'utf8')); } catch { return null; }
  }, value => Boolean(value?.ipc && value?.generation && value.lifecycle === 'live' && value.owner?.terminal.terminalId === result.terminal.split('/').at(-1)), deadline(20000));
  const rows = await waitFor('source inventory observes owner', () => f.snapshot(), value => value.rows.some(row => row.sessionId === start.sessionId && row.generation === feed.generation && row.target?.identityLabels['spider.e2e-owner'] === start.sessionId), deadline(20000));
  const row = rows.rows.find(row => row.sessionId === start.sessionId && row.generation === feed.generation && row.unavailableReason === null);
  if (!row || row.unavailableReason !== null || typeof start.sessionFile !== 'string') throw new Error('source owner identity is unavailable');
  return { pi: result, row, feed, file: start.sessionFile };
}

export async function stopPaneHelper(f: PaneFixture): Promise<string> {
  const claim = JSON.parse(await readFile(join(f.bindingRoot, 'service.json'), 'utf8'));
  const before = await f.terminal(claim.address);
  if (before.labels['spider.kind'] !== 'pane-service' || before.state !== 'live') throw new Error('owned pane helper identity changed');
  const result = await f.suite.hc(['kill', claim.address, '--json']);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  await waitFor('owned pane helper stops', () => f.terminal(claim.address), value => value.state === 'finished', deadline(5000));
  return claim.address;
}

export async function replaceAliasWithDecoy(f: PaneFixture): Promise<{ coreId: string; terminal: string; screen(): Promise<string> }> {
  const { suite } = f, cores = suite.cores!, namespace = 'x';
  const env: Record<string, string> = { ...cores.local.env, HC_SESSION: namespace, XDG_CONFIG_HOME: join(suite.root, 'xc'), HOME: join(suite.root, 'xh'), TMPDIR: join(suite.root, 'xt') };
  for (const key of ['HC_SOCKET', 'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SCOPE', 'XDG_RUNTIME_DIR']) delete (env as Record<string, string>)[key];
  for (const directory of [env.XDG_CONFIG_HOME, env.HOME, env.TMPDIR, join(env.XDG_CONFIG_HOME, 'herdr-core')]) await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(env.XDG_CONFIG_HOME, 'herdr-core/config.toml'), 'notes = false\n', { mode: 0o600 });
  const socket = assertSocketPath(suite.root, join(env.XDG_STATE_HOME, 'herdr-core', namespace, `${namespace}.sock`));
  const binary = suite.ledger.read().cores.find(core => core.side === 'local')!.hcBinary;
  suite.ledger.update(value => { value.cores.push({ side: 'alias-decoy', namespace, socket, hcBinary: binary, env }); });
  const invoke = async (args: string[]) => { const result = await runHc(cores.wrapper, args, env); if (result.exitCode !== 0 || !result.json) throw new Error(result.stderr || result.stdout); return result.json as Record<string, any>; };
  await invoke(['server', 'start', '--json']);
  const status = await invoke(['server', 'status', '--json']);
  const identity = identityOf(status.pid), coreId = status.core?.id;
  if (typeof coreId !== 'string' || coreId === cores.local.coreId || coreId === cores.dest.coreId) throw new Error('alias decoy core is not independent');
  suite.ledger.update(value => { Object.assign(value.cores.find(core => core.side === 'alias-decoy')!, { coreId, pid: identity.pid, start: identity.start }); });
  const created = await invoke(['run', '--bg', '--no-notify', '--outlive-parent', '--json', '--', '/bin/cat']);
  if (typeof created.address !== 'string' || created.address.includes('/')) throw new Error('decoy terminal is not local to its owned core');
  suite.ledger.update(value => { value.terminals.push({ side: 'alias-decoy', address: created.address }); });
  const descriptor = join(suite.root, 'via-x.json'), via = join(suite.root, 'bin/via-x');
  await writeFile(descriptor, JSON.stringify({ root: suite.root, env, log: cores.viaLog, ledgerPath: suite.ledger.path, socket, viaDirectory: suite.ledger.read().viaDirectory }), { mode: 0o600 });
  await writeFile(via, `#!/bin/sh\nexec 9<"$0"\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./via.mjs', import.meta.url)))} ${quote(descriptor)} "$@"\n`, { mode: 0o700 });
  for (const args of [['machine', 'rm', cores.machine, '--json'], ['machine', 'add', '--via', via, '--name', cores.machine, '--session', namespace, '--json']]) {
    const result = await suite.hc(args); if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  }
  const machines = (await suite.hc(['machine', 'ls', '--json'])).json as { machines: { name: string; id: string }[] };
  if (!machines.machines.some(machine => machine.name === cores.machine && machine.id === coreId)) throw new Error('replacement alias was not proved');
  return { coreId, terminal: created.address, async screen() { const value = await invoke(['read', created.address, '--json']); if (typeof value.text !== 'string') throw new Error('invalid decoy screen'); return value.text; } };
}

export async function paneProcesses(f: PaneFixture): Promise<Record<string, unknown>[]> {
  const ledger = f.suite.ledger.read(), pids = new Set([...ledger.processes, ...ledger.cores].map(value => value.pid));
  for (const side of ['local', 'dest'] as const) {
    const inventory = await f.suite.hc(['ls', '--all', '--json'], side);
    if (inventory.exitCode !== 0) throw new Error(inventory.stderr);
    for (const terminal of (inventory.json as { terminals: { pid: number }[] }).terminals) pids.add(terminal.pid);
  }
  const result = await f.suite.invoke('/bin/ps', ['-wwaxo', 'pid=,ppid=,time=,rss=,args=']);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.split('\n').filter(line => line.includes(f.suite.root) || pids.has(Number(/^\s*(\d+)/.exec(line)?.[1]))).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) throw new Error('cannot observe owned process accounting');
    return { pid: Number(match[1]), ppid: Number(match[2]), cpuSeconds: match[3].split(':').reduce((value, part) => value * 60 + Number(part), 0), rssKiB: Number(match[4]), argv: match[5] };
  });
}

export interface PickerFixture {
  view: any; inputs: any[]; host: any; notices: string[]; overlays: any[];
  control(id: string): any; text(): string; select(key: string, method: 'mouse' | 'keyboard'): Promise<void>;
}
/** Installed picker handlers use real packed CLI calls. Widget events do not certify native input. */
export async function mountPanePicker(f: PaneFixture, intent: PaneOpenIntent, machineKey: string | null, continuation = 'shell'): Promise<PickerFixture> {
  // @ts-ignore The shared strict widget fixture is also consumed by the installed-mod unit tests.
  const { createUiModules } = await import('../../src/__tests__/strict-mod-api.mjs');
  const widgets = createUiModules(), inputs: any[] = [], notices: string[] = [], overlays: any[] = [];
  const world = await f.app('ls', {}), status = await f.app('status', {});
  const state = new Map<string, unknown>();
  const cx: any = { focus_handle: () => ({ focus() {} }), notify() {}, stop_propagation() {}, spawn(fn: (cx: any) => unknown) { return Promise.resolve().then(() => fn(cx)); } };
  const config = { version: 1, nodePath: process.execPath, cliPath: f.cli };
  const host: any = {
    props: () => ({ overlay: 'owned-picker', intent, machineKey, continuation }),
    focused: () => ({ ...status, pane: status.focused_pane, terminal: presentationRows(world as PresentationDocument).find(row => row.pane === status.focused_pane)?.terminal ?? null }),
    panes: () => world.spaces.flatMap((space: AppSpace) => space.tabs.flatMap(tab => tab.panes.map(pane => ({ pane: pane.id, tab: tab.id, terminal: tab.terminals.find(row => row.pane === pane.id)?.terminal ?? null })))),
    spaces: () => world.spaces, settings: () => ({ zoom: 1 }), appHome: () => f.suite.directories.HERDR_APP_HOME,
    readTextFile: async () => JSON.stringify(config), shared: (key: string) => state.get(key), setShared: (key: string, value: unknown) => state.set(key, value),
    openOverlay: (overlay: unknown) => { overlays.push(overlay); }, closeOverlay() {}, notify: (value: { title: string }) => { notices.push(value.title); },
    exec: async (binary: string, args: string[]) => { const result = await f.suite.invoke(binary, args, f.env); return { ...result, code: result.exitCode }; },
  };
  const InputState = { new() { const handlers: Record<string, Function> = {}; const input = { handlers, valueText: '', on(name: string, fn: Function) { handlers[name] = fn; }, value() { return this.valueText; }, focus() {} }; inputs.push(input); return input; } };
  const actions = await import(/* @vite-ignore */ pathToFileURL(join(f.packageRoot, 'packages/herdr/assets/machines/actions.js')).href);
  const source = (await readFile(join(f.packageRoot, 'packages/herdr/assets/machines/picker.js'), 'utf8')).replace(/^import .*;\s*$/gm, '').replace(/export /g, '');
  const api = { ...widgets['gpui-kit'], ...widgets['gpui-base'], InputState, Input: { new: () => widgets['gpui-kit'].div() }, herdr: host, ...actions };
  const factory = new Function('api', `const { ${Object.keys(api).join(', ')} } = api; ${source}; return machinePickerView;`)(api);
  const view = new (factory(intent.place))(); view.init({}, cx); await view.ready;
  const flatten = (root: any): any[] => root && typeof root === 'object' ? [root, ...(root.items ?? []).flatMap(flatten)] : [];
  const text = (root: any): string => typeof root === 'string' ? root : root && typeof root === 'object' ? (root.items ?? []).map(text).join(' ') : '';
  const control = (id: string) => flatten(view.render()).find(node => node.styles?.id?.[0] === id);
  return { view, inputs, host, notices, overlays, control, text: () => text(view.render()),
    async select(key, method) {
      if (method === 'mouse') { const row = control(`machine-${key}`); if (!row?.events.on_click) throw new Error('machine row is disabled'); row.events.on_click({}, cx); }
      else { inputs[0].valueText = key; inputs[0].handlers.change({}, cx); inputs[0].handlers.submit({}, cx); }
      await waitFor('installed picker action settles', () => !view.pending, Boolean, deadline(20000));
      if (view.problem) throw new Error(view.problem);
    },
  };
}
