import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRenderHost } from '../render-host.js';

const hosts: any[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); });
function mod(source: string): string {
  const root = resolve('.spider/scratch/e2'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'render-')); writeFileSync(join(dir, 'main.js'), source); return dir;
}
const theme = () => ({ foreground: '#f8f8f2', dim: '#b4b4ba' });
describe('strict fake-app render host', () => {
  it('executes the installed module init and its real registered handler, then observes rerender', async () => {
    const dir = mod(`import {View,div} from 'gpui-kit'; import {Button} from 'gpui-base'; import {readTextFile,run,theme,props} from 'herdr';
      export default class Panel extends View {
        init(_props,cx) { this.count=0; this.message='Loading'; cx.spawn(async next=>{ this.message=await readTextFile(props().path); next.notify(); }); }
        render(cx) { return div().id('root').text_color(theme().foreground).child(this.message).child(Button.new('increment').child('Count '+this.count).on_click((event,next)=>{ this.count++; run('layout.show',{id:'panel'}); next.notify(); })); }
      }`);
    const emitted: unknown[] = [];
    let release!: () => void;
    const external = new Promise<string>(resolve => { release = () => resolve('Actual external input'); });
    const host = await createRenderHost({ installedDirectory: dir, props: { path: 'owned-file' }, api: { readTextFile: () => external, theme, run: (name: string, args: unknown) => { emitted.push({ name, args }); } } }); hosts.push(host);
    expect((await host.uiSnapshot()).nodes.find((n: any) => n.id === 'root')?.text).toContain('Loading');
    release();
    await host.waitForUi('external row', ui => ui.nodes.some(n => n.text.includes('Actual external input')), 2000);
    await host.activate('increment');
    expect((await host.uiSnapshot()).nodes.find((n: any) => n.id === 'increment')).toMatchObject({ text: 'Count 1', enabled: true });
    expect(emitted).toEqual([{ name: 'layout.show', args: { id: 'panel' } }]);
    await expect(host.activate('unknown-control')).rejects.toThrow(/unknown control/);
  });
  it('forwards native sidebar storage and rerenders externally changed shared state', async () => {
    const dir = mod(`import {View,div,image} from 'gpui-kit'; import {props,shared,setShared} from 'herdr';
      export default class Panel extends View { init(){localStorage.setItem('pins',JSON.stringify([props().modId]));}
        render(){return div().id('root').child(localStorage.getItem('pins')).child(div().id('filter').child(shared('filter')||'All').on_hover(()=>{}).on_click((_e,cx)=>{cx.stop_propagation();setShared('filter','selected');})).child(image('owned-icon').size(14));} }`);
    let selected: unknown = null; const values = new Map<string, string>();
    const host = await createRenderHost({ installedDirectory: dir, props: { modId: 'sidebar-a' }, storage: { getItem: k => values.get(k) ?? null, setItem: (k,v) => { values.set(k,v); } }, api: { props: () => ({modId:'sidebar-a'}), shared: () => selected, setShared: (_k,v) => { selected=v; } } }); hosts.push(host);
    expect((await host.uiSnapshot()).nodes.find(n=>n.id==='root')?.text).toContain('["sidebar-a"]');
    await host.activate('filter'); expect((await host.uiSnapshot()).nodes.find(n=>n.id==='filter')?.text).toBe('selected');
    selected='external-change'; host.invalidate(); expect((await host.uiSnapshot()).nodes.find(n=>n.id==='filter')?.text).toBe('external-change');
  });
  it('passes {} to init and serves the layout props only through props(), as Herdr 0.1.11 does', async () => {
    const dir = mod(`import {View,div} from 'gpui-kit'; import {props} from 'herdr';
      export default class Panel extends View { init(first){this.first=JSON.stringify(first);}
        render(){return div().id('root').child(this.first+' '+props().feedRoot);} }`);
    const host = await createRenderHost({ installedDirectory: dir, props: { feedRoot: '/owned/feeds' }, api: {} }); hosts.push(host);
    expect((await host.uiSnapshot()).nodes.find(n => n.id === 'root')?.text).toBe('{} /owned/feeds');
  });
  it('snapshots a tracked native focus handle as an opaque identity and still invokes real controls', async () => {
    const dir = mod(`import {View,div} from 'gpui-kit'; import {Button} from 'gpui-base'; import {run} from 'herdr';
      export default class Panel extends View { init(_props,cx){this.handle=cx.focus_handle();}
        render(){return div().id('tracked').track_focus(this.handle).bg('#161618').border_b(1).child(Button.new('focus').child('Focus action').on_click(()=>run('pane.focus',{terminal:'owned'})));} }`);
    const emitted: unknown[] = [];
    const host = await createRenderHost({ installedDirectory: dir, props: {}, api: { run: (name, args) => { emitted.push({ name, args }); } } }); hosts.push(host);
    const first = await host.uiSnapshot();
    expect(first.nodes.find(n => n.id === 'tracked')).toMatchObject({ text: 'Focus action', attributes: { track_focus: ['focus-0'], bg: ['#161618'], border_b: [1] } });
    first.nodes[0].text = 'detached snapshot edit';
    expect((await host.uiSnapshot()).nodes[0].text).toBe('Focus action');
    await host.activate('focus');
    expect(emitted).toEqual([{ name: 'pane.focus', args: { terminal: 'owned' } }]);
  });
  it('awaits the returned native click task but not unrelated init work', async () => {
    const dir = mod(`import {View,div} from 'gpui-kit'; import {exec} from 'herdr';
      export default class Panel extends View { init(_p,cx){this.value='Before';cx.spawn(()=>new Promise(()=>{}));}
        render(){return div().id('action').child(this.value).on_click((_e,cx)=>cx.spawn(async cx=>{const r=await exec('owned-command',[]);this.value=r.stdout;cx.notify();}));} }`);
    let release!: (value: { stdout: string }) => void, started!: () => void;
    const external = new Promise<{ stdout: string }>(resolve => { release = resolve; });
    const executing = new Promise<void>(resolve => { started = resolve; });
    const host = await createRenderHost({ installedDirectory: dir, props: {}, api: { exec: () => { started(); return external; } } }); hosts.push(host);
    let complete = false;
    const activation = host.activate('action').then(() => { complete = true; });
    await executing;
    expect(complete).toBe(false);
    release({ stdout: 'Actual completed effect' });
    await activation;
    expect((await host.uiSnapshot()).nodes.find(n => n.id === 'action')?.text).toBe('Actual completed effect');
  });
  it('provides actual UTF-8 encoding APIs to installed IPC helpers', async () => {
    const dir = mod(`import {View,div} from 'gpui-kit'; export default class Panel extends View { render(){const bytes=new TextEncoder().encode('界🙂');return div().id('utf8').child(new TextDecoder().decode(bytes)).child(String(bytes.length));} }`);
    const host = await createRenderHost({ installedDirectory: dir, props: {}, api: {} }); hosts.push(host);
    expect((await host.uiSnapshot()).nodes.find(n => n.id === 'utf8')?.text).toBe('界🙂 7');
  });
  it('permits a registered popup action to close its own host while refusing later input', async () => {
    const dir = mod(`import {View,div} from 'gpui-kit'; import {closeOverlay} from 'herdr'; export default class Panel extends View {render(){return div().id('dismiss').on_click(()=>closeOverlay('owned'));}}`);
    let close!: () => Promise<void>;
    const host = await createRenderHost({ installedDirectory: dir, props: {}, api: { closeOverlay: () => close() } }); hosts.push(host); close = () => host.close();
    await expect(host.activate('dismiss')).resolves.toBeUndefined();
    await expect(host.activate('dismiss')).rejects.toThrow(/render host is closed/);
    await expect(host.uiSnapshot()).rejects.toThrow(/render host is closed/);
  });
  it('refuses a forged native focus handle instead of dropping uncloneable attributes', async () => {
    const dir = mod(`import {View,div} from 'gpui-kit'; export default class Panel extends View {render(){return div().track_focus({focus(){}});}}`);
    await expect(createRenderHost({ installedDirectory: dir, props: {}, api: {} })).rejects.toMatchObject({ code: 'invalid-focus-handle' });
  });
  it('refuses disabled controls and unimplemented Herdr APIs rather than succeeding', async () => {
    const dir = mod(`import {View,div} from 'gpui-kit'; import {Button} from 'gpui-base'; import {run} from 'herdr';
      export default class Panel extends View { render(){return div().child(Button.new('disabled').disabled(true).child('Unavailable').on_click(()=>run('pane.focus',{terminal:'foreign'})));} }`);
    const host = await createRenderHost({ installedDirectory: dir, props: null, api: {} }); hosts.push(host);
    await expect(host.activate('disabled')).rejects.toThrow(/disabled control/);
    const unsupported = mod(`import {View,div} from 'gpui-kit'; import {exec} from 'herdr'; export default class Panel extends View { init(){exec('unexpected',[]);} render(){return div();} }`);
    await expect(createRenderHost({ installedDirectory: unsupported, props: {}, api: {} })).rejects.toThrow(/unimplemented Herdr API: exec/);
  });
  it('refuses unsupported widget APIs and duplicate control IDs', async () => {
    const bad = mod(`import {View,div} from 'gpui-kit'; export default class Panel extends View {render(){return div().pretend_success();}}`);
    await expect(createRenderHost({ installedDirectory: bad, props: {}, api: {} })).rejects.toThrow(/unimplemented widget API/);
    const duplicate = mod(`import {View,div} from 'gpui-kit'; export default class Panel extends View {render(){return div().child(div().id('same')).child(div().id('same'));}}`);
    await expect(createRenderHost({ installedDirectory: duplicate, props: {}, api: {} })).rejects.toThrow(/duplicate control id/);
  });
});
