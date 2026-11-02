// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { it, expect } from 'vitest';
import { access, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnOwned } from '../../harness/processes.js';
import { createSuite } from '../../harness/suite.js';
import { storyId } from '../../harness/scenario.js';
import { waitFor, deadline } from '../../harness/wait.js';
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

it('refuses the local socket and a live unregistered socket before forwarding any command', async () => {
  const suite = await createSuite({ tier: 'headless', story: storyId('H-via-negative') });
  try {
    const socket = suite.ownPath(join(suite.root, 'unregistered.s')), program = suite.ownPath(join(suite.root, 'socket-server.mjs'));
    await writeFile(program, `import {createServer} from 'node:net';const server=createServer(s=>s.destroy());server.listen(${JSON.stringify(socket)},()=>process.stdout.write('ready\\n'));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));\n`);
    const running = spawnOwned(suite.ledger, { label: 'unregistered-socket', command: process.execPath, args: [program], env: suite.env, cwd: suite.root, stdio: 'pipe' });
    let output = ''; running.child.stdout!.on('data', d => output += d); await waitFor('live owned unregistered socket', () => output, text => text.includes('ready'), deadline(10000));
    expect(suite.ledger.read().cores.some(c => c.socket === socket)).toBe(false);
    for (const [id, candidate, env] of [['local', suite.cores!.local.socket, suite.cores!.local.env], ['unregistered', socket, suite.cores!.dest.env]] as const) {
      const descriptor = suite.ownPath(join(suite.root, `${id}-via.json`)), marker = suite.ownPath(join(suite.root, `${id}-forbidden`));
      await writeFile(descriptor, JSON.stringify({ root: suite.root, env, log: suite.cores!.viaLog, ledgerPath: suite.ledger.path, socket: candidate, viaDirectory: suite.ledger.read().viaDirectory }));
      const result = await suite.invoke(process.execPath, [fileURLToPath(new URL('../via.mjs', import.meta.url)), descriptor, `printf forbidden > ${shellQuote(marker)}`]);
      await suite.evidence(`${id}-via-refusal.json`, result); expect(result.exitCode).toBe(94); expect(result.stderr).toContain('destination unavailable'); expect(await access(marker).then(() => true, () => false)).toBe(false);
    }
    process.kill(running.identity.pid, 'SIGTERM'); expect(await running.exited).toEqual({ code: 0, signal: null });
    const records = (await readFile(suite.cores!.viaLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(records.filter(r => r.outcome === 'refused')).toHaveLength(2);
  } finally { await suite.close(); }
}, 60000);

