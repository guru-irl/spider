import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { configFixtureCwd } from './herdr-config-fixture.js';

const launch = vi.hoisted(() => ({ bin: '', agent: '' }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: (command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) => {
    if (launch.bin && (command !== 'pi' || !args.includes('--session') || options.env?.PATH !== launch.bin || options.env.PI_CODING_AGENT_DIR !== launch.agent)) throw new Error('Unexpected session launcher');
    return actual.spawn(command, args, options);
  } };
});

let root = '';
afterEach(async () => { launch.bin = ''; vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

it.each([undefined, 'different-agent'])('resume pins the configured pi directory when the shell has %s', async shellDirectory => {
  const scratch = resolve('.spider/scratch/tmp'); await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, 'resume-agent-'));
  execFileSync('git', ['init', '-q', root]);
  const home = join(root, 'home'), bin = join(root, 'bin'), configured = join(root, "configured agent's directory");
  for (const directory of [home, bin, configured]) await mkdir(directory);
  const file = join(root, 'saved.jsonl'), receipt = join(root, 'launched.json'), configPath = join(root, 'config.json');
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: 'saved', cwd: root }) + '\n');
  await writeFile(configPath, JSON.stringify({ enabled: true,
    app: { binary: join(root, 'unused-app'), home: join(root, 'app') },
    core: { binary: join(root, 'unused-hc'), config: join(root, 'core.toml') },
    agentDirectory: configured, globalRoot: root, shellRc: join(root, 'rc'), spaces: [], machines: [] }));
  const pi = join(bin, 'pi.mjs');
  await writeFile(pi, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(receipt)}, JSON.stringify({ agentDirectory: process.env.PI_CODING_AGENT_DIR, argv: process.argv.slice(2), cwd: process.cwd() }));\nsetTimeout(() => process.exit(0), 500);\n`);
  await writeFile(join(bin, 'pi'), `#!/bin/sh\nexec '${process.execPath}' '${pi}' "$@"\n`, { mode: 0o700 });
  launch.bin = bin; launch.agent = configured;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, SPIDER_GLOBAL_ROOT: root,
    PATH: bin };
  delete env.PI_CODING_AGENT_DIR;
  if (shellDirectory !== undefined) env.PI_CODING_AGENT_DIR = join(root, shellDirectory);
  const cli = configFixtureCwd(createProductionHerdrCliPorts(root, env), root), errors: string[] = [];
  cli.stderr = message => errors.push(message);
  try {
    expect(env.PI_CODING_AGENT_DIR).not.toBe(configured);
    const code = await runHerdrCli(['resume', '--config', configPath, '--file', file, '--session-id', 'saved', '--cwd', root], cli);
    expect(code, errors.join('\n')).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(await readFile(receipt, 'utf8'))).toEqual({ agentDirectory: configured, argv: ['--session', file], cwd: root });
  } finally { await cli.dispose(); }
});
