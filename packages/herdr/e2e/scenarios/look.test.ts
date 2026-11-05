import { expect } from 'vitest';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';
import { HarnessError } from '../harness/environment.js';
import { installFresh } from '../native/installation.js';
import { validateInstalledLook } from '../native/installed-look.js';

export const scenarios: readonly ScenarioDefinition[] = [{
  id: storyId('S52'), title: 'First setup installs the neutral look, exact palette, fonts and unchanged paste mapping', tiers: ['headless', 'app'],
  async run(suite) {
    if (suite.options.tier === 'app') {
      await suite.evidence('native-first-load-prerequisite.json', { prerequisite: 'P2-native-rendered-ui-input-hook', coverage: 'installed documents are checked separately in headless; actual native first load and font readiness need the approved batch' });
      const app = await suite.app();
      await app.uiSnapshot();
      throw new HarnessError('missing-prerequisite', 'S52 native first load needs actual font readiness and approved rendered-state assertions; a snapshot alone is not acceptance');
    }
    // Synthetic pre-existing user key input, never the live user's keys or clipboard.
    const previousKeys = { terminal: { 'ctrl-v': 'clipboard-image.paste' }, global: { 'ctrl-shift-f': 'unchanged-search' } };
    await writeFile(join(suite.directories.HERDR_APP_HOME, 'keys.json'), JSON.stringify(previousKeys));
    const installation = await installFresh(suite);
    expect(installation.result.exitCode, 'first installed look must come from successful real setup').toBe(0);
    const installed = installation.installed;
    const readJson = async (path: string) => JSON.parse(await readFile(suite.ownPath(path), 'utf8')) as Record<string, unknown>;
    const observations = {
      appSettings: await readJson(join(installed.appHome, 'settings.json')),
      piSettings: await readJson(join(suite.directories.PI_CODING_AGENT_DIR, 'settings.json')),
      appTheme: await readJson(join(installed.appHome, 'themes/spider-glass.json')),
      piTheme: await readJson(join(suite.directories.PI_CODING_AGENT_DIR, 'themes/dracula-plus-glass.json')),
      layout: installed.layout.value,
      keys: await readJson(join(installed.appHome, 'keys.json')), previousKeys,
    };
    await suite.evidence('installed-look-observations.json', observations);
    await suite.evidence('installed-look-contrast.json', validateInstalledLook(observations));
    expect((observations.keys.global as Record<string, unknown>)['ctrl-shift-f']).toBe(previousKeys.global['ctrl-shift-f']);
    const fonts = ['GoogleSansFlex.ttf', 'GlassLabel-Bold.ttf'];
    for (const font of fonts) expect((await readFile(suite.ownPath(join(installed.appHome, 'fonts', font)))).length, `installed font ${font}`).toBeGreaterThan(1024);
    const checks: object[] = [];
    expect(Object.keys(installed.mods).filter(name => name.startsWith('spider-')).sort()).toEqual(['spider-agents', 'spider-chrome', 'spider-pane', 'spider-panel', 'spider-spaces', 'spider-tabs']);
    const retired = await lstat(suite.ownPath(join(installed.appHome, 'mods/spider-machines'))).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    expect(retired, 'retired machines mod must remain absent').toBeNull();
    for (const [name, directory] of Object.entries(installed.mods)) if (name.startsWith('spider-')) {
      const check = await installation.app.check(directory);
      checks.push({ name, directory, ...check });
      await suite.evidence('installed-native-checks.json', checks);
      expect(check.exitCode, `installed-check:${name}: ${check.stderr || check.stdout}`).toBe(0);
    }
    const bad = suite.ownPath(join(suite.root, 'bad-installed-look'));
    await mkdir(bad, { mode: 0o700 });
    const badFile = join(bad, 'spider-glass.json');
    await writeFile(badFile, JSON.stringify({ ...observations.appTheme, background: '#282a36' }));
    await expect(async () => validateInstalledLook({ ...observations, appTheme: await readJson(badFile) })).rejects.toThrow(/installed-look: app background/);
    await suite.evidence('installed-look-control.json', { result: 'caught', copy: badFile, mutation: 'tinted app background', assertion: 'installed-look: app background' });
    // Re-read the real installed theme to prove the control did not change it.
    expect(await readJson(join(installed.appHome, 'themes/spider-glass.json'))).toEqual(observations.appTheme);
    await suite.evidence('native-look-not-exercised.json', { coverage: 'actual installed files and headless checker; no native frame or live font-load acceptance', prerequisite: 'P2-native-rendered-ui-input-hook and the approved native batch' });
  },
}, {
  id: storyId('S53'), title: 'Native readability requires owned rendered readiness and targeted input', tiers: ['app'],
  async run(suite) {
    await suite.evidence('native-readability-prerequisite.json', { prerequisite: 'P2-native-rendered-ui-input-hook', blockedStates: ['narrow', 'wide', 'busy', 'error', 'long-name', 'empty', 'regular', 'fullscreen'], reason: 'app 0.1.11 cannot report actual rendered controls/readiness or target native events' });
    const app = await suite.app();
    await app.uiSnapshot();
    throw new HarnessError('missing-prerequisite', 'S53 needs the approved native batch and all populated state/contrast assertions; an available snapshot alone is not native acceptance');
  },
}];
