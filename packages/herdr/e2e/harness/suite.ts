// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// createSuite: one fenced fixture per story. Owned roots, ledger + watchdog, packed build, real cores, pi, app adapter.
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { userInfo } from 'node:os';
import { buildEnvironment, createFencedDirectories, createFixtureRoot, HarnessError, ledgerDirectory, ownedPath, type FencedDirectories, type OwnedPath, type StoryId } from './environment.js';
import { openLedger, startWatchdog, cleanupLedger, reconcileLedgers, type CleanupProof, type LedgerHandle } from './resources.js';
import { spawnOwned } from './processes.js';
import { stagePackedBuild, type PackedBuild } from './pack.js';
import { startCores, type Cores, type HcResult, type Side } from './hc.js';
import { preparePi, launchPi, createGateServer, type GateServer, type LaunchOptions, type PiDriver, type PiEnvironment } from './pi.js';
import type { ScriptFile } from '../fixtures/scripted-provider.js';

export type Tier = 'headless' | 'remote' | 'app' | 'ci';
export type SuiteOptions = (
  | { tier: 'headless' | 'ci'; story: StoryId; script?: ScriptFile; watchdogMs?: number }
  | { tier: 'remote'; story: StoryId; machine: string; script?: ScriptFile; watchdogMs?: number }
  | { tier: 'app'; story: StoryId; displayUuid: string; consent: true; script?: ScriptFile; watchdogMs?: number }
) & { coreEnvironment?: Readonly<Record<string, string>> };

export interface RenderedUi {
  frame: number;
  nodes: readonly { id: string; text: string; enabled: boolean; bounds: readonly [x: number, y: number, width: number, height: number] }[];
}
/** Implemented by Task 6 (harness/app.ts, harness/fake-app.ts). Native interaction methods are capability-gated. */
export interface AppDriver {
  command(name: string, args: Record<string, unknown>): Promise<unknown>;
  ls(): Promise<unknown>;
  status(): Promise<unknown>;
  check(installedDirectory: OwnedPath): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  shot(path: OwnedPath): Promise<OwnedPath>;
  uiSnapshot(): Promise<RenderedUi>;
  activate(controlId: string): Promise<void>;
  keyToOwnedWindow(key: string): Promise<void>;
}
export interface InvokeResult { exitCode: number; signal?: NodeJS.Signals; stdout: string; stderr: string }

export interface Suite {
  readonly options: SuiteOptions; readonly story: StoryId; readonly root: OwnedPath; readonly directories: FencedDirectories;
  /** The fenced environment every product process gets (PATH starts with the owned bin: pi launcher, hc wrapper). */
  readonly env: Readonly<Record<string, string>>;
  readonly ledger: LedgerHandle; readonly packed: PackedBuild; readonly pi: PiEnvironment;
  /** Retained story evidence, outside the removable fixture root: <scratch>/e2/_evidence/<story>/<ledger id>/. */
  readonly evidenceDirectory: string;
  /** Where close() writes the cleanup proof: <scratch>/e2/_ledgers/<ledger id>.cleanup.json. */
  readonly cleanupProofPath: string;
  /** Writes a named evidence file (string, bytes or JSON-serialisable value) and returns its path. */
  evidence(name: string, data: string | Uint8Array | object): Promise<string>;
  /** Copies an owned file (log, receipt, transcript) into the evidence directory and returns the copy's path. */
  keepEvidence(path: string, name?: string): Promise<string>;
  /** Null in the CI tier, which has no hc. */
  readonly cores: Cores | null;
  hc(argv: readonly string[], side?: Side): Promise<HcResult>;
  launchPi(options: LaunchOptions): Promise<PiDriver>;
  /** A fresh git repository under the fixture root. */
  project(name: string): Promise<OwnedPath>;
  gates(): Promise<GateServer>;
  ownPath(path: string): OwnedPath;
  /** Runs a binary as a ledger-registered owned process and resolves to its actual exit and streams. */
  invoke(binary: string, argv: readonly string[], env?: Readonly<Record<string, string>>, cwd?: string): Promise<InvokeResult>;
  /** Loads Task 6's adapter for this tier; fails with missing-adapter until it exists. */
  app(): Promise<AppDriver>;
  /** Cached initialization and the owned product CLI connection for setup inputs. */
  appReady?: Promise<AppDriver>;
  appConnection?: { binary: string; env: Record<string, string> };
  close(options?: { removeRoot?: boolean }): Promise<CleanupProof>;
}

