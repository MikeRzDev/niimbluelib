/*
 * JS side of libniimblue.
 *
 * This file is bundled together with niimbluelib (from source) into a single
 * script that is embedded in the native library and evaluated by QuickJS.
 *
 * Contract with the C side (src/niimblue.c):
 *
 *   C provides `globalThis.__native`:
 *     write(u8: Uint8Array): void         send bytes over the active native transport
 *     close(): void                        close the active native transport
 *     timerStart(id: number, ms: number)   arm a one-shot timer, C calls __niim.fireTimer(id)
 *     timerCancel(id: number)
 *     done(reqId: number, ok: boolean, json: string)   complete an API request
 *     emit(name: string, json: string)     forward an event to the host callback
 *                                          (console.* is forwarded as a "log" event)
 *
 *   This file provides `globalThis.__niim`:
 *     dispatch(reqId, method, paramsJson, binary?: ArrayBuffer)
 *     onData(u8: Uint8Array)               bytes received from the native transport
 *     onClosed()                           native transport closed by the other side
 *     fireTimer(id)
 */

import "./polyfills";

import {
  NiimbotAbstractClient,
  NiimbotVirtualClient,
  ConnectionInfo,
  ConnectEvent,
  DisconnectEvent,
  RawPacketSentEvent,
  ConnectResult,
  ImageEncoder,
  ImageSource,
  PrintDirection,
  PageColorType,
  LabelType,
  PrintTaskName,
  printTaskNames,
  modelsLibrary,
  Utils,
  SoundSettingsItemType,
  AutoShutdownTime,
  ClientEventMap,
  NiimTemplate,
  RenderOptions,
  fillTemplate,
  listTags,
  printTemplate,
  renderTemplate,
  readTemplate,
  TemplateFontData,
} from "../../src";
import { createSoftCanvas, listFonts, loadTemplateImage, registerFont, SoftCanvas } from "./canvas";
import { base64Encode } from "./png";
import { PrintQueue } from "./print_queue";
import { NiimbotPngPrinterClient, PngPage, PngPrinterOptions } from "./png_printer";

declare const __native: {
  write(data: Uint8Array): void;
  close(): void;
  done(reqId: number, ok: boolean, json: string): void;
  emit(name: string, json: string): void;
};

/* ------------------------------------------------------------------------ */
/* Native transport client                                                  */
/* ------------------------------------------------------------------------ */

class NiimbotNativeClient extends NiimbotAbstractClient {
  private open = false;

  public async connect(): Promise<ConnectionInfo> {
    // The C side has already opened the transport before calling connect.
    this.open = true;

    await this.negotiateAndGetPrinterInfo(() => this.closeTransport());

    const result: ConnectionInfo = {
      deviceName: "native",
      result: this.printerInfo.connectResult ?? ConnectResult.FirmwareErrors,
    };

    this.emit("connect", new ConnectEvent(result));
    return result;
  }

  private closeTransport() {
    if (this.open) {
      this.open = false;
      __native.close();
    }
  }

  public async disconnect(): Promise<void> {
    this.stopHeartbeat();
    if (this.open) {
      this.closeTransport();
      this.emit("disconnect", new DisconnectEvent());
    }
  }

  /** Transport was closed by the device / OS. */
  public transportClosed() {
    if (this.open) {
      this.open = false;
      this.stopHeartbeat();
      this.emit("disconnect", new DisconnectEvent());
    }
  }

  public feed(data: Uint8Array) {
    if (this.debug) {
      console.info(`<< ${Utils.bufToHex(data)}`);
    }
    this.processRawPacket(data);
  }

  public isConnected(): boolean {
    return this.open;
  }

  public async sendRaw(data: Uint8Array, force?: boolean): Promise<void> {
    const send = async () => {
      if (!this.isConnected()) {
        throw new Error("Transport is not open");
      }
      await Utils.sleep(this.packetIntervalMs);
      // The transport may have been closed while sleeping (disconnect during a pending send)
      if (!this.isConnected()) {
        throw new Error("Transport is not open");
      }
      __native.write(data);
      this.emit("rawpacketsent", new RawPacketSentEvent(data));
    };

    if (force) {
      await send();
    } else {
      await this.mutex.runExclusive(send);
    }
  }

