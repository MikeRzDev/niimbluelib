import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { cloneJson } from "./clone";
import { NiimTemplate, TemplateFont } from "./types";
import { validateTemplate } from "./validate";

/**
 * NiimBlue template package (`.niim`): a template and its assets (images, fonts) in one ZIP file.
 *
 * ```
 * label.niim
 * ├── mimetype         "application/vnd.niimblue.template+zip" (stored, first entry)
 * ├── template.json    NiimTemplate, `src` of images and fonts are paths inside the package
 * ├── images/…         image files (PNG, JPEG, SVG, …)
 * └── fonts/…          font files (TTF, OTF, WOFF, WOFF2)
 * ```
 *
 * `.niim` is the only template file format. In memory (what {@link renderTemplate} and
 * {@link printTemplate} take) a template embeds the same assets as data URLs:
 * {@link readTemplate} / {@link unpackTemplate} open a package, {@link packTemplate} writes one.
 *
 * @module Template
 */

/** File extension of template packages. @category Template */
export const NIIM_PACKAGE_EXTENSION = ".niim";
/** Media type of template packages (content of the `mimetype` entry). @category Template */
export const NIIM_PACKAGE_MIME_TYPE = "application/vnd.niimblue.template+zip";
/** Name of the template file inside a package. @category Template */
export const NIIM_PACKAGE_TEMPLATE_FILE = "template.json";

/** @category Template */
export interface UnpackTemplateOptions {
  /** Maximum total uncompressed size of the package contents in bytes. Default 64 MiB. */
  maxSize?: number;
}

/** @category Template */
export interface PackTemplateOptions {
  /** Extra files to store in the package (e.g. `preview.png`), path => contents. Ignored by readers. */
  files?: Record<string, Uint8Array>;
}

/**
 * Decoded font of a template, see {@link templateFonts}.
 *
 * @category Template
 */
export interface TemplateFontData {
  family: string;
  weight: "normal" | "bold" | number;
  style: "normal" | "italic";
  /** e.g. "font/ttf", detected from the file contents when possible. */
  mimeType: string;
  data: Uint8Array;
  /** The `src` of the font in the template (a data URL). */
  src: string;
}

const DEFAULT_MAX_SIZE = 64 * 1024 * 1024;
const ZIP_MTIME = new Date(1980, 0, 1);

/* ---------------------------------------------------------------- base64 */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  t["-".charCodeAt(0)] = 62; // base64url
  t["_".charCodeAt(0)] = 63;
  return t;
})();

