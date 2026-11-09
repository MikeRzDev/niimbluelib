/* eslint-disable @typescript-eslint/no-floating-promises */
import { test, describe } from "node:test";
import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  fillTemplate,
  isTemplatePackage,
  NIIM_PACKAGE_MIME_TYPE,
  NiimTemplate,
  packTemplate,
  readTemplate,
  renderTemplate,
  TemplateFontData,
  templateFonts,
  unpackTemplate,
  validateTemplate,
} from "../template";

const FONT_PATH = join(__dirname, "../../../native/third_party/fonts/NotoSans-Bold.ttf");
const fontBytes = new Uint8Array(readFileSync(FONT_PATH));

const pngDataUrl = (w: number, h: number, black = true): string => {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = black ? "#000" : "#fff";
  ctx.fillRect(0, 0, w, h);
  return c.toDataURL("image/png");
};

const makeTemplate = (): NiimTemplate => {
  const logo = pngDataUrl(16, 16);
  return {
    format: "niimblue-template",
    version: 1,
    title: "Package test",
    label: { width: 240, height: 96, printDirection: "top" },
    elements: [
      { type: "image", id: "logo", x: 4, y: 4, width: 16, height: 16, src: logo },
      { type: "image", x: 30, y: 4, width: 16, height: 16, src: logo },
      { type: "image", id: "other", x: 60, y: 4, width: 8, height: 8, src: pngDataUrl(8, 8, false) },
      { type: "text", x: 4, y: 40, width: 200, text: "{name}", font: { family: "Pkg Test Sans", size: 24, weight: "bold" } },
    ],
    fonts: [
      {
        family: "Pkg Test Sans",
        weight: "bold",
        src: `data:font/ttf;base64,${Buffer.from(fontBytes).toString("base64")}`,
      },
    ],
  };
};

