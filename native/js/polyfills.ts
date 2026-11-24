/*
 * Minimal browser/Node globals that niimbluelib needs, implemented on top of
 * the C side (`__native`). Must be imported before niimbluelib.
 */

declare const __native: {
  timerStart(id: number, ms: number): void;
  timerCancel(id: number): void;
  emit(name: string, json: string): void;
};

const g = globalThis as any;

/* ---- timers ---- */

type TimerEntry = { cb: (...args: unknown[]) => void; args: unknown[]; interval?: number };

const timers = new Map<number, TimerEntry>();
let nextTimerId = 1;

const startTimer = (cb: unknown, ms: unknown, args: unknown[], repeat: boolean): number => {
  if (typeof cb !== "function") {
    throw new TypeError("Timer callback must be a function");
  }
  const id = nextTimerId++;
  const delay = Math.max(0, Number(ms) || 0);
  timers.set(id, { cb: cb as TimerEntry["cb"], args, interval: repeat ? Math.max(1, delay) : undefined });
  __native.timerStart(id, delay);
  return id;
};

const clearTimer = (id: unknown) => {
  const n = Number(id);
  if (timers.delete(n)) {
    __native.timerCancel(n);
  }
};

g.setTimeout = (cb: unknown, ms?: unknown, ...args: unknown[]) => startTimer(cb, ms, args, false);
g.setInterval = (cb: unknown, ms?: unknown, ...args: unknown[]) => startTimer(cb, ms, args, true);
g.clearTimeout = clearTimer;
g.clearInterval = clearTimer;

g.__fireTimer = (id: number) => {
  const t = timers.get(id);
  if (t === undefined) {
    return;
  }
  if (t.interval !== undefined) {
    __native.timerStart(id, t.interval);
  } else {
    timers.delete(id);
  }
  t.cb(...t.args);
};

/* ---- console ---- */

const fmt = (args: unknown[]) =>
  args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");

const log = (level: string) => (...a: unknown[]) =>
  __native.emit("log", JSON.stringify({ level, message: fmt(a) }));

g.console = {
  log: log("info"),
  info: log("info"),
  debug: log("debug"),
  warn: log("warn"),
  error: log("error"),
};

/* ---- TextDecoder / TextEncoder (UTF-8 only) ---- */

class Utf8TextDecoder {
  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (input === undefined) return "";
    const b =
      input instanceof Uint8Array
        ? input
        : ArrayBuffer.isView(input)
          ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : new Uint8Array(input);
    let out = "";
    let i = 0;
    while (i < b.length) {
      const c = b[i++];
      let cp: number;
      if (c < 0x80) {
        cp = c;
      } else if (c >= 0xc0 && c < 0xe0 && i < b.length) {
        cp = ((c & 0x1f) << 6) | (b[i++] & 0x3f);
      } else if (c >= 0xe0 && c < 0xf0 && i + 1 < b.length) {
        cp = ((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
      } else if (c >= 0xf0 && i + 2 < b.length) {
        cp = ((c & 0x07) << 18) | ((b[i++] & 0x3f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
      } else {
        cp = 0xfffd;
      }
      out += String.fromCodePoint(cp);
    }
    return out;
  }
}

class Utf8TextEncoder {
  readonly encoding = "utf-8";
  encode(s = ""): Uint8Array {
    const out: number[] = [];
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      else
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    return new Uint8Array(out);
  }
}

if (typeof g.TextDecoder === "undefined") g.TextDecoder = Utf8TextDecoder;
if (typeof g.TextEncoder === "undefined") g.TextEncoder = Utf8TextEncoder;

/* Some code checks `navigator.*` with optional chaining; make the identifier exist. */
if (typeof g.navigator === "undefined") g.navigator = {};
