import { inflateSync } from 'node:zlib';

export interface PngImage { width: number; height: number; rgba: Uint8Array }
export interface Region { x: number; y: number; width: number; height: number }
const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const maxBytes = 64 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}
export function decodePng(input: Uint8Array): PngImage {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length > maxBytes || !bytes.subarray(0, 8).equals(signature)) throw new Error('invalid PNG signature or image too large');
  let width = 0, height = 0, colorType = -1, channels = 0, ended = false, seenData = false, dataEnded = false;
  let palette: Buffer | undefined, transparency: Buffer | undefined;
  const data: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('truncated PNG chunk');
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) throw new Error('truncated PNG chunk payload');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, end - 4);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('invalid PNG chunk type');
    if (crc(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error(`PNG CRC mismatch: ${type}`);
    if (!width && type !== 'IHDR') throw new Error('PNG IHDR must be first');
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) throw new Error('invalid or repeated IHDR');
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      if (!width || !height || width * height * 4 > maxBytes) throw new Error('invalid PNG dimensions');
      if (body[8] !== 8) throw new Error('unsupported PNG bit depth (requires 8-bit)');
      colorType = body[9]; channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
      if (!channels || body[10] !== 0 || body[11] !== 0) throw new Error('unsupported PNG color or compression mode');
      if (body[12] !== 0) throw new Error('unsupported PNG interlace');
    } else if (type === 'PLTE') {
      if (seenData || palette || !length || length % 3 || length > 768) throw new Error('invalid PNG palette');
      palette = body;
    } else if (type === 'tRNS') {
      if (seenData || transparency || ![0, 2, 3].includes(colorType)) throw new Error('invalid PNG transparency');
      if ((colorType === 0 && length !== 2) || (colorType === 2 && length !== 6) || (colorType === 3 && (!palette || length > palette.length / 3))) throw new Error('invalid PNG transparency length');
      transparency = body;
    } else if (type === 'IDAT') {
      if (dataEnded || (colorType === 3 && !palette)) throw new Error('invalid PNG IDAT order or missing palette');
      seenData = true; data.push(body);
    } else if (type === 'IEND') {
      if (length || !seenData || end !== bytes.length) throw new Error('invalid PNG IEND or trailing bytes');
      ended = true;
    } else {
      if (type[0] === type[0].toUpperCase()) throw new Error(`unsupported critical PNG chunk: ${type}`);
      if (seenData) dataEnded = true;
    }
    offset = end;
  }
  if (!ended) throw new Error('missing PNG IEND');
  const stride = width * channels, expected = (stride + 1) * height;
  let inflated: Buffer;
  try { inflated = inflateSync(Buffer.concat(data), { maxOutputLength: expected + 1 }); }
  catch (error) { throw new Error(`invalid or excessively large PNG data: ${String(error)}`); }
  if (inflated.length !== expected) throw new Error('incorrect PNG scanline length');
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const source = y * (stride + 1), filter = inflated[source];
    if (filter > 4) throw new Error('unsupported PNG filter');
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= channels ? pixels[index - channels] : 0;
      const up = y ? pixels[index - stride] : 0;
      const upperLeft = y && x >= channels ? pixels[index - stride - channels] : 0;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upperLeft)][filter];
      pixels[index] = (inflated[source + x + 1] + predictor) & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const i = p * channels, out = p * 4;
    let r: number, g: number, b: number, a = 255;
    if (colorType === 3) {
      const index = pixels[i];
      if (index * 3 + 2 >= palette!.length) throw new Error('PNG palette index out of bounds');
      [r, g, b] = palette!.subarray(index * 3, index * 3 + 3);
      a = transparency?.[index] ?? 255;
    } else if (colorType === 0 || colorType === 4) {
      r = g = b = pixels[i];
      if (colorType === 4) a = pixels[i + 1];
      else if (transparency?.readUInt16BE(0) === r) a = 0;
    } else {
      [r, g, b] = pixels.subarray(i, i + 3);
      if (colorType === 6) a = pixels[i + 3];
      else if (transparency && transparency.readUInt16BE(0) === r && transparency.readUInt16BE(2) === g && transparency.readUInt16BE(4) === b) a = 0;
    }
    rgba.set([r, g, b, a], out);
  }
  return { width, height, rgba };
}
function color(hex: string): number[] {
  if (!/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(hex)) throw new Error('invalid hexadecimal region color');
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), hex.length === 9 ? parseInt(hex.slice(7, 9), 16) : 255];
}
export function checkColorRegion(image: PngImage, region: Region, hex: string, options: { tolerance?: number; minFraction?: number } = {}): { matched: number; total: number; fraction: number } {
  const { x, y, width, height } = region;
  if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1 || x + width > image.width || y + height > image.height) throw new Error('color region bounds invalid or clipped');
  const expected = color(hex), tolerance = options.tolerance ?? 0, minFraction = options.minFraction ?? 1;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 3 || !(minFraction > 0 && minFraction <= 1)) throw new Error('invalid color region tolerance or fraction');
  let matched = 0;
  for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) {
    const start = (row * image.width + col) * 4;
    if (expected.every((channel, offset) => Math.abs(channel - image.rgba[start + offset]) <= tolerance)) matched++;
  }
  const total = width * height, fraction = matched / total;
  if (fraction < minFraction) throw new Error(`color region ${hex}: ${matched}/${total} pixels match (required ${minFraction})`);
  return { matched, total, fraction };
}
export function contrastRatio(first: string, second: string): number {
  const luminance = (hex: string): number => {
    const c = color(hex);
    if (c[3] !== 255) throw new Error('contrast requires opaque colors');
    const [r, g, b] = c.slice(0, 3).map(v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
