import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

function legacyDeclaration(value, roots, directory) {
  const source = typeof value === 'string' ? value : value?.source;
  if (typeof source !== 'string') return false;
  const path = source.replace(/^!/, '');
  const normalized = isAbsolute(path) || directory ? resolve(directory ?? '', path) : path;
  return /^(?:npm:)?pi-intercom(?:@[^/]+)?$/.test(path)
    || /^https:\/\/github\.com\/nicobailon\/pi-intercom(?:[\/#@]|$)/.test(path)
    || roots.some(root => normalized === resolve(root) || normalized.startsWith(resolve(root) + '/') || normalized.startsWith(resolve(root) + '\\'));
}

export function migrateIntercomSettings(text, legacyRoots, directory) {
  const settings = JSON.parse(text);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Settings must be an object');
  const next = { ...settings };
  for (const key of ['packages', 'extensions', 'skills']) {
    if (settings[key] === undefined) continue;
    if (!Array.isArray(settings[key])) throw new Error(`${key} must be an array`);
    next[key] = settings[key].filter(value => !legacyDeclaration(value, legacyRoots, directory));
  }
  return JSON.stringify(next, null, 2) + '\n';
}

/** All effects are injected. Activation and settings form one recoverable operation.
 * A prepared journal is rolled back before a retry, including after process death.
 * Legacy files and sockets are deliberately outside this operation's authority. */
export async function applyIntercomSwitchover(input, ports) {
  if (!/^[a-zA-Z0-9._-]+$/.test(input.operationId)) throw new Error('Invalid operation ID');
  if (!isAbsolute(input.release) || !isAbsolute(input.journalFile) || input.settingsFiles.some(file => !isAbsolute(file))) throw new Error('Switchover paths must be absolute');
  if (new Set(input.settingsFiles).size !== input.settingsFiles.length) throw new Error('Duplicate settings scope');
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const pending = await ports.read(input.journalFile);
  let journal = pending === null ? null : JSON.parse(pending);
  if (journal && journal.digest !== digest) throw new Error('Operation ID was reused with different inputs');
  if (journal?.state === 'done') return journal.result;
  const rollback = async () => {
    for (const change of journal.changes) await ports.writeAtomic(change.file, change.before);
    await ports.activate(journal.previousRelease);
    journal.state = 'rolled-back';
    await ports.writeAtomic(input.journalFile, JSON.stringify(journal));
  };
  if (journal?.state === 'prepared') await rollback();
  await ports.validateRelease(input.release);
  const changes = [];
  for (const file of input.settingsFiles) {
    const before = await ports.read(file);
    if (before === null) continue;
    const after = migrateIntercomSettings(before, input.legacyRoots, dirname(file));
    if (JSON.stringify(JSON.parse(before)) !== JSON.stringify(JSON.parse(after))) changes.push({ file, before, after });
  }
  journal = { version: 1, digest, state: 'prepared', previousRelease: await ports.activeRelease(), changes };
  // Exclusive backup writes never replace the original bytes on retry.
  for (const change of changes) await ports.backup(change.file + `.intercom-${input.operationId}.bak`, change.before);
  await ports.writeAtomic(input.journalFile, JSON.stringify(journal));
  try {
    for (const change of changes) await ports.writeAtomic(change.file, change.after);
    await ports.activate(input.release);
    const result = { status: 'migration-pending', reason: 'legacy-broker-quiescence-unproved', release: input.release,
      settingsFiles: changes.map(change => change.file), retainedLegacyRoots: [...input.legacyRoots] };
    journal.state = 'done'; journal.result = result;
    await ports.writeAtomic(input.journalFile, JSON.stringify(journal));
    return result;
  } catch (error) {
    try { await rollback(); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Switchover rollback pending'); }
    throw error;
  }
}

async function regularOwned(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Refusing unsafe switchover file');
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function writeAtomic(file, text) {
  await regularOwned(file);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(file), `.${randomUUID()}.stage`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
  const directory = await open(dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Fixture/file-pointer adapter. A maintainer supplies the actual release activator. */
export function filesystemSwitchoverPorts(activeFile) {
  const read = async file => await regularOwned(file) ? readFile(file, 'utf8') : null;
  return { read, writeAtomic,
    async backup(file, text) {
      if (await regularOwned(file)) {
        if (await readFile(file, 'utf8') !== text) throw new Error('Backup does not match original settings');
        return;
      }
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    },
    async validateRelease(release) {
      for (const file of ['dist/extension.js', 'dist/intercom/broker.mjs']) if (!await regularOwned(join(resolve(release), file))) throw new Error('Incomplete spider release');
    },
    async activeRelease() { const value = await read(activeFile); return value === null ? null : JSON.parse(value); },
    async activate(release) { await writeAtomic(activeFile, JSON.stringify(release)); },
  };
}