const base64Encode = (data: Uint8Array): string => {
  const parts: string[] = [];
  let chunk = "";
  for (let i = 0; i < data.length; i += 3) {
    const n = (data[i] << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0);
    chunk +=
      B64[(n >> 18) & 63] +
      B64[(n >> 12) & 63] +
      (i + 1 < data.length ? B64[(n >> 6) & 63] : "=") +
      (i + 2 < data.length ? B64[n & 63] : "=");
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  parts.push(chunk);
  return parts.join("");
};

const base64Decode = (s: string): Uint8Array => {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61 /* = */) break;
    const v = c < 128 ? B64_LOOKUP[c] : -1;
    if (v < 0) {
      if (c === 32 || c === 10 || c === 13 || c === 9) continue;
      throw new Error("invalid base64 data");
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

/* ---------------------------------------------------------------- data URLs, media types */

const startsWith = (d: Uint8Array, bytes: number[], offset = 0): boolean =>
  d.length >= offset + bytes.length && bytes.every((b, i) => d[offset + i] === b);

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** Detect media type from file contents. */
const sniffMimeType = (d: Uint8Array): string | undefined => {
  if (startsWith(d, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(d, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(d, ascii("GIF8"))) return "image/gif";
  if (startsWith(d, ascii("RIFF")) && startsWith(d, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(d, ascii("BM"))) return "image/bmp";
  if (startsWith(d, [0x00, 0x01, 0x00, 0x00]) || startsWith(d, ascii("true"))) return "font/ttf";
  if (startsWith(d, ascii("OTTO"))) return "font/otf";
  if (startsWith(d, ascii("wOFF"))) return "font/woff";
  if (startsWith(d, ascii("wOF2"))) return "font/woff2";
  if (startsWith(d, ascii("ttcf"))) return "font/collection";
  const head = strFromU8(d.subarray(0, 256), true).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return undefined;
};

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  ttc: "font/collection",
};

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "font/woff": "woff",
  "font/woff2": "woff2",
  "font/collection": "ttc",
};

/** Formats compressed on their own, stored without deflate. */
const STORED_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "font/woff", "font/woff2"];

interface DataUrl {
  mimeType: string;
  data: Uint8Array;
}

const parseDataUrl = (src: string): DataUrl => {
  const comma = src.indexOf(",");
  if (!src.startsWith("data:") || comma < 0) {
    throw new Error("not a data: URL");
  }
  const meta = src.slice(5, comma).split(";");
  const body = src.slice(comma + 1);
  const isBase64 = meta.slice(1).some((p) => p.toLowerCase() === "base64");
  const data = isBase64 ? base64Decode(body) : strToU8(decodeURIComponent(body));
  const declared = meta[0].toLowerCase();
  return { mimeType: sniffMimeType(data) ?? (declared || "application/octet-stream"), data };
};

const toDataUrl = (mimeType: string, data: Uint8Array): string => `data:${mimeType};base64,${base64Encode(data)}`;

/* ---------------------------------------------------------------- package paths */

const safeName = (s: string | undefined): string =>
  (s ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 64);

/** Normalize a path inside a package; rejects absolute paths, `..`, URLs and backslashes. */
const packagePath = (p: string, where: string): string => {
  const norm = p.replace(/^(\.\/)+/, "");
  const segments = norm.split("/");
  if (
    norm.length === 0 ||
    norm.startsWith("/") ||
    norm.includes("\\") ||
    norm.includes(":") ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new Error(`Invalid template package: ${where} has an invalid path ${JSON.stringify(p)}`);
  }
  return norm;
};

/* ---------------------------------------------------------------- API */

/**
 * Check whether the bytes are a ZIP file (a `.niim` template package) rather than template JSON.
 *
 * @category Template
 */
export const isTemplatePackage = (data: Uint8Array): boolean => startsWith(data, [0x50, 0x4b, 0x03, 0x04]);

/**
 * Pack a template into a `.niim` package (ZIP). Embedded data URLs of images and fonts are moved into
 * files (`images/…`, `fonts/…`, identical assets stored once); `src` values which already are package paths
 * must be supplied through `opts.files`.
 *
 * @example
 * ```ts
 * const bytes = packTemplate(template);
 * await fs.writeFile("label.niim", bytes);
 * ```
 *
 * @category Template
 */
export const packTemplate = (t: NiimTemplate, opts: PackTemplateOptions = {}): Uint8Array => {
  const template = cloneJson(validateTemplate(t));
  const files: Zippable = {
    mimetype: [strToU8(NIIM_PACKAGE_MIME_TYPE), { level: 0 }],
  };
  const extra = opts.files ?? {};
  const bySrc = new Map<string, string>();
  const used = new Set<string>(["mimetype", NIIM_PACKAGE_TEMPLATE_FILE]);

  const addAsset = (src: string, dir: string, baseName: string, where: string): string => {
    if (!src.startsWith("data:")) {
      const path = packagePath(src, where);
      if (extra[path] === undefined) {
        throw new Error(`${where}: ${JSON.stringify(src)} is neither a data URL nor a file given in options.files`);
      }
      return path;
    }

    const known = bySrc.get(src);
    if (known !== undefined) return known;

    let asset: DataUrl;
    try {
      asset = parseDataUrl(src);
    } catch (e) {
      throw new Error(`${where}: ${(e as Error).message}`);
    }
    const ext = MIME_TO_EXT[asset.mimeType] ?? "bin";
    const base = `${dir}/${safeName(baseName) || dir.replace(/s$/, "")}`;
    let path = `${base}.${ext}`;
    for (let i = 2; used.has(path) || extra[path] !== undefined; i++) {
      path = `${base}-${i}.${ext}`;
    }
    used.add(path);
    bySrc.set(src, path);
    files[path] = [asset.data, { level: STORED_MIME_TYPES.includes(asset.mimeType) ? 0 : 6 }];
    return path;
  };

  template.elements.forEach((e, i) => {
    if (e.type === "image") {
      e.src = addAsset(e.src, "images", e.id ?? `image-${i + 1}`, `elements[${i}].src`);
    }
  });

  template.fonts?.forEach((f, i) => {
    const variant = [f.weight !== undefined && f.weight !== "normal" ? f.weight : "", f.style === "italic" ? "italic" : ""]
      .filter((v) => v !== "")
      .join("-");
    f.src = addAsset(f.src, "fonts", variant ? `${f.family}-${variant}` : f.family, `fonts[${i}].src`);
  });

  files[NIIM_PACKAGE_TEMPLATE_FILE] = [strToU8(`${JSON.stringify(template, null, 2)}\n`), { level: 6 }];

  for (const [p, data] of Object.entries(extra)) {
    const path = packagePath(p, "options.files");
    if (path === "mimetype" || path === NIIM_PACKAGE_TEMPLATE_FILE) {
      throw new Error(`options.files: ${path} is reserved`);
    }
    if (files[path] === undefined) {
      files[path] = [data, { level: STORED_MIME_TYPES.includes(sniffMimeType(data) ?? "") ? 0 : 6 }];
    }
  }

  return zipSync(files, { mtime: ZIP_MTIME });
};

/**
 * Unzip a template package and return its files (path => contents), checking size limits.
 *
 * @category Template
 */
export const unpackTemplateFiles = (data: Uint8Array, opts: UnpackTemplateOptions = {}): Record<string, Uint8Array> => {
  if (!isTemplatePackage(data)) {
    throw new Error("Invalid template package: not a ZIP file");
  }
  const maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (f) => {
        if (f.name.endsWith("/")) return false;
        total += f.originalSize;
        if (total > maxSize) {
          throw new Error(`contents exceed ${maxSize} bytes`);
        }
        return true;
      },
    });
  } catch (e) {
    throw new Error(`Invalid template package: ${(e as Error).message}`);
  }
  return files;
};

