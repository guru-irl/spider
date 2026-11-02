import { mkdtempSync, mkdirSync, existsSync, readFileSync, symlinkSync, writeFileSync, cpSync, rmSync, realpathSync } from 'node:fs';
import { stagePackedBuild } from '../harness/pack.js';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { packedControl, requireCaughtControl } from './packed.js';

function fixture(): { root: string; packed: string } {
  const parent = path.join(process.cwd(), '.spider/scratch/e2-tests');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'control-'));
  const packed = path.join(root, 'packed');
  mkdirSync(path.join(packed, 'dist/herdr'), { recursive: true });
  writeFileSync(path.join(packed, 'package.json'), '{"name":"fixture"}');
  for (const file of ['extension.js', 'herdr/cli.mjs', 'herdr/viewer.mjs', 'herdr/remote-runtime.mjs']) writeFileSync(path.join(packed, 'dist', file), 'export const marker = "good";\n');
  return { root, packed };
}
describe('disposable packed controls', () => {
  it('accepts the real pack.ts dependency view, preserves its links without dereferencing, and rejects a planted product link', () => {
    const { root } = fixture();
    try {
      const staged = stagePackedBuild({});
      const control = packedControl({ packedRoot: staged.root, destination: path.join(root, 'bad'), kind: 'missing-runtime', mutation: { operation: 'remove', file: 'dist/herdr/remote-runtime.mjs' } });
      expect(realpathSync(path.join(control.packedRoot, 'node_modules/vitest'))).toBe(realpathSync(path.join(process.cwd(), 'node_modules/vitest')));
      expect(existsSync(staged.remoteRuntime)).toBe(true);
      const planted = path.join(root, 'planted');
      cpSync(staged.root, planted, { recursive: true, dereference: false, verbatimSymlinks: true });
      symlinkSync(staged.extension, path.join(planted, 'product-link.js'));
      expect(() => packedControl({ packedRoot: planted, destination: path.join(root, 'bad-planted'), kind: 'missing-runtime', mutation: { operation: 'remove', file: 'dist/herdr/remote-runtime.mjs' } })).toThrow(/symlink/);
      rmSync(path.join(planted, 'product-link.js')); rmSync(path.join(planted, 'dist/extension.js'));
      symlinkSync(staged.extension, path.join(planted, 'dist/extension.js'));
      expect(() => packedControl({ packedRoot: planted, destination: path.join(root, 'bad-target'), kind: 'main-pane-mutation', mutation: { operation: 'remove', file: 'dist/extension.js' } })).toThrow(/symlink/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects dependency links to a foreign directory or the wrong package inside the expected source', () => {
    const { root, packed } = fixture();
    mkdirSync(path.join(packed, 'node_modules'));
    mkdirSync(path.join(root, 'foreign-dependency'));
    const link = path.join(packed, 'node_modules/vitest');
    const options = { packedRoot: packed, kind: 'missing-runtime' as const, mutation: { operation: 'remove' as const, file: 'dist/herdr/remote-runtime.mjs' } };
    symlinkSync(path.join(root, 'foreign-dependency'), link);
    expect(() => packedControl({ ...options, destination: path.join(root, 'bad-foreign') })).toThrow(/symlink/);
    rmSync(link); symlinkSync(path.join(process.cwd(), 'node_modules/vite'), link);
    expect(() => packedControl({ ...options, destination: path.join(root, 'bad-other-package') })).toThrow(/symlink/);
    rmSync(link); symlinkSync(path.join(process.cwd(), 'node_modules/vitest'), link);
    expect(() => packedControl({ ...options, destination: path.join(root, 'bad-dependency'), mutation: { operation: 'remove', file: 'node_modules/vitest' } })).toThrow(/dependency/);
    expect(() => packedControl({ ...options, destination: path.join(root, 'bad-case-dependency'), mutation: { operation: 'remove', file: 'NODE_MODULES/vitest' } })).toThrow(/dependency/);
  });
  it('removes a runtime only from its private copy', async () => {
    const { root, packed } = fixture();
    const control = packedControl({ packedRoot: packed, destination: path.join(root, 'bad'), kind: 'missing-runtime', mutation: { operation: 'remove', file: 'dist/herdr/remote-runtime.mjs' } });
    expect(readFileSync(path.join(packed, 'dist/herdr/remote-runtime.mjs'), 'utf8')).toContain('good');
    await requireCaughtControl(control, async copy => { readFileSync(path.join(copy, 'dist/herdr/remote-runtime.mjs')); }, /ENOENT/);
  });
  it('fails if a broken copy passes, or fails for an unrelated reason', async () => {
    const { root, packed } = fixture();
    const control = packedControl({ packedRoot: packed, destination: path.join(root, 'bad'), kind: 'incorrect-outcome', mutation: { operation: 'replace', file: 'dist/extension.js', from: '"good"', to: '"bad"' } });
    await expect(requireCaughtControl(control, async () => {}, /incorrect outcome/)).rejects.toThrow(/not caught/);
    await expect(requireCaughtControl(control, async () => { throw new Error('bootstrap unavailable'); }, /incorrect outcome/)).rejects.toThrow(/unrelated/);
    await expect(requireCaughtControl(control, async copy => { expect(readFileSync(path.join(copy, 'dist/extension.js'), 'utf8')).not.toContain('bad'); }, /bad/)).resolves.toMatchObject({ kind: 'incorrect-outcome', result: 'caught' });
  });
  it('rejects non-scratch, nested source, symlink and ambiguous mutations', () => {
    const { root, packed } = fixture();
    const options = { packedRoot: packed, kind: 'main-pane-mutation' as const, mutation: { operation: 'replace' as const, file: 'dist/extension.js', from: 'missing', to: 'bad' } };
    expect(() => packedControl({ ...options, destination: path.join(process.cwd(), 'unsafe-control') })).toThrow(/scratch/);
    expect(() => packedControl({ ...options, destination: path.join(packed, 'nested') })).toThrow(/overlap/);
    expect(() => packedControl({ ...options, destination: path.join(root, 'bad') })).toThrow(/exactly one/);
    symlinkSync(path.join(packed, 'dist/extension.js'), path.join(packed, 'link'));
    expect(() => packedControl({ ...options, destination: path.join(root, 'linked') })).toThrow(/symlink/);
    expect(() => packedControl({ ...options, destination: path.join(root, 'escape'), mutation: { operation: 'remove', file: '../packed/package.json' } })).toThrow(/path/);
  });
});
