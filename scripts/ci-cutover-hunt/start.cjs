const { appendFileSync } = require('node:fs');
const log = process.env.CUTOVER_PROFILE_LOG;
const worker = process.env.VITEST_WORKER_ID;
if (log && worker) {
  const write = event => appendFileSync(log, JSON.stringify({ worker, pid: process.pid, ppid: process.ppid, at: Date.now(), ...event }) + '\n');
  write({ type: 'start', argv: process.argv.slice(1, 5), cwd: process.cwd() });
  process.on('exit', code => {
    const { user, system } = process.cpuUsage();
    write({ type: 'exit', code, cpuMs: (user + system) / 1000 });
  });
}
