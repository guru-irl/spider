import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runLocalDoctor } from '@spider/roam/local-diagnostics';
import { stageRoamDestination } from '../../e2e/fixtures/roam-destination.js';
import { scratchRoot } from '../../e2e/harness/environment.js';

it('lets doctor inspect default settings and broker evidence without an agent directory override', async () => {
  const root = await mkdtemp(join(scratchRoot(), 'rd-'));
  const sourceAgent = join(root, 'source'), box = join(root, 'box'), home = join(root, 'h');
  const release = join(root, 'release'), cli = join(release, 'dist/roam/cli.mjs');
  const agent = join(home, '.pi/agent'), intercom = join(agent, 'intercom'), socketPath = join(intercom, 'broker.sock');
  let federation = true;
  const server = createServer(socket => {
    let data = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 4 || data.length < 4 + data.readUInt32BE(0)) return;
      const request = JSON.parse(data.subarray(4, 4 + data.readUInt32BE(0)).toString()) as { type: string; requestId: string };
      if (request.type !== 'health' || typeof request.requestId !== 'string') { socket.destroy(); return; }
      const payload = Buffer.from(JSON.stringify({ type: 'health_ok', requestId: request.requestId, protocol: 'pi-intercom',
        version: 1, implementation: 'spider', features: federation ? ['federation-v1'] : [] }));
      const header = Buffer.alloc(4); header.writeUInt32BE(payload.length); socket.write(Buffer.concat([header, payload]));
    });
  });
  let listening = false;
  try {
    for (const dir of [sourceAgent, box, home, join(release, 'dist/roam'), join(release, 'scripts'), intercom]) await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(release, 'package.json'), JSON.stringify({ name: '@guru-irl/spider', type: 'module', pi: { extensions: ['./dist/extension.js'] } }));
    await writeFile(join(release, 'dist/extension.js'), 'export default () => {};');
    await writeFile(cli, '');
    for (const name of ['intercom-switchover.mjs', 'extension-shim.mjs']) await copyFile(join(process.cwd(), 'scripts', name), join(release, 'scripts', name));
    await writeFile(join(sourceAgent, 'settings.json'), JSON.stringify({ packages: [release] }), { mode: 0o600 });
    const staged = await stageRoamDestination({ root, sourceAgent, box, home, release, checkout: process.cwd(), cli });
    await copyFile(join(staged.agent, 'settings.json'), join(agent, 'settings.json'));
    await writeFile(join(box, 'roam/config.json'), JSON.stringify({ enabled: false, role: 'box',
      machineId: '00000000-0000-4000-8000-000000000002', hubMachineId: '00000000-0000-4000-8000-000000000001',
      peers: [], discoveryRoots: [], coreUnit: 'fixture' }), { mode: 0o600 });
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(socketPath, done); });
    listening = true; await chmod(socketPath, 0o600);
    vi.stubEnv('HOME', home); vi.stubEnv('PI_CODING_AGENT_DIR', undefined);

    const inspect = () => runLocalDoctor({ root: box, inspectIntercomDoctor: true });
    const report = await inspect();
    expect(report.diagnostics.filter(row => row.reason.startsWith('intercom-readiness-unavailable:'))).toEqual([]);
    expect(report.diagnostics.some(row => row.reason.startsWith('settings-unique:'))).toBe(true);
    expect(report.diagnostics.filter(row => row.severity === 'block' && /^intercom-(settings|legacy|federation)/.test(row.reason))).toEqual([]);

    federation = false;
    const missingFederation = await inspect();
    expect(missingFederation.diagnostics.some(row => row.reason === 'intercom-federation: federation-feature-missing.')).toBe(true);
    const settings = JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ ...settings, extensions: ['pi-intercom'] }), { mode: 0o600 });
    const duplicate = await inspect();
    expect(duplicate.diagnostics.some(row => row.reason.startsWith('intercom-settings-unique: legacy-extension-declared'))).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    if (listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await rm(root, { recursive: true, force: true });
  }
});
