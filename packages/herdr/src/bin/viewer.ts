// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createViewerPorts } from '../viewers/ports.js';
import { bundleDirectoryOf, piPackageRoot, piVersion, resolvePiFrom, supportedPiVersion } from '../viewers/pi-loader.js';
import { TranscriptSanitizer } from '../viewers/transcript.js';
import { runViewer } from '../viewers/program.js';
import { herdrErrorNotice } from '../notices.js';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop); process.once('SIGTERM', stop);
let code = 0;
try {
  const ports = createViewerPorts(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, signal: controller.signal });
  if (ports) {
    let presentation: Awaited<ReturnType<typeof import('../viewers/pi-main.js').startPiViewer>> | undefined;
    try {
      const root = piPackageRoot(ports.piPackageRoot ?? process.env.SPIDER_VIEWER_PI_ROOT);
      if (!root) throw new Error('The host pi package could not be found.');
      if (!supportedPiVersion(piVersion(root))) throw new Error('The viewer needs pi 1.2.0 or later.');
      const directory = bundleDirectoryOf(import.meta.url);
      resolvePiFrom(root, directory);
      const moduleUrl = pathToFileURL(join(directory, 'viewer-pi.mjs')).href;
      const { startPiViewer } = await import(/* @vite-ignore */ moduleUrl) as typeof import('../viewers/pi-main.js');
      presentation = await startPiViewer({ piRoot: root, runId: ports.runId, cwd: process.cwd(), scratch: join(process.cwd(), '.spider/scratch/viewer', ports.runId) });
    } catch (error) {
      const reason = new TranscriptSanitizer().push(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);
      ports.stdout.write(`Pi view unavailable. ${reason} Using the text view.\n`);
    }
    try { await runViewer({ ...ports, presenter: presentation?.presenter }); }
    finally { presentation?.dispose(); }
  }
} catch (error) {
  process.stderr.write(`${herdrErrorNotice(error)}\n`); code = 1;
} finally {
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
process.exit(code);
