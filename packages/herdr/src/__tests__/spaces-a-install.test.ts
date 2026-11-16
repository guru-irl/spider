// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { access, chmod, cp, mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setupHerdr } from '../setup/installer.js';
import { digest, readJournal, saveJournal } from '../setup/backup.js';
import { cleanup, fixture } from '../../../host/src/__tests__/herdr-setup-fixture.js';
import { releaseFixture } from '../../../host/src/__tests__/herdr-setup-release-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function pickerFixture() {
  const f = await fixture(), picker = join(f.root, 'packages/herdr/assets/picker');
  await mkdir(picker, { recursive: true });
  await writeFile(join(picker, 'main.js'), "import '../shared/navigation.js';\nimport './model.js';\n// import '../shared/comment.js';\nexport const literal = '../shared/not-an-import.js';\nexport async function lazy() { return import('../shared/look.js'); }\n");
  await writeFile(join(picker, 'mod.json'), '{"place":"none"}\n');
  return f;
}
const shapes = ['diamond', 'heptagon', 'hexagon', 'octagon', 'pentagon', 'star', 'triangle'];
const exists = (path: string) => access(path).then(() => true, () => false);
async function fingerprint(root: string): Promise<string[]> {
  const rows: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) rows.push(`${relative(root, path)} ${digest(await readFile(path))} ${(await stat(path)).mode & 0o777}`);
    }
  };
  await walk(root); return rows.sort();
}
async function unresolvedImports(mods: string, files: readonly string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const file of files) {
    const root = resolve(mods, relative(mods, file).split(sep)[0]);
    const source = (await readFile(file, 'utf8')).replace(/^\s*\/\/[^\n]*$/gm, '');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), match[1]);
      if (!target.startsWith(root + sep) || !await exists(target)) missing.push(`${file}: ${match[1]}`);
    }
  }
  return missing;
}

