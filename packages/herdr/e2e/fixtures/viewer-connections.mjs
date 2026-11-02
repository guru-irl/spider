// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Loaded only by an owned fixture Node wrapper. Nothing here answers a connection.
import net from 'node:net';
import fs from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';

function activate() {
  const executable = process.argv[1];
  if (!executable?.endsWith('/dist/herdr/viewer.mjs') || !process.argv.includes('--run') || !process.argv.includes('--session')) return;
  if (!process.env.TMPDIR) return;
  const input = process.env.SPIDER_E2E_VIEWER_TRACE_CONFIG ?? join(dirname(process.env.TMPDIR), 'viewer-trace', 'config.json');
  const read = path => {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error('viewer-recorder: expected a regular file');
      return fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
  };
  let config;
  try { config = JSON.parse(read(input)); }
  catch (error) { if (error?.code === 'ENOENT' && !process.env.SPIDER_E2E_VIEWER_TRACE_CONFIG) return; throw error; }
  if (config.version !== 1 || typeof config.root !== 'string' || typeof config.viewer !== 'string' || typeof config.nonce !== 'string') throw new Error('viewer-recorder: invalid configuration');
  const root = fs.realpathSync(config.root);
  if (!process.env.TMPDIR || fs.realpathSync(dirname(process.env.TMPDIR)) !== root || process.env.SPIDER_GLOBAL_ROOT !== join(root, 'g')) throw new Error('viewer-recorder: not an owned fixture environment');
  const inside = path => {
    const suffix = relative(root, path);
    return suffix !== '' && suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix);
  };
  if (!inside(input)) throw new Error('viewer-recorder: configuration escaped the fixture');
  if (fs.realpathSync(executable) !== fs.realpathSync(config.viewer)) return;
  const argument = flag => { const at = process.argv.indexOf(flag); return at < 0 ? undefined : process.argv[at + 1]; };
  const runId = argument('--run'), sessionId = argument('--session');
  if (!runId || !sessionId) throw new Error('viewer-recorder: viewer identity missing');
  const directory = join(root, 'viewer-trace');
  if (fs.realpathSync(directory) !== directory) throw new Error('viewer-recorder: trace directory is not physical');
  const log = join(directory, 'connections.jsonl');
  const record = value => {
    const fd = fs.openSync(log, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, JSON.stringify({ at: Date.now(), pid: process.pid, runId, sessionId, ...value }) + '\n'); }
    finally { fs.closeSync(fd); }
  };
  record({ kind: 'startup' });
  let nextId = 0;
  const live = new Map();
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const id = ++nextId;
    const value = Array.isArray(args[0]) ? args[0][0] : args[0];
    const path = typeof value === 'string' ? value : value?.path;
    const ownedPath = typeof path === 'string' && isAbsolute(path) && inside(path);
    record({ kind: 'connect', id, destination: ownedPath ? path : 'outside-fixture' });
    // Preserve arguments, receiver, result and synchronous errors of the real connect.
    const result = Reflect.apply(original, this, args);
    const entry = { socket: this, id, connected: false, stream: false, ownedPath };
    live.set(id, entry);
    this.once('connect', () => { entry.connected = true; record({ kind: 'connected', id }); });
    this.once('close', hadError => { live.delete(id); record({ kind: 'closed', id, hadError }); });
    let carry = '';
    this.on('data', bytes => {
      if (entry.stream || !entry.ownedPath) return;
      carry += bytes.toString('utf8');
      if (carry.length > 512 * 1024) { carry = ''; return; }
      let end;
      while ((end = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, end); carry = carry.slice(end + 1);
        let frame; try { frame = JSON.parse(line); } catch { continue; }
        record({ kind: 'frame', id, frameKind: frame.kind, frameRunId: frame.runId });
        if (frame.kind === 'snapshot' && frame.runId === runId) {
          entry.stream = true; record({ kind: 'stream', id }); carry = ''; break;
        }
      }
    });
    return result;
  };
  const key = Buffer.from(runId).toString('base64url');
  const cut = join(directory, `cut-${key}.json`), claim = join(directory, `cut-${key}.claimed`);
  let claimed = fs.existsSync(claim);
  const timer = setInterval(() => {
    if (claimed) return;
    const stream = [...live.values()].find(entry => entry.connected && entry.stream && entry.ownedPath);
    if (!stream) return;
    let request;
    try { request = JSON.parse(read(cut)); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (request.version !== 1 || request.runId !== runId || request.nonce !== config.nonce) throw new Error('viewer-recorder: foreign stream-close request');
    let fd;
    try { fd = fs.openSync(claim, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error?.code === 'EEXIST') { claimed = true; return; } throw error; }
    fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); claimed = true;
    record({ kind: 'cut', id: stream.id });
    // The only fault: the explicitly requested real stream is closed once.
    stream.socket.destroy();
  }, 75);
  timer.unref();
  process.once('exit', code => { clearInterval(timer); record({ kind: 'exit', code }); });
}
activate();
