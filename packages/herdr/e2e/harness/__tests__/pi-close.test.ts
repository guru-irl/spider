// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSuite } from '../suite.js';
import { storyId } from '../scenario.js';
import { spawnOwned } from '../processes.js';
import { deadline, waitFor } from '../wait.js';
import { identityOf, identityAlive } from '../resources.js';

it('stop awaits the actual exit event and every owned group member after SIGKILL', async () => {
  const suite = await createSuite({ tier: 'ci', story: storyId('H-pi-close-group') });
  try {
    const program = suite.ownPath(join(suite.root, 'held-process.mjs'));
    await writeFile(program, `import {spawn} from 'node:child_process';
process.on('SIGTERM',()=>{});
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
child.stdout.once('data',()=>process.stdout.write(JSON.stringify({child:child.pid})+'\\n'));
setInterval(()=>{},1000);
`);
    const owned = spawnOwned(suite.ledger, { label: 'held-pi-group', command: process.execPath, args: [program], env: suite.env, cwd: suite.root, stdio: 'pipe' });
    let output = '';
    owned.child.stdout!.on('data', bytes => output += bytes);
    await waitFor('parent and TERM-resistant descendant are ready', () => output, text => text.includes('\n'), deadline(10_000));
    const descendant = identityOf(JSON.parse(output).child);
    let exitObserved = false;
    void owned.exited.then(() => { exitObserved = true; });
    await owned.stop(deadline(1));
    expect(exitObserved, 'stop must not resolve at kill submission').toBe(true);
    expect(identityAlive(owned.identity)).toBe(false);
    expect(identityAlive(descendant)).toBe(false);
    await suite.evidence('close-group.json', { parent: owned.identity, descendant, exitObserved, exit: await owned.exited });
  } finally { await suite.close(); }
});
