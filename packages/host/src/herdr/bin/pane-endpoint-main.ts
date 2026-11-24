// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HerdrError } from '../../../../herdr/src/client/parse.js';
import { createProductionPaneEndpointPorts, runPaneEndpointCli } from './pane-endpoint.js';
export { createProductionPaneEndpointPorts, runPaneEndpointCli, stagePaneEndpointInstallation } from './pane-endpoint.js';

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  try {
    const bytes = await readFile(fileURLToPath(import.meta.url));
    const digest = createHash('sha256').update(bytes).digest('hex');
    const output = await runPaneEndpointCli(process.argv.slice(2), async () => createProductionPaneEndpointPorts(digest));
    process.stdout.write(output + '\n');
  } catch (error) {
    const code = error instanceof HerdrError ? error.code : 'pane-endpoint-failed';
    process.stderr.write(`${code}\n`); process.exitCode = 1;
  }
}