describe("template package", () => {
  test("pack moves assets to files and unpack restores data URLs", () => {
    const t = makeTemplate();
    const pkg = packTemplate(t);
    ok(isTemplatePackage(pkg));

    const files = unzipSync(pkg);
    strictEqual(strFromU8(files.mimetype), NIIM_PACKAGE_MIME_TYPE);
    // mimetype is the first entry, stored (ODF / EPUB style)
    strictEqual(strFromU8(pkg.subarray(30, 38)), "mimetype");
    strictEqual(pkg[8], 0);

    const inner = JSON.parse(strFromU8(files["template.json"])) as NiimTemplate;
    const srcs = inner.elements.map((e) => (e.type === "image" ? e.src : undefined));
    deepStrictEqual(srcs, ["images/logo.png", "images/logo.png", "images/other.png", undefined]);
    strictEqual(inner.fonts?.[0].src, "fonts/Pkg_Test_Sans-bold.ttf");
    deepStrictEqual(Object.keys(files).sort(), [
      "fonts/Pkg_Test_Sans-bold.ttf",
      "images/logo.png",
      "images/other.png",
      "mimetype",
      "template.json",
    ]);
    deepStrictEqual(files["fonts/Pkg_Test_Sans-bold.ttf"], fontBytes);

    const back = unpackTemplate(pkg);
    deepStrictEqual(back, JSON.parse(JSON.stringify(t)));
  });

  test("fillTemplate returns an independent copy, assets kept", () => {
    const t = makeTemplate();
    const before = JSON.stringify(t);
    const filled = fillTemplate(t, { name: "Hello" });
    const text = filled.elements[3];
    ok(text.type === "text" && text.text === "Hello");
    strictEqual(filled.fonts?.[0].src, t.fonts?.[0].src);

    // mutating the copy leaves the original alone
    if (text.type === "text") text.font.size = 99;
    filled.fonts![0].family = "Changed";
    filled.label.width = 1;
    strictEqual(JSON.stringify(t), before);
  });

  test("packing is deterministic", () => {
    deepStrictEqual(packTemplate(makeTemplate()), packTemplate(makeTemplate()));
  });

  test("readTemplate opens packages only", () => {
    const t = makeTemplate();
    deepStrictEqual(readTemplate(packTemplate(t)), t);
    deepStrictEqual(readTemplate(packTemplate(t).slice().buffer), t);
    throws(() => readTemplate(strToU8(JSON.stringify(t))), /Not a \.niim template package/);
  });

  test("extra files and package path sources", () => {
    const t = makeTemplate();
    const preview = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    t.elements[2] = { type: "image", x: 0, y: 0, width: 8, height: 8, src: "images/given.png" };
    const pkg = packTemplate(t, { files: { "preview.png": preview, "images/given.png": readPng() } });
    const files = unzipSync(pkg);
    deepStrictEqual(files["preview.png"], preview);
    const back = unpackTemplate(pkg);
    const el = back.elements[2];
    ok(el.type === "image" && el.src.startsWith("data:image/png;base64,"));

    t.elements[2] = { type: "image", x: 0, y: 0, width: 8, height: 8, src: "images/nope.png" };
    throws(() => packTemplate(t), /elements\[2\]\.src: "images\/nope.png" is neither a data URL/);
    throws(() => packTemplate(makeTemplate(), { files: { "template.json": preview } }), /reserved/);
  });

  test("rejects bad packages", () => {
    throws(() => unpackTemplate(strToU8("{}")), /not a ZIP file/);
    throws(() => unpackTemplate(zipSync({ "a.txt": strToU8("x") })), /template.json not found/);
    throws(() => unpackTemplate(zipSync({ "template.json": strToU8("{oops") })), /template.json:/);

    const withSrc = (src: string) => {
      const t = makeTemplate();
      t.elements = [{ type: "image", x: 0, y: 0, width: 8, height: 8, src }];
      delete t.fonts;
      return zipSync({ "template.json": strToU8(JSON.stringify(t)) });
    };
    throws(() => unpackTemplate(withSrc("../etc/passwd")), /elements\[0\]\.src has an invalid path/);
    throws(() => unpackTemplate(withSrc("/abs.png")), /invalid path/);
    throws(() => unpackTemplate(withSrc("https://example.com/a.png")), /invalid path/);
    throws(() => unpackTemplate(withSrc("images/missing.png")), /refers to missing file images\/missing.png/);
    throws(() => unpackTemplate(packTemplate(makeTemplate()), { maxSize: 1000 }), /exceed 1000 bytes/);
  });

  test("validates fonts", () => {
    const t = makeTemplate();
    t.fonts = [{ family: "", src: "x" }];
    throws(() => validateTemplate(t), /fonts\[0\]\.family must be a non-empty string/);
    t.fonts = [{ family: "A", src: "x", style: "oblique" as "italic" }];
    throws(() => validateTemplate(t), /fonts\[0\]\.style must be one of/);
  });

  test("templateFonts decodes embedded fonts", () => {
    const [f] = templateFonts(makeTemplate());
    strictEqual(f.family, "Pkg Test Sans");
    strictEqual(f.weight, "bold");
    strictEqual(f.style, "normal");
    strictEqual(f.mimeType, "font/ttf");
    deepStrictEqual(f.data, fontBytes);

    const t = makeTemplate();
    t.fonts![0].src = "fonts/a.ttf";
    throws(() => templateFonts(t), /fonts\[0\]\.src must be a data URL/);
  });

  test("renderTemplate loads embedded fonts with loadFont", async () => {
    const loaded: TemplateFontData[] = [];
    const t = unpackTemplate(packTemplate(makeTemplate()));
    const canvas = await renderTemplate(t, {
      createCanvas,
      loadImage,
      data: { name: "Hello" },
      loadFont: (f) => {
        loaded.push(f);
        GlobalFonts.register(Buffer.from(f.data), f.family);
      },
    });
    strictEqual(loaded.length, 1);
    strictEqual(loaded[0].family, "Pkg Test Sans");
    ok(GlobalFonts.has("Pkg Test Sans"));
    strictEqual(canvas.width, 240);
  });
});

function readPng(): Uint8Array {
  const url = pngDataUrl(8, 8);
  return new Uint8Array(Buffer.from(url.split(",")[1], "base64"));
}
