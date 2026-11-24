/**
 * Deep copy of a JSON-like value (plain objects, arrays, primitives). Strings are shared, not
 * re-encoded, so large embedded assets (image / font data URLs) cost nothing to copy, unlike a
 * `JSON.parse(JSON.stringify())` round trip. `undefined` object properties are dropped like in JSON.
 */
export const cloneJson = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((v: unknown) => cloneJson(v)) as T;
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = cloneJson(v);
    }
    return out as T;
  }
  return value;
};
