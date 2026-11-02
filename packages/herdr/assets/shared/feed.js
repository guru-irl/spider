// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = v => typeof v === 'string' && v.length > 0 && !v.includes('\0');
const string = v => typeof v === 'string';
const num = v => typeof v === 'number' && Number.isFinite(v);
const count = v => Number.isSafeInteger(v) && v >= 0;
const nullable = check => v => v === null || check(v);
const one = values => v => values.includes(v);
const bool = v => typeof v === 'boolean';
const shape = (v, fields) => obj(v) && Object.entries(fields).every(([k, check]) => check(v[k]));
const array = check => v => Array.isArray(v) && v.every(check);
const state = nullable(one(['idle', 'working', 'blocked', 'done', 'error']));
const identity = v => shape(v, { coreId: str, terminalId: str, address: str, socket: str, sessionNamespace: str });
const owner = v => shape(v, { sessionId: str, generation: str, terminal: identity, cwd: str, sessionFile: nullable(str), name: nullable(string) });
const placement = v => shape(v, { spaceId: str, spaceName: nullable(string), spaceOrder: nullable(count), tabId: nullable(str) });
const rows = check => v => shape(v, { rows: array(check), total: count, truncated: bool }) && v.total >= v.rows.length;
const run = v => shape(v, { id: str, ownerSessionId: str, name: nullable(string), status: one(['queued', 'running', 'paused', 'done', 'failed', 'cancelled']), childMode: one(['rpc', 'print']), canSteer: bool, startedAt: nullable(count), finishedAt: nullable(count), viewer: nullable(str), result: nullable(string) });
const todo = v => shape(v, { seq: count, sessionId: str, text: string, done: bool });
const trigger = v => shape(v, { name: str, kind: one(['loop', 'schedule']), nextAt: nullable(count), tz: nullable(string), state: str, prompt: string });
const paceLabels = v => shape(v, { month: nullable(string), usedCompact: string, used: string, projected: string, budget: string, remaining: string, updatedAt: nullable(string) });
const pace = v => shape(v, { scope: one(['shared', 'session']), used: nullable(num), budget: nullable(num), projected: nullable(num), remaining: nullable(num), periodStart: nullable(count), periodEnd: nullable(count), updatedAt: nullable(count), unavailableReason: nullable(string) })
  && (v.labels === undefined || paceLabels(v.labels));
const monthCost = v => v === undefined || shape(v, { credits: nullable(num), label: string });
const approval = v => shape(v, { uuid: str, scope: one(['repo', 'global']), repoKey: nullable(str), ownerSessionId: nullable(str), category: str, preview: string }) && (v.scope !== 'global' || v.ownerSessionId === null);
const commandPreview = v => string(v) && v.length <= 180 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v);
const terminalFinish = v => shape(v, { exitCode: nullable(v => Number.isSafeInteger(v)), signal: nullable(count), reason: str, finishedAt: count }) && (v.exitCode === null || v.signal === null);
const exitEvidence = v => shape(v, { native: terminalFinish, receipt: terminalFinish });
const jobResult = v => shape(v, { id: str, runId: nullable(str), commandPreview, machine: str, exitCode: nullable(v => Number.isSafeInteger(v)), signal: nullable(count), finishedAt: count, address: str })
  && (v.outcome === undefined || one(['exited', 'signal', 'spawn-error', 'aborted', 'timeout', 'unknown'])(v.outcome))
  && (v.evidenceConflict === undefined || bool(v.evidenceConflict))
  && (v.exitEvidence === undefined || exitEvidence(v.exitEvidence))
  && (!v.evidenceConflict || v.exitCode === null && v.signal === null && v.outcome === 'unknown')
  && (v.exitEvidence === undefined || v.evidenceConflict === true);
