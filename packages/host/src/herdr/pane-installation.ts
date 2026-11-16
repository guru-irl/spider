// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
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
export async function recordPaneInstallation(globalRoot: string, packageRoot: string): Promise<void> {
  const canonical = await realpath(packageRoot), info = await lstat(canonical);
  if (!info.isDirectory() || process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)) throw new HerdrError('pane-installation-unsafe', 'Installation must be owned by this user');
  const root = join(globalRoot, 'herdr');
  try { await privateDirectory(root); if (await realpath(root) !== root) throw new Error('Noncanonical private root'); } catch { throw new HerdrError('pane-installation-unsafe', 'Installation registry directory is not safely owned'); }
  await withProcessLock(root, 'pane-installation', async () => {
    const path = join(root, 'installation.json');
    let info; try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (info && (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > 16384 || process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600))) throw new HerdrError('pane-installation-unsafe', 'Installation registry must be private and owned');
    const current = await readPrivateJson(path);
    if (current !== null) {
      const entry = current as { version?: unknown; packageRoot?: unknown };
      if (entry.version !== 1 || entry.packageRoot !== canonical) throw new HerdrError('pane-installation-unsafe', 'Installation registry does not belong to this installation');
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
  const owned = async (path: string, directory: boolean) => {
    let info; try { info = await lstat(path); } catch { throw new HerdrError('pane-installation-missing', 'Installed endpoint is missing'); }
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || await realpath(path) !== path || process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)) throw new HerdrError('pane-installation-unsafe', 'Endpoint installation is not safely owned');
  };
  await owned(canonical, true); await owned(join(canonical, 'dist'), true); await owned(join(canonical, 'dist/herdr'), true); await owned(source, false);
  const bytes = await readFile(source), digest = createHash('sha256').update(bytes).digest('hex'), file = `pane-endpoint-${digest}.mjs`, staged = join(canonical, 'dist/herdr', file), writes: string[] = [];
  await recordPaneInstallation(globalRoot, canonical);
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
    if (current?.version !== 1 || current.packageRoot !== canonical) throw new HerdrError('pane-installation-unsafe', 'Installation registry changed during setup');
    if (JSON.stringify(current) !== JSON.stringify(next)) { await writePrivateJson(registry, next); writes.push(registry); }
  });
  return writes;
}
/** Only built-ins: resolve the installed package before importing any native dependency. */
export const PANE_ENDPOINT_BOOTSTRAP: string = String.raw`
(async()=>{
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),url=require('node:url');
const fail=code=>{throw Object.assign(new Error(code),{paneCode:code})};
const [digest,protocolText,requestText]=process.argv.slice(1),protocol=Number(protocolText);
if(!/^[a-f0-9]{64}$/.test(digest)||!Number.isSafeInteger(protocol)||protocol<1||Buffer.byteLength(requestText||'')>1048576)fail('pane-endpoint-protocol-mismatch');
const uid=process.getuid?.(),safe=(p,directory,privateMode=false)=>{let s;try{s=fs.lstatSync(p)}catch(e){if(e.code==='ENOENT')fail('pane-installation-missing');throw e}if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile())||uid!==undefined&&(s.uid!==uid||(s.mode&(privateMode?0o077:0o022))!==0))fail('pane-installation-unsafe');return s};
const root=process.env.SPIDER_GLOBAL_ROOT||path.join(os.homedir(),'.pi','agent','spider');
if(!path.isAbsolute(root))fail('pane-installation-unsafe');
const dir=path.join(root,'herdr'),registry=path.join(dir,'installation.json');safe(dir,true,true);safe(registry,false,true);
let entry;try{const fd=fs.openSync(registry,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{const s=fs.fstatSync(fd);if(s.size>16384||uid!==undefined&&(s.uid!==uid||(s.mode&0o077)!==0))fail('pane-installation-unsafe');entry=JSON.parse(fs.readFileSync(fd,'utf8'))}finally{fs.closeSync(fd)}}catch(e){if(e.paneCode)throw e;fail('pane-installation-unsafe')}
if(!entry||entry.version!==1||typeof entry.packageRoot!=='string'||!path.isAbsolute(entry.packageRoot))fail('pane-installation-unsafe');
safe(entry.packageRoot,true);safe(path.join(entry.packageRoot,'dist'),true);safe(path.join(entry.packageRoot,'dist','herdr'),true);
if(!entry.endpoint)fail('pane-installation-missing');if(entry.endpoint.protocol!==protocol)fail('pane-endpoint-protocol-mismatch');if(entry.endpoint.digest!==digest||entry.endpoint.file!=='pane-endpoint-'+digest+'.mjs')fail('pane-endpoint-build-mismatch');
const original=path.join(entry.packageRoot,'dist','herdr','pane-endpoint.mjs');safe(original,false);if(crypto.createHash('sha256').update(fs.readFileSync(original)).digest('hex')!==digest)fail('pane-endpoint-build-mismatch');
const endpoint=path.join(entry.packageRoot,'dist','herdr',entry.endpoint.file);safe(endpoint,false);
const bytes=fs.readFileSync(endpoint);if(crypto.createHash('sha256').update(bytes).digest('hex')!==digest)fail('pane-endpoint-build-mismatch');
const installed=await import(url.pathToFileURL(endpoint).href);
if(crypto.createHash('sha256').update(fs.readFileSync(endpoint)).digest('hex')!==digest)fail('pane-endpoint-build-mismatch');
const admitted=installed.createProductionPaneEndpointPorts(digest);if(admitted.protocol!==protocol)fail('pane-endpoint-protocol-mismatch');if(admitted.buildDigest!==digest)fail('pane-endpoint-build-mismatch');
const create=async()=>installed.createProductionPaneEndpointPorts(digest);
const handshake=JSON.parse(await installed.runPaneEndpointCli(['--json',JSON.stringify({version:1,op:'handshake',protocol,buildDigest:digest})],create));
if(handshake.protocol!==protocol)fail('pane-endpoint-protocol-mismatch');if(handshake.buildDigest!==digest)fail('pane-endpoint-build-mismatch');
process.stdout.write(await installed.runPaneEndpointCli(['--json',requestText],create)+'\n');
})().catch(error=>{process.stderr.write(JSON.stringify({code:error.paneCode||'pane-endpoint-failed'})+'\n');process.exitCode=1});
`;

/** Read-only admission probe, using the same installed endpoint path as runtime calls. */
export async function probeLocalPaneEndpoint(globalRoot: string, packageRoot: string): Promise<void> {
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
