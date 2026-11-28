import { afterEach, expect, it, vi } from 'vitest';
import { resolve, join } from 'node:path';
import { mountedFixture, heldObserverScenario, assertNoNativeNotes, launchScenario, installFixtureRuntime, closePaneScenario } from './herdr-wiring-fixture.js';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('explicit openJob opens the production observer and every composed hc run disables native notes', () => launchScenario('fake'), 60_000);

it('the production release writer binds the request checksum and the runtime waits for a correct publication', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, true);
  const { readFile, writeFile, rename, chmod, access, watch } = await import('node:fs/promises'); const { join, dirname } = await import('node:path');
  const captureAbort = new AbortController();
  try {
    await installFixtureRuntime(f);
    const valid = await f.mount.execution().remote!.execute({ owner: f.owner!, on: 'remote.invalid' as never, source: { kind: 'code', language: 'javascript', code: 'process.stdout.write("valid\\n");process.exitCode=23' } });
    expect(valid).toMatchObject({ stdout: 'valid\n', exitCode: 23 });
    const original = join(f.h.root, 'recorded-original'), proxy = join(f.h.root, 'release-proxy.mjs'), captured = join(f.h.root, 'captured-release.json');
    await writeFile(original, await readFile(f.config.core.binary)); await chmod(original, 0o700);
    await writeFile(proxy, `import { spawn } from 'node:child_process'; import { writeFileSync, renameSync } from 'node:fs';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const packet=JSON.parse(Buffer.concat(chunks));
const correct={path:process.argv.at(-1),packet};const corrupted={...packet,requestSha256:'0'.repeat(64)};
const child=spawn(${JSON.stringify(original)},process.argv.slice(2),{stdio:['pipe','inherit','inherit']});child.stdin.end(JSON.stringify(corrupted));child.once('exit',code=>{if(code===0){writeFileSync(${JSON.stringify(captured + '.new')},JSON.stringify(correct));renameSync(${JSON.stringify(captured + '.new')},${JSON.stringify(captured)});}process.exit(code??1);});`);
    const replacement = f.config.core.binary + '.next';
    await writeFile(replacement, `#!/bin/sh\nif [ "$1:$2" = "file:write" ]; then case "$*" in *release.json*) exec ${JSON.stringify(process.execPath)} ${JSON.stringify(proxy)} "$@";; esac; fi\nexec ${JSON.stringify(original)} "$@"\n`); await chmod(replacement, 0o700); await rename(replacement, f.config.core.binary);
    const started = join(f.h.directories.remote, 'bound-payload-started');
    const capture = (async () => {
      for await (const event of watch(f.h.root, { signal: captureAbort.signal })) if (event.filename === 'captured-release.json') return JSON.parse(await readFile(captured, 'utf8'));
      throw new Error('Release capture watcher ended');
    })(); void capture.catch(() => {});
    const blocked = f.mount.execution().remote!.execute({ owner: f.owner!, on: 'remote.invalid' as never, source: { kind: 'code', language: 'javascript', code: `require('fs').writeFileSync(${JSON.stringify(started)},'yes');process.exitCode=23` } });
    const publication = await Promise.race([capture, blocked.then(result => { throw new Error('Execution ended before release publication: ' + JSON.stringify(result)); })]);
    captureAbort.abort();
    expect(publication.packet.requestSha256).toBe((await readFile(join(dirname(publication.path), 'request.json.sha256'), 'utf8')).trim());
    await new Promise(r => setTimeout(r, 100)); await expect(access(started)).rejects.toMatchObject({ code: 'ENOENT' });
    await f.h.hc.fileWrite('remote.invalid' as never, publication.path, Buffer.from(JSON.stringify(publication.packet)));
    expect(await blocked).toMatchObject({ exitCode: 23 }); expect(await readFile(started, 'utf8')).toBe('yes');
  } catch (error) {
    const { mkdir } = await import('node:fs/promises'); const evidence = resolve('.spider/scratch/agent-consoles'); await mkdir(evidence, { recursive: true });
    const failure = error as { code?: unknown; details?: unknown };
    await writeFile(join(evidence, 'host-release-failure.json'), JSON.stringify({ message: String(error), code: failure.code, details: failure.details, fixtureExists: await access(f.h.root).then(() => true, () => false), calls: await f.calls().catch(() => []) }));
    throw error;
  } finally { captureAbort.abort(); await f.close(); }
}, 60000);

