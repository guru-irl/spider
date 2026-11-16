import { expect, it } from 'vitest';
import { loadPublishedSpacesARecipe, loadSpacesAFiles, replaySpacesARecipe } from './spaces-a-fixture.js';
import { parkFocusedTerminal } from '../../assets/pane/park.js';
import { HerdrLabelContract } from '../contracts.js';
import * as look from '../../assets/shared/look.js';
import { middlePath } from '../../assets/shared/feed.js';

for (const version of ['0.1.13', '0.1.16'] as const) {
  it(`${version}: only the focused header parks once and session close still confirms`, async () => {
    const recipe = loadPublishedSpacesARecipe(version);
    const source = replaySpacesARecipe(version, loadSpacesAFiles(version), recipe.aFragments, recipe).pane!['main.js']!;
    const commands: unknown[] = [], overlays: any[] = [];
    const terminal = { address: 't1', state: 'live' as const, labels: { 'spider.kind': 'session' } };
    const focus = { pane: 'p1', terminal: 't1' };
    const ports = { View: class {}, ...look, middlePath, parkFocusedTerminal,
      herdrApi: { focused: () => focus, terminals: () => [terminal] },
      props: () => ({ labelContract: HerdrLabelContract }), terminals: () => [terminal],
      run: (name: string, args: unknown) => { commands.push([name, args]); return null; },
      nextCommand: () => { ports.nextCommand = () => new Promise<string>(() => {}); return Promise.resolve('park'); },
      openOverlay: (value: unknown) => overlays.push(value),
    };
    const code = source.replace(/\/\* spider-look:[a-z0-9-]+ \*\//g, '').replace(/^import .*;\s*$/gm, '').replace('export default class ', 'class ');
    const name = /class (\w+) extends View/.exec(code)![1];
    const create = () => new (new Function('ports', `const { ${Object.keys(ports).join(',')} } = ports; ${code}; return ${name};`)(ports))();
    for (const focused of [false, true, false]) {
      ports.nextCommand = (() => { let sent = false; return () => sent ? new Promise<string>(() => {}) : (sent = true, Promise.resolve('park')); })();
      const view = create(); view.me = () => ({ pane: focused ? 'p1' : 'p2', terminal: 't1', focused, app: 'pi' });
      view.init({}, { spawn: (fn: any) => fn({ notify() {} }) });
      await Promise.resolve(); await Promise.resolve();
      if (focused) view.closePane({ pane: 'p1' });
    }
    expect(commands).toEqual([['terminal.park', { terminal: 't1' }]]);
    expect(overlays).toHaveLength(1);
    expect(overlays[0].props.command).toEqual({ name: 'pane.close', args: { pane: 'p1' } });
  });
}
