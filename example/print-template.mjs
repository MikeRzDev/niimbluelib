/**
 * Render a NiimBlue template package (.niim) to PNG in Node.
 *
 * Usage (from the repository root, after `npm install && npm run build`):
 *
 *   node example/print-template.mjs example/sample-template.niim '{"name":"Hex bolt M6","sku":"HB-M6"}' [out.png]
 *
 * Data can be a JSON string or a path to a JSON file. An array of objects renders one PNG per row
 * (out-1.png, out-2.png, ...).
 *
 * Browser usage (prints on a connected printer, canvas and image loading are built in):
 *
 *   import { NiimbotBluetoothClient, printTemplate, readTemplate } from "@mmote/niimbluelib";
 *
 *   const client = new NiimbotBluetoothClient();
 *   await client.connect();
 *   const template = readTemplate(await (await fetch("label.niim")).arrayBuffer());
 *   await printTemplate(client, template, [{ name: "Hex bolt M6", sku: "HB-M6" }], {
 *     quantity: 1,
 *     onProgress: (page, total) => console.log(`Printed ${page}/${total}`),
 *   });
 *
 * In Node, printTemplate also works, pass `render: { createCanvas, loadImage }` from @napi-rs/canvas
 * (and `loadFont` to register fonts embedded in the package, e.g. with GlobalFonts.register).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import lib from "../dist/cjs/index.js";

const { readTemplate, renderTemplate, listTags } = lib;

const [templatePath, dataArg = "{}", outArg = "out.png"] = process.argv.slice(2);

if (!templatePath) {
  console.error("Usage: node example/print-template.mjs <template.niim> [data JSON or file] [out.png]");
  process.exit(1);
}

const template = readTemplate(readFileSync(templatePath));
const data = JSON.parse(existsSync(dataArg) ? readFileSync(dataArg, "utf8") : dataArg);
const rows = Array.isArray(data) ? data : [data];

console.log(`Template "${template.title ?? templatePath}", tags: ${listTags(template).join(", ")}`);

for (let i = 0; i < rows.length; i++) {
  const canvas = await renderTemplate(template, {
    createCanvas,
    loadImage,
    loadFont: (f) => void GlobalFonts.register(Buffer.from(f.data), f.family),
    data: rows[i],
    fill: { strict: true },
  });

  const out = rows.length === 1 ? outArg : outArg.replace(/(\.png)?$/i, `-${i + 1}.png`);
  writeFileSync(out, canvas.toBuffer("image/png"));
  console.log(`Wrote ${out} (${canvas.width}x${canvas.height})`);
}
