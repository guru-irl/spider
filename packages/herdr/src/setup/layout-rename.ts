// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HerdrError, object } from '../client/parse.js';
import { rejectSymlinks, snapshot, verifiedBackup, type FileSnapshot, type SetupJournal } from './backup.js';

import { LEGACY_SPIDER_LAYOUT_FILE, SPIDER_LAYOUT, SPIDER_LAYOUT_FILE, legacySpiderLayoutPath, spiderLayoutPath } from '../look/names.js';

async function layoutFileNames(home: string): Promise<string[]> {
  const directory = join(home, 'layouts');
  await rejectSymlinks(directory);
  return readdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
}
export async function hasLegacyLayout(home: string): Promise<boolean> {
  return (await layoutFileNames(home)).includes(LEGACY_SPIDER_LAYOUT_FILE);
}
export async function readLegacyLayout(home: string, journalRoot: string, journal: SetupJournal, replaceChanged?: boolean) {
  const names = await layoutFileNames(home);
  const aliases = names.filter(name => name.toLowerCase() === SPIDER_LAYOUT_FILE.toLowerCase());
  const path = legacySpiderLayoutPath(home);
  const legacy = names.includes(LEGACY_SPIDER_LAYOUT_FILE) ? await snapshot(path) : null;
  if (!legacy?.bytes) return { aliases, legacy: null, replaceLegacy: false };
  const prior = journal.entries.find(entry => entry.path === path && !entry.managed && entry.after !== null);
  const changed = prior?.after !== legacy.hash;
  if (!prior || changed && (!replaceChanged || !prior.backup)) {
    const code = aliases.length ? 'layout-name-conflict' : 'unowned-clone-collision';
    const remedy = prior?.backup ? 'Inspect it or rerun with --replace-changed to back up your edits before migrating.'
      : 'Move it out of layouts before retrying setup; there is no recorded backup for replacing it.';
    throw new HerdrError(code, `Setup cannot migrate changed or unowned ${path}. ${remedy}`);
  }
  await verifiedBackup(journalRoot, prior.backup, prior.before);
  return { aliases, legacy: { ...legacy, bytes: legacy.bytes }, replaceLegacy: changed };
}

export async function readLayoutTargets(home: string, journalRoot: string, journal: SetupJournal, replaceChanged?: boolean) {
  const directory = join(home, 'layouts');
  const { aliases, legacy, replaceLegacy } = await readLegacyLayout(home, journalRoot, journal, replaceChanged);
  if (legacy?.bytes && aliases.length)
    throw new HerdrError('layout-name-conflict', `Both ${LEGACY_SPIDER_LAYOUT_FILE} and ${aliases.join(', ')} are in ${directory}. If setup was interrupted, run rollback --undo-upgrade. Otherwise move the conflicting ${SPIDER_LAYOUT_FILE} layout to a different name before retrying setup.`);
  const path = spiderLayoutPath(home);
  if (aliases.some(name => name !== SPIDER_LAYOUT_FILE) || aliases.length && !journal.entries.some(entry => entry.path === path && entry.after !== null))
    throw new HerdrError('layout-name-conflict', `Setup cannot use ${SPIDER_LAYOUT_FILE}: ${join(directory, aliases.join(', '))} is not a layout installed by setup. Move it out of layouts or rename it to a different stem, then rerun setup.`);
  const target = await snapshot(path);
  // Also check the pathname itself: a case-insensitive lookup can resolve an alias.
  if (target.bytes && !aliases.includes(SPIDER_LAYOUT_FILE))
    throw new HerdrError('layout-name-conflict', `Setup cannot use ${path}. Move the conflicting file out of layouts or rename it to a different stem, then rerun setup.`);
  return { legacy, target, replaceLegacy };
}

export async function readLayoutSelection(path: string): Promise<FileSnapshot & { values: Record<string, unknown>; layout: string | undefined }> {
  const saved = await snapshot(path);
  try {
    const values = object(JSON.parse(saved.bytes?.toString('utf8') ?? '{}'));
    if (values.layout !== undefined && typeof values.layout !== 'string') throw new Error('layout must be a string');
    return { ...saved, values, layout: values.layout };
  } catch {
    throw new HerdrError('invalid-layout-selection', `Cannot read the Herdr layout selection in ${path}. Repair the JSON object and its layout value before retrying.`);
  }
}

export async function awaitSpiderSelection(path: string): Promise<void> {
  // Herdr acknowledges layout.switch before its shared-store writer flushes.
  const deadline = Date.now() + 5000;
  do {
    if ((await readLayoutSelection(path)).layout === SPIDER_LAYOUT) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new HerdrError('layout-selection-not-saved', `Herdr did not save ${SPIDER_LAYOUT} in ${path}. Check the active Herdr layout and retry.`);
}