it.skipIf(process.env.SPIDER_HERDR_E2E !== '1')('real isolated-hc host wiring (no app window)', () => launchScenario('hc'), 60_000);


it('a missing initial index is empty output, while a malformed published index still fails', async () => {
  const f = await mountedFixture();
  const { createHostHerdrPorts } = await import('../herdr/ports.js');
  const { createHcClient } = await import('../../../herdr/src/client/hc.js');
  const { prepareRemoteProgram } = await import('../../../context/src/remote-plan.js');
  const { randomUUID } = await import('node:crypto'); const { join } = await import('node:path');
  const { sha256 } = await import('../../../herdr/src/remote/runtime.js');
  const machine = f.config.machines[0], on = machine.name as import('../../../herdr/src/contracts.js').MachineName;
  const hc = createHcClient({ binary: f.config.core.binary, env: Object.freeze({ ...process.env }) });
  const output = createHostHerdrPorts({ hc, config: f.config as never, runtimeBytes: Buffer.alloc(0), runtimePath: () => join(f.h.root, 'runtime.mjs') });
  try {
    const program = await prepareRemoteProgram({ kind: 'code', language: 'shell', code: 'echo example' }, { ...machine.runtime, on, environment: {}, nodePath: process.execPath, runtimePath: join(f.h.root, 'runtime.mjs'), runtimeSha256: sha256(Buffer.alloc(0)) });
    const job: import('../../../herdr/src/contracts.js').JobRecord = { version: 1, id: randomUUID() as import('../../../herdr/src/contracts.js').JobId, owner: f.owner!, machine: on, kind: 'exec', phase: { kind: 'preparing' }, viewer: null, remoteDirectory: program.directory, localDirectory: join(f.h.root, 'logs'), detached: false, noticeMode: 'tool', notice: 'pending' };
    await output.outputCollector.prepare(program, job);
    for (let i = 0; i < 2; i++) expect(await output.outputCollector.collect(job)).toMatchObject({ complete: false, receipt: null });
    expect(f.errors).toEqual([]);
    await hc.fileWrite(on, join(program.directory, 'index.json'), Buffer.from('{malformed'));
    await expect(output.outputCollector.collect(job)).rejects.toThrow();
  } finally { output.dispose(); await hc.dispose(); await f.close(); }
});


it('production remote preparation carries the optional console hold directory', async () => {
  const f = await mountedFixture();
  const { createHostHerdrPorts } = await import('../herdr/ports.js');
  const { prepareRemoteProgram } = await import('../../../context/src/remote-plan.js');
  const { join } = await import('node:path');
  const ports = createHostHerdrPorts({ hc: f.h.hc, config: f.config as never, runtimeBytes: Buffer.alloc(0), runtimePath: () => join(f.h.directories.remote, 'runtime.mjs') });
  try {
    const on = 'remote.invalid' as import('../../../herdr/src/contracts.js').MachineName;
    const root = join(f.h.directories.remote, 'programs');
    const program = await prepareRemoteProgram({ kind: 'code', language: 'javascript', code: 'process.exitCode=0' }, { on, directory: root, cwd: null, commands: {}, environment: {}, nodePath: f.h.nodeBinary, runtimePath: join(f.h.directories.remote, 'runtime.mjs'), runtimeSha256: '' });
    const consoleDirectory = join(root, '.consoles', 'agent');
    const job = { version: 1 as const, id: 'prepared-job' as never, owner: f.owner!, machine: on, kind: 'exec' as const, phase: { kind: 'preparing' as const }, viewer: null, remoteDirectory: program.directory, localDirectory: join(f.h.directories.local, 'prepared-job'), detached: false, noticeMode: 'tool' as const, notice: 'pending' as const };
    await ports.outputCollector.prepare({ ...program, consoleDirectory }, job);
    const request = JSON.parse((await f.h.hc.fileRead(on, join(program.directory, 'request.json'))).toString());
    expect(request).toMatchObject({ jobId: 'prepared-job', consoleDirectory });
  } finally { ports.dispose(); await f.close(); }
}, 30000);