  public override getType(): string {
    // Closest existing type, the library only uses it for informational purposes.
    return "serial";
  }
}

/* ------------------------------------------------------------------------ */
/* Raw pixel buffer image source                                            */
/* ------------------------------------------------------------------------ */

type PixelFormat = "rgba" | "rgb" | "gray";

class RawImageSource implements ImageSource {
  private readonly bpp: number;
  private readonly stride: number;

  constructor(
    private readonly data: Uint8Array,
    public readonly width: number,
    public readonly height: number,
    private readonly format: PixelFormat,
    private readonly pageColor: PageColorType,
    private readonly threshold: number,
    stride?: number,
  ) {
    this.bpp = format === "rgba" ? 4 : format === "rgb" ? 3 : 1;
    this.stride = stride ?? width * this.bpp;

    if (width <= 0 || height <= 0) {
      throw new Error("Image width and height must be positive");
    }
    if (this.stride < width * this.bpp) {
      throw new Error(`Stride ${this.stride} is too small for width ${width} (${format})`);
    }
    const need = this.stride * (height - 1) + width * this.bpp;
    if (data.byteLength < need) {
      throw new Error(`Pixel buffer too small: got ${data.byteLength} bytes, need ${need}`);
    }
  }

  /** Read pixel composited over white, as 0xRRGGBB. */
  private rgb(x: number, y: number): number {
    const i = y * this.stride + x * this.bpp;
    const d = this.data;
    let r: number, g: number, b: number;

    if (this.format === "gray") {
      r = g = b = d[i];
    } else {
      r = d[i];
      g = d[i + 1];
      b = d[i + 2];
      if (this.format === "rgba") {
        const a = d[i + 3];
        if (a !== 255) {
          r = Math.round((r * a + 255 * (255 - a)) / 255);
          g = Math.round((g * a + 255 * (255 - a)) / 255);
          b = Math.round((b * a + 255 * (255 - a)) / 255);
        }
      }
    }
    return (r << 16) | (g << 8) | b;
  }

  public getPixelColor(x: number, y: number, printDirection: PrintDirection): number {
    let px = x;
    let py = y;

    if (printDirection === "left") {
      // Same mapping as CanvasImageSource: rotate 90 degrees clockwise
      px = y;
      py = this.height - 1 - x;
    }

    if (px < 0 || py < 0 || px >= this.width || py >= this.height) {
      return 0xffffff;
    }

    const color = this.rgb(px, py);

    if (this.pageColor === PageColorType.Grayscale) {
      return color;
    }

    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;

    if (this.pageColor === PageColorType.DoubleColor && r >= 128 && g < 128 && b < 128) {
      return 0xff0000;
    }

    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    return luminance < this.threshold ? 0x000000 : 0xffffff;
  }
}

/* ------------------------------------------------------------------------ */
/* State + helpers                                                          */
/* ------------------------------------------------------------------------ */

let client: NiimbotAbstractClient | undefined;
let verboseEvents = false;

const quietEvents = new Set<keyof ClientEventMap>(["rawpacketsent", "rawpacketreceived", "packetsent", "packetreceived"]);

/** Print events tagged with the id of the job being printed */
const jobEvents = new Set<keyof ClientEventMap>(["printprogress", "printpacketprogress", "printend"]);

const allEvents: (keyof ClientEventMap)[] = [
  "connect",
  "disconnect",
  "rawpacketsent",
  "rawpacketreceived",
  "packetreceived",
  "packetsent",
  "heartbeat",
  "heartbeatfailed",
  "printerinfofetched",
  "rfidinfofetched",
  "printprogress",
  "printend",
  "printpacketprogress",
  "firmwareprogress",
];

