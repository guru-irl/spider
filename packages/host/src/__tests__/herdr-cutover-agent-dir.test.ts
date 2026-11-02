import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { leasedLauncherArgv } from '../../../herdr/src/spaces/setup.js';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it('launches cutover with the configured pi agent directory even when the app differs', () => {
  const scratch = resolve('.spider/scratch/tmp'); mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, 'cutover-agent-'));
  const configured = join(root, "pi agent's $directory"), appAgent = join(root, 'app-agent');
  const cli = join(root, 'launcher.mjs'), configPath = join(root, 'config.json'), file = join(root, 'session.jsonl');
  writeFileSync(cli, "console.log(JSON.stringify({ agent: process.env.PI_CODING_AGENT_DIR, args: process.argv.slice(2) }));\n");
  const argv = leasedLauncherArgv({ file, cwd: root, sessionId: 'session', name: 'Selected', extensionArguments: [] } as never,
    { nodePath: process.execPath, cliPath: cli, configPath }, configured);
  expect(argv[3]).toBe(`PI_CODING_AGENT_DIR=${configured}`);
  expect(argv.slice(4, 7)).toEqual([process.execPath, cli, 'resume']);
  const result = spawnSync(argv[0], argv.slice(1), { env: { ...process.env, PI_CODING_AGENT_DIR: appAgent }, encoding: 'utf8', timeout: 10000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ agent: configured, args: ['resume', '--config', configPath, '--file', file, '--session-id', 'session', '--cwd', root, '--cutover'] });
});
