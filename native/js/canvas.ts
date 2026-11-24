/*
 * Software 2D canvas for rendering niimbluelib templates inside QuickJS.
 *
 * Implements the subset of CanvasRenderingContext2D that niimbluelib's
 * renderTemplate uses (TemplateContext2D): transforms, rect/line/arc/ellipse
 * paths with anti-aliased nonzero fill and stroke, text through opentype.js
 * (kerning and ligatures like a browser), drawImage with area sampling and
 * get/putImageData. Output is RGBA like a browser canvas; the template
 * renderer thresholds it to black/white afterwards.
 */

import * as opentype from "opentype.js";
import { base64Decode, DecodedImage, decodeDataUrlImage } from "./png";
// Embedded default fonts (base64, see js/build.mjs loader config)
import notoSansRegular from "../third_party/fonts/NotoSans-Regular.ttf";
import notoSansBold from "../third_party/fonts/NotoSans-Bold.ttf";

/* ------------------------------------------------------------------------ */
/* Fonts                                                                    */
/* ------------------------------------------------------------------------ */

interface FontFace {
  family: string;
  weight: number;
  italic: boolean;
  font: opentype.Font;
}

export const DEFAULT_FONT_FAMILY = "Noto Sans";

const faces = new Map<string, FontFace[]>();
const warnedFamilies = new Set<string>();

