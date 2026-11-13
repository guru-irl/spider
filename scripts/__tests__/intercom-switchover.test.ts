import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyIntercomSwitchover, filesystemSwitchoverPorts } from '../intercom-switchover.mjs';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const scratch = resolve('.spider/scratch/intercom-switch'); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'case-')); roots.push(root);
  const agent = join(root, 'agent'); mkdirSync(agent);
  const old = join(agent, 'npm/node_modules/pi-intercom'); mkdirSync(old, { recursive: true });
  writeFileSync(join(old, 'index.ts'), 'legacy reconnect fixture');
  const settings = join(agent, 'settings.json'), project = join(root, 'project-settings.json');
  writeFileSync(settings, JSON.stringify({ theme: 'fixture', packages: ['npm:pi-intercom', { source: 'npm:pi-intercom@0.13.0', extensions: ['index.ts'] }, 'npm:other'],
    extensions: [join(old, 'index.ts'), './other.ts'], skills: [join(old, 'skills'), './other-skills'] }));
  writeFileSync(project, JSON.stringify({ packages: ['npm:pi-intercom'] }));
  const release = join(root, 'release'); mkdirSync(join(release, 'dist/intercom'), { recursive: true });
  writeFileSync(join(release, 'dist/extension.js'), 'fixture'); writeFileSync(join(release, 'dist/intercom/broker.mjs'), 'fixture');
  const activeFile = join(root, 'active.json'); writeFileSync(activeFile, JSON.stringify('previous-release'));
  const input = { operationId: 'fixture-switch', settingsFiles: [settings], legacyRoots: [old], release, journalFile: join(root, 'switch.json') };
  return { root, old, settings, project, release, activeFile, input, ports: filesystemSwitchoverPorts(activeFile) };
}
it('settings switch and release activation recover atomically', async () => {
  const f = fixture(), before = readFileSync(f.settings, 'utf8');
  let fail = true;
  const ports = { ...f.ports, async activate(release: string) { if (fail) { fail = false; throw new Error('activation failed'); } await f.ports.activate(release); } };
  await expect(applyIntercomSwitchover(f.input, ports)).rejects.toThrow('activation failed');
  expect(readFileSync(f.settings, 'utf8')).toBe(before);
  expect(await f.ports.activeRelease()).toBe('previous-release');
  const result = await applyIntercomSwitchover(f.input, ports);
  expect(result).toMatchObject({ status: 'migration-pending', reason: 'legacy-broker-quiescence-unproved' });
  expect(await f.ports.activeRelease()).toBe(f.release);
  expect(JSON.parse(readFileSync(f.settings, 'utf8'))).toEqual({ theme: 'fixture', packages: ['npm:other'], extensions: ['./other.ts'], skills: ['./other-skills'] });
  expect(JSON.parse(readFileSync(f.project, 'utf8'))).toEqual({ packages: ['npm:pi-intercom'] });
  const retry = await applyIntercomSwitchover(f.input, ports);
  expect(retry).toEqual(result);
}, 5000);
it('a prepared journal survives failed rollback and recovers on retry', async () => {
  const f = fixture(), original = readFileSync(f.settings, 'utf8');
  f.input.settingsFiles.push(f.project);
  let changed = false;
  const ports = { ...f.ports, async writeAtomic(file: string, value: string) {
    if (file === f.project || file === f.settings && changed) throw new Error('fixture interrupted');
    await f.ports.writeAtomic(file, value); if (file === f.settings) changed = true;
  } };
  await expect(applyIntercomSwitchover(f.input, ports)).rejects.toThrow('Switchover rollback pending');
  expect(JSON.parse(readFileSync(f.input.journalFile, 'utf8')).state).toBe('prepared');
  expect(readFileSync(f.settings, 'utf8')).not.toBe(original);
  await applyIntercomSwitchover(f.input, f.ports);
  expect(readFileSync(f.settings + '.intercom-fixture-switch.bak', 'utf8')).toBe(original);
  expect(JSON.parse(readFileSync(f.project, 'utf8'))).toEqual({ packages: [] });
}, 5000);
it('an incomplete backup is never trusted', async () => {
  const f = fixture(), original = readFileSync(f.settings, 'utf8');
  writeFileSync(f.settings + '.intercom-fixture-switch.bak', 'partial backup');
  await expect(applyIntercomSwitchover(f.input, f.ports)).rejects.toThrow('Backup does not match original settings');
  expect(readFileSync(f.settings, 'utf8')).toBe(original);
  expect(await f.ports.activeRelease()).toBe('previous-release');
}, 5000);
it('relative legacy resources are removed in their selected settings scope', async () => {
  const f = fixture();
  writeFileSync(f.settings, JSON.stringify({ packages: ['./npm/node_modules/pi-intercom'],
    extensions: ['./npm/node_modules/pi-intercom/index.ts', f.old + '/../other/index.ts'],
    skills: ['!./npm/node_modules/pi-intercom/skills/**/*.md', './other-skills'] }));
  await applyIntercomSwitchover(f.input, f.ports);
  expect(JSON.parse(readFileSync(f.settings, 'utf8'))).toEqual({ packages: [], extensions: [f.old + '/../other/index.ts'], skills: ['./other-skills'] });
  expect(JSON.parse(readFileSync(f.project, 'utf8'))).toEqual({ packages: ['npm:pi-intercom'] });
}, 5000);
it('old package files remain reconnectable', async () => {
  const f = fixture(); await applyIntercomSwitchover(f.input, f.ports);
  expect(readFileSync(join(f.old, 'index.ts'), 'utf8')).toBe('legacy reconnect fixture');
  expect(existsSync(f.settings + '.intercom-fixture-switch.bak')).toBe(true);
}, 5000);
it('a crash between settings writes is rolled back before retry', async () => {
  const f = fixture(), first = readFileSync(f.settings, 'utf8'), second = readFileSync(f.project, 'utf8');
  f.input.settingsFiles.push(f.project);
  let writes = 0;
  const ports = { ...f.ports, async writeAtomic(file: string, value: string) { if (file === f.project && ++writes === 1) throw new Error('fixture crash'); return f.ports.writeAtomic(file, value); } };
  await expect(applyIntercomSwitchover(f.input, ports)).rejects.toThrow('fixture crash');
  expect(readFileSync(f.settings, 'utf8')).toBe(first);
  expect(readFileSync(f.project, 'utf8')).toBe(second);
  await applyIntercomSwitchover(f.input, f.ports);
  expect(JSON.parse(readFileSync(f.project, 'utf8'))).toEqual({ packages: [] });
}, 5000);
