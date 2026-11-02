// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { appendFileSync } from 'node:fs';
import { mkdir, writeFile, readFile, chmod, stat, readdir, rename, lstat } from 'node:fs/promises';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { HarnessError, ownedPath, assertSocketPath, defaultCoreSocket, type OwnedPath } from './environment.js';
import { createSuite, type Suite, type SuiteOptions } from './suite.js';
import { identityOf, identityAlive, readLedger, type CleanupProof, type ProcessIdentity } from './resources.js';
import { spawnOwned, jsonLines, type OwnedProcess } from './processes.js';
import { realHcBinary, runHc, DEST_MACHINE, type Cores, type CoreDescriptor, type HcResult, type HcRecord } from './hc.js';
import { launchPi } from './pi.js';
import { waitFor, deadline } from './wait.js';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
const perl = ['-e', 'alarm shift; exec @ARGV'];
const LEASE_MS = 12_000;
interface DefaultOwnership { roots: string[]; namespaces: string[]; coreIds: string[]; runIds: string[]; jobIds: string[]; sessionIds: string[]; terminalIds: string[]; identitiesComplete: boolean }
interface DefaultAssessment { clean: boolean; violations: unknown[]; foreignActivity: unknown[] }
export interface RemoteMetadata {
  root: string; namespace: string; socket: string; env: Record<string, string>;
  node: string; nodePath: string; hc: string; coreBinary: string; ledger: string; lease: string;
  defaultCore: { hcBinary: string; socket: string; env: Record<string, string>; wasListening: boolean };
  defaultBefore: unknown; ownership?: DefaultOwnership; coreId?: string; pid?: number; start?: string; guardianPid?: number; guardianStart?: string;
}
export interface RemoteProof {
  clean: boolean; rootRemoved: boolean; reason: string; survivors: unknown[];
  defaultBefore?: unknown; defaultAfter?: unknown; [key: string]: unknown;
}
export interface RemoteSnapshot {
  rootExists: boolean; socketListening: boolean; coreAlive: boolean; guardianAlive: boolean;
  rootProcesses: unknown[]; defaultAfter: unknown; defaultAssessment: DefaultAssessment;
}
export interface RemoteDestination {
  readonly metadata: RemoteMetadata;
  /** Runs one shell line only in the proved owned namespace, with a Perl deadline. */
  exec(code: string, seconds?: number): Promise<HcResult>;
  snapshot(): Promise<RemoteSnapshot>;
  /** Fault injection: stop renewing and sever the guardian's observer connection, not the guardian. */
  abandon(options?: { disconnectObserver?: boolean }): Promise<{ expiresAt: number }>;
}
export interface RemoteSuite extends Suite { readonly remote: RemoteDestination }
interface RemoteRecord { version: 1; machine: string; localLedger: string; owner: ProcessIdentity; state: 'open' | 'closed'; metadata: RemoteMetadata }

export function remoteMachine(env: Readonly<NodeJS.ProcessEnv> = process.env): string {
  const explicit = env.SPIDER_HERDR_E2E_REMOTE?.trim(), legacy = env.SPIDER_HERDR_REAL_MACHINE?.trim();
  const machine = explicit || legacy;
  if (!machine) throw new HarnessError('missing-prerequisite', 'Tier 2 needs SPIDER_HERDR_REAL_MACHINE or SPIDER_HERDR_E2E_REMOTE set at run time');
  if (explicit && legacy && explicit !== legacy) throw new HarnessError('invalid-remote-destination', 'the two Tier 2 environment destinations disagree');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(machine)) throw new HarnessError('invalid-remote-destination', 'Tier 2 requires one SSH alias, not SSH options or shell syntax');
  return machine;
}
function parsed(result: HcResult, what: string): Record<string, unknown> {
  if (result.exitCode !== 0 || !result.json || typeof result.json !== 'object' || Array.isArray(result.json)) {
    const prerequisite = /missing-prerequisite: ([^\r\n]+)/.exec(result.stderr);
    if (prerequisite) throw new HarnessError('missing-prerequisite', prerequisite[1], result);
    throw new HarnessError('remote-operation-failed', `${what}: ${result.exitCode} ${result.stderr.slice(0, 600)}`, result);
  }
  return result.json as Record<string, unknown>;
}
function bindings(env: Record<string, string>): string { return Object.entries(env).map(([k, v]) => `${k}=${quote(v)}`).join(' '); }
function scoped(env: Record<string, string>, code: string, seconds: number): string {
  return `exec env -i ${bindings(env)} /usr/bin/perl -e 'alarm shift; exec @ARGV' ${seconds} /bin/sh -c ${quote(code)}`;
}
async function ready(proc: OwnedProcess, marker: string, log: string): Promise<number> {
  let output = '', ended = false;
  proc.child.stdout!.on('data', d => { output += d; appendFileSync(log, d); });
  void proc.exited.then(() => { ended = true; });
  const pattern = new RegExp(`^${marker} (\\d+)$`, 'm');
  const text = await waitFor(`${marker} acknowledgement`, () => ({ output, ended }), o => pattern.test(o.output) || o.ended, deadline(30_000));
  const m = pattern.exec(text.output);
  if (!m) throw new HarnessError('remote-ready-unavailable', `${marker} exited without readiness`, text);
  return Number(m[1]);
}