async function importAdapter(name: string): Promise<Record<string, unknown>> {
  const specifier = `./${name}.js`;
  try { return await import(/* @vite-ignore */ specifier) as Record<string, unknown>; }
  catch (error) { throw new HarnessError('missing-adapter', `harness/${name}.ts is not available (${(error as Error).message.split('\n')[0]}); app-dependent stories are blocked`); }
}

export async function createSuite(options: SuiteOptions): Promise<Suite> {
  if (options.tier === 'app' && (options.consent !== true || process.env.SPIDER_HERDR_APP_TESTS !== '1' || !options.displayUuid))
    throw new HarnessError('app-consent-required', 'the app tier needs the user opt-in SPIDER_HERDR_APP_TESTS=1 and an explicit display UUID');
  if (options.tier === 'remote') return (await import('./remote.js')).createRemoteSuite(options);
  await reconcileLedgers(ledgerDirectory());
  const packed = stagePackedBuild();
  const root = await createFixtureRoot();
  const ledger = openLedger(ledgerDirectory(), root);
  const watchdog = startWatchdog(ledger, Date.now() + (options.watchdogMs ?? 20 * 60_000), join(ledgerDirectory(), `${ledger.id}.watchdog.log`));
  let gateServer: GateServer | undefined;
  try {
    const directories = await createFencedDirectories(root);
    const bin = ownedPath(root, join(root, 'bin'));
    // P1: the fixture's own process domain. Every pi started through the launcher registers itself here, so setup's
    // inventory sees fixture writers and none of the user's live pi sessions.
    const domainManifest = ownedPath(root, join(root, 'manifest.json'));
    await mkdir(join(root, 'procs'), { recursive: true, mode: 0o700 });
    await writeFile(domainManifest, JSON.stringify({ version: 1, root }), { mode: 0o600 });
    const env = buildEnvironment(process.env, directories, { binDirectory: bin, extra: { SPIDER_HERDR_E2E_PROCESS_DOMAIN: domainManifest } });
    const cores = options.tier === 'ci' ? null : await startCores(ledger, root, env, bin, options.coreEnvironment);
    const pi = await preparePi(root, env, packed, options.story, options.script);
    const invoke: Suite['invoke'] = async (binary, argv, invokeEnv = env, cwd = root) => {
      const proc = spawnOwned(ledger, { label: `invoke:${binary.split('/').at(-1)}`, command: binary, args: argv, env: { ...invokeEnv }, cwd: cwd === root ? root : ownedPath(root, cwd), stdio: 'pipe' });
      proc.child.stdin!.end();
      const out: Buffer[] = [], err: Buffer[] = [];
      proc.child.stdout!.on('data', d => out.push(d)); proc.child.stderr!.on('data', d => err.push(d));
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => proc.child.once('close', (code, signal) => resolve({ code, signal })));
      return { exitCode: exit.code ?? 128, ...(exit.signal ? { signal: exit.signal } : {}), stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
    };
    const evidenceDirectory = join(ledgerDirectory(), '..', '_evidence', options.story, ledger.id);
    await mkdir(evidenceDirectory, { recursive: true });
    const evidenceName = (name: string) => { if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) throw new HarnessError('invalid-evidence-name', name); return join(evidenceDirectory, name); };
    const suite: Suite = {
      options, story: options.story, root, directories, env, ledger, packed, pi, cores, invoke,
      evidenceDirectory, cleanupProofPath: ledger.path.replace(/\.json$/, '.cleanup.json'),
      async evidence(name, data) { const path = evidenceName(name); await writeFile(path, typeof data === 'string' || data instanceof Uint8Array ? data : JSON.stringify(data, null, 2)); return path; },
      async keepEvidence(path, name) { const target = evidenceName(name ?? basename(path)); await copyFile(ownedPath(root, path), target); return target; },
      ownPath: path => ownedPath(root, path),
      hc: (argv, side = 'local') => { if (!cores) throw new HarnessError('missing-prerequisite', 'the CI tier has no hc core'); return cores.hc(argv, side); },
      launchPi: launch => launchPi(pi, ledger, launch, cores ?? undefined),
      async project(name) {
        const path = ownedPath(root, join(root, 'p', name));
        await mkdir(path, { recursive: true });
        for (const args of [['init', '-q'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture']]) {
          const r = spawnSync('git', args, { cwd: path, env, encoding: 'utf8' });
          if (r.status !== 0) throw new HarnessError('project-failed', r.stderr);
        }
        return path;
      },
      async gates() { gateServer ??= await createGateServer(pi.gateSocket, options.story); return gateServer; },
      async app() {
        suite.appReady ??= (async () => {
          const nativeModule = await importAdapter('app');
          const binary = join(userInfo().homedir, '.local/bin/herdr-app');
          await suite.evidence('native-app-binary.json', { path: binary });
          const native = (nativeModule.createNativeAppDriver as (o: unknown) => AppDriver)({ binary, env: { ...env }, invoke, ownPath: suite.ownPath });
          if (options.tier === 'app') return native;
          if (!cores) throw new HarnessError('missing-prerequisite', 'the fake app boundary needs the isolated hc core');
          const module = await importAdapter('fake-app');
          const stage = module.stageFakeAppDaemon as (directory: string, own: (path: string) => string) => Promise<{ module: string; binary: string; socket: string }>;
          const driver = module.createFakeAppDriver as ((o: unknown) => AppDriver) | undefined;
          if (!stage || !driver) throw new HarnessError('missing-adapter', 'fake app staging and driver factories are required');
          const staged = await stage(root, suite.ownPath);
          const appEnv = { ...cores.local.env, HC_SOCKET: cores.local.socket, SPIDER_HERDR_E2E_APP_ROOT: root, SPIDER_HERDR_E2E_APP_SOCKET: staged.socket };
          const config = suite.ownPath(join(root, 'app-daemon.json'));
          await writeFile(config, JSON.stringify({ hcBinary: cores.wrapper, coreId: cores.local.coreId, env: appEnv }), { mode: 0o600 });
          const process = spawnOwned(ledger, { label: 'fake-app-daemon', startsCores: true, command: globalThis.process.execPath, args: [staged.module, 'serve', config], env: appEnv, cwd: root, stdio: 'pipe', stderrLog: join(root, 'logs', 'app-daemon.err') });
          // Its stdin is intentionally retained. The ledger owns its process group.
          const { jsonLines } = await import('./processes.js');
          await new Promise<void>((resolve, reject) => {
            let ready = false;
            const timer = setTimeout(() => reject(new HarnessError('app-daemon-deadline', 'no owned app daemon ready acknowledgement')), 15000);
            process.child.stdout!.on('data', jsonLines(value => {
              const record = value as { ready?: unknown; socket?: unknown; coreId?: unknown; error?: unknown };
              if (record.error) { clearTimeout(timer); reject(new HarnessError('app-daemon-failed', String(record.error))); return; }
              if (record.ready === true) {
                if (record.socket !== staged.socket || record.coreId !== cores.local.coreId) { clearTimeout(timer); reject(new HarnessError('app-daemon-wrong-id', 'app daemon does not own the expected core and socket')); return; }
                ready = true; clearTimeout(timer); void suite.evidence('app-daemon-ready.json', record); resolve();
              }
            }, (_line, error) => { clearTimeout(timer); reject(new HarnessError('app-daemon-malformed', String(error))); }));
            void process.exited.then(exit => { if (!ready) { clearTimeout(timer); reject(new HarnessError('app-daemon-exited', JSON.stringify(exit))); } });
          });
          const daemon = await import(/* @vite-ignore */ staged.module) as { appRequest(socket: string, name: string, args: Record<string, unknown>): Promise<unknown> };
          // Every AppDriver and product CLI call uses this one daemon document.
          const boundary = { command: (name: string, args: Record<string, unknown>) => {
            const origin = new Error(`fixture app request ${name}`).stack;
            return daemon.appRequest(staged.socket, name, args).catch((error: unknown) => {
              if (error && typeof error === 'object' && 'stack' in error && typeof error.stack === 'string' && origin) error.stack = `${error.stack}\nFixture dispatch origin:\n${origin}`;
              throw error;
            });
          }, drain: async () => { await daemon.appRequest(staged.socket, 'ls', {}); } };
          suite.appConnection = { binary: staged.binary, env: appEnv };
          return driver({ boundary, check: (directory: OwnedPath) => native.check(directory) });
        })();
        return suite.appReady;
      },
      async close({ removeRoot = false } = {}) {
        await gateServer?.close();
        const proof = await cleanupLedger(ledger.path, 'suite-close', { removeRoot });
        watchdog.release();
        if (!proof.clean) throw new HarnessError('cleanup-unproved', `owned resources survived: ${JSON.stringify(proof.survivors)}`, proof);
        return proof;
      },
    };
    return suite;
  } catch (error) {
    await gateServer?.close();
    await cleanupLedger(ledger.path, 'suite-create-failed');
    watchdog.release();
    throw error;
  }
}
