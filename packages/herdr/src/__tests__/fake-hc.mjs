#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync, appendFileSync, watchFile, unwatchFile, writeFileSync, mkdirSync, existsSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.env.HERDR_FAKE_ROOT;
if (!root) throw new Error('HERDR_FAKE_ROOT required');
// The real core never exposes a half-written state to a concurrent reader. Replace the file in one step, as the daemon's save does.
const saveCore = value => { const next = `${root}/core.json.${process.pid}.next`; writeFileSync(next, JSON.stringify(value)); renameSync(next, `${root}/core.json`); };
async function withDimensions(terminal) {
  const appPath = `${root}/app.json`;
  let bounds;
  if (existsSync(appPath)) {
    const { paneTree, paneBounds } = await import('../../e2e/harness/pane-geometry.ts');
    const app = JSON.parse(readFileSync(appPath, 'utf8'));
    for (const tab of (app.spaces ?? []).flatMap(space => space.tabs)) {
      const pane = tab.terminals.find(row => row.terminal === terminal.address)?.pane;
      if (pane) bounds = paneBounds(tab.geometry ?? paneTree(tab.terminals.map(row => row.pane))).find(row => row.id === pane);
    }
  }
  return { cols: Math.floor(320 * (bounds?.width ?? 1)) - (bounds && bounds.width < 1 ? 1 : 0), rows: Math.floor(80 * (bounds?.height ?? 1)) - (bounds && bounds.height < 1 ? 2 : 0), ...terminal };
}
const config = JSON.parse(readFileSync(`${root}/core.json`, 'utf8'));
function roamMachine(on) {
  const exact = config.machines.filter(machine => machine.name === on);
  if (exact.length) return exact.length === 1;
  const key = value => String(value ?? '').toLowerCase().replace(/\.$/, '');
  const matches = config.machines.filter(machine => {
    const target = machine.via && (typeof machine.target !== 'string' || !/^(?:[\w.-]+@)?[\w.-]+$/.test(machine.target)) ? '' : machine.target;
    return [machine.name, machine.host, target?.replace(/^.*@/, '')].some(alias => alias && key(alias) === key(on));
  });
  return matches.length === 1;
}
const roamFile = (on, path) => `${root}/roam-files/${Buffer.from(on).toString('hex')}/${Buffer.from(path).toString('hex')}`;
function restartCore(on, command, when) {
  const restart = config.roamFixture?.restart;
  if (!restart || restart.command !== command || restart.when !== when) return;
  if (restart.target === 'local') config.coreId = restart.nextCore;
  else if (restart.remove) config.machines = config.machines.filter(machine => machine.name !== on);
  else config.machines.find(machine => machine.name === on).id = restart.nextCore;
  delete config.roamFixture.restart; saveCore(config);
}
const argv = process.argv.slice(2);
appendFileSync(`${root}/calls.jsonl`, JSON.stringify({ argv, pid: process.pid, parentPid: process.ppid, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('HC_') || ['PI_SUBAGENT_CHILD', 'PI_SUBAGENT_RUN_ID'].includes(k))) }) + '\n');
function nameArgument(args) {
  const end = args.indexOf('--'), flags = end < 0 ? args : args.slice(0, end);
  const at = flags.indexOf('--name'); return at >= 0 ? flags[at + 1] : flags.find(arg => arg.startsWith('--name='))?.slice(7);
}
function debugName(name) {
  return '"' + Array.from(name, char => {
    if (char === '\n') return '\\n'; if (char === '\r') return '\\r'; if (char === '\t') return '\\t'; if (char === '\0') return '\\0';
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(char)) return `\\u{${char.codePointAt(0).toString(16)}}`;
    return JSON.stringify(char).slice(1, -1);
  }).join('') + '"';
}
const suppliedName = argv[0] === 'run' ? nameArgument(argv) : undefined;
if (suppliedName !== undefined && (!/^[a-z0-9][a-z0-9_.-]{0,31}$/.test(suppliedName) || /^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/.test(suppliedName))) {
  console.error(JSON.stringify({ error: { hint: 'see `hc schema`', kind: 'invalid_params', message: `bad name ${debugName(suppliedName)}: use 1-32 of a-z 0-9 - _ . starting with a letter or digit, not shaped like an id (t7)` } })); process.exit(6);
}
if (process.env.HERDR_FAKE_DAEMON === '1') { await daemonMode(); } else {
if (config.failure) { process.stderr.write(JSON.stringify({ error: config.failure })); process.exit(config.failureExitCode ?? 7); }
if (config.rawReplyBase64 !== undefined) {
  process.stdout.write(Buffer.from(config.rawReplyBase64, 'base64'));
} else if (config.reply !== undefined) {
  const bytes = Buffer.from(config.reply);
  if (config.split) { process.stdout.write(bytes.subarray(0, config.split)); setTimeout(() => process.stdout.end(bytes.subarray(config.split)), 5); }
  else process.stdout.write(bytes);
} else if (argv[0] === 'exec' && config.roamFixture) {
  const end = argv.indexOf('--');
  const flags = end < 0 ? argv : argv.slice(0, end);
  const on = flags.includes('--on') ? flags[flags.indexOf('--on') + 1] : flags.find(arg => arg.startsWith('--on='))?.slice(5);
  if (!on || !roamMachine(on)) {
    console.error(JSON.stringify({ error: { kind: 'machine_not_found', message: 'No such machine' } })); process.exit(3);
  }
  const restart = config.roamFixture.restart?.command === 'exec' ? config.roamFixture.restart : null;
  restartCore(on, 'exec', 'before');
  const command = end < 0 ? [] : argv.slice(end + 1);
  let output;
  if (command[0] === 'cat') output = readFileSync(roamFile(on, command.at(-1)));
  else if (config.roamFixture.execEchoStdin) {
    const chunks = [];
    if (flags.includes('--stdin')) for await (const chunk of process.stdin) chunks.push(chunk);
    output = Buffer.concat(chunks);
  } else output = Buffer.from(config.roamFixture.execReplyBase64 ?? '', 'base64');
  if (restart?.when === 'during') { process.stdout.write(output.subarray(0, 1)); restartCore(on, 'exec', 'during'); process.stdout.write(output.subarray(1)); }
  else process.stdout.write(output);
  if (command[0] !== 'cat' && config.roamFixture.execExitCode) process.exitCode = config.roamFixture.execExitCode;
} else if (argv[0] === 'server' && argv[1] === 'status') {
  console.log(JSON.stringify({ core: { id: config.coreId, name: 'fixture' }, version: '0.1.16', pid: process.pid }));
} else if (argv[0] === 'get') {
  const terminal = config.terminals.find(t => t.address === argv[1]);
  if (!terminal) { console.error(JSON.stringify({ error: { kind: 'not_found', message: 'No such terminal' } })); process.exit(3); }
  console.log(JSON.stringify(await withDimensions(terminal)));
} else if (argv[0] === 'machine' && argv[1] === 'ls') {
  console.log(JSON.stringify({ machines: config.machines }));
} else if (argv[0] === 'events') {
  let offset = readFileSync(`${root}/events.jsonl`).length;
  watchFile(`${root}/events.jsonl`, { interval: 10 }, () => {
    const bytes = readFileSync(`${root}/events.jsonl`);
    process.stdout.write(bytes.subarray(offset)); offset = bytes.length;
  });
  console.log(JSON.stringify({ channel: null, seq: config.seq || 0, terminals: config.terminals }));
  process.on('SIGTERM', () => { unwatchFile(`${root}/events.jsonl`); process.exit(0); });
 } else if (argv[0] === 'run') {
  const end = argv.indexOf('--'), flags = end < 0 ? argv : argv.slice(0, end);
  const on = flags.includes('--on') ? flags[flags.indexOf('--on') + 1] : flags.find(arg => arg.startsWith('--on='))?.slice(5) ?? null;
  if (config.roamFixture && (!on || !roamMachine(on))) {
    console.error(JSON.stringify({ error: { kind: 'machine_not_found', message: 'No such machine' } })); process.exit(3);
  }
  restartCore(on, 'run', 'before');
  const prefix = on ? on + '/' : '';
  let number = config.nextTerminal ?? 2;
  while (config.terminals.some(t => t.address === `${prefix}t${number}`)) number++;
  const address = `${prefix}t${number}`; config.nextTerminal = number + 1;
  const labels = {};
  flags.forEach((value, i) => { if (value === '--label') { const entry = flags[i + 1], at = entry.indexOf('='); labels[entry.slice(0, at)] = entry.slice(at + 1); } });
  const t = { address, name: suppliedName ?? null, parent: flags.includes('--no-parent') ? null : process.env.HC_TERMINAL_ID || null, labels, state: 'live', status: null, exit_code: null, reason: null, signal: null, finished_ms: null };
  config.terminals.push(t); restartCore(on, 'run', 'during'); config.seq = (config.seq || 0) + 1; saveCore(config);
  appendFileSync(`${root}/events.jsonl`, JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'created', seq: config.seq, terminal: t.address, data: t } }) + '\n');
  console.log(JSON.stringify({ address, state: 'live', agent: argv[argv.indexOf('--') + 1] || 'node', cwd: root, parent: t.parent, turn: 0 }));
} else if (argv[0] === 'kill' || argv[0] === 'rm') {
  const t = config.terminals.find(t => t.address === argv[1]);
  if (!t) { console.error(JSON.stringify({ error: { kind: 'not_found', message: 'No such terminal' } })); process.exit(3); }
  if (argv[0] === 'kill') { t.state = 'finished'; t.exit_code = null; t.signal = 1; t.reason = 'killed'; t.finished_ms = Date.now(); }
  else config.terminals = config.terminals.filter(row => row !== t);
  saveCore(config); console.log('{}');
} else if (argv[0] === 'label' || argv[0] === 'keep') {
  const t = config.terminals.find(t => t.address === argv[1]);
  if (!t) { console.error(JSON.stringify({ error: { kind: 'not_found', message: 'No such terminal' } })); process.exit(3); }
  let data;
  if (argv[0] === 'label') {
    for (const kv of argv.slice(2).filter(v => !v.startsWith('--'))) { const at = kv.indexOf('='); if (at < 1) throw new Error('Invalid fixture label'); const key = kv.slice(0, at), value = kv.slice(at + 1); if (value) t.labels[key] = value; else delete t.labels[key]; }
    data = { labels: t.labels };
  } else {
    if (t.state !== 'live') { console.error(JSON.stringify({ error: { kind: 'invalid_params', message: 'Only live terminals can be kept' } })); process.exit(2); }
    t.keep = !argv.includes('--off'); data = { keep: t.keep };
  }
  config.seq = (config.seq || 0) + 1; saveCore(config);
  appendFileSync(`${root}/events.jsonl`, JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: argv[0] === 'label' ? 'labels' : 'keep', seq: config.seq, terminal: t.address, data } }) + '\n');
  console.log(JSON.stringify(t));
} else if (argv[0] === 'file' && config.roamFixture) {
  const on = argv.includes('--on') ? argv[argv.indexOf('--on') + 1] : argv.find(arg => arg.startsWith('--on='))?.slice(5);
  if (!on || !roamMachine(on) || argv[1] !== 'write') {
    console.error(JSON.stringify({ error: { kind: 'machine_not_found', message: 'No such machine or operation' } })); process.exit(3);
  }
  restartCore(on, 'file', 'before');
  if (config.roamFixture.fileEarlySuccess) { console.log('{}'); process.exit(0); }
  if (config.roamFixture.fileFailure) {
    process.stderr.write(JSON.stringify({ error: config.roamFixture.fileFailure })); process.exit(7);
  }
  const file = roamFile(on, argv.at(-1));
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.concat(chunks));
  restartCore(on, 'file', 'during'); console.log('{}');
} else if (argv[0] === 'file') {
  const machine = argv[argv.indexOf('--on') + 1];
  const path = argv.at(-1);
  const file = `${root}/files/${machine}/${Buffer.from(path).toString('hex')}`;
  if (argv[1] === 'write') {
    mkdirSync(`${root}/files/${machine}`, { recursive: true });
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    writeFileSync(file, Buffer.concat(chunks)); console.log('{}');
  } else console.log(JSON.stringify({ text: readFileSync(file, 'utf8'), first: 1, last: 1, lines: 1 }));
} else {
  console.error(JSON.stringify({ error: { kind: 'invalid_params', message: 'Unsupported fixture operation' } })); process.exit(2);
}

}

