import { parentPort, workerData } from 'node:worker_threads';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createPanelUsageReader } from '../../panel-usage.js';

const input = workerData as { file: string; now: number; sessionId: string };
setFlagsFromString('--expose_gc');
const gc = runInNewContext('gc') as () => void;
const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
const reader = createPanelUsageReader(input.file);
try {
  const before = heap();
  const value = reader.read(input.now, input.sessionId, 5000, 'off');
  const retained = heap();
  parentPort!.postMessage({ before, retained, value });
} finally {
  reader.close();
}
