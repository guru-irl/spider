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
