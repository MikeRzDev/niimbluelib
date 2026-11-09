import qrcode from "qrcode-generator";
import { CanvasImageSource, ImageSource } from "../utils/image_encoder";
import { FillOptions, fillTemplate } from "./fill";
import { TemplateFontData, templateFonts } from "./package";
import {
  NiimTemplate,
  TemplateBarcodeElement,
  TemplateColor,
  TemplateElement,
  TemplateImageElement,
  TemplateLineElement,
  TemplateQrElement,
  TemplateShapeElement,
  TemplateTextElement,
} from "./types";

/**
 * Subset of `CanvasRenderingContext2D` used by the template renderer.
 * Satisfied by DOM canvas, `OffscreenCanvas` and `@napi-rs/canvas` contexts.
 *
 * @category Template
 */
export interface TemplateContext2D {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  imageSmoothingEnabled: boolean;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
  ): void;
  stroke(): void;
  fill(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  drawImage(image: any, dx: number, dy: number, dw: number, dh: number): void;
  getImageData(
    sx: number,
    sy: number,
    sw: number,
    sh: number,
  ): { width: number; height: number; data: Uint8ClampedArray | Uint8Array };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  putImageData(imageData: any, dx: number, dy: number): void;
}

/**
 * Minimal canvas interface. Satisfied by `HTMLCanvasElement`, `OffscreenCanvas` and `@napi-rs/canvas` `Canvas`.
 *
 * @category Template
 */
export interface TemplateCanvas {
  width: number;
  height: number;
  getContext(contextId: "2d"): TemplateContext2D | null;
}

/** @category Template */
export interface RenderOptions {
  /**
   * Canvas factory. Default: `OffscreenCanvas` or `document.createElement("canvas")`.
   * Required in Node (e.g. `createCanvas` from `@napi-rs/canvas`).
   */
  createCanvas?: (width: number, height: number) => TemplateCanvas;
  /**
   * Image loader for image elements. Must return something `drawImage` accepts.
   * Default: `createImageBitmap(await (await fetch(src)).blob())`.
   * In Node pass e.g. `loadImage` from `@napi-rs/canvas`.
   */
  loadImage?: (src: string) => Promise<unknown>;
  /**
   * Font loader for fonts embedded in the template (`fonts`), called before drawing.
   * Default: register them with the CSS Font Loading API (`FontFace`, `document.fonts` / `self.fonts`) once
   * per font, if available, otherwise embedded fonts are skipped.
   * In Node with `@napi-rs/canvas` pass e.g. `(f) => { GlobalFonts.register(Buffer.from(f.data), f.family); }`.
   */
  loadFont?: (font: TemplateFontData) => Promise<void> | void;
  /** Luminance threshold (0-255) for black/white conversion. Default 128. */
  threshold?: number;
  /** If set, template is filled with {@link fillTemplate} before rendering. */
  data?: Record<string, string>;
  /** Options for {@link fillTemplate}. */
  fill?: FillOptions;
}

const COLOR_CSS: Record<TemplateColor, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
};

const GENERIC_FONT_FAMILIES = [
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
];

/** fabric.js text metrics constants, used to place lines like the NiimBlue editor does. */
const FONT_SIZE_MULT = 1.13;
const FONT_SIZE_FRACTION = 0.222;
const DEFAULT_LINE_HEIGHT = 1.16;
const MIN_FONT_SIZE = 4;

const defaultCreateCanvas = (width: number, height: number): TemplateCanvas => {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height) as unknown as TemplateCanvas;
  }
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as TemplateCanvas;
  }
  throw new Error(
    "No canvas implementation available. In Node pass RenderOptions.createCanvas " +
      '(e.g. `import { createCanvas } from "@napi-rs/canvas"`).',
  );
};

type FontFaceSetLike = { add(face: unknown): void };

/** Registered embedded fonts by `src` (data URL), default font loader only. */
const loadedFontFaces = new Map<string, Promise<void>>();