const toJson = (v: unknown): string =>
  JSON.stringify(v ?? null, (_k, value: unknown) => {
    if (value instanceof Uint8Array) {
      return Utils.bufToHex(value, "");
    }
    if (value instanceof DataView) {
      return Utils.bufToHex(value, "");
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  });

const errorMessage = (e: unknown): string => {
  if (e instanceof Error) {
    return e.message || String(e);
  }
  return String(e);
};

const requireClient = (): NiimbotAbstractClient => {
  if (client === undefined) {
    throw new Error("Not connected");
  }
  return client;
};

const queue = new PrintQueue((name, payload) => __native.emit(name, toJson(payload)));

/** Pages printed by the PNG printer (newest last), see pngPages. */
const PNG_PAGES_LIMIT = 200;
let pngPages: PngPage[] = [];

const addPngPage = (page: Omit<PngPage, "jobId">) => {
  const p: PngPage = { jobId: queue.currentJobId, ...page };
  pngPages.push(p);
  if (pngPages.length > PNG_PAGES_LIMIT) {
    pngPages = pngPages.slice(pngPages.length - PNG_PAGES_LIMIT);
  }
  // Without the image data (fetch it with pngPages)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { png, ...info } = p;
  __native.emit("pngpage", toJson(info));
};

/** Tell the PNG printer which label the next page is printed on. */
const setPngLabel = (c: NiimbotAbstractClient, width: number, height: number) => {
  if (c instanceof NiimbotPngPrinterClient) {
    c.setJobLabel(width, height);
  }
};

const attachEvents = (c: NiimbotAbstractClient) => {
  for (const name of allEvents) {
    c.on(name, (e: unknown) => {
      if (name === "disconnect" && c === client) {
        // Device / OS closed the connection: queued jobs can't print anymore.
        // The printing job fails on its own.
        queue.failQueued("disconnected");
      }
      if (!verboseEvents && quietEvents.has(name)) {
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { type, ...payload } = e as Record<string, unknown>;
      const jobId = queue.currentJobId;
      if (jobId !== undefined && jobEvents.has(name)) {
        (payload as Record<string, unknown>).jobId = jobId;
      }
      __native.emit(name, toJson(payload));
    });
  }
};

const resetClient = async () => {
  // Disconnect or reconnect: queued jobs were meant for the old connection.
  queue.failQueued("disconnected");
  if (client !== undefined) {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
    client.removeAllListeners();
    client = undefined;
  }
};

const enumValue = <T extends Record<string, string | number>>(e: T, v: unknown, what: string): number | undefined => {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v === "number") {
    return v;
  }
  if (typeof v === "string" && v in e && typeof e[v] === "number") {
    return e[v] as number;
  }
  throw new Error(`Invalid ${what}: ${String(v)}`);
};

/* ------------------------------------------------------------------------ */
/* API methods                                                              */
/* ------------------------------------------------------------------------ */

interface ConnectOptions {
  heartbeat?: boolean;
  heartbeatIntervalMs?: number;
  packetIntervalMs?: number;
  debug?: boolean;
}

/** Built by the C side: options come from the caller, the rest from the connect function used. */
interface ConnectParams {
  transport: "native" | "virtual" | "png";
  /** Virtual transport only: request/response dump, see NiimbotVirtualClient.loadHexDump */
  hexdump?: string;
  /** PNG printer: the printer options are part of the connect options */
  options?: (ConnectOptions & PngPrinterOptions) | null;
}

/** Job options shared by every print kind. */
interface JobOptions {
  /** false: return the job snapshot right away instead of waiting for the print */
  wait?: boolean;
  /** Free text shown in job snapshots */
  label?: string;
}

interface PrintOptions extends JobOptions {
  format?: PixelFormat;
  stride?: number;
  quantity?: number;
  density?: number;
  labelType?: number | keyof typeof LabelType;
  pageColor?: number | keyof typeof PageColorType;
  printTask?: PrintTaskName;
  printDirection?: PrintDirection;
  speed?: 0 | 1;
  threshold?: number;
  statusPollIntervalMs?: number;
  statusTimeoutMs?: number;
  pageTimeoutMs?: number;
}

/** niim_print() arguments, or a niim_call_bin("print") params object. */
interface PrintParams {
  width: number;
  height: number;
  options?: PrintOptions | null;
  /** Same as options.wait (lets callers queue without touching the options) */
  wait?: boolean;
}

/** Options a page may override in a batch. */
type PageOptions = Pick<PrintOptions, "format" | "stride" | "quantity" | "threshold" | "printDirection">;

/** niim_print_batch() arguments or niim_call_bin("printBatch") params: pages are slices of one binary blob. */
interface PrintBatchParams {
  options?: PrintOptions | null;
  wait?: boolean;
  pages: { width: number; height: number; offset: number; length: number; options?: PageOptions | null }[];
}

/** Options shared by renderTemplate and printTemplate. */
interface TemplateRenderOptions {
  /** Luminance below this prints black (default 128). */
  threshold?: number;
  /** Fail on unresolved tags of required / undeclared fields (default true). */
  strict?: boolean;
}

interface TemplatePrintOptions extends TemplateRenderOptions, JobOptions {
  quantity?: number;
  density?: number;
  labelType?: number | keyof typeof LabelType;
  pageColor?: number | keyof typeof PageColorType;
  printTask?: PrintTaskName;
  speed?: 0 | 1;
  statusPollIntervalMs?: number;
  statusTimeoutMs?: number;
  pageTimeoutMs?: number;
}

/** niim_render_template / niim_print_template arguments; the .niim package is the binary payload. */
interface TemplateParams<O> {
  data?: Record<string, string> | Record<string, string>[] | null;
  options?: O | null;
}

/** Open the .niim template package sent as the call's binary payload. */
const parseTemplate = (binary: ArrayBuffer | undefined): NiimTemplate => {
  if (binary === undefined || binary.byteLength === 0) {
    throw new Error("template package missing");
  }
  return readTemplate(new Uint8Array(binary));
};

/** Embedded template fonts already registered, by src (data URL). */
const templateFontsLoaded = new Set<string>();

/** Register a font embedded in a template (`fonts`). WOFF / WOFF2 can't be used and fall back to the default font. */
const loadTemplateFont = (f: TemplateFontData) => {
  if (templateFontsLoaded.has(f.src)) return;
  if (f.mimeType === "font/woff" || f.mimeType === "font/woff2") {
    console.warn(`template font "${f.family}" is ${f.mimeType}, only TTF / OTF are supported; using the default font`);
  } else {
    const weight = f.weight === "bold" ? 700 : f.weight === "normal" ? 400 : f.weight;
    registerFont(f.family, f.data, weight, f.style === "italic");
  }
  templateFontsLoaded.add(f.src);
};

const renderOptions = (o: TemplateRenderOptions): Omit<RenderOptions, "data"> => ({
  createCanvas: createSoftCanvas,
  loadImage: loadTemplateImage,
  loadFont: loadTemplateFont,
  threshold: o.threshold,
  fill: { strict: o.strict ?? true },
});

/** The job's connection must still be the active one when it starts. */
const requireSameClient = (c: NiimbotAbstractClient) => {
  if (client !== c || !c.isConnected()) {
    throw new Error("disconnected");
  }
};

const positiveInt = (v: unknown, what: string, def: number): number => {
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(`${what} must be a positive integer`);
  }
  return v;
};

