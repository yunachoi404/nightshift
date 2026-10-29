import { crc32, deflateSync } from "node:zlib";

/** A tileable film-grain texture: grey noise with low alpha, from a fixed seed so every render matches. */
export function grainPng(size = 192, seed = 7): Buffer {
  let state = seed >>> 0;
  const random = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      // Sum of two uniforms: a softer, film-like distribution than flat noise.
      const v = (random() + random()) / 2;
      const grey = Math.round(v * 255);
      const o = 1 + x * 4;
      row[o] = grey;
      row[o + 1] = grey;
      row[o + 2] = grey;
      row[o + 3] = Math.round(28 + Math.abs(v - 0.5) * 120);
    }
    rows.push(row);
  }
  return encodePng(size, size, Buffer.concat(rows));
}

function encodePng(width: number, height: number, scanlines: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}
