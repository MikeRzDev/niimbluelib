/*
 * PNG printer: a simulated printer that writes PNG files instead of burning labels.
 *
 * It is the only "test print" of libniimblue and it simulates the real print
 * end to end: a job printed to it runs the same queue, print task and packets
 * as on a real printer. The printer side decodes the image packets it receives
 * into the dots the print head would burn and lays them on the label the way
 * the device does (strip centered across the print head, cut at the head and
 * label edges, fed in the model's direction). The PNG shows the final tag in
 * reading orientation, so a wrong print direction, label size or printhead
 * width shows up rotated / cut off exactly like on paper.
 */

import {
  ConnectEvent,
  ConnectionInfo,
  ConnectResult,
  DisconnectEvent,
  modelsLibrary,
  NiimbotAbstractClient,
  NiimbotClientType,
  NiimbotPacket,
  PacketParser,
  PrintDirection,
  PrinterModelMeta,
  RawPacketSentEvent,
  RequestCommandId as TX,
  ResponseCommandId as RX,
} from "../../src";
import { base64Encode, encodeIndexedPng } from "./png";

export interface PngPrinterOptions {
  /** Printer model to simulate (niimbluelib model name, default "B1"). */
  model?: string;
  /** Protocol version reported to the print task selection (default: model default). */
  protocolVersion?: number;
  /**
   * Physical label (roll) size in dots, in design orientation (width x height of
   * the template / image). Default: the size of what is printed.
   */
  labelWidth?: number;
  labelHeight?: number;
  /** Override the model's printhead width in dots. */
  printheadPixels?: number;
  /** Override the model's feed direction. */
  printDirection?: PrintDirection;
}

/** One printed label. */
export interface PngPage {
  /** Print queue job that printed it */
  jobId?: number;
  /** 1-based page number inside the job */
  page: number;
  /** Copies the printer was told to print */
  copies: number;
  /** Label size in dots (reading orientation) */
  width: number;
  height: number;
  /** PNG file, base64 */
  png: string;
}

const NOT_SUPPORTED = new Uint8Array([0x55, 0x55, 0x00, 0x01, 0x01, 0x00, 0xaa, 0xaa]);

/** Commands a print task sends; everything else (info, heartbeat, rfid, ...) is "not supported". */
const PRINT_COMMANDS = new Set<number>([
  TX.SetDensity,
  TX.SetLabelType,
  TX.SetPrintSpeed,
  TX.PrintStart,
  TX.PageStart,
  TX.SetPageSize,
  TX.PrintQuantity,
  TX.PageEnd,
  TX.PrintEnd,
  TX.PrintClear,
  TX.PrinterCheckLine,
  TX.CancelPrint,
]);

const PALETTE: [number, number, number][] = [
  [255, 255, 255], // 0 white
  [0, 0, 0], // 1 black
  [255, 0, 0], // 2 red
];

export class NiimbotPngPrinterClient extends NiimbotAbstractClient {
  private open = false;
  private readonly meta: PrinterModelMeta;

  /** Label size of the job being printed (design orientation), set by the bridge per page. */
  private jobLabel?: { width: number; height: number };

  private dots?: Uint8Array; // current page: cols x rows, 1 byte per dot
  private rows = 0;
  private cols = 0;
  private copies = 1;
  private pagesInJob = 0;
  private printed = 0;

  constructor(
    private readonly options: PngPrinterOptions,
    private readonly onPage: (page: Omit<PngPage, "jobId">) => void,
  ) {
    super();
    const model = options.model ?? "B1";
    const meta = modelsLibrary.find((m) => m.model === model);
    if (meta === undefined) {
      throw new Error(`PNG printer: unknown model ${model}`);
    }
    this.meta = {
      ...meta,
      printheadPixels: options.printheadPixels ?? meta.printheadPixels,
      printDirection: options.printDirection ?? meta.printDirection,
    };
    this.setHeartbeatAutoStart(false);
  }

  public async connect(): Promise<ConnectionInfo> {
    this.open = true;
    this.printerInfo.connectResult = ConnectResult.Connected;
    this.printerInfo.modelId = this.meta.id[0];
    this.printerInfo.protocolVersion = this.options.protocolVersion;
    this.printerInfo.serial = "PNG-PRINTER";
    this.printerInfo.printheadWidth = this.meta.printheadPixels;
    const info: ConnectionInfo = { deviceName: `PNG printer (${this.meta.model})`, result: ConnectResult.Connected };
    this.emit("connect", new ConnectEvent(info));
    return info;
  }

  public async disconnect(): Promise<void> {
    if (this.open) {
      this.open = false;
      this.emit("disconnect", new DisconnectEvent());
    }
  }

  public isConnected(): boolean {
    return this.open;
  }

  public override getModelMetadata(): PrinterModelMeta | undefined {
    return this.meta;
  }

  public override getType(): NiimbotClientType {
    return "serial";
  }

  /** The label the next page is printed on (design orientation). */
  public setJobLabel(width: number, height: number) {
    this.jobLabel = { width, height };
  }

  public async sendRaw(data: Uint8Array): Promise<void> {
    if (!this.open) {
      throw new Error("Transport is not open");
    }
    this.emit("rawpacketsent", new RawPacketSentEvent(data));
    for (const packet of PacketParser.parsePacketBundle(data)) {
      this.handle(packet.command as TX, packet.data);
    }
  }

  private reply(bytes: Uint8Array) {
    setTimeout(() => this.processRawPacket(bytes), 0);
  }

