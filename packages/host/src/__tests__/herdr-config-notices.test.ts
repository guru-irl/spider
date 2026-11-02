import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { paths } from '@spider/db-core';
import { effectiveHerdrConfigPath } from '../herdr/mount.js';

const savedGlobalRoot = paths.globalRoot;
const roots: string[] = [];
afterEach(async () => { paths.globalRoot = savedGlobalRoot; vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test.each(['herdr.config', 'herdr.enabled'])('shared session lookup warns about ignored %s once, including reload', async key => {
  await mkdir(resolve('.spider/scratch'), { recursive: true });
  const root = await mkdtemp(resolve('.spider/scratch/config-notice-')); roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  paths.globalRoot = join(root, 'global'); vi.stubEnv('SPIDER_GLOBAL_ROOT', paths.globalRoot);
  await mkdir(paths.globalRoot); await mkdir(join(root, '.spider'));
  await writeFile(join(root, '.spider/config.json'), JSON.stringify({ [key]: key === 'herdr.config' ? './untrusted.json' : true }));
  let session = 'first'; const messages: { text: string; level: string }[] = [];
  const manager = { getSessionId: () => session };
  const ctx = { cwd: root, hasUI: true, sessionManager: manager, ui: { notify: (text: string, level: string) => messages.push({ text, level }) } };
  const lookup = effectiveHerdrConfigPath as (cwd: string, ctx?: unknown) => string | null;
  lookup(root, ctx); vi.resetModules();
  const reloaded = await import('../herdr/mount.js'); reloaded.effectiveHerdrConfigPath(root, ctx as never);
  expect(messages).toHaveLength(1); expect(messages[0]).toEqual({ text: `Spider ignores the repository's ${key} setting. Move it to the global spider settings if you want to use it.`, level: 'warning' });
  session = 'second'; lookup(root, ctx);
  expect(messages).toHaveLength(2);
});

test.each(['herdr.config', 'herdr.enabled'])('lookup without context warns about ignored %s once per process', async key => {
  await mkdir(resolve('.spider/scratch'), { recursive: true });
  const root = await mkdtemp(resolve('.spider/scratch/child-config-notice-')); roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  paths.globalRoot = join(root, 'global'); vi.stubEnv('SPIDER_GLOBAL_ROOT', paths.globalRoot);
  await mkdir(paths.globalRoot); await mkdir(join(root, '.spider'));
  await writeFile(join(root, '.spider/config.json'), JSON.stringify({ [key]: key === 'herdr.config' ? './untrusted.json' : true }));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  effectiveHerdrConfigPath(root); effectiveHerdrConfigPath(root);
  expect(stderr.mock.calls.filter(([text]) => String(text).includes(key))).toEqual([[`Spider ignores the repository's ${key} setting. Move it to the global spider settings if you want to use it.\n`]]);
});
