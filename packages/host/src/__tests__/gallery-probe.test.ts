import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

test('inspect the browser capture protocol', async () => {
  const child = spawn('npm', ['run', '-s', 'test:e2e', '--', '--grep', 'states gallery every component and state 1440$'], {
    env: { ...process.env, CI: 'true', DEBUG: 'pw:protocol', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pending = new Map<number, string>();
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', line => {
      const payload = line.match(/(?:SEND ►|◀ RECV) (\{.*\})$/)?.[1];
      if (payload) {
        try {
          const event = JSON.parse(payload);
          if (event.method === 'Page.captureScreenshot') {
            pending.set(event.id, new Date().toISOString());
            console.log('capture start', event.id, JSON.stringify(event.params));
          } else if (pending.has(event.id)) {
            console.log('capture end', event.id, 'started', pending.get(event.id), 'error', JSON.stringify(event.error ?? null), 'chars', event.result?.data?.length ?? 0);
            pending.delete(event.id);
          } else if (/crash|detach/i.test(event.method ?? '')) console.log('protocol event', JSON.stringify(event));
        } catch { /* Non-JSON debug output. */ }
      } else if (!line.includes('pw:protocol')) console.log(line);
    });
  }
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  console.log('capture calls still pending', JSON.stringify([...pending]));
  expect(code).toBe(0);
}, 450_000);
