// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { HerdrError } from '../client/parse.js';
import type { AcceptanceMode, AppClient, CoreId, Generation, HcClient, Owner, SessionId, TerminalAddress, TerminalId, TerminalSummary } from '../contracts.js';
import type { HerdrHarness, OwnedResource } from './testutil.js';

// Setup recovery exercises file publication, not app or HC process transport.
// Unknown operations fail instead of silently turning an integration check into a fake.
export async function createInProcessHerdrHarness(mode: AcceptanceMode): Promise<HerdrHarness> {
  if (mode !== 'fake') throw new Error('The in-process setup harness only supports fake mode');
  const base = resolve('.spider/scratch/h');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'setup-'));
  try {
    const directories = { local: join(root, 'l'), remote: join(root, 'r'), app: join(root, 'a'), agent: join(root, 'p'), global: join(root, 'g'), tmp: join(root, 'tmp') };
    for (const directory of Object.values(directories)) await mkdir(directory, { recursive: true });
    const configHome = join(directories.local, 'c');
    await mkdir(join(configHome, 'herdr-core'), { recursive: true });
    await writeFile(join(directories.app, 'keys.json'), JSON.stringify({
      global: { 'cmd-p': 'mod.open:picker', 'cmd-n': 'space.new', 'cmd-shift-w': 'pane.close' },
      terminal: { 'ctrl-v': 'terminal.paste_image' },
    }));
    await writeFile(join(directories.global, 'config.json'), JSON.stringify({ organism: { enabled: false } }));

    const localSocket = join(root, 'local.sock'), remoteSocket = join(root, 'remote.sock');
    const coreId = 'setup-core' as CoreId;
    const core = { coreId, socket: localSocket, sessionNamespace: 'fixture' };
    const terminal = { ...core, terminalId: 'owner' as TerminalId, address: 'owner' as TerminalAddress };
    const owner: Owner = { sessionId: 'setup-session' as SessionId, generation: 'setup-generation' as Generation, terminal, cwd: root, sessionFile: null, name: 'fixture' };
    const terminals = new Map<TerminalAddress, TerminalSummary>();
    const summary = (address: TerminalAddress, labels: Readonly<Record<string, string>> = {}): TerminalSummary => ({
      address, parent: null, labels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null,
    });
    terminals.set(terminal.address, summary(terminal.address));
    const files = new Map<string, Buffer>();
    const localEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: configHome };
    const history: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
    let next = 0, closed = false;
    const unavailable = (): never => { throw new Error('Unexpected in-process setup harness operation'); };
    const unsupported = async (): Promise<never> => unavailable();
    const hc: HcClient = {
      identity: async () => core,
      caller: async () => terminal,
      machines: unsupported,
      run: async request => {
        const address = `setup-terminal-${++next}` as TerminalAddress;
        terminals.set(address, summary(address, request.labels));
        history.push({ argv: ['run', '--no-notify', ...request.argv], env: localEnv });
        return { address, coreId };
      },
      get: async address => {
        const value = terminals.get(address);
        if (!value) throw new HerdrError('not_found', 'No such fixture terminal');
        return value;
      },
      read: unsupported,
      kill: async address => {
        const value = terminals.get(address);
        if (!value) throw new HerdrError('not_found', 'No such fixture terminal');
        terminals.set(address, { ...value, state: 'finished' });
      },
      rm: async address => { terminals.delete(address); },
      setLabels: unsupported,
      fileRead: async (_machine, path) => {
        const bytes = files.get(path);
        if (!bytes) throw new HerdrError('file-not-found', 'No such fixture file');
        return Buffer.from(bytes);
      },
      fileWrite: async (_machine, path, bytes) => {
        files.set(path, Buffer.from(bytes));
        history.push({ argv: ['file', 'write', path], env: localEnv });
      },
      events: unavailable,
    };
    const app: AppClient = {
      tabTerminals: unsupported, ownerPlacement: unsupported, awaitPane: unsupported,
      command: async name => {
        if (name !== 'layout.switch' && name !== 'app.theme') return unavailable();
        return {};
      },
    };
    const inventory = async (): Promise<OwnedResource[]> => [...terminals.keys()].map(id => ({ kind: 'terminal', id }));
    return {
      mode, root, namespace: 'fixture', hcBinary: join(root, 'hc'), appBinary: join(root, 'app'), sshBinary: join(root, 'ssh'), nodeBinary: process.execPath,
      localSocket, remoteSocket, foreignSocket: join(root, 'foreign.sock'), localEnv, remoteEnv: { ...localEnv },
      localCoreId: coreId, remoteCoreId: 'remote-core' as CoreId, hc, remoteHc: hc, app, owner, directories,
      start: async () => { if (closed) throw new Error('The setup harness is closed'); },
      close: async () => { if (!closed) { terminals.clear(); await rm(root, { recursive: true, force: true }); closed = true; } },
      remainingOwnedResources: inventory, inventory, mutations: () => [], withUnprovedSocket: unavailable, trackProcess: unavailable,
      scenario: unsupported, emitCore: unsupported, calls: async () => [...history], cli: unsupported, cleanupProof: null,
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
