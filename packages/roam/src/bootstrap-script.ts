import machineIdentitySource from "../../db-core/src/roam/machine.ts?raw";
import { selectedRemoteSource } from "./selected-remote-source";

export const BOOTSTRAP_HOME_SCRIPT = `process.stdout.write(JSON.stringify(require("node:fs").realpathSync(require("node:os").homedir())));`;

// Settings values stay on their respective machines. The probe receives only key paths.
export const BOOTSTRAP_SETTINGS_SCRIPT: string = selectedRemoteSource + String.raw`
import { readFileSync as bootstrapSettingsRead } from "node:fs";
import { homedir as bootstrapSettingsHome } from "node:os";
try {
  const raw = bootstrapSettingsRead(0);
  if (raw.length > 2 * 1024 * 1024) throw new Error("request");
  const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "agentDir,home,maximum,paths" ||
      typeof input.home !== "string" || input.home !== bootstrapSettingsHome() ||
      typeof input.agentDir !== "string") throw new Error("request");
  const value = inspectDestinationSettingsDigests({ home: input.home, destinationRoot: input.agentDir, paths: input.paths, maximum: input.maximum });
  process.stdout.write(JSON.stringify({ version: 1, kind: "settings-preview", value }));
} catch (error) {
  const allowed = new Set(["invalid-destination-settings", "unsafe-destination", "invalid-settings-preview"]);
  const code = error instanceof SelectedFilesError && allowed.has(error.code) ? error.code : "settings-preview-failed";
  process.stdout.write(JSON.stringify({ version: 1, kind: "settings-preview", error: code }));
}
`;

