import { afterEach, expect, test, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { verifiedHerdrFile } from '../herdr/ports.js';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import { doctorHerdr } from '../../../herdr/src/setup/doctor.js';
import { readJournal, saveJournal, digest } from '../../../herdr/src/setup/backup.js';
import { cleanup, fixture } from './herdr-setup-fixture.js';

export async function editUnrelated(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const settings = join(f.h.directories.agent, 'settings.json');
  await writeFile(settings, JSON.stringify({ ...JSON.parse(await readFile(settings, 'utf8')), unrelated: 'edited' }));
  await writeFile(f.request.config.shellRc, (await readFile(f.request.config.shellRc, 'utf8')) + 'export USER_CHOICE=kept\n');
  await writeFile(f.request.config.core.config, (await readFile(f.request.config.core.config, 'utf8')) + '\n[custom]\nvalue = 42\n');
  const keys = join(f.h.directories.app, 'keys.json');
  await writeFile(keys, JSON.stringify({ ...JSON.parse(await readFile(keys, 'utf8')), global: { 'ctrl-q': 'user.action' } }));
}

export async function claimCurrentHash(f: Awaited<ReturnType<typeof fixture>>, path: string): Promise<void> {
  const journal = await readJournal(f.request.journalRoot); journal.entries.find(e => e.path === path)!.after = digest(await readFile(path)); await saveJournal(f.request.journalRoot, journal);
}

export async function installedModFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await installedModFiles(path));
    else files.push(path);
  }
  return files;
}

export async function startInteractiveShell(binary: string, home: string, env: NodeJS.ProcessEnv): Promise<{
    code: number | null;
    output: string;
}> {
  // A controlling PTY avoids bash's non-TTY job-control warning, so stderr is checked too.
  const python = `import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
 os.execve(sys.argv[1], sys.argv[1:], os.environ)
while True:
 try: data = os.read(fd, 65536)
 except OSError: break
 if not data: break
 os.write(1, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
  const args = binary.endsWith('bash') ? ['--noprofile', '--rcfile', join(home, '.bashrc'), '-i', '-c', ':'] : ['-i', '-c', ':'];
  return new Promise<{ code: number | null; output: string }>((done, reject) => {
    const child = spawn('/usr/bin/python3', ['-c', python, binary, ...args], { cwd: home, env: { ...env, HOME: home, ZDOTDIR: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    child.once('error', reject); child.once('close', code => done({ code, output }));
  });
}

export const installedShells: string[] = ['/bin/bash', '/bin/zsh'].filter(shell => existsSync(shell));
