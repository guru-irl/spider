// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
export const PRIVATE_LAUNCH_DIRECTORY = ['spider', 'herdr', 'launch-environments'] as const;
export const PRIVATE_LAUNCH_GLOB = '**/spider/herdr/launch-environments';
/** Self-contained so remote readers can apply the same guard after resolving symlinks. */
export function isPrivateLaunchPath(path: string): boolean {
  return /(?:^|\/)spider\/herdr\/launch-environments(?:\/|$)/.test(path.replace(/\\/g, '/').normalize('NFD').toLowerCase());
}
