/**
 * Just enough PNG for the browser tests: reading Playwright's screenshots (8-bit RGB or RGBA, not interlaced) into
 * RGBA pixels, and writing RGBA pixels (the made-up minimap the 2.5D view traces).
 */
import { deflateSync, inflateSync } from 'node:zlib';

export interface Image {
  width: number;
  height: number;
  /** Four bytes a pixel, rows from the top. */
  rgba: Uint8Array;
}

export function decodePng(png: Buffer): Image {
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  for (let p = 8; p < png.length; ) {
    const length = png.readUInt32BE(p);
    const type = png.toString('ascii', p + 4, p + 8);
    const body = png.subarray(p + 8, p + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 0;
      if (body[8] !== 8 || body[12] !== 0 || !channels) throw new Error('not an 8-bit RGB(A) PNG');
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter] ?? 0;
      line[i] = (line[i]! + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < 3; k++) rgba[(y * width + x) * 4 + k] = line[x * channels + k]!;
      rgba[(y * width + x) * 4 + 3] = channels === 4 ? line[x * 4 + 3]! : 255;
    }
    prev = line;
  }
  return { width, height, rgba };
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([head.subarray(4), body])) crc = CRC[(crc ^ byte) & 255]! ^ (crc >>> 8);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([head, body, tail]);
}

export function encodePng({ width, height, rgba }: Image): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** How many of an image's pixels differ from its top-left one (the page behind the canvas) by more than `by`. */
export function drawnShare({ rgba }: Image, by = 24): number {
  let drawn = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (Math.abs(rgba[i]! - rgba[0]!) + Math.abs(rgba[i + 1]! - rgba[1]!) + Math.abs(rgba[i + 2]! - rgba[2]!) > by) drawn++;
  }
  return drawn / (rgba.length / 4);
}

/** How many different colours an image has, at four bits a channel. */
export function colours({ rgba }: Image): number {
  const seen = new Set<number>();
  for (let i = 0; i < rgba.length; i += 4) seen.add(((rgba[i]! >> 4) << 8) | ((rgba[i + 1]! >> 4) << 4) | (rgba[i + 2]! >> 4));
  return seen.size;
}
