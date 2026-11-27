// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// @ts-ignore The same ESM fixture is loaded directly by the owned hub process.
import { instrumentBundle, observeSyncResults } from '../../fixtures/roam-sync-observer-loader.mjs';

let root: string;
let evidence: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roam-sync-observer-'));
  evidence = join(root, 'sync.jsonl');
  vi.stubEnv('SPIDER_HERDR_E2E_SYNC_LOG', evidence);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function events(): Array<Record<string, unknown>> {
  return readFileSync(evidence, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
}

it('records each result code and reason without changing the array', () => {
  const results = [
    { code: 0, reason: 'pulled', operationId: 'first', value: { private: 'not evidence' } },
    { code: 1, reason: 'Store synchronization refused', operationId: 'second' },
    { code: 3, reason: 'Peer operation is pending reconciliation', operationId: 'third', operationKind: 'import', causeCode: 'test-cause' },
  ];
  expect(observeSyncResults('peer', results)).toBe(results);
  expect(events()).toMatchObject([{ event: 'sync-result', machineId: 'peer', results: [
    { code: 0, reason: 'pulled', operationId: 'first' },
    { code: 1, reason: 'Store synchronization refused', operationId: 'second' },
    { code: 3, reason: 'Peer operation is pending reconciliation', operationId: 'third', operationKind: 'import', causeCode: 'test-cause' },
  ] }]);
  expect(readFileSync(evidence, 'utf8')).not.toContain('not evidence');
});

it('does not alter a sync result when the evidence file cannot be written', () => {
  vi.stubEnv('SPIDER_HERDR_E2E_SYNC_LOG', join(root, 'missing', 'sync.jsonl'));
  const results = [{ code: 1, reason: 'refused', operationId: 'operation' }];
  expect(observeSyncResults('peer', results)).toBe(results);
});

const sampleBundle = `
const pull = async (peer, key, state, results) => {
  if (state.pullError) throw state.pullError;
  results.push({ code: 0, reason: "pulled", operationId: key });
};
const push = async (peer, key, state) => { if (state.pushError) throw state.pushError; };
const observe = () => {};
async function peerSync(peer, inventories) {
  const results = [], state = inventories.state, keys = inventories.keys;
  const localUngathered = [], unavailable = inventories.unavailable;
  const blocked = (key) => unavailable.some((store) => store.key === key);
  for (const key of keys) {
    if (blocked(key)) continue;
    try { await pull(peer, key, state, results); }
    catch (error) { results.push(failure(error, peer.machineId)); }
  }
  for (const key of keys) {
    if (blocked(key)) continue;
    try { await push(peer, key, state, results, observe); }
    catch (error) { results.push(failure(error, peer.machineId)); }
  }
  try { if (state.outerError) throw state.outerError; }
  catch (error) { results.push(failure(error, peer.machineId)); }
  return results;
}
function failure(error, id) { return { code: 1, reason: "Store synchronization refused", operationId: id }; }
export { peerSync };
export async function adapter(machineId, options) {
  return (await options.sync.sync(machineId)).every((result) => result.code === 0) ? true : false;
}
`;

it('records the failing store and leaves the instrumented return values unchanged', async () => {
  const file = join(root, 'sample.mjs');
  writeFileSync(file, instrumentBundle(sampleBundle));
  const module = await import(/* @vite-ignore */ pathToFileURL(file).href) as {
    peerSync(peer: unknown, inventory: unknown): Promise<unknown[]>;
    adapter(machine: string, options: unknown): Promise<boolean>;
  };
  const error = Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
  const results = await module.peerSync({ machineId: 'peer' }, { state: { pushError: error, ungathered: [] }, keys: ['global'], unavailable: [] });
  expect(results).toEqual([
    { code: 0, reason: 'pulled', operationId: 'global' },
    { code: 1, reason: 'Store synchronization refused', operationId: 'peer' },
  ]);
  expect(await module.adapter('peer', { sync: { sync: async () => results } })).toBe(false);
  expect(await module.adapter('peer', { sync: { sync: async () => [] } })).toBe(true);
  expect(events()).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: 'sync-error', direction: 'push', machineId: 'peer', storeKey: 'global',
      error: expect.objectContaining({ message: 'fixture disk full', code: 'ENOSPC' }) }),
    expect.objectContaining({ event: 'sync-result', machineId: 'peer', results: [
      { code: 0, reason: 'pulled', operationId: 'global' },
      { code: 1, reason: 'Store synchronization refused', operationId: 'peer' },
    ] }),
  ]));
});

it('refuses to instrument an unrecognized or ambiguous bundle', () => {
  expect(() => instrumentBundle('export const unknown = 1;')).toThrow();
  expect(() => instrumentBundle(sampleBundle + '\n' + sampleBundle)).toThrow();
});

it('loads only the named module and records its unchanged outcome', () => {
  const entry = join(root, 'sample.mjs'), driver = join(root, 'driver.mjs');
  writeFileSync(entry, sampleBundle);
  writeFileSync(join(root, 'other.mjs'), 'export const value = 7;\n');
  writeFileSync(driver, `import { adapter } from './sample.mjs';
import { value } from './other.mjs';
console.log(await adapter('peer', { sync: { sync: async () => [{ code: 1, reason: 'denied', operationId: 'one' }] } }), value);
`);
  const register = fileURLToPath(new URL('../../fixtures/roam-sync-register.mjs', import.meta.url));
  const child = spawnSync(process.execPath, ['--import', register, driver], {
    env: { ...process.env, SPIDER_HERDR_E2E_SYNC_ENTRY: entry }, encoding: 'utf8',
  });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toBe('false 7\n');
  expect(events()).toMatchObject([{ event: 'sync-result', machineId: 'peer',
    results: [{ code: 1, reason: 'denied', operationId: 'one' }] }]);
});
