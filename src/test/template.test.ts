/* eslint-disable @typescript-eslint/no-floating-promises */
import { test, describe } from "node:test";
import { deepStrictEqual, ok, strictEqual, throws, rejects } from "node:assert";
import { Canvas, createCanvas, loadImage } from "@napi-rs/canvas";
import {
  encodeBarcode,
  fillString,
  fillTemplate,
  listTags,
  measureTextElement,
  NiimTemplate,
  renderTemplate,
  RenderOptions,
  TemplateCanvas,
  TemplateElement,
  TemplateTextElement,
  templateToImageSource,
  validateTemplate,
} from "../template";
import { ImageEncoder } from "../utils";
import { PageColorType } from "../packets";

/** Compile-time check: common canvas implementations satisfy TemplateCanvas without casts. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _typecheck = (dom: HTMLCanvasElement, offscreen: OffscreenCanvas, napi: Canvas): TemplateCanvas[] => [
  dom,
  offscreen,
  napi,
];

const renderOpts: RenderOptions = { createCanvas, loadImage };

const makeTemplate = (elements: TemplateElement[], extra: Partial<NiimTemplate> = {}): NiimTemplate => ({
  format: "niimblue-template",
  version: 1,
  label: { width: 240, height: 120, printDirection: "top" },
  elements,
  ...extra,
});

type Rgb = [number, number, number];

const pixels = (canvas: TemplateCanvas) => {
  const ctx = canvas.getContext("2d")!;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const at = (x: number, y: number): Rgb => {
    const i = (y * canvas.width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const count = (x0: number, y0: number, x1: number, y1: number, color: Rgb): number => {
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = at(x, y);
        if (p[0] === color[0] && p[1] === color[1] && p[2] === color[2]) n++;
      }
    }
    return n;
  };
  return { data, at, count };
};

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];
const RED: Rgb = [255, 0, 0];

describe("Template validation", () => {
  const valid = makeTemplate(
    [
      { type: "text", x: 0, y: 0, width: 100, text: "Hello {name}", font: { family: "sans-serif", size: 20 } },
      { type: "qrcode", x: 0, y: 0, size: 50, value: "{url}" },
      { type: "barcode", x: 0, y: 0, width: 100, height: 40, value: "123", encoding: "CODE128" },
      { type: "rect", x: 0, y: 0, width: 10, height: 10, radius: 2 },
      { type: "ellipse", x: 0, y: 0, width: 10, height: 10, fill: "red" },
      { type: "line", points: [[0, 0], [10, 10]] },
      { type: "image", x: 0, y: 0, width: 10, height: 10, src: "data:image/png;base64,AAAA" },
    ],
    { fields: [{ name: "name", required: true }] },
  );

  test("accepts valid template", () => {
    strictEqual(validateTemplate(JSON.parse(JSON.stringify(valid))).elements.length, 7);
  });

  test("rejects non-object", () => throws(() => validateTemplate(null), /must be an object/));
  test("rejects bad format", () => throws(() => validateTemplate({ ...valid, format: "x" }), /format must be/));
  test("rejects bad version", () => throws(() => validateTemplate({ ...valid, version: 2 }), /version must be 1/));
  test("rejects missing label", () => throws(() => validateTemplate({ ...valid, label: undefined }), /label/));
  test("rejects bad printDirection", () =>
    throws(
      () => validateTemplate({ ...valid, label: { ...valid.label, printDirection: "up" } }),
      /label\.printDirection must be one of/,
    ));

  test("rejects bad qr size with path", () => {
    const t = JSON.parse(JSON.stringify(valid));
    t.elements[1].size = -5;
    throws(() => validateTemplate(t), /elements\[1\]\.size must be a positive number/);
  });

  test("rejects unknown element type", () => {
    const t = JSON.parse(JSON.stringify(valid));
    t.elements[0].type = "star";
    throws(() => validateTemplate(t), /elements\[0\]\.type must be one of/);
  });

  test("rejects missing font size", () => {
    const t = JSON.parse(JSON.stringify(valid));
    delete t.elements[0].font.size;
    throws(() => validateTemplate(t), /elements\[0\]\.font\.size must be a positive number/);
  });

  test("rejects bad barcode encoding", () => {
    const t = JSON.parse(JSON.stringify(valid));
    t.elements[2].encoding = "QR";
    throws(() => validateTemplate(t), /elements\[2\]\.encoding must be one of/);
  });

  test("rejects line with one point", () => {
    const t = JSON.parse(JSON.stringify(valid));
    t.elements[5].points = [[0, 0]];
    throws(() => validateTemplate(t), /elements\[5\]\.points must be an array/);
  });

  test("rejects bad field", () => {
    const t = JSON.parse(JSON.stringify(valid));
    t.fields[0].required = "yes";
    throws(() => validateTemplate(t), /fields\[0\]\.required must be a boolean/);
  });
});

describe("Template tags", () => {
  const t = makeTemplate(
    [
      {
        type: "text",
        x: 0,
        y: 0,
        width: 100,
        text: "{name} costs {$price} at {dt|DD.MM.YYYY} {name}",
        font: { family: "sans-serif", size: 10 },
      },
      { type: "qrcode", x: 0, y: 0, size: 50, value: "https://x/{sku|upper}" },
      { type: "barcode", x: 0, y: 0, width: 100, height: 40, value: "{ean}", encoding: "EAN13" },
    ],
    {
      fields: [
        { name: "name", required: true },
        { name: "unit", default: "pcs" },
        { name: "note" },
      ],
    },
  );

  test("listTags", () => {
    deepStrictEqual(listTags(t), ["name", "price", "sku", "ean", "unit", "note"]);
  });

  test("listTags includes dt when declared", () => {
    ok(listTags({ ...t, fields: [{ name: "dt" }] }).includes("dt"));
  });

  test("fillString", () => {
    strictEqual(
      fillString("{a} {$b} {c|fmt} {x}", (n, f) => (n === "x" ? undefined : `${n}${f ?? ""}`)),
      "a b cfmt {x}",
    );
    strictEqual(fillString("no tags {} {}", () => "X"), "no tags {} {}");
  });

  test("NiimBlue tag grammar", () => {
    const calls: [string, string?, string?][] = [];
    const out = fillString("{ name }|{ $price | 0.00 }|{dt+3d|YYYY}|{dt-12h}|{a.b}|{ü}|{x y}", (n, f, o) => {
      calls.push([n, f, o]);
      return n.toUpperCase();
    });
    strictEqual(out, "NAME|PRICE|DT|DT|{a.b}|{ü}|{x y}");
    deepStrictEqual(calls, [
      ["name", undefined, undefined],
      ["price", "0.00", undefined],
      ["dt", "YYYY", "+3d"],
      ["dt", undefined, "-12h"],
    ]);
  });

  test("dt is built-in: not listed, resolved via resolve, else left as is", () => {
    const tt = makeTemplate([
      { type: "text", x: 0, y: 0, width: 100, text: "{ dt+1d | DD.MM }", font: { family: "sans-serif", size: 10 } },
    ]);
    deepStrictEqual(listTags(tt), []);
    strictEqual((fillTemplate(tt, {}).elements[0] as TemplateTextElement).text, "{ dt+1d | DD.MM }");
    strictEqual(
      (fillTemplate(tt, {}, { strict: true }).elements[0] as TemplateTextElement).text,
      "{ dt+1d | DD.MM }",
    );
    strictEqual(
      (fillTemplate(tt, {}, { resolve: (n, f, o) => `${n}:${f}:${o}` }).elements[0] as TemplateTextElement).text,
      "dt:DD.MM:+1d",
    );
  });

  test("fillTemplate non-strict leaves unresolved", () => {
    const filled = fillTemplate(t, { name: "Apple", price: "1$" });
    const text = filled.elements[0] as TemplateTextElement;
    strictEqual(text.text, "Apple costs 1$ at {dt|DD.MM.YYYY} Apple");
    strictEqual((filled.elements[2] as { value: string }).value, "{ean}");
    // original untouched
    strictEqual((t.elements[0] as TemplateTextElement).text, "{name} costs {$price} at {dt|DD.MM.YYYY} {name}");
  });

  test("fillTemplate $-prefixed data keys", () => {
    const filled = fillTemplate(t, { $name: "Pear" });
    ok((filled.elements[0] as TemplateTextElement).text.startsWith("Pear costs"));
  });

  test("fillTemplate defaults", () => {
    const tt = makeTemplate(
      [{ type: "text", x: 0, y: 0, width: 100, text: "{qty} {unit}", font: { family: "sans-serif", size: 10 } }],
      { fields: [{ name: "unit", default: "pcs" }] },
    );
    strictEqual((fillTemplate(tt, { qty: "3" }).elements[0] as TemplateTextElement).text, "3 pcs");
    strictEqual((fillTemplate(tt, { qty: "3", unit: "kg" }).elements[0] as TemplateTextElement).text, "3 kg");
  });

  test("fillTemplate resolve", () => {
    const filled = fillTemplate(
      t,
      { name: "A", price: "1" },
      { resolve: (tag, format) => (tag === "dt" ? `date:${format}` : tag === "sku" ? `S-${format}` : undefined) },
    );
    strictEqual((filled.elements[0] as TemplateTextElement).text, "A costs 1 at date:DD.MM.YYYY A");
    strictEqual((filled.elements[1] as { value: string }).value, "https://x/S-upper");
  });

  test("fillTemplate strict: missing required throws", () => {
    throws(() => fillTemplate(t, { price: "1", sku: "x", ean: "1" }, { strict: true }), /Missing.*name/);
  });

  test("fillTemplate strict: missing undeclared throws", () => {
    throws(() => fillTemplate(t, { name: "A", sku: "x", ean: "1" }, { strict: true }), /Missing.*price/);
  });

  test("fillTemplate strict: complete data", () => {
    const tt = makeTemplate(
      [{ type: "text", x: 0, y: 0, width: 100, text: "{name}[{note}]{dt}", font: { family: "sans-serif", size: 10 } }],
      { fields: [{ name: "name", required: true }, { name: "note" }] },
    );
    // optional declared field becomes empty, reserved dt left as is
    strictEqual(
      (fillTemplate(tt, { name: "A" }, { strict: true }).elements[0] as TemplateTextElement).text,
      "A[]{dt}",
    );
  });
});

describe("Template rendering", () => {
  test("canvas size and filled rect", async () => {
    const t = makeTemplate([{ type: "rect", x: 10, y: 10, width: 40, height: 30, fill: "black" }]);
    const canvas = await renderTemplate(t, renderOpts);
    strictEqual(canvas.width, 240);
    strictEqual(canvas.height, 120);
    const p = pixels(canvas);
    strictEqual(p.count(10, 10, 50, 40, BLACK), 40 * 30);
    deepStrictEqual(p.at(5, 5), WHITE);
    deepStrictEqual(p.at(60, 60), WHITE);
  });

  test("stroked rect stays inside box", async () => {
    const t = makeTemplate([{ type: "rect", x: 10, y: 10, width: 40, height: 30, strokeWidth: 2 }]);
    const p = pixels(await renderTemplate(t, renderOpts));
    deepStrictEqual(p.at(10, 10), BLACK);
    deepStrictEqual(p.at(49, 39), BLACK);
    deepStrictEqual(p.at(9, 20), WHITE);
    deepStrictEqual(p.at(50, 20), WHITE);
    deepStrictEqual(p.at(30, 25), WHITE);
  });

  test("ellipse and line", async () => {
    const t = makeTemplate([
      { type: "ellipse", x: 100, y: 10, width: 40, height: 40, fill: "black", strokeWidth: 0 },
      { type: "line", points: [[0, 100], [239, 100]], strokeWidth: 1 },
    ]);
    const p = pixels(await renderTemplate(t, renderOpts));
    deepStrictEqual(p.at(120, 30), BLACK);
    deepStrictEqual(p.at(101, 11), WHITE);
    strictEqual(p.count(0, 100, 240, 101, BLACK), 240);
    strictEqual(p.count(0, 99, 240, 100, BLACK), 0);
  });

  test("qrcode has black and white modules", async () => {
    const t = makeTemplate([{ type: "qrcode", x: 10, y: 10, size: 100, value: "https://niim.blue/ünïcode" }]);
    const p = pixels(await renderTemplate(t, renderOpts));
    const black = p.count(10, 10, 110, 110, BLACK);
    const white = p.count(10, 10, 110, 110, WHITE);
    ok(black > 1000, `black ${black}`);
    ok(white > 1000, `white ${white}`);
    strictEqual(p.count(120, 0, 240, 120, BLACK), 0);
  });

  test("barcode has bars", async () => {
    const t = makeTemplate([
      { type: "barcode", x: 10, y: 10, width: 220, height: 60, value: "590123412345", encoding: "EAN13" },
    ]);
    const p = pixels(await renderTemplate(t, renderOpts));
    // a scan line through the bars alternates
    let transitions = 0;
    for (let x = 11; x < 230; x++) {
      if (p.at(x, 20)[0] !== p.at(x - 1, 20)[0]) transitions++;
    }
    ok(transitions > 40, `transitions ${transitions}`);
    // text area under bars has some black pixels
    ok(p.count(10, 58, 230, 70, BLACK) > 0);
  });

  test("barcode encoders", () => {
    strictEqual(encodeBarcode("590123412345", "EAN13").text, "5901234123457");
    strictEqual(encodeBarcode("5901234123457", "EAN13").bars.length, 95);
    strictEqual(encodeBarcode("96385074", "EAN8").bars.length, 67);
    strictEqual(encodeBarcode("123456789999", "UPC").bars.length, 95);
    ok(encodeBarcode("Hello-123", "CODE128").bars.length > 0);
    ok(encodeBarcode("HELLO", "CODE39").bars.length > 0);
    ok(encodeBarcode("1234567890123", "ITF14").bars.length > 0);
    throws(() => encodeBarcode("12345", "EAN13"), /Invalid EAN13 value/);
  });

  test("invalid barcode value rejects render", async () => {
    const t = makeTemplate([{ type: "barcode", x: 0, y: 0, width: 100, height: 40, value: "abc", encoding: "EAN8" }]);
    await rejects(() => renderTemplate(t, renderOpts), /Invalid EAN8 value/);
  });

  test("text is drawn and filled", async () => {
    const t = makeTemplate([
      { type: "text", x: 0, y: 0, width: 240, height: 120, text: "{word}", font: { family: "sans-serif", size: 60 } },
    ]);
    const p = pixels(await renderTemplate(t, { ...renderOpts, data: { word: "WWW" } }));
    ok(p.count(0, 0, 240, 120, BLACK) > 500);
  });

  test("only pure colors in output", async () => {
    const t = makeTemplate([
      {
        type: "text",
        x: 5,
        y: 5,
        width: 200,
        text: "Antialiased text gjpqy",
        font: { family: "sans-serif", size: 17, style: "italic", weight: "bold" },
        angle: 13,
      },
      { type: "ellipse", x: 150, y: 50, width: 60, height: 50, strokeWidth: 3, color: "red" },
      { type: "line", points: [[0, 0], [240, 120], [0, 120]], strokeWidth: 2.5 },
    ]);
    const { data } = pixels(await renderTemplate(t, renderOpts));
    let red = 0;
    for (let i = 0; i < data.length; i += 4) {
      const c = `${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`;
      ok(c === "0,0,0,255" || c === "255,255,255,255" || c === "255,0,0,255", `unexpected color ${c}`);
      if (c === "255,0,0,255") red++;
    }
    ok(red > 0);
  });

  test("red is black when template has no red", async () => {
    const t = makeTemplate([{ type: "rect", x: 0, y: 0, width: 20, height: 20, fill: "black" }]);
    const p = pixels(await renderTemplate(t, renderOpts));
    strictEqual(p.count(0, 0, 240, 120, RED), 0);
  });

  test("rotation", async () => {
    const t = makeTemplate([
      { type: "rect", x: 100, y: 0, width: 40, height: 120, fill: "black", strokeWidth: 0, angle: 90 },
      { type: "qrcode", x: 10, y: 10, size: 60, value: "rotated", angle: 45 },
      { type: "text", x: 10, y: 10, width: 80, text: "rotated", font: { family: "sans-serif", size: 12 }, angle: -30 },
      { type: "line", points: [[0, 0], [20, 20]], angle: 180 },
    ]);
    const p = pixels(await renderTemplate(t, renderOpts));
    // 40x120 vertical bar rotated 90deg around (120, 60) becomes a horizontal 120x40 bar
    deepStrictEqual(p.at(70, 60), BLACK);
    deepStrictEqual(p.at(170, 60), BLACK);
    deepStrictEqual(p.at(120, 10), WHITE);
  });

  test("shrink fit reduces font size", async () => {
    const e: TemplateTextElement = {
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 30,
      text: "A very long text that does not fit into a small box",
      font: { family: "sans-serif", size: 40 },
      fit: "shrink",
    };
    const ctx = createCanvas(10, 10).getContext("2d");
    const layout = measureTextElement(ctx, e);
    ok(layout.size < 40, `size ${layout.size}`);
    ok(layout.size >= 4);
    ok(layout.blockHeight <= 30 || layout.size === 4);
    const noFit = measureTextElement(ctx, { ...e, fit: "none" });
    strictEqual(noFit.size, 40);
    ok(noFit.lines.length > 1);

    const maxLines = measureTextElement(ctx, { ...e, height: undefined, maxLines: 1 });
    strictEqual(maxLines.lines.length, 1);
  });

  test("wrapping, newlines and overlong words", () => {
    const ctx = createCanvas(10, 10).getContext("2d");
    const base: TemplateTextElement = {
      type: "text",
      x: 0,
      y: 0,
      width: 60,
      text: "",
      font: { family: "sans-serif", size: 12 },
    };
    strictEqual(measureTextElement(ctx, { ...base, text: "a\nb\n\nc" }).lines.length, 4);
    const broken = measureTextElement(ctx, { ...base, text: "Supercalifragilisticexpialidocious" });
    ok(broken.brokeWord);
    ok(broken.lines.length > 1);
    for (const line of broken.lines) ok(ctx.measureText(line).width <= 60);
  });

  test("image element", async () => {
    const src = createCanvas(4, 4);
    const sctx = src.getContext("2d");
    sctx.fillStyle = "#000";
    sctx.fillRect(0, 0, 4, 4);
    const t = makeTemplate([{ type: "image", x: 20, y: 20, width: 40, height: 40, src: src.toDataURL("image/png") }]);
    const p = pixels(await renderTemplate(t, renderOpts));
    deepStrictEqual(p.at(40, 40), BLACK);
    deepStrictEqual(p.at(10, 10), WHITE);
  });

  test("default canvas factory fails in Node with a clear error", async () => {
    await rejects(() => renderTemplate(makeTemplate([])), /createCanvas/);
  });

  test("encode rendered canvas", async () => {
    const t = makeTemplate([{ type: "rect", x: 0, y: 0, width: 240, height: 10, fill: "black" }]);
    const canvas = await renderTemplate(t, renderOpts);
    const top = ImageEncoder.encode(templateToImageSource(canvas), PageColorType.SingleColor, "top");
    strictEqual(top.rows, 120);
    strictEqual(top.cols, 240);
    strictEqual(top.rowsData[0].dataType, "pixels");
    strictEqual(top.rowsData[0].repeat, 10);
    strictEqual(top.rowsData[0].blackPixelsCount, 240);

    const left = ImageEncoder.encode(templateToImageSource(canvas), PageColorType.SingleColor, "left");
    strictEqual(left.rows, 240);
    strictEqual(left.cols, 120);
  });
});
