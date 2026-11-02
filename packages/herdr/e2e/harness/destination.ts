// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { posix } from 'node:path';
import type { Suite } from './suite.js';
import type { RemoteSuite } from './remote.js';
import { HarnessError, type OwnedPath } from './environment.js';
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export function destinationRoot(suite: Suite): string {
  return suite.options.tier === 'remote' ? (suite as RemoteSuite).remote.metadata.root : suite.root;
}
/** Lexical containment here; the actual Linux components are checked before each fixture file operation. */
export function destinationPath(suite: Suite, path: string): OwnedPath {
  if (suite.options.tier !== 'remote') return suite.ownPath(path);
  const root = destinationRoot(suite);
  if (posix.resolve(path) !== path || !path.startsWith(root + '/')) throw new HarnessError('outside-owned-root', 'destination path is outside the owned Linux folder');
  return path as OwnedPath;
}
export async function assertDestinationPaths(suite: Suite, paths: readonly string[]): Promise<void> {
  for (const path of paths) destinationPath(suite, path);
  if (suite.options.tier !== 'remote') return;
  const remote = (suite as RemoteSuite).remote;
  const code = `const fs=require('node:fs'),p=require('node:path');const root=${JSON.stringify(remote.metadata.root)};const s=fs.lstatSync(root);if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(root)!==root||s.uid!==process.getuid()||(s.mode&63)!==0)throw Error('remote-root-unowned');for(const target of ${JSON.stringify(paths)}){for(let at=root;at!==target;){at=p.join(at,p.relative(at,target).split('/')[0]);try{if(fs.lstatSync(at).isSymbolicLink())throw Error('destination-symlink')}catch(e){if(e.code==='ENOENT')break;throw e}}}`;
  const result = await remote.exec(`${quote(remote.metadata.nodePath)} -e ${quote(code)}`);
  if (result.exitCode !== 0) throw new HarnessError('destination-path-unproved', result.stderr || result.stdout, result);
}
