// Generates maskable Pokeball PWA icons (PNG, no external deps) into www/icons.
//   node tools/make-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "www", "icons");
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawPokeball(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2,
    cy = size / 2,
    R = size * 0.5, // fill to edges -> maskable safe
    ring = size * 0.5,
    band = size * 0.11,
    inner = size * 0.15,
    innerRing = size * 0.19;
  const set = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx,
        dy = y + 0.5 - cy,
        d = Math.hypot(dx, dy);
      let r = 20, g = 20, b = 28, a = 255; // background (dark)
      if (d <= ring) {
        if (Math.abs(dy) <= band) {
          r = g = b = 20; // center band
        } else if (dy < 0) {
          r = 231; g = 76; b = 60; // top red
        } else {
          r = 245; g = 245; b = 245; // bottom white
        }
        if (d >= innerRing && Math.abs(dy) <= band) {
          r = g = b = 20;
        }
        if (d <= innerRing && d >= inner) {
          r = g = b = 20; // inner ring
        } else if (d < inner) {
          r = g = b = 245; // button
        }
      }
      set(x, y, r, g, b, a);
    }
  }
  return buf;
}

for (const size of [192, 512]) {
  const png = encodePNG(size, drawPokeball(size));
  writeFileSync(join(outDir, `icon-${size}.png`), png);
  console.log(`Wrote icon-${size}.png (${png.length} bytes)`);
}
