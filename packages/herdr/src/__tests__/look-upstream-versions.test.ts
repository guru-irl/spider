import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import shippedPatches from '../../assets/look/patches.json' with { type: 'json' };
import { applyLookPatches, type HerdrClones, type LookPatchSet } from '../look/patches.js';

async function clones(version: string): Promise<HerdrClones> {
  const result = {} as HerdrClones;
  for (const name of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'] as const) result[name] = {
    name: name === 'workspace-chrome' ? 'spider-chrome' : `spider-${name}`, clonedFrom: { name, version },
    files: { 'main.js': await readFile(new URL(`./fixtures/herdr-0.1.12/mods/${name}/main.js`, import.meta.url), 'utf8'), 'mod.json': await readFile(new URL(`./fixtures/herdr-0.1.12/mods/${name}/mod.json`, import.meta.url), 'utf8') },
  };
  return result;
}

describe('look patches across Herdr releases', () => {
  it('patches every real 0.1.12 built-in and repeats without changing bytes', async () => {
    const patched = await applyLookPatches(await clones('0.1.12'), shippedPatches as LookPatchSet);
    expect(patched.agents.clonedFrom).toEqual({ name: 'agents', version: '0.1.12' });
    expect(patched.agents.files['main.js']).toContain('run("terminal.pin"');
    expect(patched['workspace-chrome'].files['main.js']).not.toContain('window()?.platform === "macos"');
    expect(await applyLookPatches(patched, shippedPatches as LookPatchSet)).toEqual(patched);
  });

  it('emits valid modules including their imports', async () => {
    const patched = await applyLookPatches(await clones('0.1.12'), shippedPatches as LookPatchSet);
    for (const [name, clone] of Object.entries(patched)) {
      const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: clone.files['main.js'], encoding: 'utf8' });
      expect(checked.status, `${name}: ${checked.stderr}`).toBe(0);
    }
  });

  it('keeps old pins pending until core echoes them, including offline terminals', async () => {
    const patched = await applyLookPatches(await clones('0.1.12'), shippedPatches as LookPatchSet);
    const source = patched.agents.files['main.js']
      .replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)?import .*;\s*$/gm, '')
      .replace('export default class ', 'return class ');
    const actions: unknown[] = [], writes: unknown[] = [];
    const Agents = new Function('View', 'run', 'localStorage', source)(class {}, (...args: unknown[]) => actions.push(args), {
      setItem: (...args: unknown[]) => writes.push(args), removeItem: (...args: unknown[]) => writes.push(args),
    });
    const view = new Agents();
    view.pendingPins = ['t1', 'remote.invalid/t2']; view.migratingPins = new Set();
    const local = { address: 't1', state: 'live', labels: {} as Record<string, string> };
    view.migratePins([local]); view.migratePins([local]);
    expect(actions).toEqual([['terminal.pin', { terminal: 't1', pinned: true }]]);
    expect(view.pendingPins).toEqual(['t1', 'remote.invalid/t2']);
    expect(writes).toEqual([]);
    local.labels['herdr.pinned'] = 'true'; view.migratePins([local]);
    expect(view.pendingPins).toEqual(['remote.invalid/t2']);
    expect(writes).toEqual([['pins', '["remote.invalid/t2"]']]);
    const remote = { address: 'remote.invalid/t2', state: 'live', labels: {} as Record<string, string> };
    view.migratePins([local, remote]);
    expect(actions).toHaveLength(2);
    expect(actions[1]).toEqual(['terminal.pin', { terminal: remote.address, pinned: true }]);
    remote.labels['herdr.pinned'] = 'true'; view.migratePins([local, remote]);
    expect(view.pendingPins).toEqual([]);
    expect(writes.at(-1)).toEqual(['pins']);
  });

  it.each(['0.1.11', '0.1.13'])('refuses %s instead of assuming unchanged built-ins', async version => {
    await expect(applyLookPatches(await clones(version), shippedPatches as LookPatchSet)).rejects.toMatchObject({ code: 'upstream-version-mismatch', message: expect.stringMatching(/supports Herdr 0\.1\.12[\s\S]*update spider[\s\S]*Herdr 0\.1\.12/i) });
  });

  it.each(['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome'] as const)('refuses edited %s source even when the version is supported', async kind => {
    const source = await clones('0.1.12');
    source[kind].files = { ...source[kind].files, 'main.js': source[kind].files['main.js'] + '\n// changed source' };
    await expect(applyLookPatches(source, shippedPatches as LookPatchSet)).rejects.toMatchObject({ code: 'upstream-source-unknown', message: expect.stringContaining(kind) });
  });

  it('records 0.1.12 as the only supported source version', () => {
    expect(shippedPatches.upstreamVersion).toBe('0.1.12');
  });
});
