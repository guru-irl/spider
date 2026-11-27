import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

test('inspect the browser capture protocol', async () => {
  const child = spawn('npm', ['run', '-s', 'test:e2e', '--', '--grep', 'states gallery every component and state 1440$'], {
    env: { ...process.env, CI: 'true', DEBUG: 'pw:protocol', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pending = new Map<number, string>();
  let debugLines = 0, screenshots = 0;
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', line => {
      if (!line.includes('pw:protocol')) { console.log(line); return; }
      debugLines++;
      if (debugLines === 1) console.log('first debug line', line.slice(0, 200));
      const message = line.match(/(?:SEND ►|◀ RECV)\s+(\{.*)/)?.[1];
      if (!message) return;
      if (message.includes('"method":"Page.captureScreenshot"')) {
        try {
          const event = JSON.parse(message);
          pending.set(event.id, new Date().toISOString()); screenshots++;
          console.log('capture start', event.id, JSON.stringify(event.params));
        } catch { console.log('unparsed capture request', message.slice(0, 300)); }
      } else {
        const id = Number(message.match(/^\{"id":(\d+)/)?.[1]);
        if (pending.has(id)) {
          console.log('capture end', id, 'started', pending.get(id), 'error', message.includes('"error"'));
          pending.delete(id);
        }
      }
    });
  }
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  console.log('protocol lines', debugLines, 'capture starts', screenshots, 'still pending', JSON.stringify([...pending]));
  expect(screenshots).toBeGreaterThan(0);
  expect(code).toBe(0);
}, 450_000);
