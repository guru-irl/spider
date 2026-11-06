import { describe, expect, it } from 'vitest';
import { createSuite } from '../suite.js';
import { storyId } from '../scenario.js';

describe('owned invocation', () => {
  it('collects output until the child streams close after its exit', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-invoke-streams') });
    const descendant = `process.on('disconnect', () => setTimeout(() => {
      process.stdout.write('late stdout');
      process.stderr.write('late stderr');
    }, 100)); process.send('ready');`;
    const parent = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 1, 2, 'ipc'] });
      child.on('message', () => process.exit(17));`;
    try {
      expect(await suite.invoke(process.execPath, ['-e', parent])).toEqual({ exitCode: 17, stdout: 'late stdout', stderr: 'late stderr' });
    } finally { expect((await suite.close({ removeRoot: true })).clean).toBe(true); }
  });

  it('reports the signal when a child is terminated', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-invoke-signal') });
    try {
      expect(await suite.invoke(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"]))
        .toMatchObject({ exitCode: 128, signal: 'SIGTERM', stdout: '', stderr: '' });
    } finally { expect((await suite.close({ removeRoot: true })).clean).toBe(true); }
  });
});