const defaultLoadFont = (f: TemplateFontData): Promise<void> => {
  const g = globalThis as unknown as {
    FontFace?: new (family: string, source: ArrayBuffer, descriptors?: object) => { load(): Promise<unknown> };
    document?: { fonts?: FontFaceSetLike };
    fonts?: FontFaceSetLike;
  };
  const set = g.document?.fonts ?? g.fonts;
  if (g.FontFace === undefined || set === undefined) {
    return Promise.resolve();
  }
  let p = loadedFontFaces.get(f.src);
  if (p === undefined) {
    const buf = f.data.slice().buffer;
    const face = new g.FontFace(f.family, buf, { weight: String(f.weight), style: f.style });
    p = face.load().then(
      (loaded) => set.add(loaded),
      (e: unknown) => {
        loadedFontFaces.delete(f.src);
        throw new Error(`Unable to load font "${f.family}": ${e instanceof Error ? e.message : String(e)}`);
      },
    );
    loadedFontFaces.set(f.src, p);
  }
  return p;
};

const defaultLoadImage = async (src: string): Promise<unknown> => {
  if (typeof createImageBitmap !== "function" || typeof fetch !== "function") {
    throw new Error(
      "No image loader available. In Node pass RenderOptions.loadImage " +
        '(e.g. `import { loadImage } from "@napi-rs/canvas"`).',
    );
  }
  const response = await fetch(src);
  return createImageBitmap(await response.blob());
};

/** Quote font family names for the CSS font shorthand, keeping generic families unquoted. */
const quoteFontFamily = (family: string): string =>
  family
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .map((f) => {
      if (f.startsWith('"') || f.startsWith("'") || GENERIC_FONT_FAMILIES.includes(f.toLowerCase())) {
        return f;
      }
      return `"${f.replace(/"/g, '\\"')}"`;
    })
    .join(", ");

const fontString = (e: TemplateTextElement, size: number): string =>
  `${e.font.style ?? "normal"} ${e.font.weight ?? "normal"} ${size}px ${quoteFontFamily(e.font.family)}`;

export interface TemplateTextLayout {
  size: number;
  lines: string[];
  /** A word was wider than the box and had to be broken by characters. */
  brokeWord: boolean;
  /** Distance between baselines. */
  lineStep: number;
  /** Total text block height. */
  blockHeight: number;
}

