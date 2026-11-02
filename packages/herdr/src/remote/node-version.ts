// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { RuntimeDirectoryProbe } from './runtime.js';
/** The shipped runtime uses stable Node built-ins, not native TypeScript loading or pi APIs. */
export const REMOTE_NODE_MINIMUM = '22.18.0';
export function checkRemoteNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 22 || major === 22 && (minor > 18 || minor === 18 && patch >= 0);
}

export function isRuntimeRootProbe(value: unknown, directory: string): value is RuntimeDirectoryProbe {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.directory === directory && result.mode === 0o700 && typeof result.uid === 'number' && Number.isSafeInteger(result.uid) && result.uid >= 0 && typeof result.nodePath === 'string' && result.nodePath.length > 0 && typeof result.nodeVersion === 'string' && checkRemoteNodeVersion(result.nodeVersion);
}