test('installs a standalone picker with private config and resolved helper imports', async () => {
  const f = await pickerFixture();
  await setupHerdr(f.request, f.parts);
  const mods = join(f.h.directories.app, 'mods'), picker = join(mods, 'spider-picker');
  const configPath = join(picker, 'config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
  expect(config).toMatchObject({ version: 1, modId: 'spider-picker', retention: { completedRows: f.request.config.limits.completedRows, completedHours: f.request.config.limits.completedHours } });
  expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  for (const name of ['feedRoot', 'cliPath', 'nodePath', 'appBinary', 'configPath']) expect(isAbsolute(config[name]), name).toBe(true);
  expect(config.machines).toEqual(f.request.config.machines);
  expect(config.fonts).toMatchObject({ body: expect.any(String), label: expect.any(String), paths: expect.any(String) });
  const main = await readFile(join(picker, 'main.js'), 'utf8');
  expect(main).toContain("import './shared/navigation.js'");
  expect(main).toContain("import('./shared/look.js')");
  expect(main).toContain("// import '../shared/comment.js'");
  expect(main).toContain("'../shared/not-an-import.js'");
  expect(await Promise.all(shapes.map(name => exists(join(picker, `space-${name}.svg`))))).toEqual(shapes.map(() => true));
  const imports: string[] = [];
  for (const name of ['spider-picker', 'spider-agents', 'spider-panel']) {
    const root = join(mods, name), nav = join(root, 'shared/navigation.js'), children = join(root, 'spider-children.js');
    expect(await readFile(nav, 'utf8')).toContain("from '../spider-children.js'");
    expect(await exists(children)).toBe(true);
    expect(await exists(join(root, 'shared/open-failure.js'))).toBe(true);
    imports.push(nav, children);
  }
  imports.push(join(picker, 'main.js'), join(picker, 'model.js'));
  expect(await unresolvedImports(mods, imports)).toEqual([]);
  for (const name of ['grouping.js', 'connections.js', 'console-groups.js']) expect(await exists(join(mods, 'spider-agents', name)), name).toBe(true);
  expect(await exists(join(mods, 'spider-spaces/local.js'))).toBe(true);
  const layout = await readFile(join(f.h.directories.app, 'layouts/spider-glass.json'), 'utf8');
  expect(layout).not.toContain('spider-picker');
  for (const file of ['picker/main.js', 'picker/model.js', 'shared/navigation.js', 'agents/children.js']) {
    const source = await readFile(join(f.root, 'packages/herdr/assets', file), 'utf8');
    expect(source).not.toContain(f.h.root);
    expect(source).not.toMatch(/\/Users\/|\/home\//);
  }
  expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
});

test('installs the packaged picker View and manifest with resolvable imports', async () => {
  const f = await fixture(); await setupHerdr(f.request, f.parts);
  const mods = join(f.h.directories.app, 'mods'), root = join(mods, 'spider-picker');
  const main = await readFile(join(root, 'main.js'), 'utf8');
  expect(main).toContain("from './shared/navigation.js'");
  expect(main).toContain("from './shared/look.js'");
  expect(main).toContain("from './shared/feed.js'");
  expect(main).toContain("from './shared/open-failure.js'");
  expect(await readFile(join(root, 'mod.json'))).toEqual(await readFile(join(f.root, 'packages/herdr/assets/picker/mod.json')));
  expect(JSON.parse(await readFile(join(root, 'mod.json'), 'utf8'))).toMatchObject({ place: 'none', overlay: { kind: 'popup' } });
  expect(await unresolvedImports(mods, ['main.js', 'model.js', 'shared/navigation.js', 'shared/look.js', 'shared/feed.js', 'spider-children.js'].map(file => join(root, file)))).toEqual([]);
  expect((await stat(join(root, 'config.json'))).mode & 0o777).toBe(0o600);
  const before = await fingerprint(f.h.directories.app), doctor = await f.ports.doctorParts(f.request);
  expect((await doctor.inspect('mods', f.request)).failures).toEqual([]);
  expect(await fingerprint(f.h.directories.app)).toEqual(before);
});

test('doctor checks picker and shared helpers without changing installed files', async () => {
  const f = await pickerFixture(); await setupHerdr(f.request, f.parts);
  const picker = join(f.h.directories.app, 'mods/spider-picker'), helper = join(picker, 'shared/navigation.js');
  const inspect = await f.ports.doctorParts(f.request);
  const beforeInspection = await fingerprint(f.h.directories.app);
  expect((await inspect.inspect('mods', f.request)).failures).toEqual([]);
  expect(await fingerprint(f.h.directories.app)).toEqual(beforeInspection);
  const original = await readFile(helper);
  await writeFile(helper, Buffer.concat([original, Buffer.from('\nexport const changed = true;\n')]));
  const before = await readFile(helper);
  expect((await inspect.inspect('mods', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'installed-artifact-changed', message: expect.stringContaining(helper) }));
  expect(await readFile(helper)).toEqual(before);
  await writeFile(helper, original);
  const config = join(picker, 'config.json');
  await chmod(config, 0o644);
  expect((await inspect.inspect('mods', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'picker-config-insecure' }));
  expect((await stat(config)).mode & 0o777).toBe(0o644);
  await chmod(config, 0o600);
  const journal = await readJournal(f.request.journalRoot), entry = journal.entries.find(item => item.path === join(picker, 'main.js'))!;
  entry.after = '0'.repeat(64); await saveJournal(f.request.journalRoot, journal);
  const journalBefore = await readFile(join(f.request.journalRoot, 'journal.json'));
  expect((await inspect.inspect('mods', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'installed-artifact-changed' }));
  expect(await readFile(join(f.request.journalRoot, 'journal.json'))).toEqual(journalBefore);
});

test('doctor verifies native key commands or reports that inspection is unavailable', async () => {
  const f = await pickerFixture(), keysPath = join(f.h.directories.app, 'keys.json');
  const native = JSON.parse(await readFile(keysPath, 'utf8')) as Record<string, Record<string, unknown>>;
  const desired = JSON.parse(await readFile(join(f.root, 'packages/herdr/assets/keys.json'), 'utf8')) as Record<string, Record<string, unknown>>;
  for (const [section, bindings] of Object.entries(desired)) native[section] = { ...native[section], ...bindings };
  await writeFile(keysPath, JSON.stringify(native));
  const inspect = await f.ports.doctorParts(f.request), before = await fingerprint(f.h.directories.app);
  const unavailable = await inspect.inspect('keys', f.request);
  expect(unavailable.warnings).toContainEqual(expect.objectContaining({ code: 'inspection-unavailable', message: expect.stringContaining('native commands') }));
  expect(await fingerprint(f.h.directories.app)).toEqual(before);
  const script = join(f.h.root, 'app-selection.mjs'), original = await readFile(script, 'utf8');
  const commands = [
    { name: 'mod.open', args: [{ name: 'name', required: true }] },
    { name: 'terminal.park', args: [{ name: 'terminal', required: true }] },
    { name: 'pane.close', args: [{ name: 'pane', required: false }] },
  ];
  const reply = async (rows: unknown[]) => writeFile(script, `if (process.argv[2] === 'commands') { console.log(${JSON.stringify(JSON.stringify({ commands: rows }))}); process.exit(0); }\n` + original);
  await reply(commands);
  const valid = await inspect.inspect('keys', f.request);
  expect(valid.failures).toEqual([]);
  expect(valid.warnings ?? []).not.toContainEqual(expect.objectContaining({ message: expect.stringContaining('native commands') }));
  await reply(commands.filter(command => command.name !== 'terminal.park'));
  expect((await inspect.inspect('keys', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'native-command-missing', message: expect.stringContaining('terminal.park') }));
  expect(await fingerprint(f.h.directories.app)).toEqual(before);
});

test('refuses incomplete picker sources before making installation changes', async () => {
  const f = await pickerFixture(), settings = join(f.h.directories.app, 'settings.json');
  const before = await readFile(settings);
  await unlink(join(f.root, 'packages/herdr/assets/picker/main.js'));
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'picker-assets-missing' });
  expect(await readFile(settings)).toEqual(before);
  expect(await exists(join(f.h.directories.app, 'mods/spider-picker/config.json'))).toBe(false);
});

