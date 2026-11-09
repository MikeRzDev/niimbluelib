import { NIIM_TEMPLATE_FORMAT, NIIM_TEMPLATE_VERSION, NiimTemplate } from "./types";

type Obj = Record<string, unknown>;

const COLORS = ["black", "white", "red"] as const;
const ELEMENT_TYPES = ["text", "qrcode", "barcode", "rect", "ellipse", "line", "image"] as const;
const BARCODE_ENCODINGS = ["EAN13", "EAN8", "CODE128", "CODE39", "UPC", "ITF14"] as const;

const fail = (path: string, message: string): never => {
  throw new Error(`Invalid template: ${path} ${message}`);
};

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const obj = (o: Obj, key: string, path: string): Obj => {
  const v = o[key];
  if (!isObj(v)) fail(`${path}${key}`, "must be an object");
  return v as Obj;
};

const num = (o: Obj, key: string, path: string, opts: { optional?: boolean; positive?: boolean; min0?: boolean } = {}) => {
  const v = o[key];
  if (v === undefined && opts.optional) return;
  if (!isNum(v)) fail(`${path}${key}`, opts.positive ? "must be a positive number" : "must be a number");
  if (opts.positive && (v as number) <= 0) fail(`${path}${key}`, "must be a positive number");
  if (opts.min0 && (v as number) < 0) fail(`${path}${key}`, "must be a non-negative number");
};

const str = (o: Obj, key: string, path: string, opts: { optional?: boolean; nonEmpty?: boolean } = {}) => {
  const v = o[key];
  if (v === undefined && opts.optional) return;
  if (typeof v !== "string") fail(`${path}${key}`, "must be a string");
  if (opts.nonEmpty && (v as string).length === 0) fail(`${path}${key}`, "must be a non-empty string");
};

const bool = (o: Obj, key: string, path: string) => {
  const v = o[key];
  if (v !== undefined && typeof v !== "boolean") fail(`${path}${key}`, "must be a boolean");
};

const oneOf = (o: Obj, key: string, path: string, values: readonly unknown[], optional = true) => {
  const v = o[key];
  if (v === undefined && optional) return;
  if (!values.includes(v)) fail(`${path}${key}`, `must be one of ${values.map((e) => JSON.stringify(e)).join(", ")}`);
};

const validateElement = (e: unknown, path: string) => {
  if (!isObj(e)) return fail(path, "must be an object");
  const p = `${path}.`;

  oneOf(e, "type", p, ELEMENT_TYPES, false);
  str(e, "id", p, { optional: true });
  num(e, "angle", p, { optional: true });
  oneOf(e, "color", p, COLORS);

  const isLine = e.type === "line";
  num(e, "x", p, { optional: isLine });
  num(e, "y", p, { optional: isLine });

  switch (e.type) {
    case "text": {
      num(e, "width", p, { positive: true });
      num(e, "height", p, { optional: true, positive: true });
      str(e, "text", p);
      const font = obj(e, "font", p);
      str(font, "family", `${p}font.`, { nonEmpty: true });
      num(font, "size", `${p}font.`, { positive: true });
      if (font.weight !== undefined && font.weight !== "normal" && font.weight !== "bold" && !isNum(font.weight)) {
        fail(`${p}font.weight`, 'must be "normal", "bold" or a number');
      }
      oneOf(font, "style", `${p}font.`, ["normal", "italic"]);
      oneOf(e, "align", p, ["left", "center", "right", "justify"]);
      oneOf(e, "verticalAlign", p, ["top", "middle", "bottom"]);
      num(e, "lineHeight", p, { optional: true, positive: true });
      oneOf(e, "fit", p, ["none", "shrink"]);
      num(e, "maxLines", p, { optional: true, positive: true });
      oneOf(e, "background", p, COLORS);
      break;
    }
    case "qrcode":
      num(e, "size", p, { positive: true });
      str(e, "value", p);
      oneOf(e, "ecl", p, ["L", "M", "Q", "H"]);
      break;
    case "barcode":
      num(e, "width", p, { positive: true });
      num(e, "height", p, { positive: true });
      str(e, "value", p);
      oneOf(e, "encoding", p, BARCODE_ENCODINGS, false);
      bool(e, "showText", p);
      num(e, "fontSize", p, { optional: true, positive: true });
      str(e, "fontFamily", p, { optional: true, nonEmpty: true });
      break;
    case "rect":
    case "ellipse":
      num(e, "width", p, { positive: true });
      num(e, "height", p, { positive: true });
      num(e, "strokeWidth", p, { optional: true, min0: true });
      oneOf(e, "fill", p, COLORS);
      num(e, "radius", p, { optional: true, min0: true });
      break;
    case "line": {
      const points = e.points;
      if (!Array.isArray(points) || points.length < 2) {
        fail(`${p}points`, "must be an array of at least two [x, y] points");
      }
      (points as unknown[]).forEach((pt, i) => {
        if (!Array.isArray(pt) || pt.length !== 2 || !isNum(pt[0]) || !isNum(pt[1])) {
          fail(`${p}points[${i}]`, "must be an [x, y] pair of numbers");
        }
      });
      num(e, "strokeWidth", p, { optional: true, min0: true });
      break;
    }
    case "image":
      num(e, "width", p, { positive: true });
      num(e, "height", p, { positive: true });
      str(e, "src", p, { nonEmpty: true });
      break;
  }
};

