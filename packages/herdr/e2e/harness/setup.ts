// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdir, readFile, stat, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { HarnessError, type OwnedPath } from './environment.js';
import type { Suite, InvokeResult } from './suite.js';
import { destinationPath, assertDestinationPaths } from './destination.js';

export type SetupConfig = Readonly<Record<string, unknown>>;
export interface SetupResult extends InvokeResult { configPath: OwnedPath }
export interface InstalledFile { path: OwnedPath; sha256: string; mtimeMs: number; bytes: Buffer }
export interface Installed {
  configPath: OwnedPath;
  config: SetupConfig;
  appHome: OwnedPath;
  journalPath: OwnedPath;
  journal: Readonly<Record<string, unknown>>;
  files: readonly InstalledFile[];
  mods: Readonly<Record<string, OwnedPath>>;
  templates: readonly OwnedPath[];
  runtimes: readonly { machine: string; path: OwnedPath }[];
  layout: { path: OwnedPath; value: unknown };
}
const configs = new WeakMap<Suite, OwnedPath>();
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HarnessError('invalid-setup-input', 'expected a JSON object');
  return value as Record<string, unknown>;
};
const pathValue = (suite: Suite, value: unknown): OwnedPath => {
  if (typeof value !== 'string') throw new HarnessError('invalid-setup-input', 'expected an owned path');
  return suite.ownPath(value);
};
function fenceConfig(suite: Suite, input: unknown): SetupConfig {
  const config = object(input);
  for (const field of ['globalRoot', 'agentDirectory', 'shellRc']) pathValue(suite, config[field]);
  pathValue(suite, object(config.app).home); pathValue(suite, object(config.core).config);
  if (config.globalRoot !== suite.directories.SPIDER_GLOBAL_ROOT) throw new HarnessError('global-root-mismatch', 'setup must use this suite global root');
  if (!Array.isArray(config.machines) || !Array.isArray(config.spaces)) throw new HarnessError('invalid-setup-input', 'machines and spaces must be arrays');
  for (const machine of config.machines) {
    const runtime = object(object(machine).runtime);
    for (const value of [runtime.directory, runtime.cwd, object(object(machine).lock ?? {}).path]) {
      if (value == null) continue;
      if (typeof value !== 'string') throw new HarnessError('invalid-setup-input', 'expected a destination path');
      destinationPath(suite, value);
    }
  }
  for (const space of config.spaces) {
    const sessions = object(space).sessions;
    if (!Array.isArray(sessions)) throw new HarnessError('invalid-setup-input', 'space sessions must be an array');
    for (const selector of sessions) if (object(selector).file !== undefined) pathValue(suite, object(selector).file);
  }
  return config;
}
async function loadConfig(suite: Suite, path: OwnedPath): Promise<SetupConfig> {
  return fenceConfig(suite, JSON.parse(await readFile(path, 'utf8')));
}
/** No ports, source imports, runtime creation or app replies are substituted here. */
export async function runSetup(suite: Suite, config: SetupConfig | string): Promise<SetupResult> {
  let configPath: OwnedPath;
  if (typeof config === 'string') {
    configPath = suite.ownPath(config); await loadConfig(suite, configPath);
  } else {
    fenceConfig(suite, config);
    configPath = suite.ownPath(join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr/config.json'));
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    const bytes = JSON.stringify(config, null, 2) + '\n';
    const current = await readFile(configPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (current !== bytes) {
      const staging = suite.ownPath(`${configPath}.new`);
      await writeFile(staging, bytes, { mode: 0o600 }); await rename(staging, configPath);
    }
  }
  const fenced = await loadConfig(suite, configPath);
  if (suite.options.tier === 'remote') {
    const paths = (fenced.machines as Record<string, unknown>[]).flatMap(machine => {
      const runtime = object(machine.runtime);
      return [runtime.directory, runtime.cwd, object(machine.lock ?? {}).path].filter((value): value is string => typeof value === 'string');
    });
    await assertDestinationPaths(suite, paths);
  }
  configs.set(suite, configPath);
  const argv = [suite.packed.cli, 'setup', '--config', configPath], startedAt = Date.now();
  const result = await suite.invoke(process.execPath, argv, suite.env);
  const finishedAt = Date.now(), timing = suite.ownPath(join(suite.root, 'app-cli-timing.jsonl'));
  const traceExists = await stat(timing).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (traceExists) {
    await suite.keepEvidence(timing, 'app-cli-timing.jsonl');
    await suite.evidence('setup-invocation.json', { binary: process.execPath, argv, startedAt, finishedAt, durationMs: finishedAt - startedAt, result });
  }
  return { ...result, configPath };
}
/** Reads setup's installed entries. A missing or unowned artifact is not an installation. */
export async function readInstalled(suite: Suite, selectedConfig?: string): Promise<Installed> {
  const configPath = suite.ownPath(selectedConfig ?? configs.get(suite) ?? join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr/config.json'));
  const config = await loadConfig(suite, configPath);
  const appHome = pathValue(suite, object(config.app).home);
  const journalPath = suite.ownPath(join(String(config.globalRoot), 'herdr/setup/journal.json'));
  const journal = object(JSON.parse(await readFile(journalPath, 'utf8')));
  if (journal.version !== 1 || !Array.isArray(journal.entries) || !Array.isArray(journal.runtimes)) throw new HarnessError('invalid-setup-journal', 'expected installed entries and runtimes');
  const files: InstalledFile[] = [];
  const mods: Record<string, OwnedPath> = {};
  const templates: OwnedPath[] = [];
  for (const entry of journal.entries) {
    const path = pathValue(suite, object(entry).path);
    const info = await stat(path); if (!info.isFile()) throw new HarnessError('missing-installed-file', path);
    const bytes = await readFile(path);
    files.push({ path, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), mtimeMs: info.mtimeMs });
    const suffix = relative(join(appHome, 'mods'), path).split(sep);
    if (suffix.length > 1 && suffix[0] !== '..') mods[suffix[0]] = suite.ownPath(join(appHome, 'mods', suffix[0]));
    if (path.endsWith('.md') && path.includes(`${sep}templates${sep}`)) templates.push(path);
  }
  const runtimes = journal.runtimes.map(value => {
    const runtime = object(value); if (typeof runtime.machine !== 'string') throw new HarnessError('invalid-setup-journal', 'runtime machine is missing');
    if (typeof runtime.path !== 'string') throw new HarnessError('invalid-setup-journal', 'runtime path is missing');
    return { machine: runtime.machine, path: destinationPath(suite, runtime.path) };
  });
  await assertDestinationPaths(suite, runtimes.map(runtime => runtime.path));
  const layoutPath = suite.ownPath(join(appHome, 'layouts/spider-glass.json'));
  if (!files.some(file => file.path === layoutPath)) throw new HarnessError('missing-installed-layout', 'layout is absent from the setup journal');
  return { configPath, config, appHome, journalPath, journal, files, mods, templates, runtimes, layout: { path: layoutPath, value: JSON.parse(await readFile(layoutPath, 'utf8')) } };
}
