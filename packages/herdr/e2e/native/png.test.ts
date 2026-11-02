import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, checkColorRegion, contrastRatio } from './png.js';

// Independent fixture encoder, not the decoder's CRC/filter implementation.
function crc(bytes: Buffer): number {
  let n = 0xffffffff;
  for (const byte of bytes) {
    n ^= byte;
    for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  }
  return (n ^ 0xffffffff) >>> 0;
}
function chunk(type: string, bytes: Buffer): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), bytes])));
  return Buffer.concat([length, Buffer.from(type), bytes, checksum]);
}
function image(width: number, height: number, bytes: Buffer, colorType = 6, interlace = 0, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[12] = interlace;
  const compressed = deflateSync(bytes);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), ...extra, chunk('IDAT', compressed.subarray(0, 3)), chunk('IDAT', compressed.subarray(3)), chunk('IEND', Buffer.alloc(0))]);
}

describe('native PNG observations', () => {
  it('decodes split IDAT and each PNG filter into actual RGBA bytes', () => {
    // Two identical opaque near-black pixels on five identical rows.
    const raw = Buffer.from([
      0, 22,22,24,255, 22,22,24,255,
      1, 22,22,24,255, 0,0,0,0,
      2, 0,0,0,0, 0,0,0,0,
      3, 11,11,12,128, 0,0,0,0,
      4, 0,0,0,0, 0,0,0,0,
    ]);
    const decoded = decodePng(image(2, 5, raw));
    expect(decoded.width).toBe(2); expect(decoded.height).toBe(5);
    expect([...decoded.rgba]).toEqual(Array(10).fill([22,22,24,255]).flat());
    expect(checkColorRegion(decoded, { x: 0, y: 0, width: 2, height: 5 }, '#161618')).toEqual({ matched: 10, total: 10, fraction: 1 });
    expect(() => checkColorRegion(decoded, { x: 0, y: 0, width: 2, height: 5 }, '#282a36')).toThrow(/region/);
  });
  it('converts RGB, grayscale, gray-alpha and palette pixels without inventing opacity', () => {
    expect([...decodePng(image(1, 1, Buffer.from([0, 1,2,3]), 2)).rgba]).toEqual([1,2,3,255]);
    expect([...decodePng(image(1, 1, Buffer.from([0, 42]), 0)).rgba]).toEqual([42,42,42,255]);
    expect([...decodePng(image(1, 1, Buffer.from([0, 42,17]), 4)).rgba]).toEqual([42,42,42,17]);
    expect([...decodePng(image(1, 1, Buffer.from([0, 0]), 3, 0, [chunk('PLTE', Buffer.from([1,2,3])), chunk('tRNS', Buffer.from([4]))])).rgba]).toEqual([1,2,3,4]);
  });
  it('refuses corruption, truncation, unsupported modes and decompression excess', () => {
    const valid = image(1, 1, Buffer.from([0,22,22,24,255]));
    const corrupt = Buffer.from(valid); corrupt[corrupt.length - 1] ^= 1;
    expect(() => decodePng(corrupt)).toThrow(/CRC/);
    expect(() => decodePng(valid.subarray(0, -6))).toThrow(/truncated|IEND/);
    expect(() => decodePng(image(0, 1, Buffer.from([])))).toThrow(/dimensions/);
    expect(() => decodePng(image(1, 1, Buffer.from([0,1,2,3,4]), 6, 1))).toThrow(/interlace/);
    expect(() => decodePng(image(1, 1, Buffer.alloc(100)))).toThrow(/length|large/);
    expect(() => decodePng(image(1, 1, Buffer.from([5,1,2,3,4])))).toThrow(/filter/);
  });
  it('rejects empty or clipped regions and enforces independently derived contrast', () => {
    const decoded = decodePng(image(1, 1, Buffer.from([0,22,22,24,255])));
    expect(() => checkColorRegion(decoded, { x: 1, y: 0, width: 1, height: 1 }, '#161618')).toThrow(/bounds/);
    expect(() => checkColorRegion(decoded, { x: 0, y: 0, width: 0, height: 1 }, '#161618')).toThrow(/bounds/);
    expect(contrastRatio('#ffffff', '#000000')).toBe(21);
    expect(contrastRatio('#161618', '#161618')).toBe(1);
    expect(contrastRatio('#f8f8f2', '#303031')).toBeGreaterThan(4.5);
  });
});
