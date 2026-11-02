// SPDX-License-Identifier: MIT
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const inside = (parent, child) => { const path = relative(parent, child); return path !== '' && !path.startsWith('..') && !path.startsWith('/'); };
export async function checkSpiderPanel({ appBinary, appHome, feed }) {
  const scratch = resolve('.spider/scratch'); appHome = resolve(appHome);
  if (!inside(scratch, appHome)) throw new Error('App check home must be fenced under project test data');
  const canonical = await realpath(scratch);
  if (canonical !== scratch) throw new Error('Project test root must be fenced without symlinks');
  let ancestor = appHome, actual;
  for (;;) {
    try { actual = await realpath(ancestor); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = dirname(ancestor); }
  }
  if (actual !== canonical && !inside(canonical, actual)) throw new Error('App check home must be fenced without outside symlinks');
  await mkdir(appHome, { recursive: true });
  if (await realpath(appHome) !== appHome) throw new Error('App check home must be fenced without symlinks');
  const probe = join(appHome, 'probe'); await mkdir(join(probe, 'shared'), { recursive: true });
  for (const file of ['main.js', 'data.js']) {
    await writeFile(join(probe, file === 'main.js' ? 'spider.js' : file), await readFile(new URL(`../../assets/mods/spider/${file}`, import.meta.url), 'utf8'));
  }
  await writeFile(join(probe, 'shared/feed.js'), await readFile(new URL('../../assets/shared/feed.js', import.meta.url), 'utf8'));
  await writeFile(join(probe, 'mod.json'), JSON.stringify({ place: 'none' }));
  await writeFile(join(probe, 'main.js'), `import Spider from './spider.js';
export default class Probe extends Spider {
  init(_props, cx) {
    this.config = {}; this.feeds = [${JSON.stringify(feed)}];
    this.feeds[0].updatedAt = Date.now(); this.feeds[0].lifecycle = 'live';
    this.errors = []; this.expanded = new Set([this.feeds[0].sessionId]); this.closed = false; this.view = { kind: 'home' }; this.dismissed = new Set();
    this.handle = cx.focus_handle(); this.actions = { openRun: async () => null };
  }
}
`);
  await writeFile(join(appHome, 'settings.json'), JSON.stringify({ core: '/usr/bin/false' }));
  for (const folder of ['state', 'config', 'tmp']) await mkdir(join(appHome, folder), { recursive: true });
  const result = await promisify(execFile)(appBinary, ['check', probe, '--print-spec'], {
    env: { ...process.env, HERDR_APP_HOME: appHome, XDG_STATE_HOME: join(appHome, 'state'), XDG_CONFIG_HOME: join(appHome, 'config'), TMPDIR: join(appHome, 'tmp'), HC_SESSION: 'panel-check' },
    timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  if (!(result.stdout + result.stderr).includes('check passed')) throw new Error('Native panel check returned no materialization proof');
  return result;
}
