// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { appendFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TerminalIdentity } from '../../contracts.js';
import { createSessionLeases } from '../../sessions/lease.js';
import { createProcessPresence } from '../../sessions/presence.js';
import { createTerminalRegistry } from '../../sessions/registry.js';
import { offerResume, resumeOfferShell } from '../../sessions/resume.js';

const root = process.env.HOME!;
const args = process.argv.slice(2);
if (args[0] === 'resume-offer') {
  await writeFile(join(root, `ready-${process.pid}`), '');
  for (let i = 0; i < 1000 && !(await readdir(root)).includes('go'); i++) await delay(10);
  if (!(await readdir(root)).includes('go')) throw new Error('test barrier timed out');
  const terminal = { coreId: 'core', terminalId: 't1', address: 't1', socket: join(root, 'socket'), sessionNamespace: 'g2' } as TerminalIdentity;
  const offer = await offerResume(terminal, { registry: createTerminalRegistry(root), processInventory: { presence: createProcessPresence(root), leases: createSessionLeases(root), processes: async () => [], probe: async () => ({ kind: 'absent' }) }, coreStartedAt: async () => 20, autoResumeRoot: root });
  if (offer && process.env.RESUME_TEST_CRASH === '1') process.exit(55);
  if (offer) process.stdout.write(resumeOfferShell(offer, { nodePath: process.execPath, cliPath: process.argv[1], configPath: join(root, 'config.json'), hookPath: join(root, 'unused') }, 'auto'));
} else if (args[0] === 'resume') {
  await appendFile(join(root, 'automatic-launches'), JSON.stringify({ cwd: process.cwd(), args }) + '\n');
}
