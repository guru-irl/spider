import { connect } from 'node:net';
import { createHerdrHarness, proveSocketPaths, type HerdrHarness } from '../../../herdr/src/__tests__/isolated.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';

function readInventory(socketPath: string, argv: string[], env: NodeJS.ProcessEnv): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let reply = '';
    socket.setEncoding('utf8');
    const finish = (error?: Error, value?: unknown) => {
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(15_000, () => finish(new Error('Fake core inventory did not reply')));
    socket.once('error', finish);
    socket.once('connect', () => socket.write(JSON.stringify({ argv, env, input: '' }) + '\n'));
    socket.on('data', chunk => {
      reply += chunk;
      if (Buffer.byteLength(reply) > 8 * 1024 * 1024) return finish(new Error('Fake core inventory exceeds the fixture limit'));
      const end = reply.indexOf('\n');
      if (end < 0) return;
      try {
        const { result, exitCode, stderr } = JSON.parse(reply.slice(0, end));
        if (exitCode) {
          const detail = typeof stderr === 'string' ? JSON.parse(stderr) : stderr;
          throw new HerdrError(detail?.error?.kind ?? 'cli-exit', detail?.error?.message ?? `Fake CLI exited with ${exitCode}`);
        }
        finish(undefined, result);
      } catch (error) { finish(error as Error); }
    });
    socket.once('end', () => finish(new Error('Fake core closed before sending an inventory')));
  });
}

/** Only the fixture's own inventory reads bypass its executable. Test calls,
 * launch and cleanup mutations, and real-hc mode still use their original CLI. */
export async function createHostHerdrHarness(mode: 'fake' | 'hc'): Promise<HerdrHarness> {
  const h = await createHerdrHarness(mode);
  if (mode !== 'fake') return h;
  const cli = h.cli;
  const start = h.start;
  const close = h.close;
  const housekeeping = async (operation: () => Promise<void>) => {
    // A test that replaced h.cli must see every cleanup read through its own wrapper.
    if (h.cli !== cli) return operation();
    const previous = h.cli;
    h.cli = (argv, side = 'local') => {
      const command = argv.join(' ');
      if (command !== 'ls --all --json' && command !== 'server status --json' && command !== 'machine ls --json') return cli(argv, side);
      const socket = side === 'local' ? h.localSocket : h.remoteSocket;
      proveSocketPaths(h.root, [socket]);
      return readInventory(socket, argv, side === 'local' ? h.localEnv : h.remoteEnv);
    };
    try { await operation(); } finally { h.cli = previous; }
  };
  h.start = () => housekeeping(start);
  h.close = () => housekeeping(close);
  return h;
}