/**
 * Open a `.niim` template package. Returns the validated template with images and fonts embedded as
 * data URLs, ready for {@link renderTemplate} / {@link printTemplate}.
 *
 * @example
 * ```ts
 * const template = unpackTemplate(new Uint8Array(await fs.readFile("label.niim")));
 * ```
 *
 * @category Template
 */
export const unpackTemplate = (data: Uint8Array, opts: UnpackTemplateOptions = {}): NiimTemplate => {
  const files = unpackTemplateFiles(data, opts);
  const json = files[NIIM_PACKAGE_TEMPLATE_FILE];
  if (json === undefined) {
    throw new Error(`Invalid template package: ${NIIM_PACKAGE_TEMPLATE_FILE} not found`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(json).replace(/^﻿/, ""));
  } catch (e) {
    throw new Error(`Invalid template package: ${NIIM_PACKAGE_TEMPLATE_FILE}: ${(e as Error).message}`);
  }
  const template = validateTemplate(raw);

  const resolve = (src: string, where: string): string => {
    if (src.startsWith("data:")) return src;
    const path = packagePath(src, where);
    const file = files[path];
    if (file === undefined) {
      throw new Error(`Invalid template package: ${where} refers to missing file ${path}`);
    }
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return toDataUrl(sniffMimeType(file) ?? EXT_TO_MIME[ext] ?? "application/octet-stream", file);
  };

  template.elements.forEach((e, i) => {
    if (e.type === "image") e.src = resolve(e.src, `elements[${i}].src`);
  });
  template.fonts?.forEach((f, i) => {
    f.src = resolve(f.src, `fonts[${i}].src`);
  });

  return template;
};

/**
 * Read a `.niim` template package (the only template file format). Returns the validated template,
 * images and fonts embedded as data URLs. Other data (e.g. template JSON) is rejected.
 *
 * @example
 * ```ts
 * const template = readTemplate(await (await fetch("label.niim")).arrayBuffer());
 * ```
 *
 * @category Template
 */
export const readTemplate = (data: Uint8Array | ArrayBuffer, opts: UnpackTemplateOptions = {}): NiimTemplate => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!isTemplatePackage(bytes)) {
    throw new Error("Not a .niim template package (expected a ZIP file with template.json)");
  }
  return unpackTemplate(bytes, opts);
};

/**
 * Decode the fonts embedded in a template (data URL `src`, see {@link unpackTemplate} for packages).
 *
 * @category Template
 */
export const templateFonts = (t: NiimTemplate): TemplateFontData[] =>
  (t.fonts ?? []).map((f: TemplateFont, i) => {
    let decoded: DataUrl;
    try {
      decoded = parseDataUrl(f.src);
    } catch {
      throw new Error(
        `fonts[${i}].src must be a data URL (open .niim packages with readTemplate), got ${JSON.stringify(f.src.slice(0, 64))}`,
      );
    }
    return {
      family: f.family,
      weight: f.weight ?? "normal",
      style: f.style ?? "normal",
      mimeType: decoded.mimeType,
      data: decoded.data,
      src: f.src,
    };
  });
