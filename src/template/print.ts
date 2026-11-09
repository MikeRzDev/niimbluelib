import type { NiimbotAbstractClient } from "../client";
import { LabelType, PageColorType } from "../packets";
import type { AbstractPrintTask, PrintOptions, PrintTaskName } from "../print_tasks";
import { EncodedImage, ImageEncoder } from "../utils/image_encoder";
import { renderTemplate, RenderOptions, templateToImageSource } from "./render";
import { NiimTemplate } from "./types";
import { validateTemplate } from "./validate";

/** @category Template */
export interface PrintTemplateOptions {
  /** Render options (canvas factory, image loader, threshold, fill options). `data` is ignored. */
  render?: Omit<RenderOptions, "data">;
  /** Print density. Default: printer model default density, or 3. */
  density?: number;
  /** Default {@link LabelType.WithGaps}. */
  labelType?: LabelType;
  /** Copies of each page. Default 1. */
  quantity?: number;
  /** Default {@link PageColorType.SingleColor}. */
  pageColor?: PageColorType;
  /** Print task. Default: detected from the connected printer model, or "B1". */
  printTaskName?: PrintTaskName;
  /** Extra print task options, applied last. */
  printOptions?: Partial<PrintOptions>;
  /** Called after each page is printed. `page` is 1-based. */
  onProgress?: (page: number, total: number) => void;
}

/**
 * Render template for every data row and print it. Each data row is one page.
 *
 * All pages are rendered and encoded before the print starts, so invalid data
 * (e.g. bad barcode value, missing required field in strict mode) fails early.
 *
 * Heartbeat is stopped while printing and restored afterwards.
 *
 * @example
 * ```ts
 * const template = validateTemplate(JSON.parse(json));
 * await printTemplate(client, template, [{ name: "Apple" }, { name: "Banana" }], { quantity: 2 });
 * ```
 *
 * @category Template
 */
export const printTemplate = async (
  client: NiimbotAbstractClient,
  t: NiimTemplate,
  data: Record<string, string> | Record<string, string>[],
  opts: PrintTemplateOptions = {},
): Promise<void> => {
  const template = validateTemplate(t);
  const rows = Array.isArray(data) ? data : [data];

  if (rows.length === 0) {
    throw new Error("No data rows to print");
  }

  const quantity = opts.quantity ?? 1;
  const pageColor = opts.pageColor ?? PageColorType.SingleColor;
  const printTaskName = opts.printTaskName ?? client.getPrintTaskType() ?? "B1";
  const density = opts.density ?? client.getModelMetadata()?.densityDefault ?? 3;

  const pages: EncodedImage[] = [];
  for (const row of rows) {
    const canvas = await renderTemplate(template, { ...opts.render, data: row });
    pages.push(ImageEncoder.encode(templateToImageSource(canvas), pageColor, template.label.printDirection));
  }

  const printOptions: Partial<PrintOptions> = {
    totalPages: pages.length * quantity,
    density,
    labelType: opts.labelType ?? LabelType.WithGaps,
    statusPollIntervalMs: 100,
    statusTimeoutMs: 8_000,
    pageColor,
    ...opts.printOptions,
  };

  const heartbeatWasStarted = client.isHeartbeatStarted();
  client.stopHeartbeat();

  let task: AbstractPrintTask | undefined;
  let printError: unknown;

  try {
    task = client.protocol.newPrintTask(printTaskName, printOptions);
    await task.printInit();

    for (let i = 0; i < pages.length; i++) {
      await task.printPage(pages[i], quantity);
      await task.waitForPageFinished();
      opts.onProgress?.(i + 1, pages.length);
    }

    await task.waitForFinished();
  } catch (e) {
    printError = e;
  }

  try {
    if (task !== undefined) {
      await task.printEnd();
    } else {
      await client.protocol.printEnd();
    }
  } catch (e) {
    printError ??= e;
  } finally {
    if (heartbeatWasStarted) {
      client.startHeartbeat();
    }
  }

  if (printError !== undefined) {
    throw printError;
  }
};
