// SPDX-License-Identifier: MIT
import { fileURLToPath } from 'node:url';

/** Resolve a fixture file that a native command or a clean child loads. */
export function fixtureInput(file: URL): string {
  const path = fileURLToPath(file);
  const record = (globalThis as Record<symbol, ((path: string) => void) | undefined>)[Symbol.for('spider.selection.input')];
  record?.(path);
  return path;
}
