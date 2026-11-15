// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { createServer, Socket } from 'node:net';
import { createFixtureRoot } from '../environment.js';
import { launchPi, readObserved } from '../pi.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(): Promise<string> {
  const root = await createFixtureRoot();
  roots.push(root);
  return root;
}

describe('observer record framing', () => {
  it.each([undefined, 123])('defers a torn last record until its newline arrives with pid %s', async pid => {
    const root = await fixture();
    const file = join(root, '123.jsonl');
    await writeFile(file, '{"at":2,"pid":123,"type":"ready"}\n\n{"at":1,"pid":123,"type":"par');
    expect(await readObserved(root, pid)).toEqual([{ at: 2, pid: 123, type: 'ready' }]);
    await appendFile(file, 'tial"}\n');
    expect(await readObserved(root, pid)).toEqual([
      { at: 1, pid: 123, type: 'partial' },
      { at: 2, pid: 123, type: 'ready' },
    ]);
  });

  it('defers a valid JSON record until its newline arrives', async () => {
    const root = await fixture();
    const file = join(root, '123.jsonl');
    await writeFile(file, '{"at":1,"pid":123,"type":"ready"}');
    expect(await readObserved(root, 123)).toEqual([]);
    await appendFile(file, '\n');
    expect(await readObserved(root, 123)).toEqual([{ at: 1, pid: 123, type: 'ready' }]);
  });

  it('rejects an invalid complete record', async () => {
    const root = await fixture();
    await writeFile(join(root, '123.jsonl'), '{"at":1,"pid":123,"type":"ready"}\nnot json\n');
    await expect(readObserved(root, 123)).rejects.toThrow(SyntaxError);
  });
});

it('waits for the pty broker to answer when its socket path is not yet listening', async () => {
  const root = await fixture(), cwd = join(root, 'project');
  await mkdir(cwd);
  let socketPath = '', refusals = 0;
  const server = createServer(socket => socket.once('data', () => socket.end(JSON.stringify({ pid: process.pid, brokerPid: process.pid, terminal: 't1' }) + '\n')));
  const connect = Socket.prototype.connect;
  const spy = vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (this: Socket, ...args: Parameters<Socket['connect']>) {
    this.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        refusals++; unlinkSync(socketPath); server.listen(socketPath);
      }
    });
    return Reflect.apply(connect, this, args) as Socket;
  });
  const state = { cores: [{ side: 'local', coreId: 'core-a' }], terminals: [], processes: [] };
  const ledger = { read: () => state, update: (edit: (value: typeof state) => void) => edit(state) };
  const hc = vi.fn(async (argv: string[]) => {
    socketPath = argv[argv.indexOf('--socket') + 1];
    const pending = createServer();
    await new Promise<void>(resolve => pending.listen(socketPath + '.binding', resolve));
    await rename(socketPath + '.binding', socketPath);
    await new Promise<void>(resolve => pending.close(() => resolve()));
    return { exitCode: 0, json: { address: 't1' } };
  });
  try {
    const driver = await launchPi({ root, env: {}, observerDir: join(root, 'o'), launcher: '/fixture/pi' } as never, ledger as never,
      { mode: 'interactive', cwd }, { local: { coreId: 'core-a' }, hc } as never);
    expect(refusals).toBe(1);
    expect(driver).toMatchObject({ pid: process.pid, terminal: 't1' });
    expect(state.processes).toHaveLength(2);
    expect(hc).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 5000);

it.each([
  { side: 'missing', coreId: 'core-a' },
  { side: 'owned', coreId: 'core-b' },
])('rejects a terminal launch when the ledger side does not own the selected core', async ({ side, coreId }) => {
  const root = await fixture(), cwd = join(root, 'project');
  await mkdir(cwd);
  const hc = vi.fn().mockRejectedValue(new Error('unexpected hc call'));
  const ledger = { read: () => ({ cores: [{ side: 'owned', coreId: 'core-a' }] }) };
  await expect(launchPi({ root, env: {} } as never, ledger as never,
    { mode: 'interactive', cwd, terminalSide: side } as never,
    { local: { coreId }, hc } as never)).rejects.toThrow('terminal-core-unowned');
  expect(hc).not.toHaveBeenCalled();
}, 5000);
