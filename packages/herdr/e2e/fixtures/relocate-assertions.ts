// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { expect } from 'vitest';
import { waitFor, type Deadline } from '../harness/wait.js';

interface Placement { cwd: string; file: string }

function within(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false;
  const path = relative(root, candidate);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Both fixture machines share a filesystem, so content equality alone is insufficient. */
export function assertRelocatedCopy(source: Placement, destination: Placement, checkoutRoot: string, agent: string): void {
  expect(resolve(destination.cwd)).not.toBe(resolve(source.cwd));
  expect(resolve(destination.file)).not.toBe(resolve(source.file));
  expect(within(checkoutRoot, destination.cwd)).toBe(true);
  expect(within(agent, destination.file)).toBe(true);
}

/** Different paths can still refer to the same checkout or hard-linked transcript. */
export function assertDistinctInodes(source: Placement, destination: Placement): void {
  for (const key of ['cwd', 'file'] as const) {
    const before = statSync(source[key], { bigint: true }), after = statSync(destination[key], { bigint: true });
    expect({ device: after.dev, inode: after.ino }).not.toEqual({ device: before.dev, inode: before.ino });
  }
}

interface RunRecord { namespace: string; argv: string[] }

/** Compare the core's response to the exact command passed to hc, not reconstructed argv. */
export function assertNativeLaunch(native: unknown, records: readonly RunRecord[], placement: Placement,
  namespace: string, session: string, machine: string, epoch: number): void {
  const labels = [`spider.session=${session}`, `spider.machine=${machine}`, `spider.roam.epoch=${epoch}`];
  const matches = records.filter(record => {
    const args = record.argv, end = args.indexOf('--');
    return record.namespace === namespace && args[0] === 'run' && end > 0 &&
      labels.every(label => args.slice(0, end).some((arg, index) => arg === '--label' && args[index + 1] === label));
  });
  expect(matches).toHaveLength(1);
  const args = matches[0].argv, end = args.indexOf('--'), cwdIndex = args.indexOf('--cwd');
  expect(cwdIndex).toBeGreaterThan(0);
  expect(cwdIndex).toBeLessThan(end);
  expect(args[cwdIndex + 1]).toBe(placement.cwd);
  const launch = args.slice(end + 1);
  expect(launch.slice(-2)).toEqual(['--session', placement.file]);
  expect(native).toMatchObject({ cwd: placement.cwd, argv: launch });
}

interface HomeRow {
  session_id: string; machine_id: string; epoch: number; state: string;
  destination: string | null; move_id: string | null;
}

export async function waitForReplicatedHome(read: () => HomeRow | null, home: HomeRow, limit: Deadline): Promise<HomeRow> {
  const row = await waitFor('replicated home matches the authoritative home', read, value =>
    value !== null && value.session_id === home.session_id && value.machine_id === home.machine_id &&
    value.epoch === home.epoch && value.state === home.state && value.destination === home.destination && value.move_id === home.move_id, limit);
  expect(row).toEqual(home);
  if (!row) throw new Error('replicated home is missing');
  return row;
}
