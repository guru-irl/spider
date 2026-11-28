// SPDX-License-Identifier: MIT
import { chmodSync, copyFileSync, linkSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

// The packed source is read-only. Replacements use rename so they never write through a link.
export function snapshotPackage(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: lstatSync(source).mode & 0o777 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) snapshotPackage(from, to);
    else if (entry.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else if (entry.isFile()) {
      try { linkSync(from, to); }
      catch (error) {
        if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        copyFileSync(from, to);
      }
    } else throw new Error(`Unsupported package entry: ${from}`);
  }
}

export function replacePackageFile(path: string, bytes: string | Buffer): void {
  const mode = lstatSync(path).mode & 0o777;
  const temporary = `${path}.${randomUUID()}.new`;
  try {
    writeFileSync(temporary, bytes, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
