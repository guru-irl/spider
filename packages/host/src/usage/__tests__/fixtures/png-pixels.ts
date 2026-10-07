import { inflateSync } from "node:zlib";
import { expect } from "vitest";

// Decode Chromium's lossless 8-bit RGB/RGBA PNG without adding a dependency.
export function pixels(bytes: Buffer): { width: number; height: number; rgb(x: number, y: number): number[] } {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  expect(bytes[24]).toBe(8); expect([2, 6]).toContain(bytes[25]); expect(bytes[28]).toBe(0);
  const channels = bytes[25] === 6 ? 4 : 3, stride = width * channels;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), decoded = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    expect(filter).toBeLessThanOrEqual(4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= channels ? decoded[index - channels]! : 0;
      const up = y ? decoded[index - stride]! : 0;
      const upperLeft = y && x >= channels ? decoded[index - stride - channels]! : 0;
      const p = left + up - upperLeft;
      const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upperLeft);
      const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2)
        : filter === 4 ? pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft : 0;
      decoded[index] = (raw[y * (stride + 1) + x + 1]! + predictor) & 255;
    }
  }
  return { width, height, rgb(x, y) { const start = y * stride + x * channels; return [...decoded.subarray(start, start + 3)]; } };
}

