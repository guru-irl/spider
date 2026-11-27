const child = require('node:child_process');
const { appendFileSync } = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');

const trace = process.env.HSR_PROCESS_TRACE;
if (trace) {
  let seq = 0;
  const log = row => appendFileSync(trace, JSON.stringify({ at: Date.now(), ...row }) + '\n');
  const start = (file, argv) => {
    const id = `${process.pid}:${++seq}`;
    log({ id, event: 'start', file, argv: argv.slice(0, 14).map(value => String(value).slice(0, 300)) });
    return id;
  };
  const end = id => log({ id, event: 'end' });
  const spawn = child.ChildProcess.prototype.spawn;
  child.ChildProcess.prototype.spawn = function (options) {
    const id = start(options.file, options.args.slice(1));
    try {
      const result = spawn.call(this, options);
      this.once('close', () => end(id));
      return result;
    } catch (error) {
      end(id);
      throw error;
    }
  };
  for (const name of ['execFileSync', 'execSync', 'spawnSync']) {
    const original = child[name];
    child[name] = function (file, ...args) {
      const id = start(file, Array.isArray(args[0]) ? args[0] : []);
      try { return original(file, ...args); }
      finally { end(id); }
    };
  }
  syncBuiltinESMExports();
}
