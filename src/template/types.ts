/**
 * NiimBlue template format (v1).
 *
 * A declarative, data-driven label description that can be filled with values and rendered
 * to a bitmap without the NiimBlue editor or fabric.js.
 *
 * Coordinates and sizes are in printer dots (px). `x`/`y` is the top-left corner of the
 * element's **unrotated** bounding box, `angle` (degrees, clockwise) rotates it around the box center.
 *
 * Text values may contain tags in `{name}` form, which are replaced by {@link fillTemplate}.
 *
 * @module Template
 */

/** @category Template */
export const NIIM_TEMPLATE_FORMAT = "niimblue-template";
/** @category Template */
export const NIIM_TEMPLATE_VERSION = 1;

/** @category Template */
export type TemplateColor = "black" | "white" | "red";

/** @category Template */
export interface TemplateLabel {
  /** Label width in dots. */
  width: number;
  /** Label height in dots. */
  height: number;
  /** Dots per millimeter (8 = 203 dpi, 11.81 = 300 dpi). Informational, used for mm conversion. */
  dpmm?: number;
  /** "left" rotates image 90 degrees clockwise before sending (default for most printers). */
  printDirection: "left" | "top";
  /** Informational label shape, not rendered. */
  shape?: "rect" | "rounded_rect" | "circle";
}

/** @category Template */
export interface TemplateField {
  /** Tag name, used as `{name}` in element values. */
  name: string;
  /** Human readable description. */
  description?: string;
  /** Value used when no data is provided for this field. */
  default?: string;
  /** If true and strict filling is enabled, missing value is an error. */
  required?: boolean;
}

/** @category Template */
export interface TemplateElementBase {
  /** Optional stable element identifier. */
  id?: string;
  x: number;
  y: number;
  /** Rotation in degrees, clockwise, around the element center. */
  angle?: number;
  /** Foreground color. Default "black". */
  color?: TemplateColor;
}

/** @category Template */
export interface TemplateTextElement extends TemplateElementBase {
  type: "text";
  /** Box width. Text is wrapped to it. */
  width: number;
  /** Optional box height. Used for vertical alignment and shrink fitting. */
  height?: number;
  /** Text, may contain `{tags}` and newlines. */
  text: string;
  font: {
    family: string;
    /** Font size in dots. */
    size: number;
    weight?: "normal" | "bold" | number;
    style?: "normal" | "italic";
  };
  /** Horizontal alignment. Default "left". */
  align?: "left" | "center" | "right" | "justify";
  /** Vertical alignment inside `height`. Default "top". */
  verticalAlign?: "top" | "middle" | "bottom";
  /** Line height multiplier. Default 1.16 (fabric.js default). */
  lineHeight?: number;
  /** "shrink" reduces font size until text fits in width (and height / maxLines if given). Default "none". */
  fit?: "none" | "shrink";
  /** Maximum number of lines when fitting. */
  maxLines?: number;
  /** Background fill of the text box. */
  background?: TemplateColor;
}

/** @category Template */
export interface TemplateQrElement extends TemplateElementBase {
  type: "qrcode";
  /** Side length of the square. */
  size: number;
  /** Encoded value, may contain `{tags}`. */
  value: string;
  /** Error correction level. Default "M". */
  ecl?: "L" | "M" | "Q" | "H";
}

/** @category Template */
export type TemplateBarcodeEncoding = "EAN13" | "EAN8" | "CODE128" | "CODE39" | "UPC" | "ITF14";

/** @category Template */
export interface TemplateBarcodeElement extends TemplateElementBase {
  type: "barcode";
  width: number;
  height: number;
  /** Encoded value, may contain `{tags}`. */
  value: string;
  encoding: TemplateBarcodeEncoding;
  /** Print human readable text under the bars. Default true. */
  showText?: boolean;
  /** Text font size in dots. Default 12. */
  fontSize?: number;
  fontFamily?: string;
}

/** @category Template */
export interface TemplateShapeElement extends TemplateElementBase {
  type: "rect" | "ellipse";
  width: number;
  height: number;
  /** Stroke width, 0 = no stroke. Default 1. */
  strokeWidth?: number;
  /** Fill color, omitted = no fill. */
  fill?: TemplateColor;
  /** Corner radius (rect only). */
  radius?: number;
}

/** @category Template */
export interface TemplateLineElement extends Omit<TemplateElementBase, "x" | "y"> {
  type: "line";
  /** Absolute points `[x, y]`. At least two. `x`/`y` of base are not used. */
  points: [number, number][];
  /** Default 1. */
  strokeWidth?: number;
  x?: number;
  y?: number;
}

/** @category Template */
export interface TemplateImageElement extends TemplateElementBase {
  type: "image";
  width: number;
  height: number;
  /**
   * Image data URL (`data:image/png;base64,...`). Inside a `.niim` template package (see {@link packTemplate})
   * it is the path of the image file in the package, e.g. `images/logo.png`.
   */
  src: string;
}

/** @category Template */
export type TemplateElement =
  | TemplateTextElement
  | TemplateQrElement
  | TemplateBarcodeElement
  | TemplateShapeElement
  | TemplateLineElement
  | TemplateImageElement;

/**
 * Font file used by text elements (matched by `family`, `weight` and `style`).
 *
 * @category Template
 */
export interface TemplateFont {
  /** CSS family name, as used in `font.family` of text elements. */
  family: string;
  /**
   * Font data URL (`data:font/ttf;base64,...`; TTF, OTF, WOFF or WOFF2). Inside a `.niim` template package
   * it is the path of the font file in the package, e.g. `fonts/Inter.ttf`.
   */
  src: string;
  /** Default "normal". */
  weight?: "normal" | "bold" | number;
  /** Default "normal". */
  style?: "normal" | "italic";
}

/** @category Template */
export interface NiimTemplate {
  format: typeof NIIM_TEMPLATE_FORMAT;
  version: typeof NIIM_TEMPLATE_VERSION;
  title?: string;
  label: TemplateLabel;
  /** Declared tags. May be generated from element contents. */
  fields?: TemplateField[];
  /** Elements, rendered in order (first is bottom-most). */
  elements: TemplateElement[];
  /** Fonts embedded in the template, loaded before rendering (see {@link RenderOptions.loadFont}). */
  fonts?: TemplateFont[];
}
