// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { HerdrConfig } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
export type FontConfig = NonNullable<HerdrConfig['fonts']>;
export interface FontPorts { bundledRoot: string; readFile(path: string): Promise<Buffer> }
export interface FontFile { fileName: string; bytes: Buffer; sha256: string }
export interface FontAssets { files: FontFile[]; families: { body: string; label: string; paths: string } }
export interface FontMetadata { family: string; names: Readonly<Record<number, readonly string[]>>; weight: number | null; width: number | null; variable: boolean }

/** A bounded sfnt boundary parser; setup needs no font generator or subprocess. */
export function inspectFont(bytes: Buffer): FontMetadata {
  const fail = (): never => { throw new HerdrError('invalid-font', 'Expected a bounded sfnt font with a readable name table'); };
  const inside = (offset: number, length: number): void => { if (offset < 0 || length < 0 || offset + length > bytes.length) fail(); };
  if (bytes.length < 12 || bytes.length > 16 * 1024 * 1024 || (bytes.readUInt32BE(0) !== 0x00010000 && bytes.toString('ascii', 0, 4) !== 'OTTO')) fail();
  const count = bytes.readUInt16BE(4); if (count < 1 || count > 512) fail(); inside(12, count * 16);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16, tag = bytes.toString('ascii', at, at + 4), offset = bytes.readUInt32BE(at + 8), length = bytes.readUInt32BE(at + 12);
    inside(offset, length); if (tables.has(tag)) fail(); tables.set(tag, { offset, length });
  }
  const table = tables.get('name'); if (!table || table.length < 6) fail();
  const start = table!.offset, end = start + table!.length, records = bytes.readUInt16BE(start + 2), storage = start + bytes.readUInt16BE(start + 4);
  if (start + 6 + records * 12 > end || storage < start + 6 + records * 12 || storage > end) fail();
  const names: Record<number, string[]> = {};
  for (let i = 0; i < records; i++) {
    const at = start + 6 + i * 12, platform = bytes.readUInt16BE(at), id = bytes.readUInt16BE(at + 6), length = bytes.readUInt16BE(at + 8), offset = storage + bytes.readUInt16BE(at + 10);
    if (offset + length > end) fail();
    let value: string;
    if (platform === 0 || platform === 3) {
      if (length % 2) fail();
      value = Buffer.from(bytes.subarray(offset, offset + length)).swap16().toString('utf16le');
    } else if (platform === 1) value = bytes.toString('latin1', offset, offset + length);
    else continue;
    if (!names[id]?.includes(value)) (names[id] ??= []).push(value);
  }
  const family = names[16]?.[0] ?? names[1]?.[0];
  if (!family || /[\x00-\x1f\x7f]/.test(family)) fail();
  const os2 = tables.get('OS/2'); if (os2 && os2.length < 8) fail();
  return { family: family!, names, weight: os2 ? bytes.readUInt16BE(os2.offset + 4) : null, width: os2 ? bytes.readUInt16BE(os2.offset + 6) : null, variable: tables.has('fvar') };
}

export async function prepareFonts(config: FontConfig, ports: FontPorts): Promise<FontAssets> {
  const files: FontFile[] = [];
  const families = { body: 'Google Sans Flex', label: 'Glass Label', paths: 'JetBrains Mono' };
  const add = async (fileName: string, path: string, font: boolean): Promise<Buffer> => {
    let bytes: Buffer;
    try { bytes = await ports.readFile(path); } catch { throw new HerdrError('font-unreadable', `Unable to read ${font ? 'font' : 'font notice'}: ${path}`); }
    if (font) inspectFont(bytes);
    else {
      let notice: string; try { notice = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new HerdrError('invalid-font-notice', 'Font notice must be UTF-8'); }
      if (!notice.trim() || bytes.length > 1024 * 1024) throw new HerdrError('invalid-font-notice', 'Font notice is empty or oversized');
    }
    files.push({ fileName, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }); return bytes;
  };
  for (const name of ['GoogleSansFlex.ttf', 'GlassLabel-Bold.ttf', 'GoogleSansFlex-OFL.txt', 'GoogleSansFlex-TRADEMARKS.md']) {
    const bytes = await add(name, join(ports.bundledRoot, name), name.endsWith('.ttf'));
    if (name.endsWith('.ttf') && inspectFont(bytes).family !== (name === 'GoogleSansFlex.ttf' ? families.body : families.label)) throw new HerdrError('font-family-mismatch', 'Bundled font name table does not match the selected family');
  }
  for (const role of ['body', 'label', 'paths'] as const) {
    const selected = config[role]; if (!selected) continue;
    const bytes = await add(`User-${role}.ttf`, selected.path, true);
    await add(`User-${role}-LICENSE.txt`, selected.license, false);
    families[role] = inspectFont(bytes).family;
  }
  return { files, families };
}
