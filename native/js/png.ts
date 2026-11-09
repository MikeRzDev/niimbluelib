/*
 * Minimal PNG decoder for template images (data:image/png;base64,...).
 *
 * Supports every non-interlaced color type and bit depth. Interlaced PNGs
 * are rejected with a clear error; the Go binding re-encodes them (and any
 * JPEG / GIF / ...) to plain PNG before they reach this code.
 */

import inflate from "tiny-inflate";

export interface DecodedImage {
  width: number;
  height: number;
  /** Non-premultiplied RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  t["-".charCodeAt(0)] = 62; // base64url
  t["_".charCodeAt(0)] = 63;
  return t;
})();

export const base64Decode = (s: string): Uint8Array => {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4) + 3);
  let n = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61 /* = */) break;
    const v = c < 128 ? B64_LOOKUP[c] : -1;
    if (v < 0) {
      if (c === 32 || c === 10 || c === 13 || c === 9) continue;
      throw new Error("Invalid base64 data");
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
};

export const base64Encode = (b: Uint8Array): string => {
  const parts: string[] = [];
  let chunk = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    chunk +=
      B64[(n >> 18) & 63] +
      B64[(n >> 12) & 63] +
      (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") +
      (i + 2 < b.length ? B64[n & 63] : "=");
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  parts.push(chunk);
  return parts.join("");
};

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export const isPng = (b: Uint8Array): boolean => PNG_SIGNATURE.every((v, i) => b[i] === v);

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

export const decodePng = (png: Uint8Array): DecodedImage => {
  if (!isPng(png)) throw new Error("Not a PNG image");

  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  let idatLen = 0;

  let off = 8;
  while (off + 8 <= png.length) {
    const len = u32(png, off);
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
    const data = png.subarray(off + 8, off + 8 + len);
    off += 12 + len;

    if (type === "IHDR") {
      width = u32(data, 0);
      height = u32(data, 4);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) {
        throw new Error("Interlaced PNG images are not supported, re-save the image without interlacing");
      }
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      trns = data;
    } else if (type === "IDAT") {
      idat.push(data);
      idatLen += data.length;
    } else if (type === "IEND") {
      break;
    }
  }

  if (width === 0 || height === 0) throw new Error("PNG: missing IHDR");

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (channels === undefined) throw new Error(`PNG: unsupported color type ${colorType}`);

  const bitsPerPixel = channels * depth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);

  // zlib stream: 2 byte header, deflate data, 4 byte adler32
  const z = new Uint8Array(idatLen);
  let zo = 0;
  for (const c of idat) {
    z.set(c, zo);
    zo += c.length;
  }
  const raw = new Uint8Array((rowBytes + 1) * height);
  inflate(z.subarray(2), raw);

  // Unfilter in place into `pix`
  const pix = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes;
    const prev = dst - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? pix[dst + x - bpp] : 0;
      const b = y > 0 ? pix[prev + x] : 0;
      const c = x >= bpp && y > 0 ? pix[prev + x - bpp] : 0;
      let r: number;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: throw new Error(`PNG: bad filter ${filter}`);
      }
      pix[dst + x] = r & 0xff;
    }
  }

  // Sample reader for any bit depth, scaled to 0..255
  const maxVal = (1 << depth) - 1;
  const sample = (row: number, index: number): number => {
    if (depth === 8) return pix[row + index];
    if (depth === 16) return pix[row + index * 2]; // high byte
    const bit = index * depth;
    const byte = pix[row + (bit >> 3)];
    return (byte >> (8 - depth - (bit & 7))) & maxVal;
  };
  const scale = (v: number) => (depth >= 8 ? v : Math.round((v * 255) / maxVal));
  const raw16 = (row: number, index: number) =>
    depth === 16 ? (pix[row + index * 2] << 8) | pix[row + index * 2 + 1] : sample(row, index);

  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r: number, g: number, b: number, a = 255;
      switch (colorType) {
        case 0: {
          r = g = b = scale(sample(row, x));
          if (trns && trns.length >= 2 && raw16(row, x) === ((trns[0] << 8) | trns[1])) a = 0;
          break;
        }
        case 2: {
          r = sample(row, x * 3);
          g = sample(row, x * 3 + 1);
          b = sample(row, x * 3 + 2);
          if (
            trns &&
            trns.length >= 6 &&
            raw16(row, x * 3) === ((trns[0] << 8) | trns[1]) &&
            raw16(row, x * 3 + 1) === ((trns[2] << 8) | trns[3]) &&
            raw16(row, x * 3 + 2) === ((trns[4] << 8) | trns[5])
          ) {
            a = 0;
          }
          break;
        }
        case 3: {
          if (!palette) throw new Error("PNG: missing palette");
          const i = sample(row, x);
          r = palette[i * 3];
          g = palette[i * 3 + 1];
          b = palette[i * 3 + 2];
          if (trns && i < trns.length) a = trns[i];
          break;
        }
        case 4: {
          r = g = b = sample(row, x * 2);
          a = sample(row, x * 2 + 1);
          break;
        }
        default: {
          r = sample(row, x * 4);
          g = sample(row, x * 4 + 1);
          b = sample(row, x * 4 + 2);
          a = sample(row, x * 4 + 3);
        }
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }

  return { width, height, data: out };
};

