import { inflateSync } from "node:zlib";

/** Chromium screenshot PNGs are 8-bit, non-interlaced RGB or RGBA. */
export function inkRows(png: Buffer, box: { x: number; y: number; width: number; height: number }): { first: number; last: number; centre: number } {
  let width = 0, height = 0, channels = 0; const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), tag = png.toString("ascii", offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
    if (tag === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0; if (data[8] !== 8 || data[12] !== 0 || !channels) throw new Error("Unsupported screenshot PNG"); }
    if (tag === "IDAT") chunks.push(data); offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels, pixels = Buffer.alloc(stride * height);
  const paeth = (a: number, b: number, c: number) => { const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c); return x <= y && x <= z ? a : y <= z ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    if (filter > 4) throw new Error("Unsupported PNG filter");
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, a = x >= channels ? pixels[at - channels]! : 0, b = y ? pixels[at - stride]! : 0, c = y && x >= channels ? pixels[at - stride - channels]! : 0;
      pixels[at] = (raw[y * (stride + 1) + 1 + x]! + [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]!) & 255;
    }
  }
  const rows: number[] = [];
  // Inspect beyond the element box too, so offsets and untrimmed ink cannot hide.
  for (let y = Math.max(0, Math.floor(box.y) - 10); y < Math.min(height, Math.ceil(box.y + box.height) + 10); y++) {
    for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(width, Math.ceil(box.x + box.width)); x++) {
      const at = (y * width + x) * channels;
      if (pixels[at]! > 180 && pixels[at + 1]! > 180 && pixels[at + 2]! > 160) { rows.push(y); break; }
    }
  }
  if (!rows.length) throw new Error("No rendered ink in capture");
  return { first: rows[0]!, last: rows.at(-1)!, centre: (rows[0]! + rows.at(-1)!) / 2 };
}
