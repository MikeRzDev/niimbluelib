import { cloneJson } from "./clone";
import { NiimTemplate, TemplateElement, TemplateField } from "./types";

/**
 * Tag lookup function. Returns `undefined` when the tag is unresolved.
 *
 * - `name` - tag name without leading `$`.
 * - `format` - part after `|` (trimmed), e.g. `YYYY-MM-DD` in `{dt|YYYY-MM-DD}`.
 * - `offset` - date offset, e.g. `+3d` in `{dt+3d}`. Units: `y M w d h m s`.
 *
 * @category Template
 */
export type TagLookup = (name: string, format?: string, offset?: string) => string | undefined;

/** @category Template */
export interface FillOptions {
  /**
   * Strict mode. Unresolved tags of `required` fields and unresolved undeclared tags throw an error.
   * Unresolved tags of declared optional fields are replaced with an empty string.
   */
  strict?: boolean;
  /**
   * Called for tags which are missing in data. Also used for the built-in date tag `dt`
   * (e.g. `{dt+1d|DD.MM.YYYY}` gives `("dt", "DD.MM.YYYY", "+1d")`), which is left as is if unresolved.
   */
  resolve?: TagLookup;
}

/** Tag name reserved by NiimBlue for the current date. Not listed by {@link listTags} unless declared. */
const DATE_TAG = "dt";

/**
 * Same grammar as NiimBlue: `{name}`, `{$name}`, `{name+3d}` (date offset), `{name|format}`, whitespace allowed inside braces.
 * Groups: 1 - name, 2 - offset sign, 3 - offset amount, 4 - offset unit, 5 - format.
 */
const TAG_REGEX = /\{\s*(\$?\w+)(?:([+-])(\d+)([yMwdhms]))?\s*(?:\|\s*(.*?)\s*)?\}/g;

const tagOffset = (sign?: string, amount?: string, unit?: string): string | undefined =>
  sign && amount && unit ? `${sign}${amount}${unit}` : undefined;

const normalizeTagName = (raw: string): string => {
  const name = raw.trim();
  return name.startsWith("$") ? name.substring(1).trim() : name;
};

const findTagNames = (s: string): string[] => {
  const result: string[] = [];
  for (const m of s.matchAll(TAG_REGEX)) {
    const name = normalizeTagName(m[1]);
    if (name.length > 0) {
      result.push(name);
    }
  }
  return result;
};

/** Strings of the element which may contain tags. */
const taggedStrings = (e: TemplateElement): string[] => {
  switch (e.type) {
    case "text":
      return [e.text];
    case "qrcode":
    case "barcode":
      return [e.value];
    default:
      return [];
  }
};

/**
 * Replace `{name}`, `{$name}`, `{name+3d}`, `{name|format}` tags in string (same grammar as NiimBlue).
 *
 * @param lookup Returns tag value or `undefined` to leave the tag as is.
 * @category Template
 */
export const fillString = (s: string, lookup: TagLookup): string =>
  s.replace(
    TAG_REGEX,
    (match: string, rawName: string, sign?: string, amount?: string, unit?: string, format?: string) => {
      const name = normalizeTagName(rawName);
      if (name.length === 0) return match;
      const value = lookup(name, format, tagOffset(sign, amount, unit));
      return value === undefined ? match : value;
    },
  );

/**
 * List unique tag names used in template elements (text, qrcode and barcode values) and declared in `fields`.
 * Leading `$` is stripped. The reserved date tag `dt` is included only if declared in `fields`.
 *
 * @category Template
 */
export const listTags = (t: NiimTemplate): string[] => {
  const names = new Set<string>();

  for (const e of t.elements) {
    for (const s of taggedStrings(e)) {
      for (const name of findTagNames(s)) {
        if (name !== DATE_TAG) names.add(name);
      }
    }
  }

  for (const f of t.fields ?? []) {
    names.add(normalizeTagName(f.name));
  }

  return [...names];
};

/**
 * Replace tags in a deep copy of the template.
 *
 * Lookup order: `data[name]` (also `data["$" + name]`), `opts.resolve(name, format, offset)`, field default.
 *
 * Unresolved tags are left as is in non-strict mode. See {@link FillOptions.strict} for strict mode.
 *
 * @category Template
 */
export const fillTemplate = (t: NiimTemplate, data: Record<string, string>, opts: FillOptions = {}): NiimTemplate => {
  const fields = new Map<string, TemplateField>();
  for (const f of t.fields ?? []) {
    fields.set(normalizeTagName(f.name), f);
  }

  const missing = new Set<string>();

  const lookup: TagLookup = (name, format, offset) => {
    let value: unknown = data[name];
    if (value === undefined) value = data[`$${name}`];
    if (value !== undefined && value !== null) return String(value);

    const resolved = opts.resolve?.(name, format, offset);
    if (resolved !== undefined) return resolved;

    const field = fields.get(name);
    if (field?.default !== undefined) return field.default;

    if (opts.strict) {
      if (field === undefined) {
        // Built-in date tag is left as is when unresolved (e.g. filled later by the NiimBlue app).
        if (name !== DATE_TAG) missing.add(name);
        return undefined;
      }
      if (field.required) {
        missing.add(name);
        return undefined;
      }
      return "";
    }

    return undefined;
  };

  const copy = cloneJson(t);

  for (const e of copy.elements) {
    if (e.type === "text") {
      e.text = fillString(e.text, lookup);
    } else if (e.type === "qrcode" || e.type === "barcode") {
      e.value = fillString(e.value, lookup);
    }
  }

  if (missing.size > 0) {
    throw new Error(`Missing template data for tags: ${[...missing].join(", ")}`);
  }

  return copy;
};
