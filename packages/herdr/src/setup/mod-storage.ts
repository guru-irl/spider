// SPDX-License-Identifier: MIT
import { join } from 'node:path';
import { snapshot } from './backup.js';
import type { InstallFile } from './installer.js';

const mask = (1n << 64n) - 1n;
const rotate = (value: bigint, bits: bigint) => ((value << bits) | (value >> (64n - bits))) & mask;
function round(v: bigint[]): void {
  v[0] = (v[0] + v[1]) & mask; v[1] = rotate(v[1], 13n); v[1] ^= v[0]; v[0] = rotate(v[0], 32n);
  v[2] = (v[2] + v[3]) & mask; v[3] = rotate(v[3], 16n); v[3] ^= v[2];
  v[0] = (v[0] + v[3]) & mask; v[3] = rotate(v[3], 21n); v[3] ^= v[0];
  v[2] = (v[2] + v[1]) & mask; v[1] = rotate(v[1], 17n); v[1] ^= v[2]; v[2] = rotate(v[2], 32n);
}
/** Herdr 0.1.12 uses DefaultHasher on the JSON props string, including Rust's string terminator. */
export function modStoreFileName(props: unknown): string {
  if (props === null || props === undefined) return 'store.json';
  const bytes = Buffer.concat([Buffer.from(JSON.stringify(props)), Buffer.from([255])]);
  const v = [0x736f6d6570736575n, 0x646f72616e646f6dn, 0x6c7967656e657261n, 0x7465646279746573n];
  const compress = (word: bigint) => { v[3] ^= word; round(v); v[0] ^= word; };
  let offset = 0;
  for (; offset + 8 <= bytes.length; offset += 8) compress(bytes.readBigUInt64LE(offset));
  let last = BigInt(bytes.length & 255) << 56n;
  for (let index = offset; index < bytes.length; index++) last |= BigInt(bytes[index]) << BigInt((index - offset) * 8);
  compress(last); v[2] ^= 255n; round(v); round(v); round(v);
  return `store-${(v[0] ^ v[1] ^ v[2] ^ v[3]).toString(16).padStart(16, '0')}.json`;
}
function stores(layout: Buffer | null): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as Record<string, unknown>;
    if (typeof node.mod === 'string' && /^spider-[a-zA-Z0-9_-]+$/.test(node.mod)) {
      const files = result.get(node.mod) ?? new Set<string>(); files.add(modStoreFileName(node.props)); result.set(node.mod, files);
    }
    for (const [key, child] of Object.entries(node)) if (key !== 'props') visit(child);
  };
  if (layout) visit(JSON.parse(layout.toString('utf8')));
  return result;
}
/** Keep both stores and prefer any state already saved under the new identity. Ambiguous copies stay untouched. */
export async function planModStorage(appHome: string, previous: Buffer | null, planned: Buffer): Promise<InstallFile[]> {
  let before: ReturnType<typeof stores>;
  try { before = stores(previous); } catch (error) { if (error instanceof SyntaxError) return []; throw error; }
  const after = stores(planned), files: InstallFile[] = [];
  for (const [name, next] of after) {
    const old = before.get(name);
    if (old?.size !== 1 || next.size !== 1) continue;
    const source = [...old][0], destination = [...next][0];
    if (source === destination) continue;
    const path = join(appHome, 'data', name, destination);
    if ((await snapshot(path)).bytes !== null) continue;
    const current = await snapshot(join(appHome, 'data', name, source));
    if (current.bytes !== null) files.push({ path, bytes: current.bytes, expected: null, copyFrom: join(appHome, 'data', name, source), mode: 0o600 });
  }
  return files;
}