const notification = v => {
  if (!shape(v, { id: str, createdAt: count, title: string, body: string })) return false;
  if (v.scope === 'shared') return v.kind === 'budget' && v.sessionId === null && v.ownerAddress === null
    && shape(v.action, { kind: one(['open-usage']), scope: one(['shared']) });
  return (v.job === undefined || (v.kind === 'job-result' && jobResult(v.job)))
    && v.scope === 'session' && one(['subagent-result', 'escalation', 'job-result'])(v.kind)
    && str(v.sessionId) && str(v.ownerAddress)
    && shape(v.action, { kind: one(['focus-owner']), sessionId: str, address: str })
    && v.action.sessionId === v.sessionId && v.action.address === v.ownerAddress;
};
function utf8Size(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) bytes++;
    else if (c < 2048) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const low = text.charCodeAt(++i); if (!(low >= 0xdc00 && low <= 0xdfff)) return Infinity; bytes += 4;
    } else if (c >= 0xdc00 && c <= 0xdfff) return Infinity;
    else bytes += 3;
    if (bytes > 1024 * 1024) return bytes;
  }
  return bytes;
}
export function parseFeed(text) {
  if (typeof text !== 'string' || utf8Size(text) > 1024 * 1024) return null;
  try {
    const feed = JSON.parse(text);
    if (!shape(feed, { version: v => v === 1, sessionId: str, generation: str, revision: count, updatedAt: count, owner,
      placement: nullable(placement), lifecycle: one(['live', 'closed']), status: v => shape(v, { native: state, effective: state, message: nullable(string) }),
      runs: rows(run), todos: rows(todo), triggers: array(trigger), pace, approvals: array(approval), notifications: array(notification),
      ipc: nullable(v => shape(v, { address: str, capabilityFile: str })), errors: array(v => shape(v, { source: str, message: string })), monthCost })) return null;
    if (feed.owner.sessionId !== feed.sessionId || feed.owner.generation !== feed.generation) return null;
    if (feed.runs.rows.some(r => r.ownerSessionId !== feed.sessionId) || feed.todos.rows.some(t => t.sessionId !== feed.sessionId)) return null;
    return feed;
  } catch { return null; }
}