test('refuses an unresolved rewritten import before writing files', async () => {
  const f = await pickerFixture(), settings = join(f.h.directories.app, 'settings.json');
  const before = await readFile(settings);
  await writeFile(join(f.root, 'packages/herdr/assets/picker/main.js'), "import '../shared/missing.js';\n");
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'picker-import-unresolved' });
  expect(await readFile(settings)).toEqual(before);
  expect(await exists(join(f.h.directories.app, 'mods/spider-picker/config.json'))).toBe(false);
});

test.each(['./missing.js', '../../outside.js'])('refuses an unsafe picker import %s before any writes', async specifier => {
  const f = await pickerFixture(), settings = join(f.h.directories.app, 'settings.json');
  const before = await readFile(settings), source = join(f.root, 'packages/herdr/assets/picker/main.js');
  await writeFile(source, `import '${specifier}';\n`);
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'picker-import-unresolved', message: expect.stringContaining(specifier) });
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ message: expect.stringContaining('main.js') });
  expect(await readFile(settings)).toEqual(before);
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
}, 60_000);

test('refuses a skipped import after a quote-containing regex and names its source', async () => {
  const f = await pickerFixture(), settings = join(f.h.directories.app, 'settings.json');
  const before = await readFile(settings), source = join(f.root, 'packages/herdr/assets/picker/main.js');
  const specifier = '../shared/navigation.js';
  await writeFile(source, `const quote = /['"]/;\nimport '${specifier}';\n`);
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'picker-import-unresolved', message: expect.stringContaining('spider-picker/main.js') });
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ message: expect.stringContaining(specifier) });
  expect(await readFile(settings)).toEqual(before);
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
}, 60_000);

