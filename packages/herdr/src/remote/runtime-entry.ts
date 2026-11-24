// SPDX-License-Identifier: MIT
import { installRuntimeDirectory, probeRuntimeDirectory, runRemoteConsole, runRemoteRuntime, RemoteRuntimeError } from './runtime.js';

if (!process.argv[2]) { process.stderr.write('A runtime request file is required\n'); process.exitCode = 127; }
else {
  try {
    if (process.argv[2] === '--install' || process.argv[2] === '--probe') {
      const directory = process.argv[3]; if (!directory) throw new RemoteRuntimeError('runtime-root-invalid', 'A runtime root is required');
      const result = process.argv[2] === '--install' ? await installRuntimeDirectory(directory) : await probeRuntimeDirectory(directory);
      process.stdout.write(JSON.stringify(result) + '\n');
    } else if (process.argv[2] === '--console') {
      const directory = process.argv[3]; if (!directory) throw new RemoteRuntimeError('console-directory-invalid', 'A console directory is required');
      const cancellation = new AbortController(); const stop = () => cancellation.abort();
      for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) process.on(signal, stop);
      const values = new Map<string, string>();
      for (let i = 5; i < process.argv.length; i += 2) {
        if (!['--display-lease', '--session', '--generation', '--console-id'].includes(process.argv[i]) || values.has(process.argv[i]) || !process.argv[i+1]) throw new RemoteRuntimeError('console-usage', 'Invalid console view arguments');
        values.set(process.argv[i], process.argv[i+1]);
      }
      if (values.size && values.size !== 4) throw new RemoteRuntimeError('console-usage', 'Incomplete console display lease');
      try { await runRemoteConsole(directory, { signal: cancellation.signal, instance: process.argv[4], displayLeaseFile: values.get('--display-lease'), sessionId: values.get('--session'), generation: values.get('--generation'), consoleId: values.get('--console-id') }); }
      finally { for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) process.off(signal, stop); }
    } else process.exitCode = await runRemoteRuntime(process.argv[2]);
  }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 127; }
}