/**
 * Validate print pages and add the job to the queue. Pixel data is checked now,
 * pages are encoded when the job runs.
 */
const submitPrint = async (
  method: string,
  o: PrintOptions,
  pages: PrintBatchParams["pages"],
  binary: ArrayBuffer,
  single: boolean,
) => {
  const c = requireClient();
  const meta = c.getModelMetadata();
  const taskName: PrintTaskName | undefined = o.printTask ?? c.getPrintTaskType();
  if (taskName === undefined) {
    throw new Error(`${method}: unable to detect print task for this printer, pass printTask explicitly`);
  }
  if (!printTaskNames.includes(taskName)) {
    throw new Error(`${method}: unknown print task ${taskName}`);
  }

  const pageColor = enumValue(PageColorType, o.pageColor, "page color") ?? PageColorType.SingleColor;
  const labelType = enumValue(LabelType, o.labelType, "label type") ?? LabelType.WithGaps;
  const jobQuantity = positiveInt(o.quantity, `${method}: quantity`, 1);

  const prepared = pages.map((pg, i) => {
    const po: PageOptions = pg.options ?? {};
    const where = single ? method : `${method}: page ${i + 1}`;
    const offset = pg.offset ?? 0;
    const length = pg.length ?? binary.byteLength - offset;
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > binary.byteLength) {
      throw new Error(`${where}: pixel data out of range`);
    }
    let source: RawImageSource;
    try {
      source = new RawImageSource(
        new Uint8Array(binary, offset, length),
        pg.width,
        pg.height,
        po.format ?? o.format ?? "rgba",
        pageColor,
        po.threshold ?? o.threshold ?? 128,
        po.stride ?? o.stride,
      );
    } catch (e) {
      throw new Error(single ? errorMessage(e) : `${where}: ${errorMessage(e)}`);
    }
    return {
      source,
      quantity: positiveInt(po.quantity, `${where}: quantity`, jobQuantity),
      direction: (po.printDirection ?? o.printDirection ?? meta?.printDirection ?? "left") as PrintDirection,
    };
  });

  const totalPages = prepared.reduce((n, pg) => n + pg.quantity, 0);

  const run = async () => {
    requireSameClient(c);
    const task = c.protocol.newPrintTask(taskName, {
      totalPages,
      density: o.density ?? meta?.densityDefault ?? 3,
      labelType,
      pageColor,
      ...(o.speed !== undefined ? { speed: o.speed } : {}),
      ...(o.statusPollIntervalMs !== undefined ? { statusPollIntervalMs: o.statusPollIntervalMs } : {}),
      ...(o.statusTimeoutMs !== undefined ? { statusTimeoutMs: o.statusTimeoutMs } : {}),
      ...(o.pageTimeoutMs !== undefined ? { pageTimeoutMs: o.pageTimeoutMs } : {}),
    });

    const images: { cols: number; rows: number; quantity: number }[] = [];
    try {
      await task.printInit();
      for (const pg of prepared) {
        const encoded = ImageEncoder.encode(pg.source, pageColor, pg.direction);
        setPngLabel(c, pg.source.width, pg.source.height);
        await task.printPage(encoded, pg.quantity);
        await task.waitForPageFinished();
        images.push({ cols: encoded.cols, rows: encoded.rows, quantity: pg.quantity });
      }
      await task.waitForFinished();
    } finally {
      await task.printEnd();
    }

    if (single) {
      return { printTask: taskName, cols: images[0].cols, rows: images[0].rows, pages: totalPages };
    }
    return { printTask: taskName, pages: totalPages, images };
  };

  const { job, done } = queue.submit(run, { label: o.label, pages: prepared.length, totalPages });
  if (o.wait === false) {
    return job;
  }
  return { ...((await done) as object), jobId: job.id };
};

