// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { appendFileSync } from 'node:fs';

// This loader is used only by the R18 hub. The packed file on disk is unchanged.
function record(event) {
  try {
    const file = process.env.SPIDER_HERDR_E2E_SYNC_LOG;
    if (file) appendFileSync(file, JSON.stringify({ at: Date.now(), ...event }) + '\n');
  } catch { /* Evidence must not change a sync result. */ }
}

export function observeSyncResults(machineId, results) {
  try {
    record({ event: 'sync-result', machineId, results: results.map(result => ({
      code: result.code, reason: result.reason, operationId: result.operationId,
      ...(result.operationKind === undefined ? {} : { operationKind: result.operationKind }),
      ...(result.causeCode === undefined ? {} : { causeCode: result.causeCode }),
    })) });
  } catch { /* Evidence must not change a sync result. */ }
  return results;
}

export function observeSyncError(direction, machineId, storeKey, error) {
  try {
    record({ event: 'sync-error', direction, machineId, storeKey, error: {
      name: error?.name ?? null, message: error?.message ?? String(error),
      code: error?.code ?? null, stack: typeof error?.stack === 'string' ? error.stack.slice(0, 4096) : null,
    } });
  } catch { /* Evidence must not change a sync result. */ }
}

export function observeSyncInventory(machineId, stores, peerUngathered, localUngathered) {
  try {
    const fields = rows => (rows ?? []).map(({ key, scope, code, check }) => ({ key, scope, code, check }));
    record({ event: 'sync-inventory', machineId, stores, peerUngathered: fields(peerUngathered), localUngathered: fields(localUngathered) });
  } catch { /* Evidence must not change a sync result. */ }
}

function replaceOnce(source, before, after) {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) !== -1) throw new Error('Unrecognized sync observation point');
  return source.slice(0, at) + after + source.slice(at + before.length);
}

/** Fail closed if the packed bundle no longer has the expected sync boundaries. */
export function instrumentBundle(source) {
  const startMarker = 'async function peerSync(peer, inventories) {';
  const endMarker = 'function failure(error, id) {';
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0 || source.indexOf(startMarker, start + startMarker.length) !== -1 ||
      source.indexOf(endMarker, end + endMarker.length) !== -1) throw new Error('Unrecognized sync function');

  let region = source.slice(start, end);
  const pull = region.indexOf('await pull(peer, key, state, results);');
  const push = region.indexOf('await push(peer, key, state, results, observe);');
  const failure = 'results.push(failure(error, peer.machineId));';
  const points = [];
  for (let at = region.indexOf(failure); at !== -1; at = region.indexOf(failure, at + failure.length)) points.push(at);
  if (points.length !== 3 || !(0 <= pull && pull < points[0] && points[0] < push && push < points[1] && points[1] < points[2])) {
    throw new Error('Unrecognized sync error boundaries');
  }
  for (let i = points.length - 1; i >= 0; i--) {
    const direction = ['pull', 'push', 'sync'][i], key = i === 2 ? 'null' : 'key';
    region = region.slice(0, points[i]) + `__r18SyncError(${JSON.stringify(direction)}, peer.machineId, ${key}, error); ` + region.slice(points[i]);
  }
  const inventory = 'const blocked = (key) => unavailable.some((store) => store.key === key);';
  region = replaceOnce(region, inventory, `${inventory}\n__r18SyncInventory(peer.machineId, keys, state.ungathered, localUngathered);`);
  source = source.slice(0, start) + region + source.slice(end);

  const result = '(await options.sync.sync(machineId)).every((result) => result.code === 0)';
  source = replaceOnce(source, result, '__r18SyncResults(machineId, await options.sync.sync(machineId)).every((result) => result.code === 0)');
  const imports = `import { observeSyncResults as __r18SyncResults, observeSyncError as __r18SyncError, observeSyncInventory as __r18SyncInventory } from ${JSON.stringify(import.meta.url)};\n`;
  const at = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
  if (source.startsWith('#!') && at === 0) throw new Error('Unrecognized bundle header');
  return source.slice(0, at) + imports + source.slice(at);
}

let entry;
export function initialize(data) {
  if (typeof data?.entry !== 'string' || !data.entry.startsWith('file:')) throw new Error('Missing fixture entry');
  entry = data.entry;
}

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (url !== entry) return loaded;
  if (loaded.format !== 'module' || loaded.source == null) throw new Error('Invalid fixture entry');
  const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
  return { ...loaded, source: instrumentBundle(source) };
}
