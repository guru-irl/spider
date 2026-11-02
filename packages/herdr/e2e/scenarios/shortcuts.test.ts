import { expect } from 'vitest';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';
import type { InteractiveDriver } from '../harness/pi.js';
import { deadline, waitFor } from '../harness/wait.js';
import { identityOf, rootProcesses } from '../harness/resources.js';
import { HarnessError } from '../harness/environment.js';

const bindings = [
  { name: 'agents', bytes: '\x1b[97;6u', view: /No active spider agents/ },
  { name: 'todos', bytes: '\x1b[111;6u', view: /Todos/ },
  { name: 'usage', bytes: '\x1b[117;6u', view: /Usage dashboard opened/ },
  { name: 'approvals', bytes: '\x1b[109;6u', view: /\[\]/ },
  { name: 'triggers', bytes: '\x1b[107;6u', view: /No triggers are active/ },
] as const;
// Independent terminal-text extraction, never product projection functions.
const text = (bytes: Buffer) => bytes.toString('utf8').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0e-\x1f]/g, '');
async function view(pi: InteractiveDriver, name: string, offset: number, expected: RegExp, ms = 20_000): Promise<string> {
  try { return await waitFor(`shortcut-${name} real rendered output`, async () => text((await pi.rawOutput()).subarray(offset)), value => expected.test(value), deadline(ms)); }
  catch (error) { throw new Error(`shortcut-${name}: expected actual view ${expected}; ${String(error)}`); }
}
async function configure(suite: Suite): Promise<void> {
  await suite.app();
  if (!suite.appConnection || !suite.cores) throw new Error('missing-prerequisite: receiving shortcuts need the supervised fake app and isolated core');
  const path = suite.ownPath(join(suite.root, 'shortcuts-herdr.json'));
  await writeFile(path, JSON.stringify({ enabled: 'auto', app: { binary: suite.appConnection.binary, home: suite.directories.HERDR_APP_HOME }, core: { binary: suite.cores.wrapper, config: join(suite.directories.XDG_CONFIG_HOME, 'herdr-core/config.toml') }, agentDirectory: suite.directories.PI_CODING_AGENT_DIR, globalRoot: suite.directories.SPIDER_GLOBAL_ROOT, shellRc: join(suite.root, 'rc'), spaces: [], machines: [] }));
  const global = join(suite.directories.SPIDER_GLOBAL_ROOT, 'config.json');
  const config = JSON.parse(await readFile(global, 'utf8')) as Record<string, unknown>;
  config['herdr.enabled'] = true; config['herdr.config'] = path;
  await writeFile(global, JSON.stringify(config));
}

