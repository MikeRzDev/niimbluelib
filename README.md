## NiimBlueLib [![NPM](https://img.shields.io/npm/v/@mmote/niimbluelib)](https://npmjs.com/package/@mmote/niimbluelib)

> [!WARNING]
>
> This project is intended for informational and educational purposes only.
> The project is not affiliated with or endorsed by the original software or hardware vendor.

[Documentation](https://libdocs.niim.blue)

NiimBlueLib is a library for the communication with NIIMBOT printers.
Used in [NiimBlue](https://github.com/MultiMote/niimblue) project.

NiimBlueLib provides the most accurate open source implementation of the NIIMBOT printers protocol.

Also check out [niimblue-node](https://github.com/MultiMote/niimblue-node) for CLI use cases.

### Installation

NPM:

```bash
npm install -E @mmote/niimbluelib
```

CDN:

```html
<script src="https://unpkg.com/@mmote/niimbluelib@VERSION/dist/umd/niimbluelib.min.js"></script>
```

Script uses `niimbluelib` namespace. Example:

```js
const client = new niimbluelib.NiimbotBluetoothClient();
```

### Usage example

See [example/main.js](example/main.js)

Live: https://libdocs.niim.blue/example

### Templates

Label designs are exported from the NiimBlue editor as template packages (`.niim`), filled with data
and printed without the editor. A package is a ZIP with `template.json`, `images/…` and `fonts/…`
(plus a `mimetype` entry `application/vnd.niimblue.template+zip`); `.niim` is the only template file format.
`template.json` is described by the `NiimTemplate` type in [src/template/types.ts](src/template/types.ts)
(`"format": "niimblue-template"`, `"version": 1`). Image and font `src` are paths inside the package;
once opened, the in-memory template has them as data URLs.

- Coordinates and sizes are printer dots, `x`/`y` is the top-left corner of the unrotated box, `angle` rotates around the box center.
- Elements: `text`, `qrcode`, `barcode` (`EAN13`, `EAN8`, `CODE128`, `CODE39`, `UPC`, `ITF14`), `rect`, `ellipse`, `line`, `image`.
- Text, QR code and barcode values may contain `{tag}` placeholders, same grammar as NiimBlue: `{$tag}`, `{ tag | format }`, tag name is `\w+`. Tags can be declared in `fields` with `default` and `required`.
- `{dt}` is the built-in date tag (`{dt+3d|DD.MM.YYYY}`, offset units `y M w d h m s`). It is resolved by `fillTemplate`'s `resolve(name, format, offset)` callback, otherwise left as is.

- `fonts` embeds font files (`family`, `src`, `weight`, `style`) used by text elements; they are loaded before rendering.

Example: [example/sample-template.niim](example/sample-template.niim).

Main functions:

- `readTemplate(bytes)` - open a `.niim` package: validated template, assets as data URLs.
- `packTemplate(template, { files })` - write a `.niim` package (data URL assets become files).
- `validateTemplate(object)` - check an in-memory template and return it typed.
- `templateFonts(template)` - decoded embedded fonts.
- `listTags(template)` - list tag names used by the template.
- `fillTemplate(template, data, { strict, resolve })` - replace tags in a copy of the template.
- `renderTemplate(template, { data, createCanvas, loadImage, loadFont, threshold })` - render to a canvas with pure black/white (and red) pixels.
- `templateToImageSource(canvas)` - pass the rendered canvas to `ImageEncoder.encode`.
- `printTemplate(client, template, rows, { quantity, density, labelType, pageColor, printTaskName })` - render and print, one page per data row.

Browser:

```js
import { NiimbotBluetoothClient, printTemplate, readTemplate } from "@mmote/niimbluelib";

const client = new NiimbotBluetoothClient();
await client.connect();

const template = readTemplate(new Uint8Array(await (await fetch("label.niim")).arrayBuffer()));
await printTemplate(client, template, [{ name: "Hex bolt M6", sku: "HB-M6" }]);
```

Node (render to PNG, canvas implementation must be provided, e.g. [@napi-rs/canvas](https://www.npmjs.com/package/@napi-rs/canvas)):

```js
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { readTemplate, renderTemplate } from "@mmote/niimbluelib";

const template = readTemplate(readFileSync("label.niim"));
const canvas = await renderTemplate(template, {
  createCanvas,
  loadImage,
  loadFont: (f) => void GlobalFonts.register(Buffer.from(f.data), f.family),
  data: { name: "Hex bolt M6" },
});
writeFileSync("label.png", canvas.toBuffer("image/png"));
```

See also [example/print-template.mjs](example/print-template.mjs).

### Misc

Eslint not included. Install it with:

```
npm install --no-save --no-package-lock eslint globals @eslint/js typescript-eslint
```