// The program receives only selected paths on stdin. Its text never varies by peer.
export const BOOTSTRAP_SCRIPT: string = String.raw`
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

function reply(value) { process.stdout.write(JSON.stringify({ version: 1, kind: 'inventory', value }) + '\n'); }
function fail(error) { process.stdout.write(JSON.stringify({ version: 1, kind: 'inventory', error }) + '\n'); }
function command(file, args, capture = true, maxBuffer = 1024) {
  try { return spawnSync(file, args, { encoding: 'utf8', timeout: 1500, maxBuffer, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'] }); }
  catch { return { status: null }; }
}
function version(text, pattern) {
  if (typeof text !== 'string' || text.length > 1024) return null;
  const match = pattern.exec(text.trim());
  return match ? match[1] : null;
}
function numberFile(file) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch { return null; }
}
function nofile() {
  try {
    const match = /^Max open files\s+(\S+)\s+(\S+)/m.exec(fs.readFileSync('/proc/self/limits', 'utf8'));
    const limit = value => {
      if (value === 'unlimited') return 'unlimited';
      if (!/^\d+$/.test(value)) return null;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    };
    return match ? [limit(match[1]), limit(match[2])] : [null, null];
  } catch { return [null, null]; }
}
function list(dir) {
  try { return fs.readdirSync(dir).filter(name => typeof name === 'string').sort().slice(0, 128); }
  catch { return []; }
}

try {
  const request = fs.readFileSync(0, 'utf8');
  if (typeof request !== 'string' || request.length > 300000) throw new Error('request');
  const input = JSON.parse(request);
  const validPath = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !['checks,cli,core,coreId,coreUnit,globalRoot,pi', 'agentDir,checks,cli,core,coreId,coreUnit,globalRoot,pi'].includes(Object.keys(input).sort().join(',')) || !validPath(input.core) || typeof input.coreId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(input.coreId) || !validPath(input.pi) || !validPath(input.cli) || !validPath(input.globalRoot) || input.agentDir !== undefined && !validPath(input.agentDir) ||
      !(input.coreUnit === null || typeof input.coreUnit === 'string' && input.coreUnit.length <= 255 && /^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.service$/.test(input.coreUnit)) ||
      !Array.isArray(input.checks) || input.checks.length > 32 || input.checks.some(check => !check || typeof check !== 'object' ||
        Array.isArray(check) || Object.keys(check).sort().join(',') !== 'authFile,executable' ||
        !validPath(check.executable) || !(check.authFile === null || validPath(check.authFile)))) {
    throw new Error('request');
  }
  const home = fs.realpathSync(os.homedir());
  if (!path.isAbsolute(home)) throw new Error('home');
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const inside = value => value === home || value.startsWith(home + '/');
  function parents(file) {
    const dir = path.dirname(path.resolve(file));
    if (!inside(dir)) return 'unsafe';
    let cursor = home;
    for (const part of path.relative(home, dir).split('/').filter(Boolean)) {
      cursor = path.join(cursor, part);
      try {
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) return 'unsafe';
      } catch (error) { return error && error.code === 'ENOENT' ? 'missing' : 'unsafe'; }
    }
    return 'ok';
  }
  function homeFile(file, access) {
    try {
      if (!inside(path.resolve(file)) || parents(file) !== 'ok') return null;
      const link = fs.lstatSync(file), actual = fs.realpathSync(file);
      if (!inside(actual) || link.uid !== uid || parents(actual) !== 'ok') return null;
      const stat = fs.statSync(actual);
      if (!stat.isFile() || stat.uid !== uid) return null;
      fs.accessSync(actual, access);
      return actual;
    } catch { return null; }
  }
  function fileStatus(file, credential = false) {
    if (!inside(path.resolve(file))) return null;
    const parent = parents(file);
    if (parent === 'unsafe') return null;
    if (parent === 'missing') return { present: false, readable: false, modeSafe: false };
    try {
      const stat = fs.lstatSync(file);
      let readable = false;
      if (stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid) {
        try { fs.accessSync(file, fs.constants.R_OK); readable = true; } catch {}
      }
      return { present: true, readable, modeSafe: stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && stat.nlink === 1 && (credential ? (stat.mode & 0o7777) === 0o600 : (stat.mode & 0o077) === 0) };
    } catch { return { present: false, readable: false, modeSafe: false }; }
  }
  function roamingStatus(file) {
    const root = path.resolve(file);
    const result = { rootExists: null, rootSafe: false, identityExists: null, machineId: null };
    if (!inside(root)) return result;
    const parent = root === home ? 'ok' : parents(root);
    if (parent === 'unsafe') return result;
    if (parent === 'missing') { result.rootExists = false; result.rootSafe = true; result.identityExists = false; return result; }
    function privateDirectory(stat) {
      return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o7777) === 0o700;
    }
    let stat;
    try { stat = fs.lstatSync(root); }
    catch (error) { if (error && error.code === 'ENOENT') { result.rootExists = false; result.rootSafe = true; result.identityExists = false; } return result; }
    result.rootExists = true;
    if (!privateDirectory(stat)) return result;
    const directory = path.join(root, 'roam');
    try { stat = fs.lstatSync(directory); }
    catch (error) { if (error && error.code === 'ENOENT') { result.rootSafe = true; result.identityExists = false; } return result; }
    if (!privateDirectory(stat)) return result;
    const identity = path.join(directory, 'machine.json');
    try { stat = fs.lstatSync(identity); }
    catch (error) { if (error && error.code === 'ENOENT') { result.rootSafe = true; result.identityExists = false; } return result; }
    result.identityExists = true;
    const safeFile = value => value.isFile() && !value.isSymbolicLink() && value.uid === uid && value.nlink === 1 &&
      (value.mode & 0o7777) === 0o600 && value.size <= 4096;
    if (!safeFile(stat)) return result;
    try {
      const fd = fs.openSync(identity, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd);
        if (!safeFile(opened) || opened.dev !== stat.dev || opened.ino !== stat.ino) return result;
        result.rootSafe = true;
        const bytes = Buffer.alloc(4097), length = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (length <= 4096) try {
          const parsed = JSON.parse(bytes.subarray(0, length).toString('utf8'));
          if (parsed && !Array.isArray(parsed) && typeof parsed.machineId === 'string' &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed.machineId)) result.machineId = parsed.machineId;
        } catch {}
      } finally { fs.closeSync(fd); }
    } catch { result.rootSafe = false; result.machineId = null; }
    return result;
  }
  function fixedFileStatus(file) {
    return fileStatus(file, true) || { present: true, readable: false, modeSafe: false };
  }
  function executableStatus(file) {
    const status = fileStatus(file);
    if (!status) return null;
    let executable = false;
    if (status.present) try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid) { fs.accessSync(file, fs.constants.X_OK); executable = true; }
    } catch {}
    return { ...status, executable };
  }
  function diskFree(file) {
    try {
      let dir = path.dirname(path.resolve(file));
      if (!inside(dir)) return null;
      while (inside(dir)) {
        try {
          const status = parents(path.join(dir, '.probe'));
          if (status === 'unsafe') return null;
          if (status === 'missing') { if (dir === home) break; dir = path.dirname(dir); continue; }
          const actual = fs.realpathSync(dir);
          if (!inside(actual)) return null;
          const stats = fs.statfsSync(actual, { bigint: true });
          const bytes = BigInt(stats.bavail) * BigInt(stats.bsize);
          return bytes >= 0n && bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : null;
        } catch { if (dir === home) break; dir = path.dirname(dir); }
      }
    } catch {}
    return null;
  }
  function coreStatus() {
    const unitDir = path.join(home, '.config/systemd/user');
    const unitDirSafe = parents(path.join(unitDir, '.probe')) === 'ok';
    const transientDir = '/run/user/' + String(uid) + '/systemd/transient';
    const transientDirSafe = ownedDirectory('/run/user/' + String(uid)) && ownedDirectory(path.dirname(transientDir)) && ownedDirectory(transientDir);
    const candidatePattern = /^(?:(?:herdr(?:-core)?|hc(?:-core)?)(?:@[A-Za-z0-9_.-]+)?|hc-serve-[0-9a-f]+)\.service$/;
    const candidates = input.coreUnit ? [input.coreUnit] : [...new Set([...(unitDirSafe ? list(unitDir) : []), ...(transientDirSafe ? list(transientDir) : [])])].filter(name => candidatePattern.test(name));
    let pid = null;
    const status = command(input.core, ['server', 'status', '--json'], true, 64 * 1024);
    if (status.status === 0 && typeof status.stdout === 'string') try {
      const value = JSON.parse(status.stdout);
      if (value && value.core && value.core.id === input.coreId && Number.isSafeInteger(value.pid) && value.pid > 0) pid = value.pid;
    } catch {}
    function inspectUnit(name) {
      const result = command('systemctl', ['--user', 'show', '--property=Transient,FragmentPath,MainPID', name], true, 64 * 1024);
      if (result.status !== 0 || typeof result.stdout !== 'string') return null;
      const properties = Object.create(null);
      for (const line of result.stdout.replace(/\n$/, '').split('\n')) {
        const match = /^(Transient|FragmentPath|MainPID)=(.*)$/.exec(line);
        if (!match || Object.hasOwn(properties, match[1])) throw new Error('bootstrap-probe-failed');
        properties[match[1]] = match[2];
      }
      if (Object.keys(properties).length !== 3 || !['yes', 'no'].includes(properties.Transient) ||
          !/^(?:0|[1-9][0-9]*)$/.test(properties.MainPID) || !Number.isSafeInteger(Number(properties.MainPID))) throw new Error('bootstrap-probe-failed');
      if (properties.Transient === 'no' && properties.MainPID === '0' && properties.FragmentPath === '') return null;
      if (!validPath(properties.FragmentPath)) throw new Error('bootstrap-probe-failed');
      const transient = properties.Transient === 'yes', file = path.join(transient ? transientDir : unitDir, name);
      if (properties.FragmentPath !== file || !(transient ? transientDirSafe : unitDirSafe)) return null;
      let stat;
      try { stat = fs.lstatSync(file); } catch { return null; }
      const owned = stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid;
      if (!stat.isFile() && !stat.isSymbolicLink() || transient && (!owned || pid === null || Number(properties.MainPID) !== pid) ||
          !transient && !input.coreUnit && (pid === null || Number(properties.MainPID) !== pid)) return null;
      return { name, owned, transient };
    }
    const names = candidates.map(inspectUnit).filter(Boolean);
    if (!input.coreUnit && names.length !== 1) throw new Error(names.length ? 'peer-core-unit-ambiguous' : 'peer-core-unit-required');
    const selected = names.length === 1 ? names[0] : null;
    const unit = selected ? selected.name : null, unitOwned = selected ? selected.owned : false, transient = selected ? selected.transient : null;
    let socketExists = false, socketOwned = false;
    function socket(file) {
      try {
        const stat = fs.lstatSync(file);
        if (stat.isSocket() && !stat.isSymbolicLink()) { socketExists = true; if (stat.uid === uid) socketOwned = true; }
      } catch {}
    }
    function ownedDirectory(dir) {
      try { const stat = fs.lstatSync(dir); return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o022) === 0; }
      catch { return false; }
    }
    const runRoot = '/run/user/' + String(uid), runtime = runRoot + '/herdr-core';
    if (ownedDirectory(runRoot) && ownedDirectory(runtime)) {
      for (const name of list(runtime)) if (/^[A-Za-z0-9_.-]+\.sock$/.test(name)) socket(path.join(runtime, name));
    }
    const state = path.join(home, '.local/state/herdr-core');
    if (parents(path.join(state, '.probe')) === 'ok') for (const name of list(state)) if (/^[A-Za-z0-9_.-]+$/.test(name)) {
      const dir = path.join(state, name);
      if (parents(path.join(dir, '.probe')) === 'ok') for (const file of list(dir)) if (/^[A-Za-z0-9_.-]+\.sock$/.test(file)) socket(path.join(dir, file));
    }
    return { unit, unitExists: names.length > 0, unitOwned, transient, socketExists, socketOwned };
  }
  const piFile = homeFile(input.pi, fs.constants.X_OK);
  const piResult = piFile ? command(input.pi, ['--version']) : { status: null };
  const piVersion = piResult.status === 0 ? version(piResult.stdout, /^v?(\d+\.\d+\.\d+)(?:[-+][\w.-]+)?$/) : null;
  const cliFile = homeFile(input.cli, fs.constants.R_OK);
  let installed = false, spiderVersion = null, nativeModuleReady = false;
  if (cliFile) try {
    const manifest = path.resolve(cliFile, '../../../package.json');
    const actual = homeFile(manifest, fs.constants.R_OK);
    if (actual && fs.statSync(actual).size <= 65536) {
      const info = JSON.parse(fs.readFileSync(actual, 'utf8'));
      if (info && info.name === '@guru-irl/spider' && typeof info.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(info.version)) {
        installed = true; spiderVersion = info.version;
        try {
          const nativeRequire = createRequire(cliFile);
          if (homeFile(nativeRequire.resolve('better-sqlite3'), fs.constants.R_OK)) {
            const Database = nativeRequire('better-sqlite3'); const db = new Database(':memory:'); db.close(); nativeModuleReady = true;
          }
        } catch {}
      }
    }
  } catch {}
  const git = command('git', ['--version']);
  const gitVersion = git.status === 0 ? version(git.stdout, /^git version\s+(\d+\.\d+(?:\.\d+)?)(?:[.\w+-]*)?$/) : null;
  const systemd = command('systemctl', ['--user', 'is-system-running']);
  const systemdUser = systemd.status === 0 || typeof systemd.stdout === 'string' && /^(running|degraded|starting)$/.test(systemd.stdout.trim());
  const lingering = command('loginctl', ['show-user', String(uid), '--property=Linger', '--value']);
  const lingerText = lingering.status === 0 && typeof lingering.stdout === 'string' ? lingering.stdout.trim() : '';
  const linger = lingerText === 'yes' ? true : lingerText === 'no' ? false : null;
  const gh = command('gh', ['--version'], false).status === 0;
  const ghAuth = gh ? command('gh', ['auth', 'status'], false) : { status: null };
  const ghSignedIn = ghAuth.status === 0 ? true : typeof ghAuth.status === 'number' ? false : null;
  const name = command('git', ['config', '--get', 'user.name'], false);
  const email = command('git', ['config', '--get', 'user.email'], false);
  const [softNofile, hardNofile] = nofile();
  reply({
    platform: os.platform(), kernel: os.release(), nodeVersion: process.versions.node, nodeAbi: process.versions.modules,
    gitVersion, roaming: roamingStatus(input.globalRoot), systemdUser, linger, core: coreStatus(), pi: piFile ? input.pi : null, piVersion,
    softNofile, hardNofile,
    inotifyInstances: numberFile('/proc/sys/fs/inotify/max_user_instances'),
    inotifyWatches: numberFile('/proc/sys/fs/inotify/max_user_watches'),
    diskFreeBytes: diskFree(input.cli),
    spider: { installed, version: spiderVersion, nativeModuleReady },
    cli: { gh, gitIdentity: name.status === 0 && email.status === 0,
      configured: input.checks.map(check => ({ executable: executableStatus(check.executable), auth: check.authFile === null ? null : fileStatus(check.authFile, true) })) },
    auth: { pi: fixedFileStatus(path.join(input.agentDir ?? path.join(home, '.pi/agent'), 'auth.json')), gh: fixedFileStatus(path.join(home, '.config/gh/hosts.yml')), ghSignedIn },
  });
} catch (error) { fail(error && ['peer-core-unit-required', 'peer-core-unit-ambiguous'].includes(error.message) ? error.message : 'bootstrap-probe-failed'); }
`;

