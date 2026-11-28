const { appendFileSync } = require('node:fs');
const { isMainThread } = require('node:worker_threads');
const { SETUP_PROCESS_LOG, SETUP_FILE } = process.env;
// The runner is excluded from counts; keep the Vitest fork and all descendants.
if (isMainThread && SETUP_PROCESS_LOG && SETUP_FILE) {
  appendFileSync(SETUP_PROCESS_LOG, [SETUP_FILE, process.pid, process.ppid, JSON.stringify(process.argv)].join('\t') + '\n');
}
