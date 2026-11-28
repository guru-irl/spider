// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { digest } from '../setup/backup.js';
import { fixture, type SetupFixture } from '../../../host/src/__tests__/herdr-setup-fixture.js';

// Keep process transport in the install and missing-source cases.
export async function pickerFixture(coreTransport: 'process' | 'socket' = 'socket'): Promise<SetupFixture> {
  const f = await fixture('fake', false, { coreTransport }), picker = join(f.root, 'packages/herdr/assets/picker');
  await mkdir(picker, { recursive: true });
  await writeFile(join(picker, 'main.js'), "import '../shared/navigation.js';\nimport './model.js';\n// import '../shared/comment.js';\nexport const literal = '../shared/not-an-import.js';\nexport async function lazy() { return import('../shared/look.js'); }\n");
  await writeFile(join(picker, 'mod.json'), '{"place":"none"}\n');
  return f;
}
export const shapes: readonly string[] = ['diamond', 'heptagon', 'hexagon', 'octagon', 'pentagon', 'star', 'triangle'];
export const exists: (path: string) => Promise<boolean> = (path: string) => access(path).then(() => true, () => false);
export async function fingerprint(root: string): Promise<string[]> {
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
export async function unresolvedImports(mods: string, files: readonly string[]): Promise<string[]> {
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