type Method = (params: any, binary?: ArrayBuffer) => Promise<unknown> | unknown;

/** Job options with a top-level "wait" param applied. */
const withWait = (o: PrintOptions | null | undefined, wait: boolean | undefined): PrintOptions =>
  wait === undefined ? (o ?? {}) : { ...(o ?? {}), wait };

const methods: Record<string, Method> = {
  async connect(p: ConnectParams) {
    await resetClient();
    const o: ConnectOptions = p.options ?? {};

    let c: NiimbotAbstractClient;
    if (p.transport === "virtual") {
      const v = new NiimbotVirtualClient();
      v.loadHexDump(p.hexdump ?? "");
      c = v;
    } else if (p.transport === "png") {
      c = new NiimbotPngPrinterClient((p.options ?? {}) as PngPrinterOptions, addPngPage);
    } else {
      c = new NiimbotNativeClient();
    }

    c.setHeartbeatAutoStart(p.transport === "png" ? false : (o.heartbeat ?? true));
    if (o.heartbeatIntervalMs !== undefined) c.setHeartbeatInterval(o.heartbeatIntervalMs);
    if (o.packetIntervalMs !== undefined) c.setPacketInterval(o.packetIntervalMs);
    if (o.debug !== undefined) c.setDebug(o.debug);

    attachEvents(c);
    client = c;

    try {
      const info = await c.connect();
      return {
        ...info,
        printerInfo: c.getPrinterInfo(),
        modelMetadata: c.getModelMetadata() ?? null,
        printTask: c.getPrintTaskType() ?? null,
      };
    } catch (e) {
      await resetClient();
      throw e;
    }
  },

  async disconnect() {
    await resetClient();
    return true;
  },

  isConnected: () => client?.isConnected() ?? false,
  getPrinterInfo: () => requireClient().getPrinterInfo(),
  getModelMetadata: () => requireClient().getModelMetadata() ?? null,
  getPrintTaskType: () => requireClient().getPrintTaskType() ?? null,
  getRfidInfo: () => requireClient().getRfidInfo(),
  getHeartbeatData: () => requireClient().getHeartbeatData(),
  fetchPrinterInfo: () => requireClient().fetchPrinterInfo(),
  fetchRfidInfo: () => requireClient().fetchRfidInfo(),
  fetchHeartbeat: () => requireClient().fetchHeartbeatData(),

  startHeartbeat: () => (requireClient().startHeartbeat(), true),
  stopHeartbeat: () => (requireClient().stopHeartbeat(), true),
  setHeartbeatInterval: (p: { ms: number }) => (requireClient().setHeartbeatInterval(p.ms), true),
  setPacketInterval: (p: { ms: number }) => (requireClient().setPacketInterval(p.ms), true),
  setDebug: (p: { value: boolean }) => (requireClient().setDebug(p.value), true),
  setVerboseEvents: (p: { value: boolean }) => ((verboseEvents = !!p.value), true),

  async setSoundEnabled(p: { type: number | keyof typeof SoundSettingsItemType; value: boolean }) {
    const t = enumValue(SoundSettingsItemType, p.type, "sound type")!;
    await requireClient().setSoundEnabled(t, p.value);
    return true;
  },

  async setAutoShutdownTime(p: { value: number | keyof typeof AutoShutdownTime }) {
    await requireClient().setAutoShutdownTime(enumValue(AutoShutdownTime, p.value, "shutdown time")!);
    return true;
  },

  listModels: () => modelsLibrary,
  listPrintTasks: () => printTaskNames,

  print(params: PrintParams, binary?: ArrayBuffer) {
    if (binary === undefined) {
      throw new Error("print: pixel buffer missing");
    }
    // One page batch, the result keeps the single image shape
    return submitPrint(
      "print",
      withWait(params.options, params.wait),
      [{ width: params.width, height: params.height, offset: 0, length: binary.byteLength }],
      binary,
      true,
    );
  },

  printBatch(params: PrintBatchParams, binary?: ArrayBuffer) {
    if (binary === undefined) {
      throw new Error("printBatch: pixel buffer missing");
    }
    if (!Array.isArray(params.pages) || params.pages.length === 0) {
      throw new Error("printBatch: no pages");
    }
    return submitPrint("printBatch", withWait(params.options, params.wait), params.pages, binary, false);
  },

  /* ---- PNG printer ---- */

  /** Pages printed by the PNG printer, optionally of one job: [{jobId, page, copies, width, height, png}] */
  pngPages: (p: { jobId?: number }) =>
    p.jobId === undefined || p.jobId === null ? pngPages : pngPages.filter((pg) => pg.jobId === p.jobId),

  clearPngPages: () => {
    const n = pngPages.length;
    pngPages = [];
    return n;
  },

  /* ---- print queue ---- */

  getJob: (p: { id: number }) => queue.get(p.id),
  listJobs: () => queue.list(),
  cancelJob: (p: { id: number }) => queue.cancel(p.id),
  clearQueue: () => queue.clear(),
  waitJob: (p: { id: number }) => queue.wait(p.id),
  pauseQueue: () => (queue.pause(), true),
  resumeQueue: () => (queue.resume(), true),
  isQueuePaused: () => queue.isPaused,

  /* ---- templates (.niim packages) ---- */

  registerFont(p: { family: string; weight?: number; italic?: boolean }, binary?: ArrayBuffer) {
    if (typeof p.family !== "string" || p.family.trim() === "") {
      throw new Error("registerFont: family missing");
    }
    if (binary === undefined || binary.byteLength === 0) {
      throw new Error("registerFont: font data missing");
    }
    const face = registerFont(p.family, new Uint8Array(binary), p.weight ?? 400, p.italic ?? false);
    return { family: face.family, weight: face.weight, italic: face.italic };
  },

  listFonts: () => listFonts(),

  templateTags: (_p: unknown, binary?: ArrayBuffer) => listTags(parseTemplate(binary)),

  /**
   * Render the design without a printer. Pixels are base64 RGBA (only white, black and red).
   * This is the design, not a test print: print to the PNG printer (niim_connect_png) to see
   * the label as the printer puts it on paper.
   */
  async renderTemplate(p: TemplateParams<TemplateRenderOptions> | null, binary?: ArrayBuffer) {
    p = p ?? {};
    const template = parseTemplate(binary);
    if (Array.isArray(p.data)) {
      throw new Error("renderTemplate: data must be one object (one label)");
    }
    const o = p.options ?? {};
    const rendered = await renderTemplate(template, {
      ...renderOptions(o),
      data: p.data ?? {},
    });
    const canvas = rendered as unknown as SoftCanvas;
    return {
      width: canvas.width,
      height: canvas.height,
      printDirection: template.label.printDirection,
      format: "rgba",
      pixels: base64Encode(new Uint8Array(canvas.data.buffer, canvas.data.byteOffset, canvas.data.byteLength)),
    };
  },

  /** Print one label per data row. */
  async printTemplate(p: TemplateParams<TemplatePrintOptions> | null, binary?: ArrayBuffer) {
    p = p ?? {};
    const c = requireClient();
    const template = parseTemplate(binary);
    const o = p.options ?? {};
    const rows = Array.isArray(p.data) ? p.data : [p.data ?? {}];

    const printTaskName = o.printTask ?? c.getPrintTaskType();
    if (printTaskName === undefined) {
      throw new Error("printTemplate: unable to detect print task for this printer, pass printTask explicitly");
    }
    if (!printTaskNames.includes(printTaskName)) {
      throw new Error(`printTemplate: unknown print task ${printTaskName}`);
    }
    const quantity = o.quantity ?? 1;
    const labelType = enumValue(LabelType, o.labelType, "label type");
    const pageColor = enumValue(PageColorType, o.pageColor, "page color");
    // Fail on bad data rows at submit time (rendering happens when the job runs)
    for (const row of rows) {
      fillTemplate(template, row, { strict: o.strict ?? true });
    }

    const run = async () => {
      requireSameClient(c);
      setPngLabel(c, template.label.width, template.label.height);
      await printTemplate(c, template, rows, {
        render: renderOptions(o),
        density: o.density,
        labelType,
        pageColor,
        quantity,
        printTaskName,
        printOptions: {
          ...(o.speed !== undefined ? { speed: o.speed } : {}),
          ...(o.statusPollIntervalMs !== undefined ? { statusPollIntervalMs: o.statusPollIntervalMs } : {}),
          ...(o.statusTimeoutMs !== undefined ? { statusTimeoutMs: o.statusTimeoutMs } : {}),
          ...(o.pageTimeoutMs !== undefined ? { pageTimeoutMs: o.pageTimeoutMs } : {}),
        },
      });
      return { printTask: printTaskName, labels: rows.length, pages: rows.length * quantity };
    };

    const { job, done } = queue.submit(run, {
      label: o.label ?? template.title,
      pages: rows.length,
      totalPages: rows.length * quantity,
    });
    if (o.wait === false) {
      return job;
    }
    return { ...((await done) as object), jobId: job.id };
  },
};

/* ------------------------------------------------------------------------ */
/* Entry points called from C                                               */
/* ------------------------------------------------------------------------ */

const g = globalThis as any;

g.__niim = {
  dispatch(reqId: number, method: string, paramsJson: string, binary?: ArrayBuffer) {
    void (async () => {
      try {
        const fn = methods[method];
        if (fn === undefined) {
          throw new Error(`Unknown method: ${method}`);
        }
        const params: unknown = paramsJson ? JSON.parse(paramsJson) : {};
        const result = await fn(params ?? {}, binary);
        __native.done(reqId, true, toJson(result));
      } catch (e) {
        __native.done(reqId, false, errorMessage(e));
      }
    })();
  },

  onData(data: Uint8Array) {
    if (client instanceof NiimbotNativeClient) {
      client.feed(data);
    }
  },

  onClosed() {
    if (client instanceof NiimbotNativeClient) {
      client.transportClosed();
    }
  },

  fireTimer: g.__fireTimer,
};
