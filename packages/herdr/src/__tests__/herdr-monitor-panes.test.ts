// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAuxiliaryPanes } from '../jobs/placement.js';
import { runRemoteObserver } from '../jobs/observer.js';
import { HERDR_KINDS, HERDR_LABELS, type AppClient, type OwnerPlacement, type TerminalAddress } from '../contracts.js';
import { createClientFixture } from './testutil.js';
import { cleanup, finish, monitorFixture } from './herdr-monitor-fixture.js';

it.each([HERDR_KINDS.remoteObserver, HERDR_KINDS.remoteConsole])('closing a %s frees its slot for an automatic viewer without cancelling a job', async kind => {
  const h = await monitorFixture(), placement = { space: 'space', tab: 'tab', pane: 'owner-pane' } as OwnerPlacement;
  const placements = new Map<TerminalAddress, OwnerPlacement>([[h.owner.terminal.address, placement]]);
  const app: AppClient = {
    tabTerminals: async target => [...placements].filter(([, p]) => p.space === target.space && p.tab === target.tab).map(([address]) => address), ownerPlacement: async address => { const p = placements.get(address); if (!p) throw Object.assign(new Error('unplaced'), { code: 'owner-unplaced' }); return p; },
    awaitPane: async (address, p) => { placements.set(address, { ...p, pane: 'aux-pane' as never }); return 'aux-pane' as never; },
    command: async (_name, args) => { placements.delete(args.terminal as TerminalAddress); return {}; },
  };
  const launch = async (paneKind: string) => {
    const terminal = await h.hc.run({ argv: [], cwd: null, labels: { [HERDR_LABELS.kind]: paneKind, [HERDR_LABELS.session]: h.owner.sessionId, [HERDR_LABELS.ownerCore]: h.owner.terminal.coreId, [HERDR_LABELS.ownerTerminal]: h.owner.terminal.terminalId }, background: true, outliveParent: true, noNotify: true });
    return terminal.address;
  };
  const panes = createAuxiliaryPanes({ automaticSubagentPanes: true, hc: h.hc, discardSubagentViewer: async (_id, _owner, viewer) => { await h.hc.kill(viewer); await h.hc.rm(viewer); }, app, limit: 1, clock: Date.now, subagentViewer: () => launch(HERDR_KINDS.subagentViewer) }); cleanup(() => panes.dispose());
  const slot = await panes.reserveRemote('job' as never, h.owner, { timeoutMs: 1000 }), viewer = await launch(kind);
  await panes.display(slot, viewer, { timeoutMs: 1000 });
  placements.delete(viewer); h.complete(viewer);
  const automatic = await panes.acquire('subagent', 'next-run' as never, h.owner, { timeoutMs: 1000, automatic: true });
  expect(automatic).not.toBeNull();
  await expect.poll(() => h.terminals.has(viewer)).toBe(false);
  expect(h.kills).toEqual([]);
});

it('a held observer prints Disconnected rather than Finished after its core is lost', async () => {
  const f = await createClientFixture(); cleanup(f.close);
  const entered = join(f.root, 'attach-entered'), released = join(f.root, 'attach-released'), wrapper = join(f.root, 'observer-hc');
  const script = join(f.root, 'attach.mjs');
  await writeFile(script, `import { writeFileSync, existsSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(entered)}, '');\nwhile (!existsSync(${JSON.stringify(released)})) await new Promise(r => setTimeout(r, 10));\n`);
  await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = attach ]; then exec '${process.execPath}' '${script}'; fi\nexec '${f.hcBinary}' "$@"\n`); await chmod(wrapper, 0o700);
  const gate = join(f.root, 'exit.json'); await writeFile(gate, JSON.stringify({ version: 1, nonce: 'nonce' }));
  let text = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((bytes: string | Uint8Array) => { text += bytes.toString(); return true; }) as never); cleanup(() => stdout.mockRestore());
  const observer = runRemoteObserver({ hcBinary: wrapper, address: f.address('t1'), nonce: 'nonce', exitFile: gate, env: f.localEnv, holdOpen: true });
  cleanup(async () => { await writeFile(released, ''); await observer.catch(() => {}); });
  await expect.poll(() => existsSync(entered)).toBe(true);
  await f.stopCore(); await writeFile(released, ''); await observer;
  expect(text).toContain('Disconnected'); expect(text).not.toContain('Finished');
});
