import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { stageRoamDestination } from './roam-destination.js';

it('prepares an isolated agent and routes the packaged CLI through the destination environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roam-destination-'));
  try {
    const sourceAgent = join(root, 'source'), box = join(root, 'box'), home = join(root, 'home');
    const release = join(root, 'release'), checkout = join(root, 'checkout');
    const sdk = join(checkout, 'node_modules/@earendil-works/pi-coding-agent'), cli = join(release, 'dist/roam/cli.mjs');
    for (const dir of [sourceAgent, box, home, join(release, 'dist/roam'), join(release, 'scripts'), join(sdk, 'dist')]) await mkdir(dir, { recursive: true });
    await writeFile(join(sourceAgent, 'settings.json'), JSON.stringify({ packages: [release] }));
    await writeFile(join(release, 'dist/extension.js'), 'fixture release');
    await writeFile(join(release, 'scripts/intercom-switchover.mjs'), '');
    await writeFile(join(release, 'scripts/extension-shim.mjs'), '');
    await writeFile(join(sdk, 'dist/index.js'), 'fixture sdk');
    await writeFile(cli, 'console.log(JSON.stringify({home:process.env.HOME,agent:process.env.PI_CODING_AGENT_DIR,arg:process.argv[2]}));');
    const staged = await stageRoamDestination({ root, sourceAgent, box, home, release, checkout, cli });
    expect(staged.agent).not.toBe(sourceAgent);
    expect(JSON.parse(await readFile(join(staged.agent, 'settings.json'), 'utf8'))).toEqual({ packages: [release] });
    expect(JSON.parse(await readFile(join(box, 'roam/active-release.json'), 'utf8'))).toBe(release);
    expect(await readlink(join(home, '.local/lib/node_modules/@earendil-works/pi-coding-agent'))).toBe(sdk);
    const run = spawnSync(process.execPath, [staged.cli, 'probe'], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ home, agent: staged.agent, arg: 'probe' });
    await rm(join(release, 'scripts/extension-shim.mjs'));
    await expect(stageRoamDestination({ root, sourceAgent, box, home, release, checkout, cli })).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
