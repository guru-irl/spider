// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { access, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { createHerdrHarness, createClientFixture, terminal } from './testutil.js';
import { createHcClient, observeCoreIdentity } from '../client/hc.js';
import { isCoreAvailable } from '../client/liveness.js';

const realHc = process.env.SPIDER_HERDR_E2E === '1' && await access(process.env.SPIDER_HERDR_HC_BINARY ?? join(process.env.HOME!, '.local/bin/hc')).then(() => true, () => false);
async function until(check: () => Promise<boolean>, description: string) {
  const end = Date.now() + 10000;
  while (!await check()) { if (Date.now() > end) throw new Error(description); await delay(25); }
}

test.skipIf(!realHc)('a surviving old terminal cannot claim an unrelated terminal at its address on a new real core', async () => {
  const h = await createHerdrHarness('hc');
  // Leave enough time for an explicit reset before holders supervise the crashed core.
  h.localEnv.HC_HOLDER_GRACE_MS = '30000';
  const oldProcesses = new Set<number>();
  let fresh: ReturnType<typeof createHcClient> | undefined;
  try {
    await h.start();
    expect(h.localSocket).toContain(h.root); expect(Buffer.byteLength(h.localSocket)).toBeLessThan(104);
    const status = await h.cli(['server', 'status', '--json']) as { pid: number; holders: { pid: number }[]; core: { id: string } };
    const old = await h.cli(['get', h.owner!.terminal.address, '--json']) as { pid: number; scope: string };
    oldProcesses.add(old.pid);
    for (const holder of status.holders) oldProcesses.add(holder.pid);
    const envFile = join(h.root, 'terminal-env.json'), acceptedFile = join(h.root, 'accepted.json'), retryFile = join(h.root, 'retry.json'), requestFile = join(h.root, 'retry-request'), callerPidFile = join(h.root, 'caller.pid');
    await build({ configFile: false, logLevel: 'silent', build: { ssr: true, outDir: join(h.root, 'client'), rollupOptions: { input: fileURLToPath(new URL('../client/hc.ts', import.meta.url)), output: { entryFileNames: 'hc.mjs' } } } });
    const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(callerPidFile)},String(process.pid));fs.writeFileSync(${JSON.stringify(envFile)},JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('HC_')))));import(${JSON.stringify(join(h.root, 'client/hc.mjs'))}).then(async({createHcClient})=>{const c=createHcClient({binary:${JSON.stringify(h.hcBinary)},env:process.env});try{fs.writeFileSync(${JSON.stringify(acceptedFile)},JSON.stringify(await c.caller(process.env)))}catch(e){fs.writeFileSync(${JSON.stringify(acceptedFile)},JSON.stringify({error:e.code,message:e.message}))}finally{await c.dispose()}let retried=false;setInterval(async()=>{if(retried||!fs.existsSync(${JSON.stringify(requestFile)}))return;retried=true;const fresh=createHcClient({binary:${JSON.stringify(h.hcBinary)},env:process.env});try{fs.writeFileSync(${JSON.stringify(retryFile)},JSON.stringify(await fresh.caller(process.env)))}catch(e){fs.writeFileSync(${JSON.stringify(retryFile)},JSON.stringify({error:e.code,message:e.message}))}finally{await fresh.dispose()}},25)});setInterval(()=>{},1000)`;
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const run = await h.cli(['run', '--bg', '--no-notify', '--outlive-parent', '--no-parent', '--json', '--', '/bin/sh', '-c', `${quote(process.execPath)} -e ${quote(script)} & wait`]) as { address: string };
    const detail = await h.cli(['get', run.address, '--json']) as { pid: number; scope: string };
    oldProcesses.add(detail.pid);
    const latestStatus = await h.cli(['server', 'status', '--json']) as typeof status;
    for (const holder of latestStatus.holders) oldProcesses.add(holder.pid);
    await until(async () => access(envFile).then(() => true, () => false), 'terminal environment not written');
    const terminalEnv = JSON.parse(await readFile(envFile, 'utf8'));
    const callerPid = Number(await readFile(callerPidFile, 'utf8')); oldProcesses.add(callerPid);
    expect(detail.pid).not.toBe(callerPid);
    expect(detail.scope).toBeUndefined(); // hc keeps scope private; its public ownership evidence is pid.
    expect(typeof terminalEnv.HC_SCOPE).toBe('string');
    await writeFile(join(h.root, '../../coreid-reference-hc-0.1.16.json'), JSON.stringify({ status: latestStatus, terminal: detail, environment: terminalEnv }, null, 2));
    console.log('hc 0.1.16 public ownership fields:', JSON.stringify({ scope: detail.scope, HC_SCOPE: terminalEnv.HC_SCOPE, pid: detail.pid, holders: latestStatus.holders }));
    await until(async () => access(acceptedFile).then(() => true, () => false), 'in-terminal caller did not settle');
    expect(JSON.parse(await readFile(acceptedFile, 'utf8'))).toMatchObject({ coreId: status.core.id, address: run.address });
    const callerEnv = { ...h.localEnv, HERDR_TEST_SYNTHETIC_CALLER: undefined };
    const external = createHcClient({ binary: h.hcBinary, env: callerEnv });
    try { await expect.soft(external.caller(callerEnv)).rejects.toMatchObject({ code: 'terminal-core-mismatch' }); }
    finally { await external.dispose(); }
    for (const holder of latestStatus.holders) process.kill(holder.pid, 'SIGSTOP');
    process.kill(status.pid, 'SIGKILL');
    await until(async () => !await isCoreAvailable(h.localEnv), 'old core stayed live');
    await rename(join(h.root, 'herdr-core/l'), join(h.root, 'old-core-state'));
    await h.cli(['server', 'start', '--json']);
    const next = await h.cli(['server', 'status', '--json']) as typeof status;
    expect(next.core.id).not.toBe(status.core.id);
    const decoy = await h.cli(['run', '--bg', '--no-notify', '--outlive-parent', '--no-parent', '--json', '--', process.execPath, '-e', 'setInterval(()=>{},1000)']) as { address: string };
    expect(decoy.address).toBe(h.owner!.terminal.address);
    const secondDecoy = await h.cli(['run', '--bg', '--no-notify', '--outlive-parent', '--no-parent', '--json', '--', process.execPath, '-e', 'setInterval(()=>{},1000)']) as { address: string };
    expect(secondDecoy.address).toBe(run.address);
    await writeFile(requestFile, 'retry');
    await until(async () => access(retryFile).then(() => true, () => false), 'surviving terminal did not retry');
    expect(JSON.parse(await readFile(retryFile, 'utf8'))).toMatchObject({ error: 'terminal-core-mismatch' });
    const decoyDetail = await h.cli(['get', decoy.address, '--json']) as typeof old;
    expect(decoyDetail.pid).not.toBe(old.pid);
    process.kill(old.pid, 0); // Old terminal survived the reset.
    fresh = createHcClient({ binary: h.hcBinary, env: callerEnv });
    await expect(fresh.caller(callerEnv)).rejects.toMatchObject({ code: 'terminal-core-mismatch' });
    expect((await h.cli(['get', decoy.address, '--json']) as typeof old).pid).toBe(decoyDetail.pid);
  } finally {
    await fresh?.dispose();
    for (const pid of oldProcesses) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await h.close(); expect(await h.remainingOwnedResources()).toEqual([]);
    console.log('real changed-core cleanup:', JSON.stringify(h.cleanupProof));
  }
}, 60000);

test.each([undefined, null, 2147483647])('caller cannot claim a terminal without a live process ancestor: %s', async pid => {
  const h = await createClientFixture();
  const client = createHcClient({ binary: h.hcBinary, env: h.localEnv });
  try {
    await h.configure({ terminals: [{ ...terminal('t1'), pid }] });
    await expect(client.caller(h.localEnv)).rejects.toMatchObject({ code: 'terminal-core-mismatch' });
  } finally { await client.dispose(); await h.close(); }
});

test('an aborted core-identity query does not invoke hc', async () => {
  const h = await createClientFixture();
  const client = createHcClient({ binary: h.hcBinary, env: h.localEnv });
  const abort = new AbortController(); abort.abort();
  try { await expect(observeCoreIdentity(h.hcBinary, h.localEnv, { signal: abort.signal })).rejects.toMatchObject({ code: 'cli-aborted' }); }
  finally { await client.dispose(); await h.close(); }
}, 5000);
