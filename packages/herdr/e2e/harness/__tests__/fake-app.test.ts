import { describe, expect, it, vi } from 'vitest';
import { createFakeAppBoundary, stageFakeAppDaemon } from '../fake-app.js';
import { createConnection, createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawnOwned } from '../processes.js';
import { waitFor, deadline } from '../wait.js';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSuite } from '../suite.js';
import { storyId } from '../scenario.js';

// These are boundary characterization inputs, not product-story state.
function coreBoundary() {
  const rows: Record<string, any> = {};
  const calls: string[][] = [];
  let next = 0;
  let failKeep = false;
  const hc = async (argv: readonly string[]): Promise<unknown> => {
    calls.push([...argv]);
    if (argv[0] === 'run') {
      const address = `t${++next}`;
      const labels: Record<string, string> = {};
      for (let i = 0; i < argv.length; i++) if (argv[i] === '--label') { const [k, v] = argv[++i].split('='); labels[k] = v; }
      rows[address] = { address, labels, state: 'live', name: null, status: null, parent: null };
      return { address };
    }
    if (argv[0] === 'ls') return { hidden_finished: 0, machines: [], terminals: Object.values(rows).map(r => ({ address: r.address, state: r.state, agent: 'sh', cwd: '/owned/project', turn: 0 })) };
    const row = rows[argv[1]];
    if (!row) throw new Error('terminal not found');
    if (argv[0] === 'get') return row;
    if (argv[0] === 'label') { for (const label of argv.slice(2).filter(v => v !== '--json')) { const [k, v] = label.split('='); if (v === '') delete row.labels[k]; else row.labels[k] = v; } return { ok: true }; }
    if (argv[0] === 'keep') { if (failKeep) throw new Error('keep failed'); row.keep = !argv.includes('--off'); return { ok: true }; }
    if (argv[0] === 'kill') { row.state = 'finished'; return { ok: true }; }
    if (argv[0] === 'rm') { delete rows[argv[1]]; return { ok: true }; }
    throw new Error('unimplemented hc boundary');
  };
  return { hc, calls, rows, fail: () => { failKeep = true; } };
}
describe('strict fake app against the core boundary', () => {
  it('runs the bundled daemon protocol and rejects unknown, malformed, and repeated request data', async () => {
    const scratch = resolve('.spider/scratch/e2'); mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(join(scratch, 'd-'));
    const artifact = await stageFakeAppDaemon(root, p => p);
    const daemon = await import(pathToFileURL(artifact.module).href);
    expect(daemon.cliArgs(['do','space.select','--index','2'])).toEqual({name:'space.select',args:{index:2}});
    expect(daemon.cliArgs(['do', 'pane.focus', '{"terminal":"t1"}'])).toEqual({ name: 'pane.focus', args: { terminal: 't1' } });
    expect(() => daemon.cliArgs(['do', 'pane.focus', '{"typo":"t1"}'])).toThrow(/unknown argument/);
    const boundary = createFakeAppBoundary({ hc: async () => { throw new Error('no core call expected'); } });
    const socket = join(root, 'a.sock'); const server = daemon.serveBoundary(socket, boundary); await server.listen();
    const request = (bytes: string) => new Promise<any>((resolve, reject) => {
      const c = createConnection(socket); let result = '';
      c.on('connect', () => c.write(bytes)); c.on('data', b => { result += b; }); c.on('error', reject);
      c.on('end', () => { c.destroy(); try { resolve(JSON.parse(result)); } catch (e) { reject(e); } });
    });
    try {
      expect(await request(JSON.stringify({ requestId: 'bad-name', name: 'terminal.send', args: {} })+'\n')).toMatchObject({ result: { error: expect.stringContaining('unknown command') } });
      expect(await request(JSON.stringify({ requestId: 'bad-args', name: 'tab.rename', args: { typo: 'wrong' } })+'\n')).toMatchObject({ result: { error: expect.stringContaining('unknown argument') } });
      expect(await request('{broken\n')).toMatchObject({ result: { error: expect.any(String) } });
      expect(await request('{"requestId":"one","name":"ls","args":{}}\n{}\n')).toMatchObject({ error: 'one app request per connection' });
    } finally { await server.close(); }
  });
  it('retains actual CLI argv and elapsed time even when its owned process is signalled', async () => {
    const suite = await createSuite({ tier: 'ci', story: storyId('H-app-cli-timing') });
    const artifact = await stageFakeAppDaemon(suite.root, suite.ownPath), daemon = await import(pathToFileURL(artifact.module).href);
    let release!: () => void;
    const held = new Promise<Record<string, unknown>>(resolve => { release = () => resolve({ ok: true }); });
    const socket = artifact.socket;
    const boundary = createFakeAppBoundary({ hc: coreBoundary().hc });
    const server = daemon.serveBoundary(socket, { command: (name: string, args: Record<string, unknown>) => name === 'status' ? held : boundary.command(name, args), drain: boundary.drain }); await server.listen();
    const env = { ...suite.env, SPIDER_HERDR_E2E_APP_ROOT: suite.root, SPIDER_HERDR_E2E_APP_SOCKET: socket };
    const trace = join(suite.root, 'app-cli-timing.jsonl');
    const rows = (): { pid: number; phase: string; argv: string[]; startedAt: number; finishedAt?: number; durationMs?: number; signal?: string }[] => readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    try {
      const completed = await suite.invoke(artifact.binary, ['ls'], env); expect(completed.exitCode, completed.stderr || completed.stdout).toBe(0);
      const normal = rows().find(row => row.phase === 'finished')!;
      expect(normal.argv).toEqual(['ls']); expect(normal.finishedAt! - normal.startedAt).toBe(normal.durationMs);
      const waiting = spawnOwned(suite.ledger, { label: 'timed-app-cli', command: process.execPath, args: [artifact.module, 'status'], cwd: suite.root, env, stdio: 'pipe' }); waiting.child.stdin!.end();
      await waitFor('actual CLI trace starts before the held request finishes', rows, value => value.some(row => row.pid === waiting.identity.pid && row.phase === 'started'), deadline(5000));
      waiting.child.kill('SIGTERM'); expect((await waiting.exited).signal).toBe('SIGTERM');
      const ended = rows().find(row => row.pid === waiting.identity.pid && row.phase === 'signalled')!;
      expect(ended.argv).toEqual(['status']); expect(ended.signal).toBe('SIGTERM');
      expect(ended.finishedAt! - ended.startedAt).toBe(ended.durationMs);
      expect(ended.durationMs).toBeGreaterThanOrEqual(0);
    } finally { release(); await server.close(); await suite.close(); }
  });
  it('rejects malformed UTF-8 replies rather than accepting a repaired empty acknowledgement', async () => {
    const scratch = resolve('.spider/scratch/e2'); const root = mkdtempSync(join(scratch, 'b-'));
    const artifact = await stageFakeAppDaemon(root, p => p), daemon = await import(pathToFileURL(artifact.module).href);
    const socket = join(root, 'b.sock');
    const server = createServer(c => { c.once('data', bytes => { const id = JSON.parse(bytes.toString()).requestId; const [before, after] = JSON.stringify({ requestId: id, result: { ok: true, detail: 'BROKEN' } }).split('BROKEN'); c.end(Buffer.concat([Buffer.from(before), Buffer.from([0xff]), Buffer.from(after+'\n')])); }); });
    await new Promise<void>(resolve => server.listen(socket, resolve));
    try { await expect(daemon.appRequest(socket, 'tab.rename', { id: 'tb1', name: 'A' })).rejects.toThrow(/UTF-8/); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('creates a temporary mod tab without a shell and removes only its mod pane', async () => {
    const core = coreBoundary(), boundary = createFakeAppBoundary({ hc: core.hc });
    const main = await boundary.command('space.new', { name: 'Work', folder: '/owned/project', argv: ['/bin/sh'] });
    const runsBefore = core.calls.filter(argv => argv[0] === 'run').length;
    const tab = await boundary.command('tab.new', { space: main.space, mod: 'pane' });
    expect(tab).toMatchObject({ space: main.space, tab: expect.any(String), pane: expect.any(String) });
    expect(core.calls.filter(argv => argv[0] === 'run')).toHaveLength(runsBefore);
    const parked = await core.hc(['run']) as { address: string };
    await core.hc(['label', parked.address, `herdr.space=${main.space}`, `herdr.tab=${tab.tab}`]);
    const before = await boundary.command('ls', {}) as any;
    expect(before.spaces[0].tabs.find((value: any) => value.id === tab.tab).terminals.map((value: any) => value.terminal)).toEqual([parked.address]);
    await boundary.command('pane.close', { pane: tab.pane });
    const after = await boundary.command('ls', {}) as any;
    expect(after.spaces[0].tabs.find((value: any) => value.id === tab.tab).terminals.map((value: any) => value.terminal)).toEqual([parked.address]);
    expect(core.calls.some(argv => argv[0] === 'kill' && argv[1] === parked.address)).toBe(false);
  });
  it('peeks an existing native pane without launching or rewriting a terminal', async () => {
    const core = coreBoundary(), boundary = createFakeAppBoundary({ hc: core.hc });
    const first = await boundary.command('space.new', { name: 'First', folder: '/owned/project', argv: ['/bin/sh'] });
    await boundary.command('space.new', { name: 'Second', folder: '/owned/other', argv: ['/bin/sh'] });
    const before = core.calls.length;
    expect(await boundary.command('terminal.peek', { terminal: first.terminal })).toEqual({ ok: true });
    expect(await boundary.command('status', {})).toMatchObject({ space: first.space, tab: first.tab, agent: first.terminal });
    expect(core.calls.slice(before).every(argv => ['get', 'ls'].includes(argv[0]))).toBe(true);
    const unplaced = await core.hc(['run']);
    await expect(boundary.command('terminal.peek', { terminal: (unplaced as { address: string }).address })).rejects.toThrow(/unplaced|unsupported/i);
  });
  it('creates and parks actual terminals on the proved isolated hc core', async () => {
    const suite = await createSuite({ tier: 'headless', story: storyId('H-app-boundary') });
    try {
      const boundary = createFakeAppBoundary({ hc: async argv => { const r = await suite.hc(argv); await suite.evidence(`core-${argv[0]}.json`, { argv, reply: r.json }); if (r.exitCode !== 0) throw new Error(r.stderr); return r.json; } });
      const main = await boundary.command('space.new', { name: 'Workshop', folder: suite.root, argv: ['/bin/sh', '-c', 'printf boundary-ready; exec cat'] });
      const address = String(main.terminal); const original: any = (await boundary.command('ls', {})).spaces;
      const launched = await suite.hc(['run', '--json', '--bg', '--no-notify', '--no-parent', '--label', `herdr.space=${main.space}`, '--label', `herdr.tab=${main.tab}`, '--', '/bin/sh', '-c', 'printf auxiliary-ready; exec cat']);
      expect(launched.exitCode).toBe(0); const auxiliary = (launched.json as any).address;
      const adopted: any = (await boundary.command('ls', {})).spaces;
      expect(adopted[0].tabs[0].terminals.map((p: any) => p.terminal)).toEqual([address, auxiliary]);
      expect(adopted[0].tabs[0].terminals[0]).toEqual(original[0].tabs[0].terminals[0]);
      expect(await boundary.command('terminal.park', { terminal: auxiliary })).toEqual({ pending: true, terminal: auxiliary }); await boundary.drain();
      const world: any = await boundary.command('ls', {});
      expect(world.spaces[0].tabs[0].terminals.map((p: any) => p.terminal)).toEqual([address]);
      const actual: any = (await suite.hc(['get', auxiliary, '--json'])).json;
      expect(actual.state).toBe('live'); expect(actual.labels).not.toHaveProperty('herdr.space'); expect(actual.labels).not.toHaveProperty('herdr.tab');
      const records = await suite.cores!.records();
      expect(records.filter(r => ['kill', 'rm', 'label', 'keep', 'send'].includes(r.argv[0]) && r.argv[1] === address)).toEqual([]);
      await suite.evidence('app-boundary-real.json', { main, original, adopted, world, actual, records });
    } finally { const proof = await suite.close(); expect(proof.clean).toBe(true); }
  });
  it('reads other terminal inventory while one terminal read is held, preserving placement order', async () => {
    const core = coreBoundary(); let release!: () => void, secondRead = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const app = createFakeAppBoundary({ hc: async argv => {
      if (argv[0] === 'get' && argv[1] === 't1') await held;
      if (argv[0] === 'get' && argv[1] === 't2') secondRead = true;
      return core.hc(argv);
    } });
    const first = await app.command('space.new', { name: 'Workshop', argv: ['pi'] });
    await app.command('tab.new', { space: first.space, argv: ['pi'] });
    const pending = app.command('ls', {});
    try {
      await vi.waitFor(() => expect(secondRead, 'an unrelated inventory read is blocked behind t1').toBe(true), { timeout: 500 });
    } finally { release(); await app.drain(); }
    const world: any = await pending;
    expect(world.spaces[0].tabs.map((tab: any) => tab.terminals[0].terminal)).toEqual(['t1', 't2']);
    await app.drain();
  });
  it('launches supplied leased argv unchanged and reports real core terminal IDs', async () => {
    const core = coreBoundary(), app = createFakeAppBoundary({ hc: core.hc });
    const r: any = await app.command('space.new', { name: 'Workshop', folder: '/owned/project', argv: ['node', 'lease.mjs', '--', 'pi', '--session', 'owned.jsonl'] });
    expect(r).toEqual({ space: 'sp1', tab: 'tb2', terminal: 't1' });
    expect(core.calls[0].slice(-6)).toEqual(['node', 'lease.mjs', '--', 'pi', '--session', 'owned.jsonl']);
    expect(core.calls[0]).toContain('--json');
    expect(core.calls[0]).toContain('--no-notify');
    expect((await app.command('ls', {}) as any).spaces[0].tabs[0].terminals[0].terminal).toBe('t1');
    await expect(app.command('tab.rename', { id: 'wrong', name: 'A' })).rejects.toThrow(/no tab/);
    await expect(app.command('pane.focus', { terminal: 'wrong' })).rejects.toThrow(/no such pane/);
    await expect(app.command('terminal.send', {})).rejects.toThrow(/unknown command/);
    await expect(app.command('tab.close', { id: r.tab, typo: true })).rejects.toThrow(/unknown argument/);
  });
  it('closes only the explicitly addressed auxiliary observer pane', async () => {
    const core = coreBoundary(), app = createFakeAppBoundary({ hc: core.hc });
    const main = await app.command('space.new', { argv: ['pi'] });
    await core.hc(['run', '--label', `herdr.space=${main.space}`, '--label', `herdr.tab=${main.tab}`]);
    const before: any = await app.command('ls', {}), original = before.spaces[0].tabs[0].terminals[0];
    const observer = before.spaces[0].tabs[0].terminals[1]; const offset = core.calls.length;
    expect(await app.command('pane.close', { pane: observer.pane })).toEqual({ ok: true });
    expect(core.rows[observer.terminal].state).toBe('finished');
    expect((await app.command('ls', {}) as any).spaces[0].tabs[0].terminals).toEqual([original]);
    expect(core.calls.slice(offset).filter(a => ['kill', 'keep', 'label'].includes(a[0]) && a[1] === original.terminal)).toEqual([]);
    await expect(app.command('pane.close', { pane: 'wrong-pane' })).rejects.toThrow(/no such pane/);
    const finalOffset = core.calls.length;
    await expect(app.command('pane.close', { pane: original.pane })).rejects.toMatchObject({ code: 'confirmation-required' });
    expect(core.rows[original.terminal].state).toBe('live');
    expect(core.calls.slice(finalOffset).filter(a => ['keep', 'kill', 'label'].includes(a[0]))).toEqual([]);
  });
  it('returns pending park, waits for actual changes, and never kills the parked terminal', async () => {
    const core = coreBoundary(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const app = createFakeAppBoundary({ hc: async argv => { if (argv[0] === 'keep') await gate; return core.hc(argv); } });
    await app.command('space.new', { argv: ['pi'] });
    expect(await app.command('terminal.park', { terminal: 't1' })).toEqual({ pending: true, terminal: 't1' });
    const world = app.command('ls', {});
    release();
    expect((await world as any).spaces).toEqual([]);
    expect(core.rows.t1.state).toBe('live');
    expect(core.calls.filter(a => ['kill', 'rm', 'send'].includes(a[0]))).toEqual([]);
  });
  it('retains placement and exposes an error when native park changes fail', async () => {
    const core = coreBoundary(), app = createFakeAppBoundary({ hc: core.hc });
    await app.command('space.new', { argv: ['pi'] }); core.fail();
    await app.command('terminal.park', { terminal: 't1' });
    const world: any = await app.command('ls', {});
    expect(world.spaces[0].tabs[0].terminals[0].terminal).toBe('t1');
    expect((await app.command('status', {}) as any).errors).toEqual(['keep failed']);
  });
  it('selects a known space by ID or position and restores its observed tab and pane', async () => {
    const core=coreBoundary(), app=createFakeAppBoundary({hc:core.hc});
    const first=await app.command('space.new',{name:'first',argv:['sh']}), extra=await app.command('tab.new',{space:first.space,argv:['sh']});
    await app.command('pane.focus',{terminal:extra.terminal}); const selected=await app.command('status',{});
    const second=await app.command('space.new',{name:'second',argv:['sh']}); const mutations=core.calls.length;
    await app.command('space.select',{id:first.space,index:2}); expect(await app.command('status',{})).toMatchObject({space:first.space,tab:selected.tab,focused_pane:selected.focused_pane,agent:extra.terminal});
    await app.command('space.select',{index:2}); expect(await app.command('status',{})).toMatchObject({space:second.space,tab:second.tab,agent:second.terminal});
    for(const index of [-1,1.5,'2',null,NaN])await expect(app.command('space.select',{index})).rejects.toMatchObject({code:'invalid-args'});
    await expect(app.command('space.select',{index:0})).rejects.toThrow(/no such space/);await expect(app.command('space.select',{id:'absent'})).rejects.toThrow(/no such space/);
    expect(core.calls.slice(mutations)).toEqual([]); expect(await app.command('status',{})).toMatchObject({space:second.space,tab:second.tab,agent:second.terminal});
  });
  it('awaits the optional layout write after load, including a repeated valid selection', async () => {
    const order: string[] = [], writes: string[] = []; let entered!: () => void, release!: () => void;
    const atWriter = new Promise<void>(resolve => { entered=resolve; }), gate = new Promise<void>(resolve => { release=resolve; }); let held=true;
    const app=createFakeAppBoundary({ hc: async()=>{throw new Error('no core operation');},
      readLayout: async name=>{order.push(`load:${name}`); if(name==='missing')throw new Error('layout missing');return {id:'root'};},
      selectLayout: async name=>{order.push(`write:${name}`);entered();if(held)await gate;writes.push(name);},
      record: name=>{order.push(`reply:${name}`);},
    });
    let completed=false;const pending=app.command('layout.switch',{name:'spider-glass'}).then(reply=>{completed=true;return reply;});await Promise.race([atWriter,pending]);
    expect(completed).toBe(false);expect(order).toEqual(['load:spider-glass','write:spider-glass']);release();expect(await pending).toEqual({ok:true});
    held=false;await app.command('layout.switch',{name:'spider-glass'});expect(writes).toEqual(['spider-glass','spider-glass']);
    await expect(app.command('layout.switch',{name:'missing'})).rejects.toThrow(/layout missing/);expect(writes).toEqual(['spider-glass','spider-glass']);
    expect(order.slice(0,3)).toEqual(['load:spider-glass','write:spider-glass','reply:layout.switch']);
  });
  it('preserves the exact legacy layout replies and calls without selectLayout', async () => {
    const reads: string[]=[],records: unknown[]=[];
    const app=createFakeAppBoundary({hc:async()=>{throw new Error('no core operation');},readLayout:async name=>{reads.push(name);return {id:'root'};},record:(name,args,result)=>records.push({name,args,result})});
    expect(JSON.stringify(await app.command('layout.switch',{name:'spider-glass'}))).toBe('{"ok":true}');
    expect(JSON.stringify(await app.command('status',{}))).toBe('{"layout":"spider-glass","space":null,"tab":null,"focused_pane":null,"agent":null,"floats":[],"overlays":[],"errors":[],"zoom":1,"font_size":14,"ui_font_size":14}');
    expect(reads).toEqual(['spider-glass']);expect(records[0]).toEqual({name:'layout.switch',args:{name:'spider-glass'},result:{ok:true}});
  });
  it('rejects malformed core replies and wrong get IDs rather than allocating guessed placement', async () => {
    const app = createFakeAppBoundary({ hc: async () => ({}) });
    await expect(app.command('space.new', { argv: ['pi'] })).rejects.toThrow(/core reply/);
    const core = coreBoundary();
    const other = createFakeAppBoundary({ hc: async a => a[0] === 'get' ? { address: 'wrong' } : core.hc(a) });
    await other.command('space.new', { argv: ['pi'] });
    await expect(other.command('terminal.park', { terminal: 't1' })).rejects.toThrow(/wrong terminal/);
  });
});


it('focuses an empty mod pane before keeping a terminal beside it without a new tab', async () => {
  const core = coreBoundary(), app = createFakeAppBoundary({ hc: core.hc });
  const main = await app.command('space.new', { name: 'Work', argv: ['/bin/sh'] });
  const placeholder = await app.command('tab.new', { space: main.space, name: 'Destination', mod: 'pane' });
  const parked = await core.hc(['run']) as { address: string };
  expect(await app.command('pane.focus', { pane: placeholder.pane })).toEqual({ ok: true });
  await app.command('terminal.keep', { terminal: parked.address, place: 'right' });
  await app.drain();
  await app.command('pane.close', { pane: placeholder.pane });
  const world = await app.command('ls', {}) as any;
  expect(world.spaces[0].tabs.map((tab: any) => tab.id)).toEqual([main.tab, placeholder.tab]);
  expect(world.spaces[0].tabs[1].terminals.map((row: any) => row.terminal)).toEqual([parked.address]);
  expect(core.calls.filter(argv => argv[0] === 'kill')).toEqual([]);
});
