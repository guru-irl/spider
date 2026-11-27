// SPDX-License-Identifier: MIT
'use strict';

const threads = require('node:worker_threads');
const threadContextKey = 'spider.selection.recorder';
const threadContext = threads.isMainThread ? null : threads.getEnvironmentData(threadContextKey);
const workerPreload = `--require=${__filename}`;
const dir = threads.isMainThread ? process.env.SPIDER_SELECTION_DIR
  : process.execArgv.at(-1) === workerPreload ? threadContext?.dir : null;
if (dir) {
  const { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } = require('node:fs');
  const { basename, join, relative, resolve, isAbsolute, sep } = require('node:path');
  const { fileURLToPath } = require('node:url');
  const { createHash, randomUUID } = require('node:crypto');
  const { syncBuiltinESMExports } = require('node:module');
  const cp = require('node:child_process');
  const root = resolve(threadContext?.root ?? (process.env.SPIDER_SELECTION_ROOT || join(__dirname, '../..')));
  const keysEnv = threadContext?.keysEnv ?? (process.env.SPIDER_SELECTION_BUNDLE_KEYS || '');
  const keys = new Set(keysEnv.split(',').filter(Boolean));
  const sizes = new Set([...keys].map(key => Number(key.split(':', 1)[0])));
  const processId = threadContext?.processId ?? randomUUID();
  const launchId = threadContext?.launchId ?? process.env.SPIDER_SELECTION_LAUNCH_ID ?? null;
  delete process.env.SPIDER_SELECTION_LAUNCH_ID;
  const id = `${process.pid}-${randomUUID()}`;
  const dest = join(dir, `${id}.json`);
  const preload = `--require=${JSON.stringify(__filename)}`;
  if (threadContext) process.execArgv.pop();
  const savedOptions = 'SPIDER_SELECTION_SAVED_NODE_OPTIONS';
  const launchOptions = process.env.NODE_OPTIONS ?? '';
  if (launchOptions === preload || launchOptions.endsWith(` ${preload}`)) {
    // Node has already loaded the hook. Do not expose our flag to code that
    // must see the sanitized env supplied by its caller.
    const original = process.env[savedOptions] ?? launchOptions.slice(0, -preload.length).trimEnd();
    if (original || Object.hasOwn(process.env, savedOptions)) process.env.NODE_OPTIONS = original;
    else delete process.env.NODE_OPTIONS;
  }
  delete process.env[savedOptions];
  const scripts = new Map();
  const fileCache = new Map();
  let test = threadContext?.test ?? (process.env.SPIDER_SELECTION_TEST || null);
  let worker = false;
  let finished = false;
  let collect;
  const channelName = threadId => `spider.selection:${process.pid}:${threadId}`;

  function note(where, error) {
    try { appendFileSync(join(dir, 'hook-errors.ndjson'), JSON.stringify({ where, code: error?.code }) + '\n'); }
    catch { /* The recorder must not change a child exit code or its streams. */ }
  }

  function withEnv(args, hasArgv, childLaunchId) {
    const index = hasArgv && (Array.isArray(args[1]) || (args[1] == null && args.length > 2)) ? 2 : 1;
    const options = args[index];
    if (options != null && typeof options !== 'function' && (typeof options !== 'object' || Array.isArray(options))) return args;
    const env = { ...(options?.env ?? process.env) };
    const nodeOptions = String(env.NODE_OPTIONS ?? '');
    if (!nodeOptions.includes(preload)) {
      if (env.NODE_OPTIONS === undefined) delete env[savedOptions];
      else env[savedOptions] = nodeOptions;
      env.NODE_OPTIONS = `${nodeOptions} ${preload}`.trim();
    }
    env.SPIDER_SELECTION_DIR = dir;
    env.SPIDER_SELECTION_ROOT = root;
    env.SPIDER_SELECTION_BUNDLE_KEYS = keysEnv;
    if (childLaunchId) env.SPIDER_SELECTION_LAUNCH_ID = childLaunchId;
    else delete env.SPIDER_SELECTION_LAUNCH_ID;
    if (test) {
      env.SPIDER_SELECTION_TEST = test;
      // A test that starts Vitest is still one outer test's execution.
      delete env.SPIDER_SELECTION;
    } else delete env.SPIDER_SELECTION_TEST;
    const updated = { ...options, env };
    if (typeof options === 'function') args.splice(index, 0, updated);
    else args[index] = updated;
    return args;
  }

  function recordLaunch(event) {
    try { appendFileSync(join(dir, 'launches.ndjson'), JSON.stringify({ test, ...event }) + '\n'); }
    catch (error) { note('launch', error); }
  }

  function wrap(fn, hasArgv, name) {
    return function (...args) {
      // Only direct Node executables can be identified without guessing what a shell runs.
      const direct = test && (name === 'fork' || (hasArgv && typeof args[0] === 'string'
        && /^(node|nodejs)(\.exe)?$/i.test(basename(args[0]))));
      const childLaunchId = direct ? randomUUID() : null;
      try {
        const result = Reflect.apply(fn, this, withEnv(args, hasArgv, childLaunchId));
        const child = result?.child ?? result;
        if (direct && (child?.pid > 0 || name === 'execFileSync')) {
          recordLaunch({ kind: 'process', launchId: childLaunchId });
        }
        return result;
      } catch (error) {
        if (direct && error?.pid > 0) recordLaunch({ kind: 'process', launchId: childLaunchId });
        throw error;
      }
    };
  }

  function scriptPath(url) {
    if (url.startsWith('file:')) return fileURLToPath(url);
    return isAbsolute(url) ? url.split(/[?#]/, 1)[0] : null;
  }

  function classify(file, scriptHash) {
    const name = relative(root, file);
    const dist = file.split(sep).includes('dist');
    const dependency = file.split(sep).includes('node_modules');
    if ((!dependency || dist) && /\.[cm]?js$/.test(file) && scriptHash
      && existsSync(join(dir, 'fixture-maps', `${scriptHash}.json`))) return 'fixture';
    if (dist && !dependency) return 'bundle';
    if (!dependency && !isAbsolute(name) && !name.startsWith(`..${sep}`) && !name.startsWith(`.spider${sep}`)
      && !name.startsWith(`scripts${sep}selection${sep}`)) return 'source';
    // Installed copies can be renamed, including content-addressed runtime
    // files outside dist. Ordinary node_modules scripts are not recorded.
    if (!/\.[cm]?js$/.test(file)) return null;
    try {
      if (sizes.has(statSync(file).size)) return 'candidate';
      if (dist && !sizes.size) return 'bundle';
    } catch { /* Virtual or already removed. */ }
    return null;
  }

  function installWorkerCapture() {
    threads.setEnvironmentData(threadContextKey, { test, dir, root, keysEnv, processId, launchId });
    const BaseWorker = threads.Worker;
    threads.Worker = new Proxy(BaseWorker, {
      construct(target, [entry, options], newTarget) {
        const limit = options?.resourceLimits?.maxOldGenerationSizeMb;
        // An inspector session prevents Node from recovering a worker-local
        // OOM in deliberately heap-starved fixtures. Leave them unrecorded.
        if (limit > 0 && limit <= 64) {
          const worker = Reflect.construct(target, [entry, options], newTarget);
          recordLaunch({ kind: 'thread', processId, threadId: worker.threadId });
          return worker;
        }
        const execArgv = [...(options?.execArgv ?? process.execArgv), workerPreload];
        const worker = Reflect.construct(target, [entry, { ...options, execArgv }], newTarget);
        recordLaunch({ kind: 'thread', processId, threadId: worker.threadId });
        const name = channelName(worker.threadId);
        const terminate = worker.terminate;
        let pending;
        worker.terminate = () => {
          if (worker.threadId === -1) return terminate.call(worker);
          pending ??= new Promise(resolve => {
            // Node's forced thread termination does not run JS exit hooks.
            // Use an out-of-band channel so the worker protocol is unchanged.
            const channel = new threads.BroadcastChannel(name);
            let done = false;
            const close = () => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              channel.close();
              worker.off('exit', close);
              resolve();
            };
            const timer = setTimeout(close, 50);
            worker.once('exit', close);
            channel.onmessage = close;
            channel.postMessage('flush');
          }).then(() => terminate.call(worker));
          return pending;
        };
        return worker;
      },
    });
    syncBuiltinESMExports();
  }

  try {
    const custom = Symbol.for('nodejs.util.promisify.custom');
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']) {
      const base = cp[name];
      const hasArgv = name !== 'exec' && name !== 'execSync';
      cp[name] = wrap(base, hasArgv, name);
      if (base[custom]) Object.defineProperty(cp[name], custom, { value: wrap(base[custom], hasArgv, name) });
    }
    syncBuiltinESMExports();

    function startCollector() {
      if (collect) return;
      const { Session } = require('node:inspector');
      const session = new Session();
      session.connect();
      const post = (method, params, accept = () => {}) => session.post(method, params, (error, value) => {
        try { if (error) note(method, error); else accept(value); }
        catch (error) { note(method, error); }
      });

      let bundleCheckpoint = false;
      session.on('Debugger.scriptParsed', ({ params: { url, hash } }) => {
        try {
          const file = scriptPath(url);
          if (!file) return;
          // An inspector script hash is SHA-256 over its UTF-8 bytes. Cache
          // negative lookups by script version too: tests rebuild at the same path.
          const cacheKey = `${file}:${hash}`;
          let disk = fileCache.get(cacheKey);
          if (disk === undefined) {
            const kind = classify(file, hash);
            disk = kind ? { kind, sha256: kind === 'fixture' ? hash : null } : null;
            fileCache.set(cacheKey, disk);
            if (disk && kind !== 'fixture' && kind !== 'source') {
              try {
                const bytes = readFileSync(file);
                disk.sha256 = createHash('sha256').update(bytes).digest('hex');
                if (kind === 'candidate') {
                  disk = keys.has(`${bytes.length}:${disk.sha256}`) ? { ...disk, kind: 'bundle' } : null;
                  fileCache.set(cacheKey, disk);
                }
              } catch (error) {
                if (kind === 'candidate') { disk = null; fileCache.set(cacheKey, null); }
                if (error.code !== 'ENOENT') note('hash', error);
              }
            }
          }
          if (!disk) return;
          if (!bundleCheckpoint && (disk.kind === 'bundle' || disk.kind === 'fixture')) {
            bundleCheckpoint = true;
            setImmediate(flush).unref();
          }
          scripts.set(cacheKey, { url, ...disk });
        } catch (error) { note('scriptParsed', error); }
      });
      post('Debugger.enable');

      function flush(ended = false) {
        finished ||= ended;
        try {
          const cpu = process.cpuUsage();
          writeFileSync(`${dest}.tmp`, JSON.stringify({
            pid: process.pid, processId, launchId, threadId: threads.threadId, test, argv: process.argv, worker, ended: finished,
            cpuMs: (cpu.user + cpu.system) / 1000, scripts: [...scripts.values()],
          }), { mode: 0o600 });
          renameSync(`${dest}.tmp`, dest);
        } catch (error) { note('flush', error); }
      }

      collect = flush;
      flush();
      setInterval(flush, 2_000).unref();
      process.on('exit', () => flush(true));
      if (threads.isMainThread && process.platform !== 'win32') {
        const kill = process.kill;
        const emit = process.emit;
        const codes = require('node:os').constants.signals;
        const signals = new Set(['SIGINT', 'SIGTERM', 'SIGHUP']);
        const fatal = new Set([...signals, 'SIGKILL'].flatMap(name => [name, codes[name]]));
        // Installing a JS signal listener replaces the native default. A
        // blocked program would then survive TERM/HUP until JS can run. Flush
        // existing handler dispatches and self-signals without adding listeners.
        process.emit = function (name) {
          if (signals.has(name)) flush();
          return Reflect.apply(emit, this, arguments);
        };
        process.kill = function (pid, signal) {
          if (pid === process.pid && fatal.has(signal ?? 'SIGTERM')) flush();
          return Reflect.apply(kill, this, arguments);
        };
      }
      if (threadContext) {
        const channel = new threads.BroadcastChannel(channelName(threads.threadId));
        channel.onmessage = () => { flush(true); channel.postMessage('flushed'); };
        channel.unref();
      }
      installWorkerCapture();
    }

    if (test) startCollector();
    // Refuse to union coverage from different tests if fork isolation changes.
    globalThis[Symbol.for('spider.selection.tag')] = file => {
      if (test && test !== file) throw new Error(`The recorder worker reused for ${test} and ${file}`);
      worker = true;
      process.env.SPIDER_SELECTION_TEST = test = file;
      startCollector();
    };
    globalThis[Symbol.for('spider.selection.finish')] = () => collect?.(true);
  } catch (error) { note('startup', error); }
}
