// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createViewerPorts } from '../../../host/src/herdr/ports.js';
import { runViewer } from '../viewers/program.js';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop); process.once('SIGTERM', stop);
let code = 0;
try {
  const ports = createViewerPorts(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, signal: controller.signal });
  if (ports) await runViewer(ports);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); code = 1;
} finally {
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
process.exit(code);