function attachTerminalIndex(args) {
  let last = -1;
  let positionalOnly = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!positionalOnly && arg === '--') { positionalOnly = true; continue; }
    if (!positionalOnly && (arg === '--history' || arg === '--on')) { i++; continue; }
    if (!positionalOnly && arg.startsWith('-')) continue;
    last = i;
  }
  return last;
}

async function daemonMode() {
  const socketPath = process.env.HC_TERMINAL_SOCKET || `${process.env.XDG_STATE_HOME}/herdr-core/${process.env.HC_SESSION}/${process.env.HC_SESSION}.sock`;
  if (Buffer.byteLength(socketPath) > 103 || !socketPath.startsWith((process.env.HERDR_TEST_ROOT || root) + '/')) throw new Error('Unfenced fake socket');
  const scenarioPath = process.env.HERDR_FAKE_SCENARIO || `${root}/scenario.json`;
  const scenario = () => existsSync(scenarioPath) ? JSON.parse(readFileSync(scenarioPath, 'utf8')) : {};
  const request = (path, body, output) => new Promise((resolve, reject) => {
    const socket = connect(path); let pending = ''; const decoder = new StringDecoder('utf8');
    socket.on('error', reject); socket.on('connect', () => socket.write(JSON.stringify(body) + '\n'));
    socket.on('data', bytes => {
      if (output) { output(bytes); return; }
      pending += decoder.write(bytes); const end = pending.indexOf('\n');
      if (end >= 0) { const reply = JSON.parse(pending.slice(0, end)); socket.end(); resolve(reply); }
    });
    socket.on('end', () => { if (output) resolve(null); });
  });
  const listening = () => new Promise(resolve => {
    const socket = connect(socketPath);
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(100, () => done(false));
    socket.once('connect', () => done(true)); socket.once('error', () => done(false));
  });
  if (argv[0] !== '--daemon') {
    let input = Buffer.alloc(0);
    if (argv[0] !== 'events' && argv[0] !== 'attach') { const chunks = []; for await (const c of process.stdin) chunks.push(c); input = Buffer.concat(chunks); }
    if (argv[0] === 'server' && argv[1] === 'start') {
      const deadline = Date.now() + 5000; let spawned = false;
      // bind creates the inode before listen can accept a connection. An old
      // stopping daemon can also leave its inode here until shutdown completes.
      while (!await listening() && Date.now() < deadline) {
        if (!existsSync(socketPath) && !spawned) {
          const log = openSync(`${root}/daemon.log`, 'a');
          const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--daemon'], { env: process.env, stdio: ['ignore', log, log], detached: true }); child.unref(); closeSync(log);
          spawned = true;
        }
        await delay(10);
      }
    }
    try {
      if (argv[0] === 'events' || argv[0] === 'attach') {
        await request(socketPath, { argv, env: process.env }, bytes => process.stdout.write(bytes));
      } else {
        const reply = await request(socketPath, { argv, env: process.env, input: input.toString('base64') });
        if (reply.stderr) process.stderr.write(typeof reply.stderr === 'string' ? reply.stderr : JSON.stringify(reply.stderr));
        if (reply.exitCode) process.exitCode = reply.exitCode;
        else if (typeof reply.bytesBase64 === 'string') process.stdout.write(Buffer.from(reply.bytesBase64, 'base64'));
        else console.log(typeof reply.raw === 'string' ? reply.raw : JSON.stringify(reply.result));
      }
    } catch (e) { console.error(JSON.stringify({ error: { kind: 'server_stopped', message: e.message } })); process.exitCode = 3; }
    return;
  }
  writeFileSync(`${root}/daemon.pid`, String(process.pid));
  const ownerPid = Number(process.env.HERDR_TEST_OWNER_PID);
  const watchdog = setInterval(() => {
    let ownerAlive = Number.isSafeInteger(ownerPid) && ownerPid > 0;
    if (ownerAlive) { try { process.kill(ownerPid, 0); } catch { ownerAlive = false; } }
    if (!ownerAlive || !existsSync(process.env.HERDR_TEST_ROOT || root)) process.kill(process.pid, 'SIGTERM');
  }, 1000);
  const state = JSON.parse(readFileSync(`${root}/core.json`, 'utf8')); state.seq ??= 0; state.next ??= 1;
  const subscribers = new Set(); const attaches = new Map(); const payloads = new Map(); const rulesUsed = new Map(); const remoteChannels = new Map();
  const save = () => { writeFileSync(`${root}/core.next`, JSON.stringify(state)); renameSync(`${root}/core.next`, `${root}/core.json`); };
  const apply = record => {
    const event = record.method === 'event' ? record.params : record.method === 'missed' ? { ...record.params, type: 'missed' } : record;
    if (Array.isArray(event.terminals)) state.terminals = event.terminals;
    if (event.type === 'created' || event.type === 'restarted') {
      state.terminals = state.terminals.filter(t => t.address !== event.terminal); state.terminals.push(event.data);
    } else if (event.type === 'finished') {
      const t = state.terminals.find(t => t.address === event.terminal); if (t) Object.assign(t, event.data, { state: 'finished' });
    } else if (event.type === 'removed') state.terminals = state.terminals.filter(t => t.address !== event.terminal);
    else if (event.type === 'status') { const t = state.terminals.find(t => t.address === event.terminal); if (t) t.status = event.data.status; }
    state.seq = Math.max(state.seq, event.seq || 0); save();
    const line = JSON.stringify(record) + '\n'; for (const s of subscribers) s.write(line);
  };
  const emit = (type, terminal, data) => apply({ jsonrpc: '2.0', method: 'event', params: { type, seq: ++state.seq, terminal, data } });
  let eventOffset = existsSync(`${root}/events.jsonl`) ? readFileSync(`${root}/events.jsonl`).length : 0;
  watchFile(`${root}/events.jsonl`, { interval: 10 }, () => {
    const bytes = readFileSync(`${root}/events.jsonl`); const newText = bytes.subarray(eventOffset).toString('utf8');
    const end = newText.lastIndexOf('\n'); if (end < 0) return;
    eventOffset += Buffer.byteLength(newText.slice(0, end + 1));
    for (const line of newText.slice(0, end).split('\n').filter(Boolean)) apply(JSON.parse(line));
  });
  function mirror(machine) {
    const channel = connect(machine.socket); let pending = ''; const decoder = new StringDecoder('utf8'); remoteChannels.set(machine.name, channel);
    channel.on('error', () => {}); channel.on('connect', () => channel.write(JSON.stringify({ argv: ['events', '--json'] }) + '\n'));
    channel.on('data', bytes => {
      pending += decoder.write(bytes); let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const raw = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
        const qualify = t => ({ ...t, address: `${machine.name}/${t.address}`, parent: t.parent?.startsWith(state.coreId + '/') ? t.parent.slice(state.coreId.length + 1) : t.parent });
        if (raw.terminals) { for (const t of raw.terminals) emit('created', `${machine.name}/${t.address}`, qualify(t)); }
        else if (raw.params?.terminal) {
          const e = raw.params; emit(e.type, `${machine.name}/${e.terminal}`, e.type === 'created' || e.type === 'restarted' ? qualify(e.data) : e.data);
        }
      }
    });
  }
  let scenarioRevision;
  const reply = (s, result) => s.end(JSON.stringify({ result }) + '\n');
  const server = createServer(s => {
    let pending = ''; const decoder = new StringDecoder('utf8'); s.on('error', () => {});
    s.on('data', async bytes => {
      pending += decoder.write(bytes); const end = pending.indexOf('\n'); if (end < 0) return;
      s.removeAllListeners('data');
      const message = JSON.parse(pending.slice(0, end)); const args = message.argv, env = message.env || {};
      const delimiter = args.indexOf('--'), flags = delimiter < 0 ? args : args.slice(0, delimiter);
      const option = key => flags.includes(key) ? flags[flags.indexOf(key) + 1] : flags.find(arg => arg.startsWith(key + '='))?.slice(key.length + 1);
      try {
        const script = scenario();
        const revision = script.fixtureRevision || JSON.stringify(script.steps || []);
        if (revision !== scenarioRevision) { rulesUsed.clear(); scenarioRevision = revision; }
        const step = (script.steps || []).find((rule, index) => {
          if (rule.once && rulesUsed.has(index)) return false;
          const prefix = rule.argvPrefix || [];
          return prefix.every((v, i) => args[i] === v) && (rule.argvIncludes || []).every(v => args.includes(v));
        });
        if (step) {
          const index = script.steps.indexOf(step); rulesUsed.set(index, true);
          for (const e of step.beforeReply || []) apply(e);
          for (const [p, bytes] of Object.entries(step.writes || {})) { if (!p.startsWith(root + '/')) throw new Error('Unfenced scenario write'); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, bytes); }
          if (step.delayMs) await delay(step.delayMs);
          if ('reply' in step || step.stderr || step.exitCode) { s.end(JSON.stringify({ result: step.reply, stderr: step.stderr, exitCode: step.exitCode }) + '\n'); return; }
        }
        const terminalIndex = args[0] === 'attach' ? attachTerminalIndex(args) : 1;
        const terminal = args[terminalIndex];
        const on = option('--on') || (terminal?.includes('/') && !terminal.startsWith('/') ? terminal.split('/')[0] : undefined);
        if (on && ['run', 'get', 'kill', 'rm', 'read', 'attach', 'file', 'exec'].includes(args[0])) {
          const machine = state.machines.find(m => m.name === on); if (!machine) throw new Error('Unknown fake machine');
          const remoteArgs = [...args]; const index = flags.indexOf('--on');
          if (index >= 0) remoteArgs.splice(index, 2);
          else { const equals = flags.findIndex(arg => arg.startsWith('--on=')); if (equals >= 0) remoteArgs.splice(equals, 1); }
          const remoteTerminalIndex = args[0] === 'attach' ? attachTerminalIndex(remoteArgs) : 1;
          if (remoteArgs[remoteTerminalIndex]?.startsWith(on + '/')) remoteArgs[remoteTerminalIndex] = remoteArgs[remoteTerminalIndex].slice(on.length + 1);
          const remoteEnv = { ...env, HC_TERMINAL_ID: env.HC_TERMINAL_ID ? `${state.coreId}/${env.HC_TERMINAL_ID}` : undefined };
          if (args[0] === 'attach') { await request(machine.socket, { argv: remoteArgs, env: remoteEnv }, bytes => s.write(bytes)); s.end(); return; }
          const result = await request(machine.socket, { ...message, argv: remoteArgs, env: remoteEnv, remoteRoute: true });
          if (result.result?.address) result.result.address = `${on}/${result.result.address}`;
          if (result.result?.parent?.startsWith(state.coreId + '/')) result.result.parent = result.result.parent.slice(state.coreId.length + 1);
          s.end(JSON.stringify(result) + '\n'); return;
        }
        if (args[0] === 'server') {
          if (args[1] === 'stop') {
            reply(s, {}); unwatchFile(`${root}/events.jsonl`); for (const c of remoteChannels.values()) c.destroy();
            for (const child of payloads.values()) { try { process.kill(-child.pid, 'SIGHUP'); } catch {} }
            for (const sub of subscribers) sub.end(); server.close(() => { try { unlinkSync(socketPath); } catch {} process.exit(0); });
          } else reply(s, { core: { id: state.coreId, name: 'fixture' }, version: '0.1.16', pid: process.pid, holders: [] });
        } else if (args[0] === 'events') {
          subscribers.add(s); s.on('close', () => subscribers.delete(s)); s.write(JSON.stringify({ channel: null, seq: state.seq, terminals: state.terminals }) + '\n');
          for (const queued of script.events || []) setTimeout(() => { if (!s.destroyed) apply(queued.record || queued); }, queued.delayMs || 0);
        } else if (args[0] === 'ls') reply(s, { hidden_finished: 0, terminals: state.terminals });
        else if (args[0] === 'machine') {
          if (args[1] === 'ls') reply(s, { machines: state.machines.map(({ socket, ...m }) => m) });
          else if (args[1] === 'add') {
            const socket = script.machineSocket || process.env.HERDR_FAKE_REMOTE_SOCKET;
            const hello = await request(socket, { argv: ['server', 'status'] }); const name = option('--name') || args.at(-1);
            const m = { id: hello.result.core.id, host: 'fixture', name, session: option('--session') || 'r', target: option('--via') || 'fixture', via: true, version: '0.1.16', temporary: false, socket };
            state.machines.push(m); save(); mirror(m); const { socket: ignored, ...result } = m; reply(s, result);
          } else { const name = args[2]; state.machines = state.machines.filter(m => m.name !== name); state.terminals = state.terminals.filter(t => !t.address.startsWith(name + '/')); remoteChannels.get(name)?.destroy(); remoteChannels.delete(name); save(); reply(s, {}); }
        } else if (args[0] === 'run') {
          const address = `t${state.next++}`; const index = args.indexOf('--'); const program = index >= 0 ? args.slice(index + 1) : [];
          const labels = {}; args.forEach((v, i) => { if (v === '--label') { const kv = args[i + 1], at = kv.indexOf('='); labels[kv.slice(0, at)] = kv.slice(at + 1); } });
          const parent = args.includes('--no-parent') ? null : option('--parent') || env.HC_TERMINAL_ID || null;
          const t = { address, name: nameArgument(args) ?? null, parent, labels, state: 'live', status: null, exit_code: null, reason: null, signal: null, finished_ms: null, argv: program, cwd: option('--cwd') || root, screenText: '' };
          state.terminals.push(t); save(); emit('created', address, t);
          const child = spawn(program[0] || process.execPath, program.length ? program.slice(1) : ['-e', 'setInterval(()=>{},1000)'], { cwd: t.cwd, env: { ...process.env, ...env, XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, HC_SESSION: process.env.HC_SESSION, HERDR_FAKE_ROOT: root, HERDR_FAKE_SCENARIO: scenarioPath, HC_TERMINAL_ID: address, HC_TERMINAL_SOCKET: socketPath }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
          payloads.set(address, child); t.pid = child.pid; save();
          for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { t.screenText += bytes.toString('utf8'); save(); for (const sink of attaches.get(address) || []) sink.write(bytes); });
          child.once('error', error => { t.spawnError = error.message; });
          child.once('close', (code, signal) => {
            payloads.delete(address); const signals = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
            const data = { exit_code: code, signal: signal ? signals[signal] || 0 : null, reason: t.cancelled ? 'killed' : 'exited', finished_ms: Date.now() };
            Object.assign(t, data, { state: 'finished' }); save(); emit('finished', address, data); for (const sink of attaches.get(address) || []) sink.end();
          });
          reply(s, { address, agent: basename(program[0] || 'node'), cwd: t.cwd, parent, state: 'live', turn: 0 });
        } else if (['get', 'kill', 'rm', 'read', 'attach', 'label', 'keep'].includes(args[0])) {
          const t = state.terminals.find(t => t.address === terminal); if (!t) { s.end(JSON.stringify({ stderr: { error: { kind: 'not_found', message: 'No such terminal', hint: null } }, exitCode: 3 }) + '\n'); return; }
          if (args[0] === 'get') { const { screenText, ...result } = t; reply(s, await withDimensions(result)); }
          else if (args[0] === 'read') reply(s, { text: t.screenText || '', complete: true, how: 'history' });
          else if (args[0] === 'attach') { s.write(t.screenText || ''); if (t.state === 'finished') s.end(); else { const sinks = attaches.get(t.address) || new Set(); sinks.add(s); attaches.set(t.address, sinks); s.on('close', () => sinks.delete(s)); } }
          else if (args[0] === 'kill') { const child = payloads.get(t.address); if (child) { t.cancelled = true; process.kill(-child.pid, 'SIGHUP'); await new Promise(resolve => child.once('close', resolve)); } reply(s, {}); }
          else if (args[0] === 'label') { for (const kv of args.slice(2).filter(v => !v.startsWith('--'))) { const at = kv.indexOf('='); if (at < 1) throw new Error('Invalid fixture label'); const key = kv.slice(0, at), value = kv.slice(at + 1); if (value) t.labels[key] = value; else delete t.labels[key]; } save(); emit('labels', t.address, { labels: t.labels }); reply(s, t); }
          else if (args[0] === 'keep') { if (t.state !== 'live') { reply(s, { error: { kind: 'invalid_params', message: 'Only live terminals can be kept' } }); return; } t.keep = !args.includes('--off'); save(); emit('keep', t.address, { keep: t.keep }); reply(s, t); }
          else { state.terminals = state.terminals.filter(row => row !== t); save(); emit('removed', t.address, {}); reply(s, {}); }
        } else if (args[0] === 'exec') {
          if (!message.remoteRoute || delimiter < 0) throw new Error('Remote fake exec requires an explicit destination');
          const command = args.slice(delimiter + 1);
          let bytes;
          if (command[0] === 'cat') {
            const path = command.at(-1), preset = script.files?.[path];
            const file = path.startsWith(root + '/') ? path : `${root}/files/${Buffer.from(path).toString('hex')}`;
            bytes = preset !== undefined ? Buffer.from(typeof preset === 'string' ? preset : preset.base64, typeof preset === 'string' ? 'utf8' : 'base64') : readFileSync(file);
          } else if (script.execEchoStdin) bytes = flags.includes('--stdin') || flags.includes('-i') ? Buffer.from(message.input || '', 'base64') : Buffer.alloc(0);
          else if (typeof script.execReplyBase64 === 'string') bytes = Buffer.from(script.execReplyBase64, 'base64');
          else throw new Error('Unsupported fake remote exec');
          s.end(JSON.stringify({ bytesBase64: bytes.toString('base64') }) + '\n');
        } else if (args[0] === 'file') {
          const path = args.at(-1); const key = path; const preset = script.files?.[key];
          const file = path.startsWith(root + '/') ? path : `${root}/files/${Buffer.from(path).toString('hex')}`;
          if (args[1] === 'write') { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(message.input || '', 'base64')); reply(s, { path }); }
          else {
            let bytes = preset !== undefined ? Buffer.from(typeof preset === 'string' ? preset : preset.base64, typeof preset === 'string' ? 'utf8' : 'base64') : readFileSync(file);
            reply(s, { text: bytes.toString('utf8'), first: 1, last: bytes.toString('utf8').split('\n').length, lines: bytes.toString('utf8').split('\n').length });
          }
        } else throw new Error('Unsupported fixture operation');
      } catch (e) { s.end(JSON.stringify({ stderr: { error: { kind: 'invalid_params', message: e.message } }, exitCode: 2 }) + '\n'); }
    });
  });
  const heartbeat = setInterval(() => { for (const s of subscribers) s.write(JSON.stringify({ jsonrpc: '2.0', method: 'heartbeat', params: { seq: state.seq } }) + '\n'); }, 15000);
  server.on('close', () => { clearInterval(heartbeat); clearInterval(watchdog); }); mkdirSync(dirname(socketPath), { recursive: true }); server.listen(socketPath);
  process.on('SIGTERM', () => { for (const child of payloads.values()) { try { process.kill(-child.pid, 'SIGHUP'); } catch {} } try { unlinkSync(socketPath); } catch {} process.exit(0); });
  await new Promise(() => {});
}
