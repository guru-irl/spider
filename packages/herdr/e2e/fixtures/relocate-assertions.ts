// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { expect } from 'vitest';

interface Placement { cwd: string; file: string }

function within(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false;
  const path = relative(root, candidate);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Both fixture machines share a filesystem, so content equality alone is insufficient. */
export function assertRelocatedCopy(source: Placement, destination: Placement, repository: string, agent: string): void {
  expect(resolve(destination.cwd)).not.toBe(resolve(source.cwd));
  expect(resolve(destination.file)).not.toBe(resolve(source.file));
  expect(within(repository, destination.cwd)).toBe(true);
  expect(within(agent, destination.file)).toBe(true);
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