// The reply contains only the directory classification, never environment values.
export const BOOTSTRAP_AGENT_DIRECTORY_SCRIPT: string = String.raw`
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { spawnSync } = require('node:child_process');
const reply = value => process.stdout.write(JSON.stringify({ version: 1, kind: 'agent-directory', value }) + '\n');
try {
  const request = fs.readFileSync(0, 'utf8');
  if (request.length > 16384) throw new Error('request');
  const input = JSON.parse(request);
  if (!input || typeof input !== 'object' || Array.isArray(input) || !['home', 'home,agentDir'].includes(Object.keys(input).join(',')) ||
      typeof input.home !== 'string' || input.home.length > 4096 || !path.isAbsolute(input.home) ||
      path.resolve(input.home) !== input.home || /[\x00-\x1f\x7f]/.test(input.home)) throw new Error('request');
  const home = fs.realpathSync(os.homedir()), expected = input.agentDir ?? path.join(home, '.pi/agent');
  if (input.agentDir !== undefined) {
    if (input.home !== home || typeof expected !== 'string' || !path.isAbsolute(expected) || path.normalize(expected) !== expected || !expected.startsWith(home + '/') || /[\x00-\x1f\x7f]/.test(expected)) throw new Error('request');
  }
  function isDefault(value, cwd) {
    if (!value) return expected === path.join(home, '.pi/agent');
    if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return false;
    try {
      let expanded = value;
      if (value === '~') expanded = home;
      else if (value.startsWith('~/')) expanded = path.join(home, value.slice(2));
      else if (value.startsWith('file://')) expanded = fileURLToPath(value);
      return path.resolve(cwd, expanded) === expected;
    } catch { return false; }
  }
  function configuredDirectorySafe() {
    if (input.agentDir === undefined) return true;
    try {
      let cursor = home;
      for (const part of path.relative(home, expected).split(path.sep)) {
        cursor = path.join(cursor, part);
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) return false;
      }
      return fs.realpathSync(expected) === expected;
    } catch { return false; }
  }
  if (input.home !== home || !configuredDirectorySafe() || !isDefault(process.env.PI_CODING_AGENT_DIR, process.cwd())) reply('custom');
  else {
    const manager = spawnSync('systemctl', ['--user', 'show-environment'],
      { encoding: 'utf8', timeout: 1500, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'ignore'] });
    if (manager.status !== 0 || typeof manager.stdout !== 'string') reply('unknown');
    else {
      const entries = manager.stdout.split('\n').filter(line => line.startsWith('PI_CODING_AGENT_DIR='));
      if (entries.length > 1) reply('unknown');
      else {
        const value = entries.length ? entries[0].slice('PI_CODING_AGENT_DIR='.length) : '';
        // Configured launches set their own directory without a manager override.
        reply((input.agentDir !== undefined && !value) || isDefault(value, home) ? 'default' : 'custom');
      }
    }
  }
} catch { process.stdout.write(JSON.stringify({ version: 1, kind: 'agent-directory', error: 'agent-directory-probe-failed' }) + '\n'); }
`;