/**
 * Validate an unknown value (e.g. parsed JSON) against the NiimBlue template format.
 *
 * @returns The same object, typed as {@link NiimTemplate}.
 * @throws Error with a path to the first invalid property (e.g. `elements[2].size must be a positive number`).
 *
 * @category Template
 */
export const validateTemplate = (obj: unknown): NiimTemplate => {
  if (!isObj(obj)) return fail("template", "must be an object");

  if (obj.format !== NIIM_TEMPLATE_FORMAT) fail("format", `must be "${NIIM_TEMPLATE_FORMAT}"`);
  if (obj.version !== NIIM_TEMPLATE_VERSION) {
    fail("version", `must be ${NIIM_TEMPLATE_VERSION} (got ${JSON.stringify(obj.version)})`);
  }
  str(obj, "title", "", { optional: true });

  const label = (() => {
    const v = obj.label;
    if (!isObj(v)) return fail("label", "must be an object");
    return v;
  })();
  num(label, "width", "label.", { positive: true });
  num(label, "height", "label.", { positive: true });
  num(label, "dpmm", "label.", { optional: true, positive: true });
  oneOf(label, "printDirection", "label.", ["left", "top"], false);
  oneOf(label, "shape", "label.", ["rect", "rounded_rect", "circle"]);

  if (obj.fields !== undefined) {
    if (!Array.isArray(obj.fields)) fail("fields", "must be an array");
    (obj.fields as unknown[]).forEach((f, i) => {
      const p = `fields[${i}]`;
      if (!isObj(f)) return fail(p, "must be an object");
      str(f, "name", `${p}.`, { nonEmpty: true });
      str(f, "description", `${p}.`, { optional: true });
      str(f, "default", `${p}.`, { optional: true });
      bool(f, "required", `${p}.`);
    });
  }

  if (obj.fonts !== undefined) {
    if (!Array.isArray(obj.fonts)) fail("fonts", "must be an array");
    (obj.fonts as unknown[]).forEach((f, i) => {
      const p = `fonts[${i}]`;
      if (!isObj(f)) return fail(p, "must be an object");
      str(f, "family", `${p}.`, { nonEmpty: true });
      str(f, "src", `${p}.`, { nonEmpty: true });
      if (f.weight !== undefined && f.weight !== "normal" && f.weight !== "bold" && !isNum(f.weight)) {
        fail(`${p}.weight`, 'must be "normal", "bold" or a number');
      }
      oneOf(f, "style", `${p}.`, ["normal", "italic"]);
    });
  }

  if (!Array.isArray(obj.elements)) fail("elements", "must be an array");
  (obj.elements as unknown[]).forEach((e, i) => validateElement(e, `elements[${i}]`));

  return obj as unknown as NiimTemplate;
};
