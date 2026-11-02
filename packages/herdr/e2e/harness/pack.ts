// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Packed-build staging: npm pack the checkout once, extract under scratch, and launch spider only from there.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { checkoutRoot, scratchRoot, HarnessError, ownedPath, type OwnedPath } from './environment.js';

export const PACKED_ROOT_ENV = 'SPIDER_HERDR_E2E_PACKED_ROOT';
export const PACKED_ENTRIES = ['dist/extension.js', 'dist/herdr/cli.mjs', 'dist/herdr/viewer.mjs', 'dist/herdr/remote-runtime.mjs'] as const;
export interface PackedBuild {
  /** The extracted package directory, which pi loads as an installed package. */
  root: OwnedPath;
  digests: Record<(typeof PACKED_ENTRIES)[number], string>;
  cli: OwnedPath; viewer: OwnedPath; extension: OwnedPath; remoteRuntime: OwnedPath;
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function packRoot(): string { return join(scratchRoot(), 'e2', '_pack'); }

/**
 * Verifies a staged package: physical directory inside the checkout scratch root, owned by this user,
 * every entry the package manifest ships, and no workspace-source links in its dependency view.
 */
export function verifyPackedRoot(candidate: string): PackedBuild {
  const scratch = scratchRoot();
  const suffix = relative(scratch, candidate);
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new HarnessError('packed-root-outside-scratch', `${candidate} is not under ${scratch}`);
  const root = ownedPath(scratch, candidate);
  let stat; try { stat = lstatSync(root); } catch { throw new HarnessError('packed-root-missing', `${root} does not exist`); }
  if (!stat.isDirectory()) throw new HarnessError('packed-root-invalid', `${root} is not a directory`);
  if (stat.uid !== process.getuid?.()) throw new HarnessError('packed-root-not-owned', `${root} is not owned by this user`);
  let manifest: { files?: unknown; pi?: { extensions?: unknown } };
  try { manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { throw new HarnessError('packed-entry-missing', `${root}/package.json is missing or invalid`); }
  const shipped = Array.isArray(manifest.files) ? manifest.files.filter((f): f is string => typeof f === 'string' && !f.includes('*')) : [];
  for (const entry of [...PACKED_ENTRIES, ...shipped]) {
    const path = ownedPath(scratch, join(root, entry));
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new HarnessError('packed-entry-missing', `packed build lacks ${entry}`);
  }
  if (!Array.isArray(manifest.pi?.extensions) || !manifest.pi.extensions.includes('./dist/extension.js')) throw new HarnessError('packed-entry-missing', 'package.json does not declare ./dist/extension.js');
  if (existsSync(join(root, 'node_modules', '@spider'))) throw new HarnessError('packed-source-link', 'staged dependencies include workspace @spider links');
  if (existsSync(join(root, 'packages')) && readdirSync(join(root, 'packages')).some(p => existsSync(join(root, 'packages', p, 'src')))) throw new HarnessError('packed-source-link', 'staged package ships workspace source');
  const digests = Object.fromEntries(PACKED_ENTRIES.map(e => [e, sha256(join(root, e))])) as PackedBuild['digests'];
  return { root, digests, extension: ownedPath(scratch, join(root, PACKED_ENTRIES[0])), cli: ownedPath(scratch, join(root, PACKED_ENTRIES[1])), viewer: ownedPath(scratch, join(root, PACKED_ENTRIES[2])), remoteRuntime: ownedPath(scratch, join(root, PACKED_ENTRIES[3])) };
}

/** Uses the runner's packed root when exported; otherwise packs the checkout's current build once per content digest. */
export function stagePackedBuild(env: Readonly<NodeJS.ProcessEnv> = process.env): PackedBuild {
  const exported = env[PACKED_ROOT_ENV];
  if (exported !== undefined) return verifyPackedRoot(exported);
  const checkout = checkoutRoot();
  for (const entry of PACKED_ENTRIES) if (!existsSync(join(checkout, entry))) throw new HarnessError('packed-entry-missing', `${entry} is missing; run npm run build first`);
  const base = packRoot(), work = join(base, `w${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  try {
    const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work, '--cache', join(base, 'npm-cache')], {
      cwd: checkout, encoding: 'utf8', env: { PATH: `${process.execPath.replace(/\/node$/, '')}:/usr/bin:/bin`, HOME: join(base, 'h'), TMPDIR: work, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' },
    });
    if (pack.status !== 0) throw new HarnessError('pack-failed', pack.stderr.slice(0, 2000));
    const [{ filename }] = JSON.parse(pack.stdout) as { filename: string }[];
    const tarball = join(work, filename), digest = sha256(tarball).slice(0, 16);
    const target = join(base, digest);
    if (!existsSync(join(target, 'package', 'package.json'))) {
      const extract = spawnSync('tar', ['-xzf', tarball, '-C', work], { encoding: 'utf8' });
      if (extract.status !== 0) throw new HarnessError('pack-failed', extract.stderr);
      linkDependencies(checkout, join(work, 'package'));
      mkdirSync(join(work, 'stage'));
      renameSync(join(work, 'package'), join(work, 'stage', 'package'));
      try { renameSync(join(work, 'stage'), target); } catch (error) { if (!existsSync(join(target, 'package', 'package.json'))) throw error; }
    }
    return verifyPackedRoot(join(target, 'package'));
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/** Per-entry links into the checkout's private dependency clone, excluding workspace links and bin shims. */
function linkDependencies(checkout: string, packageDirectory: string): void {
  const source = join(checkout, 'node_modules'), target = join(packageDirectory, 'node_modules');
  mkdirSync(target);
  for (const name of readdirSync(source)) {
    if (name === '@spider' || name === '.bin' || name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      mkdirSync(join(target, name));
      for (const inner of readdirSync(join(source, name))) {
        const real = join(source, name, inner);
        if (lstatSync(real).isSymbolicLink()) continue; // workspace links point at source
        symlinkSync(real, join(target, name, inner));
      }
    } else if (!lstatSync(join(source, name)).isSymbolicLink() && statSync(join(source, name)).isDirectory()) symlinkSync(join(source, name), join(target, name));
  }
}