test('all installed shipped mod JavaScript imports resolve inside their own mod', async () => {
  const f = await fixture();
  await setupHerdr(f.request, f.parts);
  const mods = join(f.h.directories.app, 'mods'), files: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && path.endsWith('.js')) files.push(path);
    }
  };
  for (const name of await readdir(mods)) if (name.startsWith('spider-')) await walk(join(mods, name));
  expect(files.length).toBeGreaterThan(10);
  expect(files.some(path => path.endsWith('/spider-picker/main.js'))).toBe(true);
  expect(files.some(path => path.endsWith('/spider-panel/main.js'))).toBe(true);
  expect(await unresolvedImports(mods, files)).toEqual([]);
}, 60_000);

test('every shipped mod asset has a staged copy with in-root imports', async () => {
  const f = await releaseFixture('0.1.16'), app = f.h.directories.app, assets = join(f.root, 'packages/herdr/assets');
  const base = f.context.modProps[0].props;
  f.context.modProps = [...f.context.modProps, ...['picker', 'toast'].map(name => ({ directory: join(app, 'mods', `spider-${name}`), props: { ...base, modId: `spider-${name}` } }))];
  const staged = [...await f.parts.stageLook(f.request, f.context, 'export'), ...await f.parts.installFiles(f.request, f.context)];
  const mods = join(f.h.root, 'staged-mods'), originalMods = join(app, 'mods'), stagedJs: string[] = [];
  for (const file of staged) {
    const name = relative(originalMods, file.path);
    if (name.startsWith('..') || !name.startsWith('spider-') || !name.endsWith('.js')) continue;
    const path = join(mods, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.bytes); stagedJs.push(path);
  }
  const sourceJs: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && path.endsWith('.js')) sourceJs.push(relative(assets, path));
    }
  };
  await walk(assets);
  const target = (source: string) => {
    const [group, ...rest] = source.split('/');
    if (source === 'agents/children.js') return 'spider-agents/spider-children.js';
    if (group === 'shared') return `spider-picker/shared/${rest.join('/')}`;
    if (group === 'mods') return `spider-panel/${rest.slice(1).join('/')}`;
    return `spider-${group === 'spaces' ? 'spaces' : group}/${rest.join('/')}`;
  };
  expect(sourceJs.length).toBeGreaterThan(10);
  expect(sourceJs.filter(source => !stagedJs.includes(join(mods, target(source))))).toEqual([]);
  expect(await unresolvedImports(mods, stagedJs)).toEqual([]);
}, 60_000);

test('refuses a symlinked navigation source before writing files', async () => {
  const f = await pickerFixture(), settings = join(f.h.directories.app, 'settings.json');
  const before = await readFile(settings), source = join(f.root, 'packages/herdr/assets/shared/navigation.js');
  const target = join(f.h.root, 'private-navigation.js');
  await writeFile(target, Buffer.concat([await readFile(source), Buffer.from('\nexport const marker = "private";\n')]));
  await unlink(source); await symlink(target, source);
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'asset-symlink' });
  expect(await readFile(settings)).toEqual(before);
  expect(await exists(join(f.h.directories.app, 'mods/spider-picker/config.json'))).toBe(false);
});

test('rejects a relative path in generated picker props', async () => {
  const f = await pickerFixture(), directory = join(f.h.directories.app, 'mods/spider-picker');
  const props = { ...f.context.modProps[0].props, modId: 'spider-picker', configPath: 'relative.json' };
  const context = { ...f.context, modProps: [...f.context.modProps, { directory, props }] };
  await expect(f.parts.stageLook(f.request, context, 'export')).rejects.toMatchObject({ code: 'invalid-mod-path' });
  expect(await exists(join(directory, 'config.json'))).toBe(false);
});