const familyKey = (f: string) => f.trim().replace(/^["']|["']$/g, "").toLowerCase();

const toArrayBuffer = (b: Uint8Array): ArrayBuffer =>
  b.byteOffset === 0 && b.byteLength === b.buffer.byteLength
    ? (b.buffer as ArrayBuffer)
    : (b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);

/**
 * Register a TrueType / OpenType font (not WOFF/WOFF2) under a CSS family name.
 * Registering the same family, weight and style again replaces the font.
 */
export const registerFont = (family: string, data: Uint8Array, weight = 400, italic = false): FontFace => {
  if (data.length >= 4) {
    const sig = String.fromCharCode(data[0], data[1], data[2], data[3]);
    if (sig === "wOFF" || sig === "wOF2") {
      throw new Error("WOFF/WOFF2 fonts are not supported, use the TTF or OTF file");
    }
  }
  let font: opentype.Font;
  try {
    font = opentype.parse(toArrayBuffer(data));
  } catch (e) {
    throw new Error(`Invalid font data for "${family}": ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!font.supported) {
    throw new Error(`Font "${family}" uses an unsupported format`);
  }
  const key = familyKey(family);
  const face: FontFace = { family: family.trim(), weight, italic, font };
  const list = (faces.get(key) ?? []).filter((f) => !(f.weight === weight && f.italic === italic));
  list.push(face);
  faces.set(key, list);
  return face;
};

export const listFonts = () =>
  [...faces.values()].flat().map((f) => ({ family: f.family, weight: f.weight, italic: f.italic }));

let defaultsLoaded = false;
const ensureDefaultFonts = () => {
  if (defaultsLoaded) return;
  defaultsLoaded = true;
  registerFont(DEFAULT_FONT_FAMILY, base64Decode(notoSansRegular), 400, false);
  registerFont(DEFAULT_FONT_FAMILY, base64Decode(notoSansBold), 700, false);
};

/** Families that are the same typeface as a registered one (NiimBlue's editor uses the variable build). */
const FAMILY_ALIASES: Record<string, string> = {
  "noto sans variable": "noto sans",
};

const facesFor = (family: string): FontFace[] | undefined => {
  const k = familyKey(family);
  const list = faces.get(k);
  if (list?.length) return list;
  return FAMILY_ALIASES[k] !== undefined ? faces.get(FAMILY_ALIASES[k]) : undefined;
};

interface ParsedFont {
  size: number;
  weight: number;
  italic: boolean;
  families: string[];
}

const parseCssFont = (css: string): ParsedFont => {
  const m = /^\s*((?:[a-z0-9-]+\s+)*?)([\d.]+)px(?:\s*\/\s*\S+)?\s+(.+)$/i.exec(css);
  if (!m) return { size: 10, weight: 400, italic: false, families: [DEFAULT_FONT_FAMILY] };
  let weight = 400;
  let italic = false;
  for (const tok of m[1].trim().split(/\s+/).filter(Boolean)) {
    const t = tok.toLowerCase();
    if (t === "italic" || t === "oblique") italic = true;
    else if (t === "bold" || t === "bolder") weight = 700;
    else if (t === "lighter") weight = 300;
    else if (/^\d{3}$/.test(t)) weight = Number(t);
  }
  const families: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^,]+))\s*(?:,|$)/g;
  let fm: RegExpExecArray | null;
  while ((fm = re.exec(m[3])) !== null && fm[0].length > 0) {
    const f = (fm[1] ?? fm[2] ?? fm[3] ?? "").replace(/\\(.)/g, "$1").trim();
    if (f) families.push(f);
  }
  return { size: Number(m[2]), weight, italic, families };
};

interface ResolvedFont {
  face: FontFace;
  size: number;
  /** Synthesize bold / italic like browsers do when the family lacks the face. */
  fakeBold: boolean;
  fakeItalic: boolean;
}

const resolveFont = (css: string): ResolvedFont => {
  ensureDefaultFonts();
  const p = parseCssFont(css);
  let list: FontFace[] | undefined;
  for (const fam of p.families) {
    list = facesFor(fam);
    if (list?.length) break;
  }
  if (!list?.length) {
    const wanted = p.families.join(", ");
    if (!warnedFamilies.has(wanted)) {
      warnedFamilies.add(wanted);
      console.warn(`Font "${wanted}" is not registered, using ${DEFAULT_FONT_FAMILY}`);
    }
    list = faces.get(familyKey(DEFAULT_FONT_FAMILY))!;
  }

  // CSS-like matching: style first, then closest weight (heavier wins ties for bold requests)
  const sameStyle = list.filter((f) => f.italic === p.italic);
  const pool = sameStyle.length > 0 ? sameStyle : list;
  let best = pool[0];
  for (const f of pool) {
    const d = Math.abs(f.weight - p.weight);
    const bd = Math.abs(best.weight - p.weight);
    if (d < bd || (d === bd && (p.weight >= 500 ? f.weight > best.weight : f.weight < best.weight))) best = f;
  }

  return {
    face: best,
    size: p.size,
    fakeBold: p.weight >= 600 && best.weight < 600,
    fakeItalic: p.italic && !best.italic,
  };
};

const TEXT_OPTIONS = { kerning: true, features: { liga: true, rlig: true } };

/* ------------------------------------------------------------------------ */
/* Geometry helpers                                                         */
/* ------------------------------------------------------------------------ */

type Matrix = [number, number, number, number, number, number];
type Pt = [number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

const apply = (m: Matrix, x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

const invert = (m: Matrix): Matrix => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (det === 0) return [0, 0, 0, 0, 0, 0];
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
};

const matrixScale = (m: Matrix) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

const signedArea = (poly: Pt[]) => {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += (poly[j][0] - poly[i][0]) * (poly[j][1] + poly[i][1]);
  }
  return s / 2;
};

/** Same orientation for every stroke piece so overlapping pieces never cancel under nonzero. */
const oriented = (poly: Pt[]): Pt[] => (signedArea(poly) < 0 ? poly.slice().reverse() : poly);

const circlePoly = (c: Pt, r: number): Pt[] => {
  const n = Math.max(8, Math.ceil((2 * Math.PI) / (2 * Math.acos(Math.max(-1, 1 - 0.1 / Math.max(r, 0.1))))));
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  return pts;
};

/** Number of segments for an arc of `angle` radians and device radius `r` (0.1 px tolerance). */
const arcSegments = (angle: number, r: number) => {
  const step = 2 * Math.acos(Math.max(-1, 1 - 0.1 / Math.max(r, 0.1)));
  return Math.max(1, Math.min(256, Math.ceil(Math.abs(angle) / Math.max(step, 0.01))));
};

/* ------------------------------------------------------------------------ */
/* Colors                                                                   */
/* ------------------------------------------------------------------------ */

type RGBA = [number, number, number, number];

const NAMED: Record<string, RGBA> = {
  black: [0, 0, 0, 255],
  white: [255, 255, 255, 255],
  red: [255, 0, 0, 255],
  transparent: [0, 0, 0, 0],
};

const parseColor = (v: unknown): RGBA => {
  if (typeof v !== "string") return [0, 0, 0, 255];
  const s = v.trim().toLowerCase();
  if (NAMED[s]) return NAMED[s];
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const c = h.split("").map((x) => parseInt(x + x, 16));
      return [c[0], c[1], c[2], c[3] ?? 255];
    }
    if (h.length === 6 || h.length === 8) {
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
        h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255,
      ];
    }
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), Math.round(Math.max(0, Math.min(1, a)) * 255)];
  }
  return [0, 0, 0, 255];
};

/* ------------------------------------------------------------------------ */
/* Canvas                                                                   */
/* ------------------------------------------------------------------------ */

interface State {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  miterLimit: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  imageSmoothingEnabled: boolean;
  globalAlpha: number;
  m: Matrix;
}

interface SubPath {
  pts: Pt[];
  closed: boolean;
}

/** Sub-scanlines per pixel row for anti-aliasing (horizontal coverage is exact). */
const SUBSAMPLES = 5;

export class SoftImageData {
  constructor(
    public readonly width: number,
    public readonly height: number,
    public readonly data: Uint8ClampedArray,
  ) {}
}

export class SoftCanvas {
  readonly data: Uint8ClampedArray;
  private ctx: SoftContext2D | undefined;

  constructor(
    public readonly width: number,
    public readonly height: number,
  ) {
    if (!(width > 0 && height > 0)) throw new Error(`Invalid canvas size ${width}x${height}`);
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  getContext(id: "2d"): SoftContext2D | null {
    if (id !== "2d") return null;
    this.ctx ??= new SoftContext2D(this);
    return this.ctx;
  }
}

export class SoftContext2D {
  private s: State = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    miterLimit: 10,
    font: `10px ${DEFAULT_FONT_FAMILY}`,
    textAlign: "start",
    textBaseline: "alphabetic",
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    m: [...IDENTITY],
  };
  private stack: State[] = [];
  private path: SubPath[] = [];
  /** Current point in user space (needed by arcTo). */
  private last: Pt | undefined;

  constructor(readonly canvas: SoftCanvas) {}

  /* ---- state ---- */

  get fillStyle() { return this.s.fillStyle; }
  set fillStyle(v: unknown) { this.s.fillStyle = v; }
  get strokeStyle() { return this.s.strokeStyle; }
  set strokeStyle(v: unknown) { this.s.strokeStyle = v; }
  get lineWidth() { return this.s.lineWidth; }
  set lineWidth(v: number) { if (v > 0 && isFinite(v)) this.s.lineWidth = v; }
  get lineCap() { return this.s.lineCap; }
  set lineCap(v: string) { this.s.lineCap = v; }
  get lineJoin() { return this.s.lineJoin; }
  set lineJoin(v: string) { this.s.lineJoin = v; }
  get miterLimit() { return this.s.miterLimit; }
  set miterLimit(v: number) { if (v > 0) this.s.miterLimit = v; }
  get font() { return this.s.font; }
  set font(v: string) { this.s.font = v; }
  get textAlign() { return this.s.textAlign; }
  set textAlign(v: string) { this.s.textAlign = v; }
  get textBaseline() { return this.s.textBaseline; }
  set textBaseline(v: string) { this.s.textBaseline = v; }
  get imageSmoothingEnabled() { return this.s.imageSmoothingEnabled; }
  set imageSmoothingEnabled(v: boolean) { this.s.imageSmoothingEnabled = v; }
  get globalAlpha() { return this.s.globalAlpha; }
  set globalAlpha(v: number) { if (v >= 0 && v <= 1) this.s.globalAlpha = v; }

  save() {
    this.stack.push({ ...this.s, m: [...this.s.m] as Matrix });
  }

  restore() {
    const s = this.stack.pop();
    if (s) this.s = s;
  }

  /* ---- transforms ---- */

  translate(x: number, y: number) {
    this.s.m = multiply(this.s.m, [1, 0, 0, 1, x, y]);
  }

  rotate(a: number) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    this.s.m = multiply(this.s.m, [c, s, -s, c, 0, 0]);
  }

  scale(x: number, y: number) {
    this.s.m = multiply(this.s.m, [x, 0, 0, y, 0, 0]);
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.s.m = multiply(this.s.m, [a, b, c, d, e, f]);
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.s.m = [a, b, c, d, e, f];
  }

  resetTransform() {
    this.s.m = [...IDENTITY];
  }

  /* ---- paths (points are stored in device space) ---- */

  beginPath() {
    this.path = [];
    this.last = undefined;
  }

  moveTo(x: number, y: number) {
    this.path.push({ pts: [apply(this.s.m, x, y)], closed: false });
    this.last = [x, y];
  }

  lineTo(x: number, y: number) {
    const sp = this.path[this.path.length - 1];
    if (!sp || sp.closed) {
      this.moveTo(x, y);
      return;
    }
    sp.pts.push(apply(this.s.m, x, y));
    this.last = [x, y];
  }

  closePath() {
    const sp = this.path[this.path.length - 1];
    if (!sp || sp.closed) return;
    sp.closed = true;
    // A new subpath starts at the closed subpath's first point
    const inv = invert(this.s.m);
    const start = apply(inv, sp.pts[0][0], sp.pts[0][1]);
    this.path.push({ pts: [sp.pts[0]], closed: false });
    this.last = start;
  }

  rect(x: number, y: number, w: number, h: number) {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }

  private arcPoints(cx: number, cy: number, rx: number, ry: number, rot: number, a0: number, a1: number) {
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    const n = arcSegments(a1 - a0, Math.max(rx, ry) * matrixScale(this.s.m));
    for (let i = 0; i <= n; i++) {
      const t = a0 + ((a1 - a0) * i) / n;
      const ex = Math.cos(t) * rx;
      const ey = Math.sin(t) * ry;
      this.lineTo(cx + ex * cr - ey * sr, cy + ex * sr + ey * cr);
    }
  }

  arc(x: number, y: number, r: number, start: number, end: number, ccw = false) {
    this.ellipse(x, y, r, r, 0, start, end, ccw);
  }

  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number, ccw = false) {
    if (rx < 0 || ry < 0) throw new Error("Negative ellipse radius");
    let sweep = end - start;
    if (!ccw && sweep < 0) sweep = (sweep % (2 * Math.PI)) + 2 * Math.PI;
    if (ccw && sweep > 0) sweep = (sweep % (2 * Math.PI)) - 2 * Math.PI;
    if (Math.abs(end - start) >= 2 * Math.PI) sweep = ccw ? -2 * Math.PI : 2 * Math.PI;
    this.arcPoints(x, y, rx, ry, rotation, start, start + sweep);
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, r: number) {
    if (r < 0) throw new Error("Negative arcTo radius");
    if (!this.last) {
      this.moveTo(x1, y1);
      return;
    }
    const [x0, y0] = this.last;
    const v1x = x0 - x1, v1y = y0 - y1;
    const v2x = x2 - x1, v2y = y2 - y1;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    const cross = v1x * v2y - v1y * v2x;
    if (r === 0 || l1 === 0 || l2 === 0 || Math.abs(cross) < 1e-9) {
      this.lineTo(x1, y1);
      return;
    }
    const u1x = v1x / l1, u1y = v1y / l1;
    const u2x = v2x / l2, u2y = v2y / l2;
    const angle = Math.acos(Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y)));
    const t = r / Math.tan(angle / 2);
    const t1: Pt = [x1 + u1x * t, y1 + u1y * t];
    const t2: Pt = [x1 + u2x * t, y1 + u2y * t];
    const bx = u1x + u2x, by = u1y + u2y;
    const bl = Math.hypot(bx, by);
    const d = r / Math.sin(angle / 2);
    const c: Pt = [x1 + (bx / bl) * d, y1 + (by / bl) * d];

    this.lineTo(t1[0], t1[1]);
    const a0 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
    let a1 = Math.atan2(t2[1] - c[1], t2[0] - c[0]);
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    a1 = a0 + sweep;
    this.arcPoints(c[0], c[1], r, r, 0, a0, a1);
  }

  fill() {
    const polys = this.path.filter((sp) => sp.pts.length >= 3).map((sp) => sp.pts);
    this.rasterize(polys, parseColor(this.s.fillStyle));
  }

  stroke() {
    const w = this.s.lineWidth * matrixScale(this.s.m);
    this.rasterize(this.strokePolygons(this.path, w), parseColor(this.s.strokeStyle));
  }

  fillRect(x: number, y: number, w: number, h: number) {
    if (w === 0 || h === 0) return;
    const m = this.s.m;
    const color = parseColor(this.s.fillStyle);
    if (m[1] === 0 && m[2] === 0) {
      // Axis aligned: exact coverage without the polygon rasterizer
      const [ax, ay] = apply(m, x, y);
      const [bx, by] = apply(m, x + w, y + h);
      this.fillDeviceRect(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), color);
      return;
    }
    this.rasterize(
      [[apply(m, x, y), apply(m, x + w, y), apply(m, x + w, y + h), apply(m, x, y + h)]],
      color,
    );
  }

  clearRect(x: number, y: number, w: number, h: number) {
    const [ax, ay] = apply(this.s.m, x, y);
    const [bx, by] = apply(this.s.m, x + w, y + h);
    const x0 = Math.max(0, Math.round(Math.min(ax, bx)));
    const x1 = Math.min(this.canvas.width, Math.round(Math.max(ax, bx)));
    const y0 = Math.max(0, Math.round(Math.min(ay, by)));
    const y1 = Math.min(this.canvas.height, Math.round(Math.max(ay, by)));
    for (let yy = y0; yy < y1; yy++) {
      this.canvas.data.fill(0, (yy * this.canvas.width + x0) * 4, (yy * this.canvas.width + x1) * 4);
    }
  }

  /* ---- text ---- */

  measureText(text: string): { width: number; actualBoundingBoxAscent: number; actualBoundingBoxDescent: number } {
    const f = resolveFont(this.s.font);
    const font = f.face.font;
    const width = font.getAdvanceWidth(text, f.size, TEXT_OPTIONS);
    const scale = f.size / font.unitsPerEm;
    return {
      width,
      actualBoundingBoxAscent: font.ascender * scale,
      actualBoundingBoxDescent: -font.descender * scale,
    };
  }

  fillText(text: string, x: number, y: number) {
    if (text.length === 0) return;
    const f = resolveFont(this.s.font);
    const font = f.face.font;
    const scale = f.size / font.unitsPerEm;
    const width = font.getAdvanceWidth(text, f.size, TEXT_OPTIONS);

    let ox = x;
    const align = this.s.textAlign;
    if (align === "center") ox -= width / 2;
    else if (align === "right" || align === "end") ox -= width;

    // Browsers place "top" / "middle" / "bottom" on the em square: ascent and descent
    // scaled so that together they are exactly one em.
    const asc = font.ascender;
    const desc = -font.descender;
    const emAsc = (asc / (asc + desc)) * f.size;
    const emDesc = (desc / (asc + desc)) * f.size;
    let baseline = y;
    switch (this.s.textBaseline) {
      case "top":
      case "hanging":
        baseline = y + emAsc;
        break;
      case "middle":
        baseline = y + (emAsc - emDesc) / 2;
        break;
      case "bottom":
      case "ideographic":
        baseline = y - emDesc;
        break;
    }

    const path = font.getPath(text, ox, baseline, f.size, TEXT_OPTIONS);
    // Synthetic italic: shear around the baseline (about 12 degrees, like browsers)
    const skew = f.fakeItalic ? 0.21 : 0;
    const m = this.s.m;
    const tp = (px: number, py: number): Pt => apply(m, px - (py - baseline) * skew, py);

    const polys = flattenGlyphPath(path.commands, tp, matrixScale(m));
    const color = parseColor(this.s.fillStyle);

    if (f.fakeBold) {
      // Embolden by stroking the outline, roughly what Skia does for fake bold
      const w = f.size * (1 / 24) * matrixScale(m);
      const outline = this.strokePolygons(polys.map((pts) => ({ pts, closed: true })), w);
      this.rasterize([...polys, ...outline], color);
    } else {
      this.rasterize(polys, color);
    }
  }

  strokeText(text: string, x: number, y: number) {
    // Not used by templates; approximate with fill so text is never silently lost
    this.fillText(text, x, y);
  }

  /* ---- images ---- */

  drawImage(image: unknown, ...args: number[]) {
    const img = image as DecodedImage | SoftCanvas;
    const src: DecodedImage =
      img instanceof SoftCanvas ? { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer) } : img;
    if (!src || !src.data || !(src.width > 0) || !(src.height > 0)) {
      throw new Error("drawImage: unsupported image");
    }

    let sx = 0, sy = 0, sw = src.width, sh = src.height;
    let dx: number, dy: number, dw: number, dh: number;
    if (args.length >= 8) {
      [sx, sy, sw, sh, dx, dy, dw, dh] = args;
    } else if (args.length >= 4) {
      [dx, dy, dw, dh] = args;
    } else {
      [dx, dy] = args;
      dw = sw;
      dh = sh;
    }
    if (dw === 0 || dh === 0 || sw === 0 || sh === 0) return;

    const m = this.s.m;
    const corners = [apply(m, dx, dy), apply(m, dx + dw, dy), apply(m, dx + dw, dy + dh), apply(m, dx, dy + dh)];
    const W = this.canvas.width;
    const H = this.canvas.height;
    const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))));
    const x1 = Math.min(W, Math.ceil(Math.max(...corners.map((c) => c[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))));
    const y1 = Math.min(H, Math.ceil(Math.max(...corners.map((c) => c[1]))));
    if (x0 >= x1 || y0 >= y1) return;

    // Device pixel -> source pixel
    const inv = invert(m);
    const kx = sw / dw;
    const ky = sh / dh;
    // Area sampling: enough samples per device pixel to cover the source footprint
    const ratio = Math.max(Math.abs(kx), Math.abs(ky)) / Math.max(matrixScale(m), 1e-6);
    const n = this.s.imageSmoothingEnabled ? Math.max(2, Math.min(16, Math.ceil(ratio * 2))) : 1;
    const d = src.data;
    const alpha = this.s.globalAlpha;

    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let j = 0; j < n; j++) {
          for (let i = 0; i < n; i++) {
            const [ux, uy] = apply(inv, px + (i + 0.5) / n, py + (j + 0.5) / n);
            const u = sx + (ux - dx) * kx;
            const v = sy + (uy - dy) * ky;
            if (u < sx || v < sy || u >= sx + sw || v >= sy + sh) continue;
            const iu = Math.min(src.width - 1, Math.max(0, Math.floor(u)));
            const iv = Math.min(src.height - 1, Math.max(0, Math.floor(v)));
            const o = (iv * src.width + iu) * 4;
            const sa = d[o + 3];
            r += d[o] * sa;
            g += d[o + 1] * sa;
            b += d[o + 2] * sa;
            a += sa;
          }
        }
        if (a === 0) continue;
        const cov = (a / (n * n * 255)) * alpha;
        this.blend(px, py, r / a, g / a, b / a, cov);
      }
    }
  }

  /* ---- pixels ---- */

  getImageData(sx: number, sy: number, sw: number, sh: number): SoftImageData {
    const out = new Uint8ClampedArray(sw * sh * 4);
    const W = this.canvas.width;
    const H = this.canvas.height;
    for (let y = 0; y < sh; y++) {
      const yy = sy + y;
      if (yy < 0 || yy >= H) continue;
      for (let x = 0; x < sw; x++) {
        const xx = sx + x;
        if (xx < 0 || xx >= W) continue;
        const s = (yy * W + xx) * 4;
        const o = (y * sw + x) * 4;
        out[o] = this.canvas.data[s];
        out[o + 1] = this.canvas.data[s + 1];
        out[o + 2] = this.canvas.data[s + 2];
        out[o + 3] = this.canvas.data[s + 3];
      }
    }
    return new SoftImageData(sw, sh, out);
  }

  putImageData(img: { width: number; height: number; data: ArrayLike<number> }, dx: number, dy: number) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    for (let y = 0; y < img.height; y++) {
      const yy = dy + y;
      if (yy < 0 || yy >= H) continue;
      for (let x = 0; x < img.width; x++) {
        const xx = dx + x;
        if (xx < 0 || xx >= W) continue;
        const s = (y * img.width + x) * 4;
        const o = (yy * W + xx) * 4;
        this.canvas.data[o] = img.data[s];
        this.canvas.data[o + 1] = img.data[s + 1];
        this.canvas.data[o + 2] = img.data[s + 2];
        this.canvas.data[o + 3] = img.data[s + 3];
      }
    }
  }

  createImageData(w: number, h: number): SoftImageData {
    return new SoftImageData(w, h, new Uint8ClampedArray(w * h * 4));
  }

  /* ---- internals ---- */

  /** Source-over blend of a color with coverage `cov` (0..1) into pixel (x, y). */
  private blend(x: number, y: number, r: number, g: number, b: number, cov: number) {
    if (cov <= 0) return;
    const d = this.canvas.data;
    const o = (y * this.canvas.width + x) * 4;
    const sa = Math.min(1, cov);
    const da = d[o + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    d[o] = (r * sa + d[o] * da * (1 - sa)) / oa;
    d[o + 1] = (g * sa + d[o + 1] * da * (1 - sa)) / oa;
    d[o + 2] = (b * sa + d[o + 2] * da * (1 - sa)) / oa;
    d[o + 3] = oa * 255;
  }

  private fillDeviceRect(x0: number, y0: number, x1: number, y1: number, c: RGBA) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const alpha = (c[3] / 255) * this.s.globalAlpha;
    const ys = Math.max(0, Math.floor(y0));
    const ye = Math.min(H, Math.ceil(y1));
    const xs = Math.max(0, Math.floor(x0));
    const xe = Math.min(W, Math.ceil(x1));
    for (let y = ys; y < ye; y++) {
      const cy = Math.min(y + 1, y1) - Math.max(y, y0);
      if (cy <= 0) continue;
      for (let x = xs; x < xe; x++) {
        const cx = Math.min(x + 1, x1) - Math.max(x, x0);
        if (cx <= 0) continue;
        this.blend(x, y, c[0], c[1], c[2], cx * cy * alpha);
      }
    }
  }

  /** Outline polygons of a stroked path (device space, width `w`). */
  private strokePolygons(path: SubPath[], w: number): Pt[][] {
    const out: Pt[][] = [];
    const hw = w / 2;
    const cap = this.s.lineCap;
    const join = this.s.lineJoin;
    const miterLimit = this.s.miterLimit;

    for (const sp of path) {
      // Drop repeated points
      const pts: Pt[] = [];
      for (const p of sp.pts) {
        const q = pts[pts.length - 1];
        if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) pts.push(p);
      }
      if (sp.closed && pts.length > 2) {
        const f = pts[0];
        const l = pts[pts.length - 1];
        if (Math.hypot(f[0] - l[0], f[1] - l[1]) <= 1e-9) pts.pop();
      }
      if (pts.length === 1) {
        if (cap === "round") out.push(circlePoly(pts[0], hw));
        else if (cap === "square") {
          const [x, y] = pts[0];
          out.push(oriented([[x - hw, y - hw], [x + hw, y - hw], [x + hw, y + hw], [x - hw, y + hw]]));
        }
        continue;
      }
      if (pts.length < 2) continue;

      const segs: [Pt, Pt][] = [];
      for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]);
      if (sp.closed && pts.length > 2) segs.push([pts[pts.length - 1], pts[0]]);

      const normal = (a: Pt, b: Pt): Pt => {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const l = Math.hypot(dx, dy);
        return [(-dy / l) * hw, (dx / l) * hw];
      };

      segs.forEach(([a, b], i) => {
        let [sa, sb] = [a, b];
        const open = !sp.closed || pts.length <= 2;
        if (open && cap === "square") {
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const l = Math.hypot(dx, dy);
          const ex = (dx / l) * hw;
          const ey = (dy / l) * hw;
          if (i === 0) sa = [a[0] - ex, a[1] - ey];
          if (i === segs.length - 1) sb = [b[0] + ex, b[1] + ey];
        }
        const n = normal(a, b);
        out.push(
          oriented([
            [sa[0] + n[0], sa[1] + n[1]],
            [sb[0] + n[0], sb[1] + n[1]],
            [sb[0] - n[0], sb[1] - n[1]],
            [sa[0] - n[0], sa[1] - n[1]],
          ]),
        );
      });

      // Joins between consecutive segments
      const joinCount = sp.closed && pts.length > 2 ? segs.length : segs.length - 1;
      for (let i = 0; i < joinCount; i++) {
        const [a, v] = segs[i];
        const [, b] = segs[(i + 1) % segs.length];
        if (join === "round") {
          out.push(circlePoly(v, hw));
          continue;
        }
        const n1 = normal(a, v);
        const n2 = normal(v, b);
        const turn = (v[0] - a[0]) * (b[1] - v[1]) - (v[1] - a[1]) * (b[0] - v[0]);
        if (Math.abs(turn) < 1e-12) continue;
        // Outer side is opposite to the turn direction
        const s = turn > 0 ? -1 : 1;
        const p1: Pt = [v[0] + n1[0] * s, v[1] + n1[1] * s];
        const p2: Pt = [v[0] + n2[0] * s, v[1] + n2[1] * s];
        const bevel = oriented([v, p1, p2]);
        if (join === "miter") {
          const d1x = v[0] - a[0], d1y = v[1] - a[1];
          const d2x = b[0] - v[0], d2y = b[1] - v[1];
          const cosT = (d1x * d2x + d1y * d2y) / (Math.hypot(d1x, d1y) * Math.hypot(d2x, d2y));
          const theta = Math.PI - Math.acos(Math.max(-1, Math.min(1, cosT))); // interior angle
          const ratio = 1 / Math.sin(theta / 2);
          if (ratio <= miterLimit) {
            // Miter tip: intersection of the two offset lines
            const den = d1x * d2y - d1y * d2x;
            const t = ((p2[0] - p1[0]) * d2y - (p2[1] - p1[1]) * d2x) / den;
            const tip: Pt = [p1[0] + d1x * t, p1[1] + d1y * t];
            out.push(oriented([v, p1, tip, p2]));
            continue;
          }
        }
        out.push(bevel);
      }

      if ((!sp.closed || pts.length <= 2) && cap === "round") {
        out.push(circlePoly(pts[0], hw), circlePoly(pts[pts.length - 1], hw));
      }
    }
    return out;
  }

  /** Anti-aliased nonzero fill of device-space polygons. */
  private rasterize(polys: Pt[][], color: RGBA) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const alpha = (color[3] / 255) * this.s.globalAlpha;
    if (alpha <= 0) return;

    // Edges oriented top to bottom with their winding direction
    const edges: { x0: number; y0: number; x1: number; y1: number; dir: number; slope: number }[] = [];
    let minY = Infinity;
    let maxY = -Infinity;
    for (const poly of polys) {
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        if (a[1] === b[1]) continue;
        const down = a[1] < b[1];
        const [p, q] = down ? [a, b] : [b, a];
        edges.push({ x0: p[0], y0: p[1], x1: q[0], y1: q[1], dir: down ? 1 : -1, slope: (q[0] - p[0]) / (q[1] - p[1]) });
        minY = Math.min(minY, p[1]);
        maxY = Math.max(maxY, q[1]);
      }
    }
    if (edges.length === 0) return;
    edges.sort((e, f) => e.y0 - f.y0);

    const ys = Math.max(0, Math.floor(minY));
    const ye = Math.min(H, Math.ceil(maxY));
    const cov = new Float32Array(W + 1);
    const xs: { x: number; dir: number }[] = [];
    let first = 0;

    for (let y = ys; y < ye; y++) {
      cov.fill(0);
      let touched = false;
      let minX = W;
      let maxX = 0;
      while (first < edges.length && edges[first].y1 <= y) first++;

      for (let s = 0; s < SUBSAMPLES; s++) {
        const sy = y + (s + 0.5) / SUBSAMPLES;
        xs.length = 0;
        for (let i = first; i < edges.length; i++) {
          const e = edges[i];
          if (e.y0 > sy) break;
          if (e.y1 <= sy) continue;
          xs.push({ x: e.x0 + (sy - e.y0) * e.slope, dir: e.dir });
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a.x - b.x);

        let wind = 0;
        for (let i = 0; i < xs.length - 1; i++) {
          wind += xs[i].dir;
          if (wind === 0) continue;
          const xa = Math.max(0, xs[i].x);
          const xb = Math.min(W, xs[i + 1].x);
          if (xb <= xa) continue;
          touched = true;
          // Exact horizontal coverage of span [xa, xb) on this sub-scanline
          const ia = Math.floor(xa);
          const ib = Math.floor(xb);
          minX = Math.min(minX, ia);
          maxX = Math.max(maxX, ib);
          const wgt = 1 / SUBSAMPLES;
          if (ia === ib) {
            cov[ia] += (xb - xa) * wgt;
          } else {
            cov[ia] += (ia + 1 - xa) * wgt;
            for (let x = ia + 1; x < ib; x++) cov[x] += wgt;
            if (ib < W) cov[ib] += (xb - ib) * wgt;
          }
        }
      }

      if (!touched) continue;
      for (let x = minX; x <= Math.min(maxX, W - 1); x++) {
        if (cov[x] > 0) this.blend(x, y, color[0], color[1], color[2], Math.min(1, cov[x]) * alpha);
      }
    }
  }
}

interface GlyphCommand {
  type: string;
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

/** Flatten opentype.js path commands into device-space polygons. */
const flattenGlyphPath = (cmds: GlyphCommand[], tp: (x: number, y: number) => Pt, scale: number): Pt[][] => {
  const polys: Pt[][] = [];
  let cur: Pt[] = [];
  let lx = 0;
  let ly = 0;
  const steps = (len: number) => Math.max(2, Math.min(24, Math.ceil(Math.sqrt(len * scale) * 1.5)));

  for (const c of cmds) {
    switch (c.type) {
      case "M":
        if (cur.length > 2) polys.push(cur);
        cur = [tp(c.x!, c.y!)];
        lx = c.x!;
        ly = c.y!;
        break;
      case "L":
        cur.push(tp(c.x!, c.y!));
        lx = c.x!;
        ly = c.y!;
        break;
      case "Q": {
        const n = steps(Math.hypot(c.x1! - lx, c.y1! - ly) + Math.hypot(c.x! - c.x1!, c.y! - c.y1!));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const mt = 1 - t;
          cur.push(
            tp(
              mt * mt * lx + 2 * mt * t * c.x1! + t * t * c.x!,
              mt * mt * ly + 2 * mt * t * c.y1! + t * t * c.y!,
            ),
          );
        }
        lx = c.x!;
        ly = c.y!;
        break;
      }
      case "C": {
        const n = steps(
          Math.hypot(c.x1! - lx, c.y1! - ly) + Math.hypot(c.x2! - c.x1!, c.y2! - c.y1!) + Math.hypot(c.x! - c.x2!, c.y! - c.y2!),
        );
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const mt = 1 - t;
          cur.push(
            tp(
              mt * mt * mt * lx + 3 * mt * mt * t * c.x1! + 3 * mt * t * t * c.x2! + t * t * t * c.x!,
              mt * mt * mt * ly + 3 * mt * mt * t * c.y1! + 3 * mt * t * t * c.y2! + t * t * t * c.y!,
            ),
          );
        }
        lx = c.x!;
        ly = c.y!;
        break;
      }
      case "Z":
        if (cur.length > 2) polys.push(cur);
        cur = [];
        break;
    }
  }
  if (cur.length > 2) polys.push(cur);
  return polys;
};

/* ------------------------------------------------------------------------ */
/* Factories for niimbluelib RenderOptions                                  */
/* ------------------------------------------------------------------------ */

export const createSoftCanvas = (width: number, height: number) => new SoftCanvas(width, height);

export const loadTemplateImage = async (src: string): Promise<DecodedImage> => decodeDataUrlImage(src);