// Execute the same identity publication code used by local admission. The appended
// program accepts only the enrollment request on stdin, never executable input.
export const BOOTSTRAP_IDENTITY_SCRIPT: string = machineIdentitySource + String.raw`
import { readSync } from 'node:fs';
import { homedir as bootstrapHome } from 'node:os';
import { isAbsolute as bootstrapAbsolute, relative as bootstrapRelative, resolve as bootstrapResolve, sep as bootstrapSep } from 'node:path';
import { spawnSync as bootstrapSpawn } from 'node:child_process';

const bootstrapReply = value => process.stdout.write(JSON.stringify({ version: 1, kind: 'identity', ...value }) + '\n');
try {
  const request = Buffer.alloc(16385); let count = 0;
  while (count < request.length) { const size = readSync(0, request, count, request.length - count, null); if (!size) break; count += size; }
  if (count > 16384) throw new Error('invalid-request');
  const input = JSON.parse(request.subarray(0, count).toString('utf8'));
  const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'core,coreId,globalRoot,machineId,operationId' ||
      typeof input.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.operationId) ||
      !valid(input.core) || !bootstrapAbsolute(input.core) || !valid(input.coreId) || !valid(input.globalRoot) ||
      !bootstrapAbsolute(input.globalRoot) || bootstrapResolve(input.globalRoot) !== input.globalRoot ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.machineId)) throw new Error('invalid-request');
  const result = bootstrapSpawn(input.core, ['server', 'status', '--json'],
    { encoding: 'utf8', timeout: 1500, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status !== 0 || typeof result.stdout !== 'string') throw new Error('core-unavailable');
  let core;
  try { core = JSON.parse(result.stdout).core.id; } catch { throw new Error('core-unavailable'); }
  if (core !== input.coreId) throw new Error('core-changed');
  const home = realpathSync(bootstrapHome()), root = input.globalRoot, uid = process.getuid();
  if (root !== home && !root.startsWith(home + bootstrapSep)) throw new Error('unsafe-identity');
  let cursor = home, missing = false;
  for (const part of bootstrapRelative(home, root).split(bootstrapSep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (missing) continue;
    try {
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0 ||
          cursor === root && (stat.mode & 0o7777) !== 0o700) throw new Error('unsafe-identity');
    } catch (error) { if (error && error.code === 'ENOENT') missing = true; else throw error; }
  }
  if (!missing) {
    const directory = join(root, 'roam'), file = join(directory, 'machine.json');
    try {
      const dir = lstatSync(directory);
      if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== uid || (dir.mode & 0o7777) !== 0o700) throw new Error('unsafe-identity');
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || stat.nlink !== 1 ||
            (stat.mode & 0o7777) !== 0o600 || stat.size > 4096) throw new Error('unsafe-identity');
      } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  }
  const machineId = claimMachineIdentity(root, input.machineId);
  bootstrapReply({ coreId: input.coreId, machineId });
} catch (error) {
  const named = error && error.code === 'machine-mismatch' ? 'machine-mismatch' : error && error.message;
  const allowed = ['invalid-request', 'core-unavailable', 'core-changed', 'unsafe-identity', 'machine-mismatch'];
  bootstrapReply({ error: allowed.includes(named) ? named : 'identity-bootstrap-failed' });
}
`;
