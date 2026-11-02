// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
/**
 * Fixture-only process domain for Herdr e2e tests (never active in ordinary use).
 *
 * The production inventory lists every same-user pi process, so a fenced test fixture would treat the user's own
 * live pi sessions as unknown writers and refuse every non-empty cutover. When SPIDER_HERDR_E2E_PROCESS_DOMAIN names a
 * private manifest inside the fixture checkout's scratch root, the inventory instead lists only pi processes
 * registered in that domain (`<root>/procs/<pid>.json`) whose actual OS start identity still matches. Everything else
 * about the inventory is unchanged: presence, leases and probes still decide, and unknown or uncertain processes
 * inside the domain still block. Any unproved configuration throws; there is no fallback.
 */
import { lstatSync, readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, basename } from 'node:path';
import { HerdrError } from '@spider/herdr/client/parse';
import type { PiProcess } from '@spider/herdr/sessions/lease';
import { processStartTime } from '../../../subagents/src/process-identity.js';

export const FIXTURE_PROCESS_DOMAIN_ENV = 'SPIDER_HERDR_E2E_PROCESS_DOMAIN';

function physical(path: string): string {
  const tail: string[] = []; let parent = resolve(path);
  while (!existsSync(parent) && dirname(parent) !== parent) { tail.unshift(basename(parent)); parent = dirname(parent); }
  return join(realpathSync(parent), ...tail);
}
function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
function privateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    throw new HerdrError('fixture-process-domain-not-private', 'The process-domain manifest must be a private regular file owned by this user');
}

export interface FixtureProcessDomain { readonly root: string; processes(): Promise<readonly PiProcess[]> }

/** Null when the variable is unset (ordinary behaviour). Throws on any configuration that is set but unproved. */
export function fixtureProcessDomain(inventoryRoot: string, env: Readonly<NodeJS.ProcessEnv> = process.env): FixtureProcessDomain | null {
  const manifestPath = env[FIXTURE_PROCESS_DOMAIN_ENV];
  if (manifestPath === undefined) return null;
  const checkout = env.SPIDER_TEST_FIXTURE_CHECKOUT;
  if (!checkout) throw new HerdrError('fixture-process-domain-unfenced', 'A process domain requires the fixture checkout fence');
  if (!isAbsolute(manifestPath)) throw new HerdrError('fixture-process-domain-invalid', 'The process-domain manifest path must be absolute');
  const scratch = physical(join(checkout, '.spider', 'scratch'));
  if (!within(scratch, physical(manifestPath)) || !within(scratch, resolve(manifestPath))) throw new HerdrError('fixture-process-domain-outside', 'The process-domain manifest is outside the fixture scratch root');
  privateFile(manifestPath);
  let manifest: { version?: unknown; root?: unknown };
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { throw new HerdrError('fixture-process-domain-invalid', 'The process-domain manifest is not valid JSON'); }
  const root = manifest.root;
  if (manifest.version !== 1 || typeof root !== 'string' || !isAbsolute(root) || resolve(dirname(manifestPath)) !== resolve(root) || !within(scratch, physical(root)))
    throw new HerdrError('fixture-process-domain-invalid', 'The manifest must be version 1 and name its own directory as the domain root');
  if (!within(physical(root), physical(inventoryRoot))) throw new HerdrError('fixture-process-domain-outside', 'The inventory root is outside the process domain');
  return {
    root,
    async processes() {
      const directory = join(root, 'procs');
      const names = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.json')) : [];
      const listed: PiProcess[] = [];
      for (const name of names) {
        let entry: { version?: unknown; pid?: unknown; start?: unknown };
        try { privateFile(join(directory, name)); entry = JSON.parse(readFileSync(join(directory, name), 'utf8')); }
        catch (error) { throw error instanceof HerdrError ? error : new HerdrError('fixture-process-domain-invalid', `Unreadable registration ${name}`); }
        if (entry.version !== 1 || !Number.isInteger(entry.pid) || (entry.pid as number) <= 0 || typeof entry.start !== 'string' || !entry.start)
          throw new HerdrError('fixture-process-domain-invalid', `Invalid registration ${name}`);
        const pid = entry.pid as number, current = processStartTime(pid);
        if (current !== null && current === entry.start) listed.push({ pid, startIdentity: current, classification: 'pi' });
      }
      return listed.sort((a, b) => a.pid - b.pid);
    },
  };
}
