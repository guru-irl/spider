import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mountedFixture } from './herdr-wiring-fixture.js';
import { writePrivateJson } from '../../../herdr/src/sessions/registry.js';
import { readCutoverRecovery } from '../../../herdr/src/spaces/setup.js';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('moves the owner and records its new tab through the authenticated endpoint', async () => {
  const f = await mountedFixture();
  try {
    const appFile = join(f.h.directories.local, 'app.json');
    const layout = JSON.parse(await readFile(appFile, 'utf8'));
    layout.spaces[0].tabs.push({ id: 'target', name: 'Target', terminals: [{ terminal: 'shell', pane: 'target-pane' }] });
    await writeFile(appFile, JSON.stringify(layout));
    const root = join(f.config.globalRoot, 'herdr/spaces');
    await writePrivateJson(join(root, 'spaces.json'), { version: 1, focused: true, intents: [], retired: [], spaces: [{ name: 'Fixture', id: 's1', adopted: false }], tabs: [{
      target: { file: join(f.h.root, 'session.jsonl'), sessionId: f.owner!.sessionId, cwd: f.owner!.cwd, name: 'Session', spaceName: 'Fixture', spaceOrder: 0, sessionOrder: 0, extensionArguments: [] },
      placement: { space: 's1', tab: 'tb1', terminal: f.owner!.terminal.address }, result: null, failure: null,
    }] });
    const reply = await f.ipc!.request({ op: 'moveSession', generation: f.owner!.generation, destination: { kind: 'tab', tab: 'target' as never } });
    expect(reply).toEqual({ ok: true, op: 'moveSession' });
    expect(await f.h.app.ownerPlacement(f.owner!.terminal.address)).toMatchObject({ space: 's1', tab: 'target' });
    expect((await readCutoverRecovery(root)).entries[0]).toMatchObject({ placement: { space: 's1', tab: 'target', terminal: f.owner!.terminal.address }, manuallyMoved: true });
  } finally { await f.close(); }
}, 45000);
