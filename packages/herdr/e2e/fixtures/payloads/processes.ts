// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { Suite } from '../../harness/suite.js';
import type { RemoteSuite } from '../../harness/remote.js';
import { identityOf, identityAlive, type ProcessIdentity } from '../../harness/resources.js';
import { HarnessError } from '../../harness/environment.js';
import { destinationPath } from '../../harness/destination.js';
import { shellQuote } from './index.js';

async function remoteOperation(suite: Suite, body: string): Promise<any> {
  const remote = (suite as RemoteSuite).remote, m = remote.metadata;
  const source = `import fs from 'node:fs';const root=${JSON.stringify(m.root)};const helpers=await import(${JSON.stringify(m.root + '/guardian.mjs')});${body}`;
  const result = await remote.exec(`${shellQuote(m.nodePath)} --input-type=module -e ${shellQuote(source)}`);
  if (result.exitCode !== 0) throw new HarnessError('remote-process-unproved', result.stderr || result.stdout, result);
  try { return JSON.parse(result.stdout); } catch { throw new HarnessError('remote-process-unproved', 'process observation is not JSON', result); }
}
export function runtimeArgvMatches(argv: readonly string[], requestPath: string): boolean {
  return /(?:^|\/)spider-remote-runtime-[a-f0-9]+\.mjs$/.test(argv[1] ?? '') && argv[2] === requestPath;
}
export async function runtimePid(suite: Suite, requestPath: string): Promise<number> {
  destinationPath(suite, requestPath);
  if (suite.options.tier !== 'remote') {
    const listing = await suite.invoke('/bin/ps', ['-axo', 'pid=,command=']);
    if (listing.exitCode !== 0) throw new HarnessError('runtime-process-unproved', listing.stderr);
    const rows = listing.stdout.split('\n').map(line => /^\s*(\d+)\s+(.+)$/.exec(line)).filter(m => m && runtimeArgvMatches(m[2].trim().split(/\s+/), requestPath));
    await suite.evidence('wrapper-crash-candidates.json', rows);
    if (rows.length !== 1) throw new HarnessError('runtime-process-unproved', 'expected one runtime for the exact owned request');
    return Number(rows[0]![1]);
  }
  const rows = await remoteOperation(suite, `const matches=${runtimeArgvMatches.toString()};const rows=helpers.rootProcesses(root).filter(p=>{try{return matches(fs.readFileSync('/proc/'+p.pid+'/cmdline','utf8').split(String.fromCharCode(0)),${JSON.stringify(requestPath)});}catch{return false;}});console.log(JSON.stringify(rows));`) as { pid: number }[];
  await suite.evidence('wrapper-crash-candidates.json', rows);
  if (rows.length !== 1) throw new HarnessError('runtime-process-unproved', 'expected one remote runtime for the exact owned request');
  return rows[0].pid;
}
/** Register the proved identity before a crash can orphan it. The guardian owns Linux cleanup. */
export async function registerDestinationProcess(suite: Suite, pid: number, label: string, group: boolean): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new HarnessError('remote-process-unproved', 'invalid PID');
  if (suite.options.tier !== 'remote') {
    const identity = identityOf(pid); suite.ledger.update(l => l.processes.push({ ...identity, label, group })); return identity;
  }
  return remoteOperation(suite, `const pid=${pid};const observed=helpers.rootProcesses(root).find(p=>p.pid===pid);if(!observed?.start)throw Error('process-outside-owned-root');const identity={pid,start:observed.start,label:${JSON.stringify(label)},group:${group}};const path=${JSON.stringify((suite as RemoteSuite).remote.metadata.ledger)};const ledger=JSON.parse(fs.readFileSync(path));if(ledger.root!==root||ledger.state!=='open')throw Error('remote-ledger-closed');ledger.processes.push(identity);const temporary=path+'.process';fs.writeFileSync(temporary,JSON.stringify(ledger),{mode:384});fs.renameSync(temporary,path);console.log(JSON.stringify({pid,start:observed.start}));`);
}
export async function destinationProcessAlive(suite: Suite, identity: ProcessIdentity): Promise<boolean> {
  if (suite.options.tier !== 'remote') return identityAlive(identity);
  return remoteOperation(suite, `console.log(JSON.stringify(helpers.processStart(${identity.pid})===${JSON.stringify(identity.start)}));`);
}
export async function signalDestinationProcess(suite: Suite, identity: ProcessIdentity, signal: 'SIGKILL'): Promise<void> {
  if (suite.options.tier !== 'remote') {
    if (!identityAlive(identity)) throw new HarnessError('process-identity-changed', 'refusing to signal a changed process');
    process.kill(identity.pid, signal); return;
  }
  await remoteOperation(suite, `const identity=${JSON.stringify(identity)};const ledger=JSON.parse(fs.readFileSync(${JSON.stringify((suite as RemoteSuite).remote.metadata.ledger)}));if(!ledger.processes.some(p=>p.pid===identity.pid&&p.start===identity.start)||helpers.processStart(identity.pid)!==identity.start||!helpers.rootProcesses(root).some(p=>p.pid===identity.pid))throw Error('process-identity-changed');process.kill(identity.pid,${JSON.stringify(signal)});console.log('{}');`);
}
