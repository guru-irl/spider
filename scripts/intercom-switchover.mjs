import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

function legacyDeclaration(value, roots, directory) {
  const source = typeof value === 'string' ? value : value?.source;
  if (typeof source !== 'string') return false;
  const path = source.replace(/^!/, '');
  const normalized = isAbsolute(path) || directory ? resolve(directory ?? '', path) : path;
  const gitSource = path.replace(/^git:/, '').replace(/^git\+/, '');
  return /^(?:npm:)?pi-intercom(?:@[^/]+)?$/.test(path)
    || /^(?:(?:https?|ssh):\/\/(?:git@)?github\.com\/|git@github\.com:|github\.com\/)nicobailon\/pi-intercom(?:\.git)?(?:[\/?#@]|$)/i.test(gitSource)
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
  if (journal) {
    for (const change of journal.changes) {
      const backup = change.backup ?? change.file + `.intercom-${input.operationId}.bak`;
      if (await ports.read(backup) !== change.before) throw new Error('Backup does not match original settings');
    }
  }
  const rollback = async (attempted = journal.changes) => {
    const restore = [];
    for (const change of attempted) {
      const current = await ports.read(change.file);
      if (current === change.before) continue;
      if (current !== change.after) throw new Error(`Settings changed after switchover; rollback refused: ${change.file}`);
      restore.push(change);
    }
    const active = await ports.activeRelease();
    if (active !== journal.previousRelease && active !== input.release) throw new Error('Active release changed; rollback refused');
    for (const change of restore) {
      if (!await ports.compareAndSwap(change.file, change.after, change.before)) throw new Error(`Settings changed during rollback; retry: ${change.file}`);
    }
    if (active !== journal.previousRelease) await ports.activate(journal.previousRelease);
    journal.state = 'rolled-back';
    await ports.writeAtomic(input.journalFile, JSON.stringify(journal));
  };
  if (journal?.state === 'prepared') await rollback();
  const retrying = journal?.state === 'rolled-back';
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
  for (const change of changes) {
    const original = change.file + `.intercom-${input.operationId}.bak`;
    const existing = retrying ? await ports.read(original) : null;
    const backup = existing !== null && existing !== change.before
      ? change.file + `.intercom-${input.operationId}.${createHash('sha256').update(change.before).digest('hex').slice(0, 16)}.bak` : original;
    await ports.backup(backup, change.before);
    change.backup = backup;
  }
  await ports.writeAtomic(input.journalFile, JSON.stringify(journal));
  const attempted = [];
  try {
    for (const change of changes) {
      attempted.push(change);
      if (!await ports.compareAndSwap(change.file, change.before, change.after)) {
        attempted.pop();
        throw new Error(`Settings changed since read; retry switchover: ${change.file}`);
      }
    }
    await ports.activate(input.release);
    const result = { status: 'migration-pending', reason: 'legacy-broker-quiescence-unproved', release: input.release,
      settingsFiles: changes.map(change => change.file), retainedLegacyRoots: [...input.legacyRoots] };
    journal.state = 'done'; journal.result = result;
    await ports.writeAtomic(input.journalFile, JSON.stringify(journal));
    return result;
  } catch (error) {
    try { await rollback(attempted); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], `Switchover rollback pending: ${rollbackError.message}`); }
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
    async compareAndSwap(file, expected, next) {
      // Pi's file settings storage uses proper-lockfile with realpath:false.
      // Its lock is the exclusive directory beside the settings file.
      const lock = file + '.lock';
      try { await mkdir(lock, { mode: 0o700 }); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error(`Settings lock held; retry switchover: ${file}`);
        throw error;
      }
      try {
        if (await read(file) !== expected) return false;
        await writeAtomic(file, next);
        return true;
      } finally { await rmdir(lock); }
    },
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