export async function ownedJournalIds(globalRoot: string): Promise<{ sessionIds: string[]; runIds: string[]; jobIds: string[]; terminalIds: string[]; identitiesComplete: boolean }> {
  const sessionIds = new Set<string>(), runIds = new Set<string>(), jobIds = new Set<string>(), terminalIds = new Set<string>();
  let identitiesComplete = true;
  const directories = async (path: string) => {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      if (entries.some(entry => entry.isSymbolicLink() || entry.isDirectory() && !/^[a-zA-Z0-9_-]{1,160}$/.test(entry.name))) identitiesComplete = false;
      return entries.filter(entry => entry.isDirectory() && /^[a-zA-Z0-9_-]{1,160}$/.test(entry.name));
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  const journal = async (path: string, sessionId: string) => {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('unsafe fixture job journal');
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (value.version !== 1 || value.sessionId !== sessionId || !Array.isArray(value.jobs)) throw new Error('invalid fixture job journal');
      for (const job of value.jobs) {
        if (typeof job.id !== 'string' || job.owner?.sessionId !== sessionId) throw new Error('foreign fixture job');
        jobIds.add(job.id); if (typeof job.runId === 'string') runIds.add(job.runId);
        if (typeof job.phase?.address === 'string') terminalIds.add(job.phase.address.split('/').at(-1)!);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  const root = join(globalRoot, 'herdr/jobs/sessions');
  for (const session of await directories(root)) {
    sessionIds.add(session.name); const directory = join(root, session.name);
    await journal(join(directory, 'jobs.json'), session.name);
    for (const run of await directories(join(directory, 'runs'))) {
      runIds.add(run.name); await journal(join(directory, 'runs', run.name, 'jobs.json'), session.name);
    }
  }
  const feeds = join(globalRoot, 'herdr/sessions');
  for (const session of await directories(feeds)) {
    const path = join(feeds, session.name, 'session.json');
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('unsafe fixture session feed');
      const feed = JSON.parse(await readFile(path, 'utf8'));
      if (feed.sessionId !== session.name || !Array.isArray(feed.runs?.rows)) throw new Error('invalid fixture session feed');
      sessionIds.add(session.name);
      for (const run of feed.runs.rows) { if (typeof run.id !== 'string') throw new Error('invalid fixture run'); runIds.add(run.id); }
      if (feed.runs.truncated) identitiesComplete = false;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!sessionIds.size) identitiesComplete = false;
  return { sessionIds: [...sessionIds], runIds: [...runIds], jobIds: [...jobIds], terminalIds: [...terminalIds], identitiesComplete };
}

/** The remote folder is exclusively created before any daemon starts. No default namespace command mutates. */
function preparation(stamp: string, guardianSource: string, initialLeaseMs: number, commandSeconds: number, localRoot: string): string {
  const encoded = Buffer.from(guardianSource).toString('base64');
  return `
import { mkdirSync, writeFileSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
const root=homedir()+'/spider-herdr-e2e-'+${JSON.stringify(stamp)};
if(process.platform!=='linux')throw new Error('missing-prerequisite: Tier 2 requires Linux');
const version=process.versions.node.split('.').map(Number);
if(version[0]<22 || version[0]===22 && version[1]<18)throw new Error('missing-prerequisite: remote Node >=22.18.0 required');
const run=(bin,args)=>execFileSync('/usr/bin/perl',['-e','alarm shift; exec @ARGV','15',bin,...args],{encoding:'utf8'}).trim();
const hc=run('/bin/sh',['-c','command -v hc']);
const coreBinary=run('/bin/sh',['-c','command -v herdr-core']);
if(run(hc,['--version'])!=='hc 0.1.16')throw new Error('missing-prerequisite: remote hc 0.1.16 required');
const original={PATH:process.env.PATH,HOME:homedir(),TMPDIR:root+'/t',HC_SESSION:'default'};
for(const key of ['XDG_STATE_HOME','XDG_CONFIG_HOME','XDG_RUNTIME_DIR'])if(process.env[key])original[key]=process.env[key];
const defaultSocket=process.env.XDG_RUNTIME_DIR?process.env.XDG_RUNTIME_DIR+'/herdr-core/default.sock':(process.env.XDG_STATE_HOME||homedir()+'/.local/state')+'/herdr-core/default/default.sock';
const namespace='e'+${JSON.stringify(stamp.slice(-6))};
const env={PATH:root+'/bin:'+process.env.PATH,HOME:root+'/h',TMPDIR:root+'/t',HC_SESSION:namespace,XDG_STATE_HOME:root+'/x',XDG_CONFIG_HOME:root+'/c',XDG_RUNTIME_DIR:root+'/r'};
const socket=env.XDG_RUNTIME_DIR+'/herdr-core/'+namespace+'.sock';
for(const p of [socket,socket.replace(/\\.sock$/,'.holder.4294967295.sock')])if(Buffer.byteLength(p)>103)throw new Error('socket-path-too-long: relocate the owned remote folder');
const helpers=await import('data:text/javascript;base64,'+${JSON.stringify(encoded)});
const defaultCore={hcBinary:hc,socket:defaultSocket,env:original,wasListening:await helpers.listening(defaultSocket)};
const ownership={roots:[root,${JSON.stringify(localRoot)}],namespaces:[namespace],coreIds:[],runIds:[],jobIds:[],sessionIds:[],terminalIds:[],identitiesComplete:false};
const defaultBefore=await helpers.defaultInventory(defaultCore,ownership);
let created=false;
try {
  mkdirSync(root,{mode:448});created=true;
  if(realpathSync(root)!==root||lstatSync(root).uid!==process.getuid())throw new Error('remote-root-unowned');
  for(const d of ['h','t','x','c','r','runtime','bin'])mkdirSync(root+'/'+d,{mode:448});
  mkdirSync(env.XDG_CONFIG_HOME+'/herdr-core',{mode:448});
  writeFileSync(env.XDG_CONFIG_HOME+'/herdr-core/config.toml','notes = false\\n',{mode:384});
  writeFileSync(root+'/guardian.mjs',Buffer.from(${JSON.stringify(encoded)},'base64'),{mode:384});
  for(const [name,binary] of [['node',process.execPath],['hc',hc],['herdr-core',coreBinary]]) {
    writeFileSync(root+'/bin/'+name,'#!/bin/sh\\nexec /usr/bin/perl -e '+helpers.quote('alarm shift; exec @ARGV')+' ${commandSeconds} '+helpers.quote(binary)+' "$@"\\n',{mode:448});
  }
  const metadata={root,namespace,socket,env,node:process.execPath,nodePath:root+'/bin/node',hc,coreBinary,defaultCore,defaultBefore,ownership,ledger:root+'/ledger.json',lease:root+'/lease.json'};
  writeFileSync(metadata.ledger,JSON.stringify({version:1,id:${JSON.stringify(stamp)},root,state:'open',processes:[],cores:[{side:'dest',namespace,socket,hcBinary:hc,env}],defaultCore,defaultBefore,ownership}),{mode:384});
  writeFileSync(metadata.lease,JSON.stringify({version:1,expiresAt:Date.now()+${initialLeaseMs}}),{mode:384});
  console.log(JSON.stringify(metadata));
} catch(error) {if(created)rmSync(root,{recursive:true});throw error;}`;
}

export async function createRemoteSuite(options: Extract<SuiteOptions, { tier: 'remote' }>): Promise<RemoteSuite> {
  // SuiteOptions.machine cannot authorize transport; only these runtime environment variables can.
  const machine = remoteMachine();
  const base = await createSuite({ ...options, tier: 'ci' });
  const seconds = Math.ceil((options.watchdogMs ?? 20 * 60_000) / 1000) + 90;
  const endsAt = Date.now() + seconds * 1000 - 90_000;
  const stamp = randomBytes(4).toString('hex');
  const sshBinary = '/usr/bin/ssh';
  // Only SSH reads the user's existing SSH configuration. Never copy it or pass this HOME to pi, hc or payloads.
  const transportEnv: Record<string, string> = { ...base.env, HOME: userInfo().homedir };
  if (process.env.SSH_AUTH_SOCK) transportEnv.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  const guardianSource = await readFile(fixture('remote-guardian.mjs'), 'utf8');
  const sourceForEval = guardianSource.replace(/^#![^\n]*\n/, '');
  const defaultSocket = defaultCoreSocket();
  const defaultStat = async () => {
    try { const s = await stat(defaultSocket, { bigint: true }); return { socket: defaultSocket, inode: String(s.ino), mtimeNs: String(s.mtimeNs) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const defaultBefore = await defaultStat();
  await base.evidence('local-default-before.json', { value: defaultBefore });
  let metadata: RemoteMetadata | undefined, guardian: OwnedProcess | undefined, supervisor: OwnedProcess | undefined;
  let closed: Promise<CleanupProof> | undefined, abandoned = false, observerDisconnected = false, remoteProof: RemoteProof | undefined;
  let localCores: Cores | undefined;
  const observedTerminalIds = new Set<string>();
  let reconciling = true;
  const logs = join(base.evidenceDirectory, 'guardian.jsonl');
  const remoteRecord = base.ledger.path.replace(/\.json$/, '.remote.json');
  const saveRemote = async (state: RemoteRecord['state']) => {
    if (!metadata) return;
    const value: RemoteRecord = { version: 1, machine, localLedger: base.ledger.path, owner: base.ledger.read().owner, state, metadata };
    const temporary = `${remoteRecord}.${process.pid}.new`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temporary, remoteRecord);
  };
  const ssh = async (line: string, commandSeconds = 30, input = ''): Promise<HcResult> => {
    const proc = spawnOwned(base.ledger, { label: 'tier2-ssh', command: '/usr/bin/perl', args: [...perl, String(commandSeconds + 5), sshBinary, '-S', 'none', '-o', 'ControlMaster=no', '-o', 'ControlPersist=no', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=10', '-T', '--', machine, line], env: transportEnv, cwd: base.root, stdio: 'pipe' });
    const out: Buffer[] = [], err: Buffer[] = [];
    proc.child.stdout!.on('data', d => out.push(d)); proc.child.stderr!.on('data', d => err.push(d)); proc.child.stdin!.end(input);
    const exit = await proc.exited;
    const stdout = Buffer.concat(out).toString(), stderr = Buffer.concat(err).toString();
    let json: unknown = null; try { json = JSON.parse(stdout); } catch { /* non-JSON shell result */ }
    const result = { exitCode: exit.code, signal: exit.signal, stdout, stderr, json };
    await base.evidence(`ssh-${proc.identity.pid}.json`, { line, ...result });
    return result;
  };
  const node = (code: string, s = 30) => ssh(`exec env -i PATH="$PATH" HOME="$HOME" TMPDIR=${metadata ? quote(metadata.env.TMPDIR) : '"$HOME/spider-herdr-e2e-'+stamp+'/t"'} /usr/bin/perl -e 'alarm shift; exec @ARGV' ${s} ${metadata ? quote(metadata.node) : 'node'} --input-type=module -e ${quote(code)}`, s);
  const syncOwnership = async (includeJobs: boolean) => {
    const m = metadata!;
    if (!m.ownership) throw new HarnessError('cleanup-unproved', 'remote ownership scope is missing');
    if (includeJobs) {
      if (!localCores) throw new HarnessError('cleanup-unproved', 'fixture core inventory is unavailable');
      const addresses: string[] = [];
      for (const side of ['local', 'dest'] as const) {
        const inventory = parsed(await localCores.hc(['ls', '--all', '--json'], side), 'fixture terminal inventory').terminals;
        if (!Array.isArray(inventory) || inventory.some(row => !row || typeof row.address !== 'string')) throw new HarnessError('cleanup-unproved', 'fixture terminal inventory is invalid');
        addresses.push(...inventory.map(row => row.address as string).filter(address => !address.includes('/')));
      }
      const journalIds = await ownedJournalIds(base.directories.SPIDER_GLOBAL_ROOT);
      for (const call of await localCores.records()) for (const arg of call.argv) if (/(?:^|\/)t[0-9a-z]+$/i.test(arg)) addresses.push(arg.split('/').at(-1)!);
      Object.assign(m.ownership, journalIds, { terminalIds: [...new Set([...addresses, ...journalIds.terminalIds, ...observedTerminalIds])] });
    }
    parsed(await node(`const fs=await import('node:fs');const p=${JSON.stringify(m.ledger)},v=JSON.parse(fs.readFileSync(p,'utf8'));v.ownership=${JSON.stringify(m.ownership)};const t=p+'.ownership';fs.writeFileSync(t,JSON.stringify(v),{mode:384});fs.renameSync(t,p);console.log('{}');`), 'record fixture ownership');
    await saveRemote('open');
  };
  const snapshot = async (): Promise<RemoteSnapshot> => {
    const m = metadata!;
    return parsed(await node(`${sourceForEval}\nconst m=${JSON.stringify(m)}; const scope=m.ownership??{roots:[m.root],namespaces:[m.namespace],coreIds:[m.coreId].filter(Boolean),runIds:[],jobIds:[],sessionIds:[],terminalIds:[],identitiesComplete:false}; const defaultAfter=await defaultInventory(m.defaultCore,scope); console.log(JSON.stringify({rootExists:existsSync(m.root),socketListening:await listening(m.socket),coreAlive:m.pid?processStart(m.pid)===m.start:false,guardianAlive:m.guardianPid?processStart(m.guardianPid)===m.guardianStart:false,rootProcesses:rootProcesses(m.root),defaultAfter,defaultAssessment:assessDefaultInventory(m.defaultBefore,defaultAfter,scope)}));`), 'remote cleanup observation') as unknown as RemoteSnapshot;
  };
  const cleanupRemote = async (): Promise<RemoteSnapshot | null> => {
    if (!metadata) return null;
    let ownershipFailure: unknown;
    if (!abandoned) try { await syncOwnership(true); } catch (error) { ownershipFailure = error; }
    if (supervisor) { supervisor.child.stdin?.end(); await supervisor.exited; }
    if (!abandoned) {
      // Stop renewal first, then expire the existing lease atomically. This is the same guardian cleanup path.
      parsed(await node(`const fs=await import('node:fs');const p=${JSON.stringify(metadata.lease)};if(fs.existsSync(p)){const t=p+'.finish';fs.writeFileSync(t,JSON.stringify({version:1,expiresAt:0}),{mode:384});fs.renameSync(t,p);}console.log('{}');`), 'expire remote lease');
    }
    const after = await waitFor('remote folder, sockets and owned identities are gone', snapshot,
      s => !s.rootExists && !s.socketListening && !s.coreAlive && !s.guardianAlive && s.rootProcesses.length === 0,
      deadline(LEASE_MS + 40_000), { reconcileMs: 500 });
    if (ownershipFailure) throw new HarnessError('cleanup-unproved', 'fixture ownership could not be recorded', ownershipFailure);
    if (!after.defaultAssessment.clean) throw new HarnessError('cleanup-unproved', 'remote default inventory contains harness-owned or unproved changes', after);
    if (!observerDisconnected && (!remoteProof?.clean || !remoteProof.rootRemoved)) throw new HarnessError('cleanup-unproved', 'guardian did not publish its successful root-removal proof', remoteProof);
    await base.evidence('remote-final.json', { metadata, after, guardian: remoteProof ?? null, observerDisconnected });
    await saveRemote('closed');
    return after;
  };
  const close = ({ removeRoot = false } = {}): Promise<CleanupProof> => closed ??= (async () => {
    let remoteFailure: unknown, remoteAfter: RemoteSnapshot | null = null;
    try { remoteAfter = await cleanupRemote(); } catch (error) { remoteFailure = error; }
    // Keep the SSH descriptor and logs on a failure for next-invocation recovery.
    const proof = await base.close({ removeRoot: removeRoot && !remoteFailure });
    const defaultAfter = await defaultStat();
    const combined = { ...proof, localDefault: { before: defaultBefore, after: defaultAfter }, remote: { metadata, after: remoteAfter, proof: remoteProof, error: remoteFailure ? String(remoteFailure) : null } };
    if (JSON.stringify(defaultBefore) !== JSON.stringify(defaultAfter)) { combined.clean = false; combined.survivors.push({ kind: 'default-local-socket-changed', id: defaultSocket }); }
    if (remoteFailure) { combined.clean = false; combined.survivors.push({ kind: 'remote-cleanup-unverified', id: metadata?.root ?? 'unknown' }); }
    await writeFile(base.cleanupProofPath, JSON.stringify(combined, null, 2));
    if (!combined.clean) throw new HarnessError('cleanup-unproved', 'Tier 2 cleanup was not proved on both sides', combined);
    return combined;
  })();
  try {
    // The local watchdog cannot fetch proof after its own death. Reconnect and prove prior remote ledgers here.
    for (const name of await readdir(dirname(base.ledger.path))) {
      if (!/^[a-z0-9]+\.remote\.json$/.test(name)) continue;
      const path = join(dirname(base.ledger.path), name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) throw new HarnessError('invalid-remote-ledger', 'persistent remote records must be private owned files');
      const record = JSON.parse(await readFile(path, 'utf8')) as RemoteRecord;
      if (record.localLedger !== path.replace(/\.remote\.json$/, '.json')) throw new HarnessError('invalid-remote-ledger', 'remote record names a foreign local ledger');
      if (record.version !== 1 || !record.metadata || !/\/spider-herdr-e2e-[a-f0-9]{8}$/.test(record.metadata.root)) throw new HarnessError('invalid-remote-ledger', 'invalid persistent remote ownership record');
      if (record.state === 'closed') continue;
      const local = readLedger(record.localLedger);
      if (identityAlive(record.owner) && local.state === 'open') continue;
      if (local.state === 'cleanup-failed') throw new HarnessError('cleanup-unproved', 'a prior fixture still has uncollected local resources', local);
      if (record.machine !== machine) throw new HarnessError('missing-prerequisite', 'an unfinished remote ledger needs its original runtime environment destination');
      metadata = record.metadata;
      let observed = await snapshot();
      const knownGuardian = observed.guardianAlive || observed.rootProcesses.some(p => typeof (p as { command?: unknown }).command === 'string' && (p as { command: string }).command.includes('/guardian.mjs'));
      if (observed.rootExists && !knownGuardian) {
        const recovery = await node(`${sourceForEval}\nawait guardian(${JSON.stringify(metadata.ledger)},${JSON.stringify(metadata.lease)},true);`, 90);
        await base.evidence(`recovery-${name}.log`, recovery.stdout + recovery.stderr);
        if (recovery.exitCode !== 0) throw new HarnessError('cleanup-unproved', 'the previous remote guardian could not be reconciled', recovery);
      }
      observed = await waitFor('unfinished remote fixture reconciled', snapshot,
        s => !s.rootExists && !s.socketListening && !s.coreAlive && !s.guardianAlive && s.rootProcesses.length === 0,
        deadline(55_000), { reconcileMs: 500 });
      if (!observed.defaultAssessment.clean) throw new HarnessError('cleanup-unproved', 'previous remote default inventory contains harness-owned or unproved changes', observed);
      record.state = 'closed';
      await writeFile(path, JSON.stringify(record, null, 2), { mode: 0o600 });
      await base.evidence(`reconciled-${name}`, { metadata, observed });
      metadata = undefined;
    }
    reconciling = false;
    metadata = parsed(await node(preparation(stamp, guardianSource, LEASE_MS * 3, seconds, base.root)), 'remote preparation') as unknown as RemoteMetadata;
    if (!metadata.root.endsWith(`/spider-herdr-e2e-${stamp}`) || metadata.namespace !== `e${stamp.slice(-6)}` || metadata.socket === metadata.defaultCore.socket) throw new HarnessError('isolation-unproved', 'remote preparation returned an unexpected root, namespace or socket');
    base.ledger.update(l => { l.remoteRoot = metadata!.root; });
    await saveRemote('open');
    await base.evidence('remote-prepared.json', metadata);
    const remoteCommand = `exec env -i ${bindings(metadata.env)} setsid /usr/bin/perl -e 'alarm shift; exec @ARGV' ${seconds} ${quote(metadata.node)} ${quote(metadata.root + '/guardian.mjs')} ${quote(metadata.ledger)} ${quote(metadata.lease)} --remove-root`;
    guardian = spawnOwned(base.ledger, { label: 'remote-guardian-observer', command: '/usr/bin/perl', args: [...perl, String(seconds), sshBinary, '-S', 'none', '-o', 'ControlMaster=no', '-o', 'ControlPersist=no', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=10', '-T', '--', machine, remoteCommand], env: transportEnv, cwd: base.root, stdio: 'pipe', stderrLog: join(base.evidenceDirectory, 'guardian.err') });
    guardian.child.stdin!.end();
    metadata.guardianPid = await ready(guardian, 'guardian-ready', logs);
    let buffer = '';
    guardian.child.stdout!.on('data', d => { buffer += d; for (;;) { const i = buffer.indexOf('\n'); if (i < 0) break; const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.startsWith('{')) remoteProof = JSON.parse(line) as RemoteProof; } });
    metadata.guardianStart = String(parsed(await node(`${sourceForEval}\nconsole.log(JSON.stringify({start:processStart(${metadata.guardianPid})}));`), 'guardian identity').start);
    await saveRemote('open');
    const supervisorConfig = ownedPath(base.root, join(base.root, 'supervisor.json'));
    await writeFile(supervisorConfig, JSON.stringify({ sshBinary, machine, env: transportEnv, remoteNode: metadata.node, remoteTmp: metadata.env.TMPDIR, remoteEnv: metadata.env, leasePath: metadata.lease, localLedger: base.ledger.path, deadlineAt: endsAt, leaseMs: LEASE_MS, renewMs: 2500 }), { mode: 0o600 });
    supervisor = spawnOwned(base.ledger, { label: 'remote-lease-supervisor', command: process.execPath, args: [fixture('remote-guardian.mjs'), '--supervise', supervisorConfig], env: { ...base.env }, cwd: base.root, stdio: 'pipe', stderrLog: join(base.evidenceDirectory, 'supervisor.err') });
    await ready(supervisor, 'supervisor-ready', join(base.evidenceDirectory, 'supervisor.log'));
    // The remote ledger already owns the expected socket before this first core bootstrap.
    const m = metadata;
    const remoteStart = parsed(await node(`
const fs=await import('node:fs'); const cp=await import('node:child_process');
const m=${JSON.stringify(m)};const run=a=>JSON.parse(cp.execFileSync('perl',['-e','alarm shift; exec @ARGV','15',m.hc,...a],{env:m.env,cwd:m.root,encoding:'utf8'}));
run(['server','start','--json']);const status=run(['server','status','--json']);
if(status.version!=='0.1.16'||!status.core?.id||!status.pid||!fs.statSync(m.socket).isSocket())throw new Error('remote-core-isolation-unproved');
const helpers=await import(m.root+'/guardian.mjs');const start=helpers.processStart(status.pid);
const l=JSON.parse(fs.readFileSync(m.ledger));Object.assign(l.cores[0],{coreId:status.core.id,pid:status.pid,start});
const t=m.ledger+'.core';fs.writeFileSync(t,JSON.stringify(l),{mode:384});fs.renameSync(t,m.ledger);
console.log(JSON.stringify({coreId:status.core.id,pid:status.pid,start}));`), 'remote core bootstrap');
    Object.assign(metadata, remoteStart);
    await saveRemote('open');
    const local = await startLocalCore(base);
    metadata.ownership!.coreIds = [String(m.coreId), local.local.coreId];
    await syncOwnership(false);
    Object.assign(base.pi.env, local.local.env);
    const transportConfig = ownedPath(base.root, join(base.root, 'ssh-transport.json'));
    await writeFile(transportConfig, JSON.stringify({ sshBinary, machine, log: join(base.evidenceDirectory, 'ssh-transport.jsonl'), prefix: `test -S ${quote(m.socket)} || exit 123;`, remoteEnv: m.env, seconds, env: transportEnv }), { mode: 0o600 });
    await mkdir(join(base.root, 'transport'), { mode: 0o700 });
    const sshWrapper = ownedPath(base.root, join(base.root, 'transport', 'ssh'));
    await writeFile(sshWrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture('remote-guardian.mjs'))} --transport ${quote(transportConfig)} "$@"\n`, { mode: 0o700 });
    const dest: CoreDescriptor = { side: 'dest', namespace: m.namespace, socket: m.socket as OwnedPath, env: m.env, coreId: String(m.coreId), pid: Number(m.pid) };
    const hc: Cores['hc'] = (argv, side = 'local', o) => {
      for (const arg of argv) if (/(?:^|\/)t[0-9a-z]+$/i.test(arg)) observedTerminalIds.add(arg.split('/').at(-1)!);
      if (side === 'local') return runHc(local.wrapper, argv, local.local.env, o);
      const cwd = posix.resolve(o?.cwd ?? m.root);
      if (cwd !== m.root && !cwd.startsWith(m.root + '/')) throw new HarnessError('outside-owned-root', 'destination cwd is not inside the remote fixture');
      return ssh(scoped(m.env, `test -S ${quote(m.socket)} || exit 123; cd ${quote(cwd)} || exit 124; test "$(pwd -P)" = ${quote(cwd)} || exit 125; exec ${quote(m.hc)} ${argv.map(quote).join(' ')}`, 30), 30, o?.input);
    };
    base.ledger.update(l => { l.machines.push({ side: 'local', name: DEST_MACHINE }); });
    parsed(await hc(['machine', 'add', machine, '--name', DEST_MACHINE, '--session', m.namespace, '--json']), 'real SSH machine registration');
    const inventory = parsed(await hc(['machine', 'ls', '--json']), 'real SSH machine inventory').machines;
    const registered = Array.isArray(inventory) ? inventory.find(x => x.name === DEST_MACHINE) : null;
    if (!registered || registered.id !== dest.coreId || dest.coreId === local.local.coreId) throw new HarnessError('isolation-unproved', 'registered SSH destination did not reach the owned remote core', inventory);
    localCores = { ...local, dest, machine: DEST_MACHINE, hc };
    await base.evidence('tier2-isolation.json', { localSocket: local.local.socket, defaultLocalSocket: defaultCoreSocket(), localId: local.local.coreId, remote: metadata, registered });
    const remote: RemoteDestination = {
      metadata,
      exec: (code, s = 30) => ssh(scoped(m.env, `cd ${quote(m.root)} || exit 124; ${code}`, s), s),
      snapshot,
      async abandon({ disconnectObserver = true } = {}) {
        if (abandoned) throw new HarnessError('remote-already-abandoned', 'renewals are already stopped');
        supervisor!.child.stdin!.end(); await supervisor!.exited;
        const lease = parsed(await node(`const fs=await import('node:fs');console.log(fs.readFileSync(${JSON.stringify(m.lease)},'utf8'));`), 'last renewed lease');
        if (typeof lease.expiresAt !== 'number') throw new HarnessError('invalid-remote-lease', 'missing expiry deadline');
        abandoned = true; observerDisconnected = disconnectObserver;
        if (disconnectObserver) await guardian!.stop();
        await base.evidence('renewal-abandoned.json', { at: Date.now(), expiresAt: lease.expiresAt, observerDisconnected, observer: guardian!.identity, metadata });
        return { expiresAt: lease.expiresAt };
      },
    };
    const suite: RemoteSuite = { ...base, options, cores: localCores, remote, hc: (argv, side) => hc(argv, side), launchPi: o => launchPi(base.pi, base.ledger, o, localCores), close,
      app() { suite.appReady ??= remoteApp(suite); return suite.appReady; },
    };
    return suite;
  } catch (error) {
    if (reconciling) { metadata = undefined; await base.close(); throw error; }
    try { await close(); } catch (cleanupError) { throw new HarnessError('cleanup-unproved', `${String(error)}; ${String(cleanupError)}`, { error, cleanupError }); }
    throw error;
  }
}

/** Only the local namespace is put in the local watchdog ledger. The destination has its own guardian ledger. */
async function startLocalCore(base: Suite): Promise<Omit<Cores, 'dest' | 'machine' | 'hc'>> {
  const binary = realHcBinary();
  try { await stat(binary); } catch { throw new HarnessError('missing-prerequisite', 'Tier 2 requires local hc 0.1.16'); }
  const bin = ownedPath(base.root, join(base.root, 'bin'));
  const recordLog = ownedPath(base.root, join(base.root, 'hc-calls.jsonl')), viaLog = ownedPath(base.root, join(base.root, 'ssh-calls.jsonl'));
  await writeFile(recordLog, ''); await writeFile(viaLog, '');
  const wrapper = ownedPath(base.root, join(bin, 'hc'));
  for (const [name, real] of [['hc', binary], ['herdr-core', join(dirname(binary), 'herdr-core')]]) {
    const path = ownedPath(base.root, join(bin, name));
    await writeFile(path, `#!/bin/sh\nPATH=${quote(join(base.root, 'transport'))}:"$PATH" HC_RECORD_LOG=${quote(recordLog)} HC_REAL_BINARY=${quote(real)} exec perl -e 'alarm shift; exec @ARGV' 30 ${quote(process.execPath)} ${quote(fixture('hc-record.mjs'))} "$@"\n`); await chmod(path, 0o700);
  }
  const env: Record<string, string> = { ...base.env, HC_SESSION: 'l', XDG_RUNTIME_DIR: join(base.root, 'v') };
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  const socket = assertSocketPath(base.root, join(env.XDG_RUNTIME_DIR, 'herdr-core/l.sock'));
  await mkdir(join(env.XDG_CONFIG_HOME, 'herdr-core'), { recursive: true });
  await writeFile(join(env.XDG_CONFIG_HOME, 'herdr-core/config.toml'), 'notes = false\n');
  base.ledger.update(l => { l.cores.push({ side: 'local', namespace: 'l', socket, hcBinary: binary, env }); });
  parsed(await runHc(wrapper, ['server', 'start', '--json'], env), 'local bootstrap');
  const status = parsed(await runHc(wrapper, ['server', 'status', '--json'], env), 'local status');
  const core = status.core as { id?: unknown } | undefined;
  if (status.version !== '0.1.16' || typeof core?.id !== 'string' || typeof status.pid !== 'number' || !(await stat(socket)).isSocket() || socket === defaultCoreSocket()) throw new HarnessError('isolation-unproved', 'local core identity or socket is not proved', status);
  const identity = identityOf(status.pid);
  base.ledger.update(l => { Object.assign(l.cores[0], { coreId: core.id, ...identity }); });
  return { local: { side: 'local', namespace: 'l', socket, env, coreId: core.id, pid: status.pid }, wrapper, recordLog, viaLog,
    records: async () => (await readFile(recordLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as HcRecord) };
}

async function remoteApp(suite: RemoteSuite): ReturnType<Suite['app']> {
  const { stageFakeAppDaemon, createFakeAppDriver } = await import('./fake-app.js');
  const { createNativeAppDriver } = await import('./app.js');
  const cores = suite.cores!;
  const staged = await stageFakeAppDaemon(suite.root, suite.ownPath);
  const env = { ...cores.local.env, HC_SOCKET: cores.local.socket, SPIDER_HERDR_E2E_APP_ROOT: suite.root, SPIDER_HERDR_E2E_APP_SOCKET: staged.socket };
  const config = suite.ownPath(join(suite.root, 'app-daemon.json'));
  await writeFile(config, JSON.stringify({ hcBinary: cores.wrapper, coreId: cores.local.coreId, env }), { mode: 0o600 });
  const proc = spawnOwned(suite.ledger, { label: 'fake-app-daemon', startsCores: true, command: process.execPath, args: [staged.module, 'serve', config], env, cwd: suite.root, stdio: 'pipe', stderrLog: join(suite.evidenceDirectory, 'app-daemon.err') });
  let acknowledged = false, error: unknown;
  proc.child.stdout!.on('data', jsonLines(value => {
    const r = value as { ready?: boolean; socket?: string; coreId?: string; error?: unknown };
    if (r.error) error = r.error;
    if (r.ready) { if (r.socket !== staged.socket || r.coreId !== cores.local.coreId) error = 'wrong owned app identity'; else acknowledged = true; }
  }, (_line, e) => { error = e; }));
  void proc.exited.then(exit => { error ??= `app daemon exited ${JSON.stringify(exit)}`; });
  await waitFor('remote-tier fake app ready', () => ({ acknowledged, error }), r => r.acknowledged || Boolean(r.error), deadline(15_000));
  if (error) throw new HarnessError('missing-adapter', String(error));
  const daemon = await import(/* @vite-ignore */ staged.module) as { appRequest(socket: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> };
  suite.appConnection = { binary: staged.binary, env };
  const native = createNativeAppDriver({ binary: join(userInfo().homedir, '.local/bin/herdr-app'), env, invoke: (binary, argv, inputEnv) => suite.invoke(binary, argv, Object.fromEntries(Object.entries(inputEnv).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))), ownPath: suite.ownPath });
  const driver = createFakeAppDriver({ boundary: { command: (name, args) => daemon.appRequest(staged.socket, name, args), drain: async () => { await daemon.appRequest(staged.socket, 'ls', {}); } }, check: directory => native.check(suite.ownPath(directory)) });
  return driver as unknown as Awaited<ReturnType<Suite['app']>>;
}