  private ok(cmd: TX) {
    const rx = ({
      [TX.SetDensity]: RX.In_SetDensity,
      [TX.SetLabelType]: RX.In_SetLabelType,
      [TX.SetPrintSpeed]: RX.In_SetPrintSpeed,
      [TX.PrintStart]: RX.In_PrintStart,
      [TX.PageStart]: RX.In_PageStart,
      [TX.SetPageSize]: RX.In_SetPageSize,
      [TX.PrintQuantity]: RX.In_PrintQuantity,
      [TX.PageEnd]: RX.In_PageEnd,
      [TX.PrintEnd]: RX.In_PrintEnd,
      [TX.PrintClear]: RX.In_PrintClear,
      [TX.PrinterCheckLine]: RX.In_PrinterCheckLine,
      [TX.CancelPrint]: RX.In_CancelPrint,
    } as Partial<Record<TX, RX>>)[cmd];
    if (rx !== undefined) {
      this.reply(new NiimbotPacket(rx, [1]).toBytes());
    }
  }

  private handle(cmd: TX, d: Uint8Array) {
    const u16 = (i: number) => (d[i] << 8) | d[i + 1];

    switch (cmd) {
      case TX.PrintStart:
        this.pagesInJob = 0;
        this.printed = 0;
        this.copies = 1;
        break;
      case TX.PageStart:
        this.dots = undefined;
        this.copies = 1;
        break;
      case TX.SetPageSize:
        this.rows = d.length >= 2 ? u16(0) : 0;
        this.cols = d.length >= 4 ? u16(2) : this.meta.printheadPixels;
        if (d.length >= 6) this.copies = u16(4);
        this.dots = new Uint8Array(this.rows * this.cols);
        break;
      case TX.PrintQuantity:
        if (d.length >= 2) this.copies = u16(0);
        break;
      case TX.PrintBitmapRow:
      case TX.PrintBitmapRowIndexed:
        this.drawRow(cmd, d);
        return; // no response
      case TX.PrintEmptyRow:
        return; // nothing burned, no response
      case TX.PrintBitmapRowDoubleColor:
      case TX.PrintBitmapRowGray:
        throw new Error("PNG printer: two-color and grayscale pages are not supported yet");
      case TX.PageEnd:
        this.finishPage();
        break;
      case TX.PrintStatus: {
        const page = this.printed;
        this.reply(new NiimbotPacket(RX.In_PrintStatus, [page >> 8, page & 0xff, 0x64, 0x64]).toBytes());
        return;
      }
    }

    if (PRINT_COMMANDS.has(cmd)) {
      this.ok(cmd);
    } else {
      this.reply(NOT_SUPPORTED);
    }
  }

  private drawRow(cmd: TX, d: Uint8Array) {
    if (this.dots === undefined || d.length < 6) return;
    // pos u16, pixel counts [3], repeats, then bitmap bytes or u16 dot indexes
    const pos = (d[0] << 8) | d[1];
    const repeats = d[5];
    const body = d.subarray(6);
    for (let r = 0; r < repeats; r++) {
      const row = pos + r;
      if (row >= this.rows) break;
      const base = row * this.cols;
      if (cmd === TX.PrintBitmapRow) {
        for (let i = 0; i < body.length; i++) {
          for (let bit = 0; bit < 8; bit++) {
            const c = i * 8 + bit;
            if (body[i] & (0x80 >> bit) && c < this.cols) this.dots[base + c] = 1;
          }
        }
      } else {
        for (let i = 0; i + 1 < body.length; i += 2) {
          const c = (body[i] << 8) | body[i + 1];
          if (c < this.cols) this.dots[base + c] = 1;
        }
      }
    }
  }

  /** Lay the burned strip on the label and emit it as PNG. */
  private finishPage() {
    const dots = this.dots ?? new Uint8Array(0);
    const cols = this.cols;
    const rows = this.rows;
    const dir = this.meta.printDirection;

    // Physical label in design orientation
    let w = this.options.labelWidth ?? this.jobLabel?.width;
    let h = this.options.labelHeight ?? this.jobLabel?.height;
    if (w === undefined || h === undefined) {
      w = dir === "left" ? rows : cols;
      h = dir === "left" ? cols : rows;
    }

    // Printer frame: across the head x along the feed
    const across = dir === "left" ? h : w;
    const along = dir === "left" ? w : h;

    // The sent width is centered on the head; a narrower head cuts both sides.
    const head = this.meta.printheadPixels > 0 ? this.meta.printheadPixels : Infinity;
    const headFrom = cols > head ? Math.floor((cols - head) / 2) : 0;
    const headTo = cols > head ? headFrom + head : cols;
    const offset = Math.floor((across - cols) / 2);

    const pixels = new Uint8Array(w * h); // palette indexes, 0 = white
    for (let f = 0; f < along && f < rows; f++) {
      for (let a = 0; a < across; a++) {
        const c = a - offset;
        if (c < headFrom || c >= headTo || c < 0 || c >= cols) continue;
        if (!dots[f * cols + c]) continue;
        // Back to reading orientation
        const x = dir === "left" ? f : a;
        const y = dir === "left" ? across - 1 - a : f;
        pixels[y * w + x] = 1;
      }
    }

    this.pagesInJob++;
    this.printed += this.copies;
    this.dots = undefined;

    this.onPage({
      page: this.pagesInJob,
      copies: this.copies,
      width: w,
      height: h,
      png: base64Encode(encodeIndexedPng(w, h, pixels, PALETTE)),
    });
  }
}
