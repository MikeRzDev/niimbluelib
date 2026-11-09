/* Type declarations for bundled modules without their own types. */

/** Fonts are bundled as base64 strings (esbuild "base64" loader, see build.mjs). */
declare module "*.ttf" {
  const base64: string;
  export default base64;
}

declare module "tiny-inflate" {
  /** Inflate raw deflate data into `dest` (sized to the expected output). Returns `dest` or a subarray of it. */
  export default function inflate(source: Uint8Array, dest: Uint8Array): Uint8Array;
}

declare module "opentype.js" {
  export interface PathCommand {
    type: "M" | "L" | "Q" | "C" | "Z";
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }

  export interface Path {
    commands: PathCommand[];
  }

  export interface RenderOptions {
    kerning?: boolean;
    features?: Record<string, boolean>;
  }

  export interface Font {
    supported: boolean;
    unitsPerEm: number;
    ascender: number;
    descender: number;
    getPath(text: string, x: number, y: number, fontSize: number, options?: RenderOptions): Path;
    getAdvanceWidth(text: string, fontSize: number, options?: RenderOptions): number;
  }

  export function parse(buffer: ArrayBuffer): Font;
}