/** Decode a `data:image/png;base64,...` URL. */
export const decodeDataUrlImage = (src: string): DecodedImage => {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),/.exec(src);
  if (!m) {
    throw new Error("Template images must be embedded as data: URLs");
  }
  if (!m[2].includes(";base64")) {
    throw new Error(`Template image ${m[1] || "data"} must be base64 encoded`);
  }
  const bytes = base64Decode(src.slice(m[0].length));
  if (!isPng(bytes)) {
    throw new Error(
      `Template image type ${m[1] || "unknown"} is not supported here, only PNG (the Go binding converts other formats)`,
    );
  }
  return decodePng(bytes);
};

/* ------------------------------------------------------------------------ */
/* Encoder (PNG printer output)                                             */
/* ------------------------------------------------------------------------ */

let crcTable: Uint32Array | undefined;

const crc32 = (data: Uint8Array, crc = 0xffffffff): number => {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const u32be = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  out.set(u32be(data.length), 0);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  out.set(u32be(crc32(out.subarray(4, 8 + data.length))), 8 + data.length);
  return out;
};

/** zlib stream with stored (uncompressed) deflate blocks. */
const zlibStored = (raw: Uint8Array): Uint8Array => {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  let o = 0;
  out[o++] = 0x78;
  out[o++] = 0x01;
  for (let b = 0; b < blocks; b++) {
    const start = b * 65535;
    const len = Math.min(65535, raw.length - start);
    out[o++] = b === blocks - 1 ? 1 : 0;
    out[o++] = len & 0xff;
    out[o++] = len >> 8;
    out[o++] = ~len & 0xff;
    out[o++] = (~len >> 8) & 0xff;
    out.set(raw.subarray(start, start + len), o);
    o += len;
  }
  let a = 1;
  let s = 0;
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]) % 65521;
    s = (s + a) % 65521;
  }
  out.set(u32be(((s << 16) | a) >>> 0), o);
  return out;
};

/**
 * Encode an indexed image as PNG (color type 3, 8 bit).
 * @param pixels width*height palette indexes
 * @param palette [r, g, b] per index
 */
export const encodeIndexedPng = (width: number, height: number, pixels: Uint8Array, palette: [number, number, number][]): Uint8Array => {
  const ihdr = new Uint8Array([...u32be(width), ...u32be(height), 8, 3, 0, 0, 0]);
  const plte = new Uint8Array(palette.flat());
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const parts = [PNG_SIGNATURE_BYTES, chunk("IHDR", ihdr), chunk("PLTE", plte), chunk("IDAT", zlibStored(raw)), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const PNG_SIGNATURE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