const ipcUtf8Size = text => new TextEncoder().encode(text).byteLength;
const IPC_LINE_BYTES = 256 * 1024;
const IPC_PAGE_BYTES = 64 * 1024;
const IPC_STEER_BYTES = 16 * 1024;
const IPC_CURSOR_BYTES = 1024;
const ipcObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const ipcString = (value) => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const ipcCount = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const ipcOne = (value, choices) => typeof value === 'string' && choices.includes(value);
function ipcCursor(value) {
  return ipcString(value) && ipcUtf8Size(value) <= IPC_CURSOR_BYTES;
}
function ipcRequest(value) {
  if (!ipcObject(value) || !ipcString(value.generation)) return false;
  switch (value.op) {
    case 'ping': return true;
    case 'openView': return ipcOne(value.view, ['agents', 'todos', 'usage', 'memory', 'triggers']);
    case 'openRun': return ipcString(value.runId);
    case 'openJob': return ipcString(value.jobId);
    case 'steerRun': return ipcString(value.runId) && typeof value.text === 'string' && ipcUtf8Size(value.text) <= IPC_STEER_BYTES;
    case 'subscribeRun': return ipcString(value.runId) && (value.cursor === null || ipcCursor(value.cursor));
    default: return false;
  }
}
function ipcEvent(value) {
  return ipcObject(value) && ipcString(value.runId) && ipcCount(value.id) && typeof value.type === 'string'
    && (value.text === undefined || typeof value.text === 'string')
    && (value.summary === undefined || typeof value.summary === 'string')
    && (value.tool === undefined || typeof value.tool === 'string');
}
function ipcPage(value, runId) {
  return ipcObject(value) && typeof value.text === 'string' && Array.isArray(value.events)
    && value.events.every(event => ipcEvent(event) && event.runId === runId)
    && ipcUtf8Size(JSON.stringify(value)) <= IPC_PAGE_BYTES;
}
function ipcFrame(value) {
  if (!ipcObject(value) || !ipcString(value.runId) || !ipcCursor(value.cursor) || !ipcObject(value.data)) return false;
  switch (value.kind) {
    case 'snapshot': return run(value.data.run) && value.data.run.id === value.runId;
    case 'event': return ipcPage(value.data, value.runId);
    case 'gap': return typeof value.data.reason === 'string';
    case 'end': return ipcOne(value.data.reason, ['finished', 'disposed', 'wrong-generation', 'overflow', 'run-not-owned']);
    default: return false;
  }
}
function ipcSteerReply(value) {
  if (!ipcObject(value) || typeof value.queued !== 'boolean'
    || (value.transformed !== undefined && typeof value.transformed !== 'boolean')
    || (value.error !== undefined && typeof value.error !== 'string')) return false;
  switch (value.delivery) {
    case 'delivered': return value.accepted === true && value.delivered === true;
    case 'accepted but not confirmed':
    case 'broker-accepted':
    case 'consumed by an extension, not delivered': return value.accepted === true && value.delivered === false;
    case 'no reply yet, delivery unknown':
    case 'refused': return value.accepted === false && value.delivered === false;
    default: return false;
  }
}
function ipcReply(value) {
  if (!ipcObject(value)) return false;
  if (value.ok === false) {
    if (typeof value.message !== 'string') return false;
    if (value.code === 'refused') return value.reason === undefined || ipcOne(value.reason, ['queued', 'paused', 'print-mode', 'slash-prefixed', 'wrong-owner', 'dead-pipe']);
    return value.reason === undefined && ipcOne(value.code, ['wrong-generation', 'unauthorized', 'unknown-op', 'too-large', 'not-found', 'unavailable', 'status-instance-unavailable']);
  }
  if (value.ok !== true || value.reason !== undefined) return false;
  switch (value.op) {
    case 'ping': return ipcObject(value.status)
      && (value.status.native === null || ipcOne(value.status.native, ['idle', 'working', 'blocked', 'done', 'error']))
      && (value.status.effective === null || ipcOne(value.status.effective, ['idle', 'working', 'blocked', 'done', 'error']));
    case 'openView': return true;
    case 'openRun':
    case 'openJob': return ipcString(value.viewer);
    case 'steerRun': return ipcSteerReply(value.acknowledgement);
    default: return false;
  }
}
function ipcDecode(line, guard) {
  if (typeof line !== 'string' || ipcUtf8Size(line) > IPC_LINE_BYTES) return null;
  // A decoder accepts one NDJSON line, optionally including its final newline.
  if (/[\r\n]/.test(line.replace(/\r?\n$/, ''))) return null;
  try { const value = JSON.parse(line); return guard(value) ? value : null; } catch { return null; }
}
/** Decode a bounded request line before invoking any session action. */
export function parseSessionIpcRequest(line) { return ipcDecode(line, ipcRequest); }
/** Decode the authenticated first line without reading files or comparing the server's secret. */
export function parseSessionIpcEnvelope(line) {
  return ipcDecode(line, (value) => ipcObject(value) && value.v === 1
    && typeof value.capability === 'string' && /^[0-9a-fA-F]{64}$/.test(value.capability) && ipcRequest(value.request));
}
/** Decode a single bounded action reply, preserving typed refusal information. */
export function parseSessionIpcReply(line) { return ipcDecode(line, ipcReply); }
/** Decode a bounded stream frame and enforce the smaller serialized transcript-page limit. */
export function parseRunViewFrame(line) { return ipcDecode(line, ipcFrame); }
/** Build the packaged CLI's argv using descriptor paths, never capability contents. */
export function panelIpcArgv(nodePath, cliPath, descriptor, request) {
  const publicDescriptor = { version: descriptor.version, sessionId: descriptor.sessionId,
    generation: descriptor.generation, address: descriptor.address, capabilityFile: descriptor.capabilityFile };
  return [nodePath, cliPath, 'ipc', '--descriptor', JSON.stringify(publicDescriptor), '--request', JSON.stringify(request)];
}
/** Parse exactly the panel CLI argv; the CLI separately reads the descriptor's capability file. */
export function parsePanelIpcArgv(argv) {
  if (argv.length !== 7 || !ipcString(argv[0]) || !ipcString(argv[1]) || argv[2] !== 'ipc'
    || argv[3] !== '--descriptor' || argv[5] !== '--request') return null;
  const descriptor = ipcDecode(argv[4], (value) => ipcObject(value) && value.version === 1
    && ipcString(value.sessionId) && ipcString(value.generation) && ipcString(value.address) && ipcString(value.capabilityFile));
  const request = parseSessionIpcRequest(argv[6]);
  return descriptor && request ? { nodePath: argv[0], cliPath: argv[1], descriptor, request } : null;
}

// Shortens a path to at most `max` code points by cutting its middle, like Finder:
// "~/src/spi…/herdr-e2e-1". The last folder stays whole when it fits; otherwise
// the head and tail of the whole path are kept.
export function middlePath(path, max) {
  const points = [...path];
  if (points.length <= max) return path;
  if (max < 1) return '';
  const slash = points.lastIndexOf('/'), last = points.slice(slash + 1);
  if (slash >= 0 && last.length > 0 && last.length + 2 <= max) return points.slice(0, max - 2 - last.length).join('') + '\u2026/' + last.join('');
  const head = Math.ceil((max - 1) / 2), tail = Math.floor((max - 1) / 2);
  return points.slice(0, head).join('') + '\u2026' + (tail ? points.slice(-tail).join('') : '');
}