export const scenarios: readonly ScenarioDefinition[] = [{
  id: storyId('S54'), title: 'Five receiving shortcuts preserve a multibyte draft/cursor and fullscreen search', tiers: ['headless', 'app'],
  async run(suite) {
    if (suite.options.tier === 'app') {
      const app = await suite.app();
      await suite.evidence('native-shortcut-prerequisite.json', { prerequisite: 'P2-native-rendered-ui-input-hook', operation: 'keyToOwnedWindow', coverage: 'native Cmd translation is blocked; receiving pi behavior is covered separately in headless' });
      await app.keyToOwnedWindow('cmd-shift-a');
      throw new HarnessError('missing-prerequisite', 'native shortcut acceptance also requires all five CSI-u byte observations and actual receiving UI in the approved batch');
    }
    await configure(suite);
    const browserLog = suite.ownPath(join(suite.root, 'browser-boundary.log'));
    for (const name of ['open', 'xdg-open']) {
      const opener = suite.ownPath(join(suite.root, 'bin', name));
      await writeFile(opener, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${browserLog}'\n`); await chmod(opener, 0o700);
    }
    const settingsPath = join(suite.directories.PI_CODING_AGENT_DIR, 'settings.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    settings.tuiMode = 'fullscreen'; await writeFile(settingsPath, JSON.stringify(settings));
    const project = await suite.project('shortcuts');
    const driver = await suite.launchPi({ mode: 'interactive', cwd: project }) as InteractiveDriver;
    const observations: object[] = [], failures: string[] = [];
    const ownProductDaemons = () => {
      const ledger = suite.ledger.read(), known = new Set(ledger.processes.map(p => p.pid));
      for (const owned of rootProcesses(suite.root, [ledger.watchdog!.pid])) if (!known.has(owned.pid)) suite.ledger.update(l => l.processes.push({ ...identityOf(owned.pid), label: 'owned-shortcut-product-daemon', group: false }));
    };
    try {
      await driver.waitEvent('session_start', e => e.mode === 'tui', deadline(60_000));
      const draft = 'before 日本 after';
      const resetDraft = async () => {
        await driver.key('\x01\x0b'); await driver.key(draft);
        await waitFor('owned pi receives multibyte draft', () => driver.draft(), value => value === draft, deadline(10_000));
        await driver.key('\x1b[D\x1b[D\x1b[D');
      };
      for (const binding of bindings) {
        await resetDraft();
        const offset = (await driver.rawOutput()).length;
        try {
          await driver.key(binding.bytes);
          const output = await view(driver, binding.name, offset, binding.view);
          await driver.key('\x1b[27u'); // Unambiguous Escape releases a real overlay.
          await driver.key('!');
          await waitFor(`${binding.name} draft and cursor preserved`, () => driver.draft(), value => value === 'before 日本 af!ter', deadline(3000));
          observations.push({ shortcut: binding.name, bytes: binding.bytes, output, draft: await driver.draft(), result: 'passed' });
        } catch (error) {
          failures.push(`${binding.name}: ${String(error)}`);
          observations.push({ shortcut: binding.name, bytes: binding.bytes, output: text((await driver.rawOutput()).subarray(offset)), draft: await driver.draft(), result: 'failed', error: String(error), details: (error as { details?: unknown }).details });
          await driver.key('\x1b[27u');
        } finally { ownProductDaemons(); }
        await suite.evidence('receiving-shortcut-subcases.json', observations);
      }
      await resetDraft();
      const offset = (await driver.rawOutput()).length;
      await driver.key('\x1b[102;6u');
      let search = '';
      try {
        search = await view(driver, 'fullscreen-search', offset, /Find in transcript/);
        await driver.key('\x1b[27u'); await driver.key('!');
        await waitFor('fullscreen search keeps draft and cursor', () => driver.draft(), value => value === 'before 日本 af!ter', deadline(3000));
      } catch (error) { failures.push(`fullscreen-search: ${String(error)}`); }
      await suite.evidence('receiving-shortcuts.json', { scope: 'real pi PTY receiving side; actual empty view states; native Cmd translation not exercised', observations, search });
      const url = new URL((await readFile(browserLog, 'utf8')).trim());
      expect(['127.0.0.1', 'localhost', '[::1]']).toContain(url.hostname);
      await suite.evidence('usage-browser-boundary.json', { origin: url.origin, openedRealBrowser: false });
      await suite.evidence('fullscreen-settings.json', settings);
    } finally { ownProductDaemons(); await suite.evidence('receiving-shortcuts.raw', await driver.rawOutput()); await driver.close(); }
    const bad = await suite.launchPi({ mode: 'interactive', cwd: project }) as InteractiveDriver;
    try {
      await bad.waitEvent('session_start', e => e.mode === 'tui', deadline(60_000));
      const controls: object[] = [];
      for (const binding of bindings) {
        const offset = (await bad.rawOutput()).length;
        await bad.key('\x1b[122;6u');
        await expect(view(bad, binding.name, offset, binding.view, 1000)).rejects.toThrow(new RegExp(`shortcut-${binding.name}:`));
        controls.push({ result: 'caught', expectedBytes: binding.bytes, wrongBytes: '\x1b[122;6u', actualOutput: text((await bad.rawOutput()).subarray(offset)) });
      }
      await suite.evidence('wrong-receiving-key-controls.json', controls);
    } finally { await bad.close(); }
    if (failures.length) throw new Error(failures.join('\n'));
  },
}];