/** Break a word that doesn't fit the width by characters. */
const breakWord = (ctx: TemplateContext2D, word: string, width: number): string[] => {
  const parts: string[] = [];
  let current = "";
  for (const ch of Array.from(word)) {
    if (current.length > 0 && ctx.measureText(current + ch).width > width) {
      parts.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
};

const layoutText = (ctx: TemplateContext2D, e: TemplateTextElement, size: number): TemplateTextLayout => {
  ctx.font = fontString(e, size);
  const lines: string[] = [];
  let brokeWord = false;

  for (const paragraph of e.text.split(/\r?\n/)) {
    const words = paragraph.split(" ");
    let line = "";
    let hasLine = false;

    for (const word of words) {
      const candidate = hasLine ? `${line} ${word}` : word;

      if (ctx.measureText(candidate).width <= e.width) {
        line = candidate;
        hasLine = true;
        continue;
      }

      if (hasLine) {
        lines.push(line);
      }

      if (ctx.measureText(word).width > e.width) {
        brokeWord = true;
        const parts = breakWord(ctx, word, e.width);
        lines.push(...parts.slice(0, -1));
        line = parts[parts.length - 1];
      } else {
        line = word;
      }
      hasLine = true;
    }
    lines.push(line);
  }

  const lineHeight = e.lineHeight ?? DEFAULT_LINE_HEIGHT;
  const lineStep = size * FONT_SIZE_MULT * lineHeight;
  const blockHeight = lineStep * (lines.length - 1) + size * FONT_SIZE_MULT;

  return { size, lines, brokeWord, lineStep, blockHeight };
};

const fits = (e: TemplateTextElement, l: TemplateTextLayout): boolean =>
  !l.brokeWord &&
  (e.maxLines === undefined || l.lines.length <= e.maxLines) &&
  (e.height === undefined || l.blockHeight <= e.height);

/**
 * Compute text layout (font size after fitting and wrapped lines).
 * Exposed for tests and previews.
 *
 * @category Template
 */
export const measureTextElement = (ctx: TemplateContext2D, e: TemplateTextElement): TemplateTextLayout => {
  let layout = layoutText(ctx, e, e.font.size);

  if (e.fit === "shrink") {
    let size = e.font.size;
    while (!fits(e, layout) && size > MIN_FONT_SIZE) {
      size = Math.max(MIN_FONT_SIZE, size - 1);
      layout = layoutText(ctx, e, size);
    }
    if (e.maxLines !== undefined && layout.lines.length > e.maxLines) {
      layout.lines = layout.lines.slice(0, e.maxLines);
      layout.blockHeight = layout.lineStep * (layout.lines.length - 1) + layout.size * FONT_SIZE_MULT;
    }
  }

  return layout;
};

const elementCenter = (ctx: TemplateContext2D, e: TemplateElement): [number, number] => {
  switch (e.type) {
    case "text": {
      const h = e.height ?? measureTextElement(ctx, e).blockHeight;
      return [e.x + e.width / 2, e.y + h / 2];
    }
    case "qrcode":
      return [e.x + e.size / 2, e.y + e.size / 2];
    case "line": {
      const xs = e.points.map((p) => p[0]);
      const ys = e.points.map((p) => p[1]);
      return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    }
    default:
      return [e.x + e.width / 2, e.y + e.height / 2];
  }
};

const drawText = (ctx: TemplateContext2D, e: TemplateTextElement) => {
  const layout = measureTextElement(ctx, e);
  const boxHeight = e.height ?? layout.blockHeight;

  if (e.background !== undefined) {
    ctx.fillStyle = COLOR_CSS[e.background];
    ctx.fillRect(e.x, e.y, e.width, boxHeight);
  }

  let top = e.y;
  if (e.height !== undefined) {
    if (e.verticalAlign === "middle") {
      top += (e.height - layout.blockHeight) / 2;
    } else if (e.verticalAlign === "bottom") {
      top += e.height - layout.blockHeight;
    }
  }

  let x = e.x;
  let textAlign = "left";
  if (e.align === "center") {
    x += e.width / 2;
    textAlign = "center";
  } else if (e.align === "right") {
    x += e.width;
    textAlign = "right";
  }

  ctx.font = fontString(e, layout.size);
  ctx.fillStyle = COLOR_CSS[e.color ?? "black"];
  ctx.textAlign = textAlign;
  ctx.textBaseline = "alphabetic";

  const firstBaseline = layout.size * FONT_SIZE_MULT * (1 - FONT_SIZE_FRACTION);
  layout.lines.forEach((line, i) => {
    ctx.fillText(line, x, top + firstBaseline + i * layout.lineStep);
  });
};

const drawQr = (ctx: TemplateContext2D, e: TemplateQrElement) => {
  if (e.value.length === 0) {
    return;
  }

  // Encode as UTF-8 without permanently changing the shared qrcode-generator module state.
  // The library's own UTF-8 helper (stringToBytesFuncs) only exists in its CommonJS build,
  // the ESM build used by bundlers has a Latin-1 stringToBytes only, so encode here.
  const prevStringToBytes = qrcode.stringToBytes;
  let qr: ReturnType<typeof qrcode>;
  try {
    qrcode.stringToBytes = (s: string) => Array.from(new TextEncoder().encode(s));
    qr = qrcode(0, e.ecl ?? "M");
    qr.addData(e.value, "Byte");
    qr.make();
  } finally {
    qrcode.stringToBytes = prevStringToBytes;
  }

  const count = qr.getModuleCount();
  let moduleSize = Math.floor(e.size / count);
  if (moduleSize < 1) {
    moduleSize = e.size / count;
  }
  const offset = (e.size - moduleSize * count) / 2;
  const ox = Math.round(e.x + offset);
  const oy = Math.round(e.y + offset);

  ctx.fillStyle = COLOR_CSS[e.color ?? "black"];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect(ox + col * moduleSize, oy + row * moduleSize, moduleSize, moduleSize);
      }
    }
  }
};

interface BarcodeEncoder {
  valid(): boolean;
  encode(): BarcodeEncoding | BarcodeEncoding[];
}
interface BarcodeEncoding {
  data: string;
  text?: string;
}
type BarcodeEncoderCtor = new (data: string, options: Record<string, unknown>) => BarcodeEncoder;

let barcodeEncoders: Record<string, BarcodeEncoderCtor> | undefined;

const getBarcodeEncoders = (): Record<string, BarcodeEncoderCtor> => {
  if (barcodeEncoders === undefined) {
    // Pure encoders from jsbarcode, without DOM renderers.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("jsbarcode/bin/barcodes");
    barcodeEncoders = (mod.default ?? mod) as Record<string, BarcodeEncoderCtor>;
  }
  return barcodeEncoders;
};

