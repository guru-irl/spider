// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Finds and loads the host's pi for the viewer. Nothing here imports pi
// statically, so the text viewer still runs when pi cannot be loaded.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as nodeModule from 'node:module';
import { findPiPackageRootFromEntry, PI_CODING_AGENT_PACKAGE } from '../../../subagents/src/pi-spawn.js';

/** Returns pi's package root: the session's own when it passed one, otherwise the one this module resolves. */
export function piPackageRoot(explicit?: string): string | null {
  if (explicit) {
    try {
      const root = realpathSync(explicit);
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: unknown };
      return pkg.name === PI_CODING_AGENT_PACKAGE ? root : null;
    } catch { return null; }
  }
  try { return findPiPackageRootFromEntry(fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE))) ?? null; } catch { return null; }
}
/** The version string of a pi package root, or null. */
export function piVersion(root: string): string | null {
  try { const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }; return typeof pkg.version === 'string' ? pkg.version : null; }
  catch { return null; }
}
/** pi 1.2.0 is the first release whose components this viewer draws with. */
export function supportedPiVersion(version: string | null): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? ''); if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 1 || major === 1 && minor >= 2;
}
export async function loadBuiltInRenderers(root: string | null): Promise<((name: string) => never) | null> {
  if (!root) return null;
  const file = join(root, 'dist/core/tools/renderers/index.js'); if (!existsSync(file)) return null;
  try {
    const module = await import(pathToFileURL(file).href) as { withBuiltInRenderers?: (name: string, definition: unknown) => unknown };
    const merge = module.withBuiltInRenderers; return merge ? name => merge(name, undefined) as never : null;
  } catch { return null; }
}
let hooked: string | null = null;
/**
 * Makes pi package imports from the viewer bundle resolve as if pi itself
 * imported them, so the view uses the host's pi and its own pi-tui copy.
 */
export function resolvePiFrom(root: string, bundleDirectory: string): void {
  if (hooked === root) return;
  if (hooked) throw new Error('The viewer already resolves pi from another install.');
  const register = (nodeModule as { registerHooks?: (hooks: unknown) => unknown }).registerHooks;
  if (typeof register !== 'function') throw new Error('This Node.js cannot redirect module resolution.');
  const parentURL = pathToFileURL(join(root, 'package.json')).href;
  const bundle = pathToFileURL(bundleDirectory).href.replace(/\/?$/, '/');
  register({
    resolve(specifier: string, context: { parentURL?: string }, next: (specifier: string, context: unknown) => unknown) {
      if (/^(?:@earendil-works\/pi-[a-z-]+|typebox)(?:\/|$)/.test(specifier) && context.parentURL?.startsWith(bundle)) return next(specifier, { ...context, parentURL });
      return next(specifier, context);
    },
  });
  hooked = root;
}
export function bundleDirectoryOf(url: string): string { return dirname(fileURLToPath(url)); }
