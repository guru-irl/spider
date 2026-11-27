// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

let sequence = 0;
function record(event) {
  try {
    const directory = process.env.SPIDER_HERDR_E2E_OWNER_DIR;
    if (directory) appendFileSync(join(directory, `${process.pid}.jsonl`), JSON.stringify({ at: Date.now(), pid: process.pid, ...event }) + '\n');
  } catch { /* Evidence must not change the owner decision. */ }
}

export function beginOwner(machineId, sessionId, caller, home) {
  const trace = `${process.pid}:${++sequence}`;
  record({ event: 'owner-begin', trace, machineId, sessionId, caller, home });
  return trace;
}

export function ownerValue(trace, phase, value) {
  record({ event: 'owner-value', trace, phase, value });
  return value;
}

export function ownerError(trace, error) {
  try {
    record({ event: 'owner-error', trace, error: {
      name: error?.name ?? null, message: error?.message ?? String(error), code: error?.code ?? null,
      stack: typeof error?.stack === 'string' ? error.stack.slice(0, 4096) : null,
    } });
  } catch { /* An unusual error must not change the owner decision. */ }
}

function replaceCount(source, pattern, replacement, expected) {
  let count = 0;
  const result = source.replace(pattern, () => { count++; return replacement; });
  if (count !== expected) throw new Error('Unrecognized owner observation point');
  return result;
}

/** Fail closed if a packed entry no longer has the expected owner boundaries. */
export function instrumentOwnerBundle(source) {
  const marker = 'async function inspectOwner(id, placement) {';
  const endMarker = 'async function owner(id, placement) {';
  const start = source.indexOf(marker), end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0 || source.indexOf(marker, start + marker.length) !== -1 ||
      source.indexOf(endMarker, end + endMarker.length) !== -1) throw new Error('Unrecognized owner function');
  const original = source.slice(start + marker.length, end);
  const closing = /\}\s*$/.exec(original);
  if (!closing) throw new Error('Unrecognized owner function end');
  let body = original.slice(0, closing.index);
  for (const [pattern, phase, count] of [
    [/await io\.inspect\(id\)/g, 'lock', 3],
    [/await io\.terminals\(id\)/g, 'terminals', 1],
    [/await io\.probe\(lock\.identity\.pid\)/g, 'probe', 1],
    [/await io\.writerBlockers\(id,\s*placement\)/g, 'writers', 1],
  ]) {
    body = replaceCount(body, pattern, `__r18OwnerValue(__r18Trace, ${JSON.stringify(phase)}, ${
      phase === 'lock' ? 'await io.inspect(id)' : phase === 'terminals' ? 'await io.terminals(id)' :
        phase === 'probe' ? 'await io.probe(lock.identity.pid)' : 'await io.writerBlockers(id, placement)'})`, count);
  }
  body = replaceCount(body, /\}\s*catch\s*\{/g, '} catch (__r18Error) { __r18OwnerError(__r18Trace, __r18Error);', 1);
  const replacement = `async function inspectOwner(id, placement, __r18Caller, __r18Home) {
    const __r18Trace = __r18BeginOwner(options.config.machineId, id, __r18Caller, __r18Home);
    const __r18Result = await (async () => {${body}\n})();
    return __r18OwnerValue(__r18Trace, "result", __r18Result);
  }\n`;
  source = source.slice(0, start) + replacement + source.slice(end);
  source = replaceCount(source, /await inspectOwner\(id,\s*placement\)/g, 'await inspectOwner(id, placement, "owner", null)', 1);
  source = replaceCount(source, /await inspectOwner\(home\.sessionId,\s*placement\)/g, 'await inspectOwner(home.sessionId, placement, "start", home)', 1);
  const imports = `import { beginOwner as __r18BeginOwner, ownerValue as __r18OwnerValue, ownerError as __r18OwnerError } from ${JSON.stringify(import.meta.url)};\n`;
  const at = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
  if (source.startsWith('#!') && at === 0) throw new Error('Unrecognized bundle header');
  return source.slice(0, at) + imports + source.slice(at);
}
