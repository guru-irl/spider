// SPDX-License-Identifier: MIT
'use strict';

const dir = process.env.SPIDER_TIA_DIR;
if (dir && require('node:worker_threads').isMainThread) {
  const { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } = require('node:fs');
  const { join, relative, resolve, isAbsolute, sep } = require('node:path');
  const { fileURLToPath } = require('node:url');
  const { createHash, randomUUID } = require('node:crypto');
  const { syncBuiltinESMExports } = require('node:module');
  const { Session } = require('node:inspector');
  const cp = require('node:child_process');
  const root = resolve(process.env.SPIDER_TIA_ROOT || join(__dirname, '../..'));
  const keysEnv = process.env.SPIDER_TIA_BUNDLE_KEYS || '';
  const keys = new Set(keysEnv.split(',').filter(Boolean));
  const sizes = new Set([...keys].map(key => Number(key.split(':', 1)[0])));
  const id = `${process.pid}-${randomUUID()}`;
  const dest = join(dir, `${id}.json`);
  const ppid = process.ppid;
  const started = Date.now() - Math.round(process.uptime() * 1000);
  const preload = `--require=${JSON.stringify(__filename)}`;
  const savedOptions = 'SPIDER_TIA_SAVED_NODE_OPTIONS';
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
  let test = process.env.SPIDER_TIA_TEST || null;
  let worker = false;
  let finished = false;

  function note(where, error) {
    try { appendFileSync(join(dir, 'hook-errors.ndjson'), JSON.stringify({ where, code: error?.code }) + '\n'); }
    catch { /* The recorder must not change a child exit code or its streams. */ }
  }

  function withEnv(args, hasArgv) {
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
    env.SPIDER_TIA_DIR = dir;
    env.SPIDER_TIA_ROOT = root;
    env.SPIDER_TIA_BUNDLE_KEYS = keysEnv;
    if (test) {
      env.SPIDER_TIA_TEST = test;
      // A test that starts Vitest is still one outer test's execution.
      delete env.SPIDER_TIA;
    } else delete env.SPIDER_TIA_TEST;
    const updated = { ...options, env };
    if (typeof options === 'function') args.splice(index, 0, updated);
    else args[index] = updated;
    return args;
  }

  function wrap(fn, hasArgv) {
    return function (...args) { return Reflect.apply(fn, this, withEnv(args, hasArgv)); };
  }

  function scriptPath(url) {
    if (url.startsWith('file:')) return fileURLToPath(url);
    return isAbsolute(url) ? url.split(/[?#]/, 1)[0] : null;
  }

  function classify(file) {
    const name = relative(root, file);
    const dist = file.split(sep).includes('dist');
    const dependency = file.split(sep).includes('node_modules');
    if (dist && !dependency) return 'bundle';
    if (!dependency && !isAbsolute(name) && !name.startsWith(`..${sep}`) && !name.startsWith(`.spider${sep}`)) return 'source';
    // Installed copies can be renamed, including content-addressed runtime
    // files outside dist. Ordinary node_modules scripts are not recorded.
    if (!/\.[cm]?js$/.test(file)) return null;
    try {
      if (sizes.has(statSync(file).size)) return 'candidate';
      if (dist && !sizes.size) return 'bundle';
    } catch { /* Virtual or already removed. */ }
    return null;
  }

  try {
    const custom = Symbol.for('nodejs.util.promisify.custom');
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']) {
      const base = cp[name];
      const hasArgv = name !== 'exec' && name !== 'execSync';
      cp[name] = wrap(base, hasArgv);
      if (base[custom]) Object.defineProperty(cp[name], custom, { value: wrap(base[custom], hasArgv) });
    }
    syncBuiltinESMExports();

    const session = new Session();
    session.connect();
    const post = (method, params, accept = () => {}) => session.post(method, params, (error, value) => {
      try { if (error) note(method, error); else accept(value); }
      catch (error) { note(method, error); }
    });

    session.on('Debugger.scriptParsed', ({ params: { url, scriptId } }) => {
      try {
        const file = scriptPath(url);
        if (!file) return;
        let disk = fileCache.get(file);
        if (disk === undefined) {
          const kind = classify(file);
          disk = kind ? { kind, sha256: null } : null;
          fileCache.set(file, disk);
          if (disk) {
            try {
              const bytes = readFileSync(file);
              disk.sha256 = createHash('sha256').update(bytes).digest('hex');
              if (kind === 'candidate') {
                disk = keys.has(`${bytes.length}:${disk.sha256}`) ? { ...disk, kind: 'bundle' } : null;
                fileCache.set(file, disk);
              }
            } catch (error) {
              if (kind === 'candidate') { disk = null; fileCache.set(file, null); }
              if (error.code !== 'ENOENT') note('hash', error);
            }
          }
        }
        if (!disk) return;
        const entry = { url, ...disk, exact: false, loaded: false, wrapperOffset: -1, offsets: new Set() };
        scripts.set(scriptId, entry);
        // Coverage offsets are UTF-16 indices in the actual V8 script, not
        // necessarily the on-disk file (e.g. Vite's transformed TS modules).
        if (disk.sha256) post('Debugger.getScriptSource', { scriptId }, ({ scriptSource }) => {
          entry.exact = createHash('sha256').update(scriptSource).digest('hex') === disk.sha256;
          // Vitest wraps each transformed module in a VM async arrow. V8
          // reports this as a second called function, but it's top-level code.
          const strict = "'use strict';";
          if (scriptSource.startsWith(`${strict}async (__vite_ssr_exports__,__vite_ssr_import_meta__,`)
            || scriptSource.startsWith(`${strict}async (__vite_ssr_exports__,__vite_ssr_import_meta__)`)) entry.wrapperOffset = strict.length;
        });
      } catch (error) { note('scriptParsed', error); }
    });
    post('Profiler.enable');
    post('Profiler.startPreciseCoverage', { callCount: false, detailed: false });
    post('Debugger.enable');

    function flush(ended = false) {
      finished ||= ended;
      try {
        post('Profiler.takePreciseCoverage', {}, ({ result }) => {
          for (const { scriptId, functions } of result) {
            const entry = scripts.get(scriptId);
            if (!entry) continue;
            for (const { functionName, ranges: [range] } of functions) {
              if (!range?.count) continue;
              entry.loaded = true;
              if (functionName || (range.startOffset !== 0 && range.startOffset !== entry.wrapperOffset)) entry.offsets.add(range.startOffset);
            }
          }
          writeFileSync(`${dest}.tmp`, JSON.stringify({
            pid: process.pid, ppid, test, argv: process.argv, worker, ended: finished,
            started, wallMs: Date.now() - started, cpuUsage: process.cpuUsage(),
            scripts: [...scripts.values()].filter(script => script.loaded).map(({ offsets, wrapperOffset: _, ...entry }) => ({ ...entry, offsets: [...offsets] })),
          }), { mode: 0o600 });
          renameSync(`${dest}.tmp`, dest);
        });
      } catch (error) { note('flush', error); }
    }

    // Refuse to union coverage from different tests if fork isolation changes.
    globalThis[Symbol.for('spider.tia.tag')] = file => {
      if (test && test !== file) throw new Error(`TIA worker reused for ${test} and ${file}`);
      worker = true;
      process.env.SPIDER_TIA_TEST = test = file;
      flush();
    };
    globalThis[Symbol.for('spider.tia.finish')] = () => flush(true);
    setInterval(flush, 2_000).unref();
    process.on('exit', () => flush(true));
  } catch (error) { note('startup', error); }
}
