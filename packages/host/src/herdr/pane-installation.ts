// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { PANE_ENDPOINT_BOOTSTRAP } from '../../../herdr/src/panes/bootstrap.js';
export { PANE_ENDPOINT_BOOTSTRAP };
import { realpath, lstat, readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { privateDirectory, readPrivateJson, writePrivateJson, withProcessLock } from '../../../herdr/src/sessions/registry.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { atomicWrite } from '../../../herdr/src/setup/backup.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';
export const PANE_INSTALLATION_REFUSALS = ['pane-installation-missing', 'pane-installation-unsafe', 'pane-endpoint-build-mismatch', 'pane-endpoint-protocol-mismatch'] as const;
export class PaneInstallationPermissionsError extends HerdrError {
  readonly repair: string;
  constructor(paths: readonly string[]) {
    super('pane-installation-unsafe', 'Endpoint package permissions allow other users to write');
    this.repair = 'chmod go-w ' + paths.map(path => "'" + path.replaceAll("'", "'\"'\"'") + "'").join(' ');
  }
}
async function owned(path: string, directory: boolean): Promise<void> {
  let info; try { info = await lstat(path); } catch { throw new HerdrError('pane-installation-missing', 'Installed endpoint is missing'); }
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || await realpath(path) !== path || process.platform !== 'win32' && info.uid !== process.getuid?.()) throw new HerdrError('pane-installation-unsafe', 'Endpoint installation is not safely owned');
  if (process.platform !== 'win32' && (info.mode & 0o022)) throw new PaneInstallationPermissionsError([path]);
}
async function inspectPackage(root: string): Promise<void> {
  const writable: string[] = [];
  for (const [path, directory] of [[root, true], [join(root, 'dist'), true], [join(root, 'dist/herdr'), true], [join(root, 'dist/herdr/pane-endpoint.mjs'), false]] as const) {
    try { await owned(path, directory); }
    catch (error) { if (error instanceof PaneInstallationPermissionsError) writable.push(path); else throw error; }
  }
  if (writable.length) throw new PaneInstallationPermissionsError(writable);
}
export async function recordPaneInstallation(globalRoot: string, packageRoot: string, onUnsafe?: (error: HerdrError) => void): Promise<void> {
  try { await recordInstallation(globalRoot, packageRoot); }
  catch (error) { if (onUnsafe && error instanceof HerdrError && error.code === 'pane-installation-unsafe') onUnsafe(error); else throw error; }
}
async function recordInstallation(globalRoot: string, packageRoot: string, replace = false): Promise<void> {
  const canonical = await realpath(packageRoot); await owned(canonical, true);
  const root = join(globalRoot, 'herdr');
  try { await privateDirectory(root); if (await realpath(root) !== root) throw new Error('Noncanonical private root'); } catch { throw new HerdrError('pane-installation-unsafe', 'Installation registry directory is not safely owned'); }
  await withProcessLock(root, 'pane-installation', async () => {
    const path = join(root, 'installation.json');
    let info; try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (info && (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > 16384 || process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600))) throw new HerdrError('pane-installation-unsafe', 'Installation registry must be private and owned');
    const current = await readPrivateJson(path);
    if (current !== null) {
      const entry = current as { version?: unknown; packageRoot?: unknown };
      if (entry.version !== 1 || typeof entry.packageRoot !== 'string' || !isAbsolute(entry.packageRoot) || entry.packageRoot !== canonical && !replace) throw new HerdrError('pane-installation-unsafe', 'Installation registry does not belong to this installation');
      return;
    }
    if (info) throw new HerdrError('pane-installation-unsafe', 'Installation registry is malformed');
    await writePrivateJson(path, { version: 1, packageRoot: canonical });
  });
}
/** Explicit local setup only. Runtime requests and diagnostics never call this. */
export async function stagePaneEndpointInstallation(globalRoot: string, packageRoot: string): Promise<string[]> {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 19) throw new HerdrError('pane-node-unavailable', 'Endpoint setup requires a supported Node executable');
  if (!isAbsolute(globalRoot) || !isAbsolute(packageRoot)) throw new HerdrError('pane-installation-unsafe', 'Installation paths must be absolute');
  const canonical = await realpath(packageRoot), source = join(canonical, 'dist/herdr/pane-endpoint.mjs');
  await inspectPackage(canonical);
  const bytes = await readFile(source), digest = createHash('sha256').update(bytes).digest('hex'), file = `pane-endpoint-${digest}.mjs`, staged = join(canonical, 'dist/herdr', file), writes: string[] = [];
  await recordInstallation(globalRoot, canonical, true);
  let existing: Buffer | null = null; try { await owned(staged, false); existing = await readFile(staged); } catch (error) { if (!(error instanceof HerdrError) || error.code !== 'pane-installation-missing') throw error; }
  if (existing && createHash('sha256').update(existing).digest('hex') !== digest) throw new HerdrError('pane-endpoint-build-mismatch', 'Content-addressed endpoint differs');
  if (!existing) { try { await atomicWrite(staged, bytes, 0o600, null); writes.push(staged); } catch (error) { if (!(error instanceof HerdrError) || error.code !== 'concurrent-settings-edit') throw error; } }
  await owned(staged, false);
  if (createHash('sha256').update(await readFile(staged)).digest('hex') !== digest || createHash('sha256').update(await readFile(source)).digest('hex') !== digest) throw new HerdrError('pane-endpoint-build-mismatch', 'Endpoint changed during staging');
  const installed = await import(pathToFileURL(staged).href) as { createProductionPaneEndpointPorts(digest: string, env: NodeJS.ProcessEnv, root: string): { protocol: number; buildDigest: string; dispose?(): Promise<void> } };
  if (typeof installed.createProductionPaneEndpointPorts !== 'function') throw new HerdrError('pane-endpoint-protocol-mismatch', 'Endpoint protocol export is missing');
  const admitted = installed.createProductionPaneEndpointPorts(digest, { ...process.env, SPIDER_GLOBAL_ROOT: globalRoot }, canonical);
  try {
    if (admitted.protocol !== 1) throw new HerdrError('pane-endpoint-protocol-mismatch', 'Endpoint protocol differs');
    if (admitted.buildDigest !== digest) throw new HerdrError('pane-endpoint-build-mismatch', 'Endpoint build differs');
  } finally { await admitted.dispose?.(); }
  const registry = join(globalRoot, 'herdr/installation.json'), next = { version: 1, packageRoot: canonical, endpoint: { file, digest, protocol: 1 } };
  await withProcessLock(join(globalRoot, 'herdr'), 'pane-installation', async () => {
    const current = await readPrivateJson(registry) as { version?: unknown; packageRoot?: unknown } | null;
    const info = await lstat(registry);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) || current?.version !== 1 || typeof current.packageRoot !== 'string' || !isAbsolute(current.packageRoot)) throw new HerdrError('pane-installation-unsafe', 'Installation registry changed during setup');
    if (JSON.stringify(current) !== JSON.stringify(next)) { await writePrivateJson(registry, next); writes.push(registry); }
  });
  return writes;
}
/** Read-only admission probe, using the same installed endpoint path as runtime calls. */
export async function probeLocalPaneEndpoint(globalRoot: string, packageRoot: string): Promise<void> {
  await inspectPackage(await realpath(packageRoot));
  let bytes: Buffer; try { bytes = await readFile(join(packageRoot, 'dist/herdr/pane-endpoint.mjs')); } catch { throw new HerdrError('pane-installation-missing', 'Installed endpoint is missing'); }
  const digest = createHash('sha256').update(bytes).digest('hex');
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', PANE_ENDPOINT_BOOTSTRAP, digest, '1', JSON.stringify({ version: 1, op: 'handshake', protocol: 1, buildDigest: digest })], { env: { ...process.env, SPIDER_GLOBAL_ROOT: globalRoot }, timeout: 5000, maxBuffer: 1024 * 1024 });
    const reply = JSON.parse(stdout);
    if (reply.version !== 1 || reply.op !== 'handshake' || reply.protocol !== 1) throw new HerdrError('pane-endpoint-protocol-mismatch', 'Endpoint protocol differs');
    if (reply.buildDigest !== digest) throw new HerdrError('pane-endpoint-build-mismatch', 'Endpoint build differs');
  } catch (error) {
    if (error instanceof HerdrError) throw error;
    let code: unknown; try { code = JSON.parse(String((error as { stderr?: unknown }).stderr ?? '').trim()).code; } catch { /* Unknown probe errors carry no source text into diagnostics. */ }
    if (PANE_INSTALLATION_REFUSALS.includes(code as never)) throw new HerdrError(String(code), 'Installed endpoint admission refused');
    throw new HerdrError('pane-endpoint-inspection-unavailable', 'Endpoint admission could not be inspected');
  }
}
