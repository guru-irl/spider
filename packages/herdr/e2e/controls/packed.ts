import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type ControlKind = 'missing-runtime' | 'helper-import' | 'wrong-transcript-path' | 'duplicated-notice' | 'incorrect-outcome' | 'main-pane-mutation' | 'view-eviction';
export type PackedMutation = { operation: 'remove'; file: string } | { operation: 'replace'; file: string; from: string; to: string };
export interface PackedControl { kind: ControlKind; packedRoot: string; originalRoot: string; changedFile: string }
function fence(candidate: string): void {
  const checkout = realpathSync(process.cwd()), scratch = path.join(checkout, '.spider', 'scratch');
  if (!path.isAbsolute(candidate) || !candidate.startsWith(scratch + path.sep)) throw new Error('control paths must be inside checkout scratch');
  let current = checkout;
  for (const segment of path.relative(checkout, candidate).split(path.sep)) {
    if (segment === '..' || segment === '.') throw new Error('invalid control path');
    current = path.join(current, segment);
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error('control path has symlink or foreign owner');
    }
  }
}
function dependencyLink(link: string, expected: string, sourceRoot: string, directoryOnly: boolean): void {
  const info = lstatSync(link);
  if (!info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error('packed dependency entry must be an owned symlink');
  try {
    const source = lstatSync(expected), target = realpathSync(link), canonicalSource = realpathSync(sourceRoot);
    if (source.isSymbolicLink() || (directoryOnly && !source.isDirectory()) || !target.startsWith(canonicalSource + path.sep) || target !== realpathSync(expected)) throw new Error('unexpected dependency');
  } catch { throw new Error('packed dependency symlink does not resolve to its expected dependency source'); }
}
function dependencyView(view: string, source: string): void {
  if (lstatSync(source).isSymbolicLink() || !lstatSync(source).isDirectory()) throw new Error('expected dependency source must be a physical directory');
  for (const name of readdirSync(view)) {
    if (name === '@spider' || name === '.bin' || name.startsWith('.')) throw new Error('packed dependency view contains a forbidden symlink entry');
    const entry = path.join(view, name), info = lstatSync(entry);
    if (name.startsWith('@')) {
      if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error('packed dependency scope must be an owned directory, not a symlink');
      for (const inner of readdirSync(entry)) dependencyLink(path.join(entry, inner), path.join(source, name, inner), source, false);
    } else dependencyLink(entry, path.join(source, name), source, true);
  }
}
function noLinks(root: string, dependencies: string, source: string): void {
  const info = lstatSync(root);
  if (info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error('packed control contains symlink or foreign owner');
  if (root === dependencies) { if (!info.isDirectory()) throw new Error('packed dependency view must be a directory'); dependencyView(root, source); return; }
  if (info.isDirectory()) for (const name of readdirSync(root)) noLinks(path.join(root, name), dependencies, source);
  else if (!info.isFile()) throw new Error('packed control contains unsupported filesystem entry');
}
export function packedControl(options: { packedRoot: string; destination: string; kind: ControlKind; mutation: PackedMutation }): PackedControl {
  const { packedRoot, destination, kind, mutation } = options;
  const allowed: readonly ControlKind[] = ['missing-runtime', 'helper-import', 'wrong-transcript-path', 'duplicated-notice', 'incorrect-outcome', 'main-pane-mutation', 'view-eviction'];
  if (!allowed.includes(kind)) throw new Error('unknown packed control kind');
  if (!mutation.file || path.isAbsolute(mutation.file) || mutation.file.split(/[\\/]/).some(part => part === '..' || part === '.' || !part)) throw new Error('invalid mutation path');
  if (mutation.file.split(/[\\/]/)[0]?.toLowerCase() === 'node_modules') throw new Error('dependency mutation is forbidden');
  fence(packedRoot); fence(destination);
  if (destination === packedRoot || destination.startsWith(packedRoot + path.sep) || packedRoot.startsWith(destination + path.sep)) throw new Error('control destination and source overlap');
  if (existsSync(destination)) throw new Error('control destination must be fresh');
  const dependencies = path.join(packedRoot, 'node_modules');
  noLinks(packedRoot, dependencies, path.join(realpathSync(process.cwd()), 'node_modules'));
  for (const file of ['package.json', 'dist/extension.js', 'dist/herdr/cli.mjs', 'dist/herdr/viewer.mjs', 'dist/herdr/remote-runtime.mjs']) if (!lstatSync(path.join(packedRoot, file)).isFile()) throw new Error(`missing packed control entry: ${file}`);
  const target = path.join(packedRoot, mutation.file);
  if (!lstatSync(target).isFile()) throw new Error('mutation target must be a packed file');
  let changed: string | undefined;
  if (mutation.operation === 'replace') {
    const original = readFileSync(target, 'utf8');
    if (!mutation.from || original.split(mutation.from).length !== 2 || mutation.from === mutation.to) throw new Error('control replacement needs exactly one changed anchor');
    changed = original.replace(mutation.from, mutation.to);
  }
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  cpSync(packedRoot, destination, { recursive: true, errorOnExist: true, force: false, dereference: false });
  const copiedTarget = path.join(destination, mutation.file);
  if (mutation.operation === 'remove') rmSync(copiedTarget);
  else writeFileSync(copiedTarget, changed!, { mode: 0o600 });
  return { kind, packedRoot: destination, originalRoot: packedRoot, changedFile: mutation.file };
}
export async function requireCaughtControl(control: PackedControl, assertion: (copy: string) => Promise<unknown>, expectedFailure: RegExp): Promise<{ kind: ControlKind; result: 'caught'; reason: string }> {
  let failure: unknown;
  try { await assertion(control.packedRoot); } catch (error) { failure = error; }
  if (failure === undefined) throw new Error(`known-bad control not caught: ${control.kind}`);
  const reason = failure instanceof Error ? failure.message : String(failure);
  expectedFailure.lastIndex = 0;
  if (!expectedFailure.test(reason)) throw new Error(`known-bad control failed for unrelated reason: ${control.kind}: ${reason}`);
  return { kind: control.kind, result: 'caught', reason };
}
