// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { HerdrError } from './parse.js';
export function launchNotStarted(error: unknown): boolean {
  if (!(error instanceof HerdrError)) return false;
  if (['core-unavailable', 'core-mismatch'].includes(error.code) && error.details === undefined) return true;
  const details = error.details;
  return ['missing-hc', 'spawn-error'].includes(error.code) && !!details && typeof details === 'object' &&
    Object.hasOwn(details, 'pid') && (details as { pid?: unknown }).pid === undefined;
}
