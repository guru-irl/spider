// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it } from 'vitest';
import { loadPublishedSpacesARecipe, loadSpacesAFiles, replaySpacesARecipe } from './spaces-a-fixture.js';
import { parkFocusedTerminal } from '../../assets/pane/park.js';
import { HerdrLabelContract } from '../contracts.js';
import * as look from '../../assets/shared/look.js';
import { middlePath } from '../../assets/shared/feed.js';

for (const version of ['0.1.13', '0.1.16'] as const) {
  it.each(['remote', 'proxy']) (`${version}: Send back key refuses a %s pane with a notice`, async kind => {
    const recipe = loadPublishedSpacesARecipe(version);
    const source = replaySpacesARecipe(version, loadSpacesAFiles(version), recipe.aFragments, recipe).pane!['main.js']!;
    const commands: unknown[] = [], notices: unknown[] = [];
    const terminal = kind === 'remote' ? { address: 'box-1.invalid/t2', state: 'live' as const, labels: { 'spider.kind': 'session' } }
      : { address: 'proxy', state: 'live' as const, labels: { 'spider.kind': 'roam-proxy' } };
    const focus = { pane: 'p2', terminal: terminal.address };
    const ports = { View: class {}, ...look, middlePath, parkFocusedTerminal,
      herdrApi: { focused: () => focus, terminals: () => [terminal], notify: (notice: unknown) => notices.push(notice) },
      props: () => ({ labelContract: HerdrLabelContract }), terminals: () => [terminal],
      run: (name: string, args: unknown) => { commands.push([name, args]); return null; },
      nextCommand: (() => { let sent = false; return () => sent ? new Promise<string>(() => {}) : (sent = true, Promise.resolve('park')); })(),
    };
    const code = source.replace(/\/\* spider-look:[a-z0-9-]+ \*\//g, '').replace(/^import .*;\s*$/gm, '').replace('export default class ', 'class ');
    const name = /class (\w+) extends View/.exec(code)![1];
    const view = new (new Function('ports', `const { ${Object.keys(ports).join(',')} } = ports; ${code}; return ${name};`)(ports))();
    view.me = () => ({ pane: focus.pane, terminal: focus.terminal, focused: true, app: 'pi' });
    view.init({}, { spawn: (fn: any) => fn({ notify() {} }) });
    await Promise.resolve(); await Promise.resolve();
    expect(commands).toEqual([]);
    expect(notices).toContainEqual(expect.objectContaining({ title: "Send back works only for this computer's panes for now" }));
  });

  it(`${version}: Send back menu refuses a remote pane and keeps local menu behavior`, () => {
    const recipe = loadPublishedSpacesARecipe(version);
    const source = replaySpacesARecipe(version, loadSpacesAFiles(version), recipe.aFragments, recipe).menu!['main.js']!;
    const commands: unknown[] = [], notices: any[] = [];
    let target = 'box-1.invalid/t2', proxy = false;
    const terminals = () => [{ address: target, parent: target.includes('/') ? 'box-1.invalid/t1' : 't1', labels: proxy ? { 'spider.kind': 'roam-proxy' } : {} },
      { address: target.includes('/') ? 'box-1.invalid/t1' : 't1', name: 'Owner', labels: {} }];
    const ports = { View: class {}, run: (name: string, args: unknown) => commands.push([name, args]),
      notify: (value: unknown) => notices.push(value), props: () => ({ tab: 'pane', target: { pane: 'p2', terminal: target }, overlay: 'overlay' }),
      closeOverlay() {}, openOverlay() {}, terminals, spaces: () => [], panes: () => [], keys: () => [] };
    const code = source.replace(/\/\* spider-look:[a-z0-9-]+ \*\//g, '').replace(/^import .*;\s*$/gm, '').replace('export default class ', 'class ');
    const api = new Function('ports', `const { ${Object.keys(ports).join(',')} } = ports; ${code}; return { Menu, items };`)(ports);
    const menu = new api.Menu();
    const choose = () => menu.choose(api.items(ports.props(), null).findIndex((item: any[]) => item[1] === 'terminal.park'), {});
    choose();
    expect(commands).toEqual([]);
    expect(notices).toContainEqual(expect.objectContaining({ title: "Send back works only for this computer's panes for now" }));
    target = 'proxy'; proxy = true; choose();
    expect(commands).toEqual([]);
    expect(notices).toHaveLength(2);
    target = 't2'; proxy = false; choose();
    expect(commands).toEqual([['terminal.park', { terminal: 't2' }]]);
  });
}