/**
 * Encode barcode value into a string of bars (`"1"` = bar, `"0"` = space) and human readable text.
 *
 * @throws Error if value is not valid for the encoding.
 * @category Template
 */
export const encodeBarcode = (
  value: string,
  encoding: TemplateBarcodeElement["encoding"],
): { bars: string; text: string } => {
  const Encoder = getBarcodeEncoders()[encoding];
  if (Encoder === undefined) {
    throw new Error(`Unsupported barcode encoding: ${encoding}`);
  }

  let encoder: BarcodeEncoder;
  try {
    encoder = new Encoder(value, {
      flat: true,
      width: 2,
      height: 100,
      fontSize: 20,
      textMargin: 2,
      displayValue: true,
      text: undefined,
      mod43: false,
    });
  } catch (err) {
    throw new Error(`Invalid ${encoding} value: "${value}" (${err})`);
  }

  if (!encoder.valid()) {
    throw new Error(`Invalid ${encoding} value: "${value}"`);
  }

  const encoded = encoder.encode();
  const parts = Array.isArray(encoded) ? encoded : [encoded];

  return {
    bars: parts.map((p) => p.data).join(""),
    text: parts.map((p) => p.text ?? "").join(""),
  };
};

const drawBarcode = (ctx: TemplateContext2D, e: TemplateBarcodeElement) => {
  const { bars, text } = encodeBarcode(e.value, e.encoding);
  const showText = e.showText ?? true;
  const fontSize = e.fontSize ?? 12;
  const textMargin = 2;
  const barsHeight = showText ? Math.max(1, e.height - fontSize - textMargin) : e.height;

  let barWidth = Math.floor(e.width / bars.length);
  if (barWidth < 1) {
    barWidth = e.width / bars.length;
  }
  const ox = Math.round(e.x + (e.width - barWidth * bars.length) / 2);

  ctx.fillStyle = COLOR_CSS[e.color ?? "black"];

  // Draw runs of bars as single rectangles
  let i = 0;
  while (i < bars.length) {
    if (bars[i] !== "1") {
      i++;
      continue;
    }
    const start = i;
    while (i < bars.length && bars[i] === "1") i++;
    ctx.fillRect(ox + start * barWidth, e.y, (i - start) * barWidth, barsHeight);
  }

  if (showText) {
    ctx.font = `normal normal ${fontSize}px ${quoteFontFamily(e.fontFamily ?? "sans-serif")}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(text, e.x + e.width / 2, e.y + barsHeight + textMargin);
  }
};

const roundRectPath = (ctx: TemplateContext2D, x: number, y: number, w: number, h: number, r: number) => {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (r === 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

const ellipsePath = (ctx: TemplateContext2D, x: number, y: number, w: number, h: number) => {
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h / 2, Math.max(0, w / 2), Math.max(0, h / 2), 0, 0, Math.PI * 2);
  ctx.closePath();
};

const drawShape = (ctx: TemplateContext2D, e: TemplateShapeElement) => {
  const sw = e.strokeWidth ?? 1;
  const path = (inset: number) => {
    const x = e.x + inset;
    const y = e.y + inset;
    const w = e.width - inset * 2;
    const h = e.height - inset * 2;
    if (e.type === "ellipse") {
      ellipsePath(ctx, x, y, w, h);
    } else {
      roundRectPath(ctx, x, y, w, h, (e.radius ?? 0) - inset);
    }
  };

  if (e.fill !== undefined) {
    path(0);
    ctx.fillStyle = COLOR_CSS[e.fill];
    ctx.fill();
  }

  if (sw > 0) {
    path(sw / 2);
    ctx.lineWidth = sw;
    ctx.lineJoin = "miter";
    ctx.strokeStyle = COLOR_CSS[e.color ?? "black"];
    ctx.stroke();
  }
};

const drawLine = (ctx: TemplateContext2D, e: TemplateLineElement) => {
  const sw = e.strokeWidth ?? 1;
  if (sw <= 0) {
    return;
  }

  // Odd integer widths on integer coordinates are drawn on pixel centers to avoid blurry 2px lines.
  const snap = Number.isInteger(sw) && sw % 2 === 1;
  const c = (v: number) => (snap && Number.isInteger(v) ? v + 0.5 : v);

  ctx.beginPath();
  e.points.forEach(([px, py], i) => {
    if (i === 0) {
      ctx.moveTo(c(px), c(py));
    } else {
      ctx.lineTo(c(px), c(py));
    }
  });
  ctx.lineWidth = sw;
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  ctx.strokeStyle = COLOR_CSS[e.color ?? "black"];
  ctx.stroke();
};

const drawImage = async (
  ctx: TemplateContext2D,
  e: TemplateImageElement,
  loadImage: (src: string) => Promise<unknown>,
) => {
  const img = await loadImage(e.src);
  ctx.drawImage(img, e.x, e.y, e.width, e.height);
};

const usesRed = (t: NiimTemplate): boolean =>
  t.elements.some(
    (e) =>
      e.color === "red" ||
      ("fill" in e && e.fill === "red") ||
      ("background" in e && e.background === "red"),
  );

/** Convert every pixel to pure white, black or red. */
const postProcess = (ctx: TemplateContext2D, width: number, height: number, threshold: number, allowRed: boolean) => {
  const iData = ctx.getImageData(0, 0, width, height);
  const d = iData.data;

  for (let i = 0; i < d.length; i += 4) {
    // Composite over white
    const a = d[i + 3] / 255;
    const r = d[i] * a + 255 * (1 - a);
    const g = d[i + 1] * a + 255 * (1 - a);
    const b = d[i + 2] * a + 255 * (1 - a);

    let color: [number, number, number];

    if (allowRed && r >= threshold && g < threshold && b < threshold) {
      color = [255, 0, 0];
    } else if (0.299 * r + 0.587 * g + 0.114 * b < threshold) {
      color = [0, 0, 0];
    } else {
      color = [255, 255, 255];
    }

    d[i] = color[0];
    d[i + 1] = color[1];
    d[i + 2] = color[2];
    d[i + 3] = 255;
  }

  ctx.putImageData(iData, 0, 0);
};

/**
 * Render template to a canvas. Output contains only pure white, black (and red, if template uses red) pixels.
 *
 * @example Node
 * ```js
 * import { createCanvas, loadImage } from "@napi-rs/canvas";
 * const canvas = await renderTemplate(template, { createCanvas, loadImage, data: { name: "Hello" } });
 * ```
 *
 * @category Template
 */
export const renderTemplate = async (t: NiimTemplate, opts: RenderOptions = {}): Promise<TemplateCanvas> => {
  const template = opts.data !== undefined || opts.fill !== undefined ? fillTemplate(t, opts.data ?? {}, opts.fill) : t;
  const createCanvas = opts.createCanvas ?? defaultCreateCanvas;
  const loadImage = opts.loadImage ?? defaultLoadImage;
  const threshold = opts.threshold ?? 128;

  if (template.fonts !== undefined && template.fonts.length > 0) {
    const loadFont = opts.loadFont ?? defaultLoadFont;
    for (const f of templateFonts(template)) {
      await loadFont(f);
    }
  }

  const width = Math.round(template.label.width);
  const height = Math.round(template.label.height);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  if (ctx === null) {
    throw new Error("Unable to get 2d canvas context");
  }

  ctx.fillStyle = COLOR_CSS.white;
  ctx.fillRect(0, 0, width, height);

  for (const e of template.elements) {
    ctx.save();

    if (e.angle) {
      const [cx, cy] = elementCenter(ctx, e);
      ctx.translate(cx, cy);
      ctx.rotate((e.angle * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }

    try {
      switch (e.type) {
        case "text":
          drawText(ctx, e);
          break;
        case "qrcode":
          drawQr(ctx, e);
          break;
        case "barcode":
          drawBarcode(ctx, e);
          break;
        case "rect":
        case "ellipse":
          drawShape(ctx, e);
          break;
        case "line":
          drawLine(ctx, e);
          break;
        case "image":
          await drawImage(ctx, e, loadImage);
          break;
      }
    } finally {
      ctx.restore();
    }
  }

  postProcess(ctx, width, height, threshold, usesRed(template));

  return canvas;
};

/**
 * Create {@link ImageSource} from rendered canvas, to be used with `ImageEncoder.encode`.
 *
 * @category Template
 */
export const templateToImageSource = (canvas: TemplateCanvas): ImageSource => {
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("Unable to get 2d canvas context");
  }
  return CanvasImageSource.fromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
};
