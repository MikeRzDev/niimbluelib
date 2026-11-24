/*
 * libniimblue - NIIMBOT label printer library with a plain C API.
 *
 * The niimbluelib JavaScript library and a QuickJS engine are compiled into
 * this library; callers see C functions only.
 *
 * Conventions
 * -----------
 *  - Functions returning `int` return NIIM_OK (0) on success or a negative
 *    NIIM_E* code on failure.
 *  - Every `char **out` parameter is optional (may be NULL). When non-NULL it
 *    receives a heap string the caller frees with niim_string_free():
 *      success -> JSON result
 *      failure -> human readable error message
 *  - All calls block until the operation finishes and may be made from any
 *    thread. Do NOT call niim_* functions on the same handle from inside the
 *    event callback (it returns NIIM_E_REENTRANT).
 *
 * Print queue
 * -----------
 *  Every print (niim_print, niim_print_batch, niim_print_template) is a job in
 *  a FIFO queue; one job prints at a time, so prints from several threads wait
 *  their turn instead of mixing their packets.
 *
 *  - By default a print call blocks until its job finished and *out receives
 *    the job result plus "jobId". With {"wait":false} in its options the call
 *    returns right after the job was queued and *out receives the job snapshot.
 *    Sizes / options are validated when the job is submitted; images are
 *    encoded when it runs.
 *  - Job snapshot:
 *      {"id":N, "state":"queued"|"printing"|"done"|"failed"|"cancelled",
 *       "label":"...", "pages":N, "totalPages":N,
 *       "createdAt":ms, "startedAt":ms, "finishedAt":ms,   (unix time in ms)
 *       "error":"...", "result":{...}}                     (optional fields)
 *    pages: different images / labels, totalPages: including copies.
 *  - Queue methods (niim_call):
 *      getJob {"id"}       snapshot of a job
 *      listJobs            active jobs and the last ~100 finished ones (oldest first)
 *      cancelJob {"id"}    cancel a queued job (a printing job can't be cancelled)
 *      clearQueue          cancel every queued job, result: number cancelled
 *      waitJob {"id"}      wait until the job finished; fails with the job error
 *                          if it failed or was cancelled
 *      pauseQueue          the printing job finishes, no new job starts
 *      resumeQueue, isQueuePaused
 *  - A blocking print call whose job is cancelled fails with "job N cancelled".
 *  - On disconnect (also when the device closes the connection) and on a new
 *    connect, queued jobs fail with "disconnected"; the printing job fails on
 *    its own.
 *  - Events: "jobqueued" and "jobstarted" (job snapshot), "jobdone"
 *    {"id","state","error"?,"result"?}. While a job prints, "printprogress",
 *    "printpacketprogress" and "printend" payloads carry "jobId".
 *  - Common job options: "wait":true|false, "label":"text shown in snapshots".
 */

#ifndef NIIMBLUE_H
#define NIIMBLUE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32) && !defined(NIIM_STATIC)
#  ifdef NIIM_BUILDING
#    define NIIM_API __declspec(dllexport)
#  else
#    define NIIM_API __declspec(dllimport)
#  endif
#elif defined(__GNUC__)
#  define NIIM_API __attribute__((visibility("default")))
#else
#  define NIIM_API
#endif

/* Result codes */
#define NIIM_OK              0
#define NIIM_E_INVALID_ARG  -1  /* bad argument (NULL handle, ...)          */
#define NIIM_E_JS           -2  /* the operation failed (see error message)  */
#define NIIM_E_TRANSPORT    -3  /* could not open / use the transport        */
#define NIIM_E_CLOSED       -4  /* handle is shutting down                   */
#define NIIM_E_REENTRANT    -5  /* called from the event callback thread     */
#define NIIM_E_NOMEM        -6
#define NIIM_E_INIT         -7  /* engine / bundle failed to initialize      */

typedef struct niim niim_t;

/*
 * Event callback. Called on the library's internal thread.
 *   name: "connect", "disconnect", "heartbeat", "heartbeatfailed",
 *         "printerinfofetched", "rfidinfofetched", "printprogress",
 *         "printpacketprogress", "printend", "jobqueued", "jobstarted",
 *         "jobdone", "pngpage", "log", ...
 *         (packet level events only after setVerboseEvents {"value":true})
 *   json: event payload. Both strings are only valid during the call.
 */
typedef void (*niim_event_cb)(void *user, const char *name, const char *json);

/*
 * Custom transport write callback (e.g. Bluetooth LE implemented by the host).
 * Must send `len` bytes to the printer. Return 0 on success, non-zero on error.
 * Called on the library's internal thread.
 */
typedef int (*niim_write_cb)(void *user, const uint8_t *data, size_t len);

/* Version of this native library, e.g. "0.1.0". */
NIIM_API const char *niim_version(void);

/* Version of the embedded niimbluelib JavaScript library, e.g. "0.49.1". */
NIIM_API const char *niim_niimbluelib_version(void);

/* Create a handle. Returns NULL on failure (message in *out if given). */
NIIM_API niim_t *niim_new(char **out);

/* Disconnect, stop the internal thread and free the handle. */
NIIM_API void niim_free(niim_t *h);

/* Set (or clear with NULL) the event callback. */
NIIM_API void niim_set_event_callback(niim_t *h, niim_event_cb cb, void *user);

/* Free a string returned through an `out` parameter. NULL is ignored. */
NIIM_API void niim_string_free(char *s);

/* JSON array of candidate serial port paths, e.g. ["/dev/ttyACM0"] or ["COM3"]. */
NIIM_API char *niim_list_serial_ports(void);

/*
 * Connect options (all optional, JSON object or NULL):
 *   {"heartbeat":true, "heartbeatIntervalMs":2000, "packetIntervalMs":10, "debug":false}
 *
 * On success *out receives:
 *   {"deviceName":..., "result":..., "printerInfo":{...}, "modelMetadata":{...}, "printTask":"B1"}
 */

/* Connect over USB serial: "/dev/ttyACM0", "/dev/cu.usbmodem1101", "COM3". */
NIIM_API int niim_connect_serial(niim_t *h, const char *port, const char *options_json, char **out);

/*
 * Connect over a host provided transport. The library calls `write` to send
 * bytes; the host passes every received byte chunk to niim_feed().
 */
NIIM_API int niim_connect_custom(niim_t *h, niim_write_cb write, void *user,
                                 const char *options_json, char **out);

/* Bytes received by a custom transport. Safe to call from any thread. */
NIIM_API void niim_feed(niim_t *h, const uint8_t *data, size_t len);

/* The custom transport was closed by the device. Safe to call from any thread. */
NIIM_API void niim_transport_closed(niim_t *h);

/* Simulated printer driven by a request/response hex dump (for testing). */
NIIM_API int niim_connect_virtual(niim_t *h, const char *hexdump, const char *options_json, char **out);

/*
 * PNG printer: a simulated printer that produces PNG files instead of labels.
 * This is the test print: jobs printed to it run the same queue, print task and
 * packets as on a real printer, and the printer side lays the decoded dots on
 * the label like the device does (centered across the print head, cut at the
 * head and label edges, fed in the model's direction). Each page becomes a PNG
 * of the final tag in reading orientation, so a wrong printDirection, label
 * size or printhead width shows up rotated / cut off exactly like on paper.
 *
 *   options_json (optional):
 *     {"model":"B1",              model to simulate (niimbluelib model name)
 *      "protocolVersion":N,       for print task selection
 *      "labelWidth":W, "labelHeight":H,   physical label in dots, design orientation
 *                                 (default: size of the printed template / image)
 *      "printheadPixels":N, "printDirection":"left"|"top"}   override the model
 *
 * Printed pages: niim_call "pngPages" {"jobId":N} (optional filter) returns
 *   [{"jobId","page","copies","width","height","png":"<base64 PNG>"}, ...]
 * (last 200 pages), "clearPngPages" forgets them. A "pngpage" event (same
 * fields without "png") is emitted per page. Two-color and grayscale pages are
 * not supported yet (the job fails).
 */
NIIM_API int niim_connect_png(niim_t *h, const char *options_json, char **out);

NIIM_API int niim_disconnect(niim_t *h);

/*
 * Print an image.
 *   pixels: width*height pixels, top-left first, row-major
 *   options_json (optional):
 *     {"format":"rgba"|"rgb"|"gray",   pixel format (default "rgba"; gray: 0=black 255=white)
 *      "stride":N,                     bytes per row (default width*bpp)
 *      "quantity":1, "density":3, "labelType":"WithGaps"|1,
 *      "pageColor":"SingleColor"|0, "printTask":"B1", "printDirection":"left"|"top",
 *      "speed":0|1, "threshold":128,   luminance below threshold prints black
 *      "statusPollIntervalMs", "statusTimeoutMs", "pageTimeoutMs",
 *      "wait":true, "label":"..."}     see "Print queue" above
 *   Defaults for density / direction / print task come from the detected model.
 *   *out: {"printTask":"B1","cols":C,"rows":R,"pages":quantity,"jobId":N}
 *   (a one page niim_print_batch).
 */
NIIM_API int niim_print(niim_t *h, const uint8_t *pixels, size_t pixels_len,
                        uint32_t width, uint32_t height, const char *options_json, char **out);

/* One page of niim_print_batch. */
typedef struct {
    const uint8_t *pixels;     /* width*height pixels, see niim_print            */
    size_t len;                /* bytes in pixels                                */
    uint32_t width, height;
    /* Optional page options overriding the job options:
     * {"format","stride","quantity","threshold","printDirection"} (may be NULL) */
    const char *options_json;
} niim_image_t;

/*
 * Print several different images in one print job (one print task, each page
 * printed `quantity` times; totalPages is the sum of page quantities).
 *   options_json: job options, same as niim_print (page options override
 *                 format / stride / quantity / threshold / printDirection).
 * The pixel buffers are copied, they may be freed when the call returns.
 * *out: {"printTask":"B1","pages":totalPages,"jobId":N,
 *        "images":[{"cols":C,"rows":R,"quantity":Q},...]}
 * or the job snapshot with {"wait":false}.
 */
NIIM_API int niim_print_batch(niim_t *h, const niim_image_t *images, size_t count, const char *options_json,
                              char **out);

/*
 * Label templates: .niim packages (ZIP with template.json, images and fonts,
 * e.g. exported from the NiimBlue editor), the only template format. Rendering
 * runs inside the library: text uses registered fonts (Noto Sans Regular/Bold
 * are built in and also answer to "Noto Sans Variable", the NiimBlue editor
 * default; unknown families fall back to it) and the TTF / OTF fonts embedded
 * in the package, which are registered when it is rendered. Images must be PNG.
 *
 *   package, package_len: the .niim file contents
 *   data_json:     tag values, {"name":"value",...}; niim_print_template also
 *                  takes an array of objects, one label per object (may be NULL)
 *   options_json (optional):
 *     {"threshold":128,                luminance below threshold prints black
 *      "strict":true,                  unresolved tags of required / undeclared fields fail
 *      print only: "quantity":1 (copies of each label), "density", "labelType",
 *      "pageColor", "printTask", "speed", "statusPollIntervalMs",
 *      "statusTimeoutMs", "pageTimeoutMs", "wait", "label"}   (same meaning as niim_print)
 */

/*
 * Render a template without a printer. On success *out receives
 *   {"width":W,"height":H,"printDirection":"left"|"top","format":"rgba",
 *    "pixels":"<base64 RGBA, W*H*4 bytes, only white/black/red>"}
 */
NIIM_API int niim_render_template(niim_t *h, const uint8_t *package, size_t package_len, const char *data_json,
                                  const char *options_json, char **out);

/*
 * Print a template, one label per data row, as one queued job.
 * *out: {"printTask":"B1","labels":N,"pages":N*quantity,"jobId":N} (or the job snapshot with "wait":false)
 */
NIIM_API int niim_print_template(niim_t *h, const uint8_t *package, size_t package_len, const char *data_json,
                                 const char *options_json, char **out);

/*
 * Register a TrueType / OpenType font (TTF or OTF bytes; WOFF/WOFF2 are not
 * supported) for template text under a CSS family name. weight: 100..900
 * (400 regular, 700 bold, <= 0 means 400). Missing bold / italic faces are
 * synthesized. Registering the same family/weight/style again replaces it.
 */
NIIM_API int niim_register_font(niim_t *h, const char *family, int weight, int italic, const uint8_t *data,
                                size_t len, char **out);

/*
 * Generic call into the embedded library. `params_json` (a JSON object) may be NULL.
 * "connect" (JS-only transports "virtual" / "png") first closes the current
 * connection and transport, like the niim_connect_* functions.
 * Methods (generated from api/api.json, see also the Print queue section):
 * BEGIN GENERATED METHODS
 *   connect {"transport":"virtual","hexdump","options"?} -> ConnectionInfo
 *       connectVirtual: Connect to a simulated printer driven by a request/response hex dump (testing).
 *   connect {"transport":"png","options"?} -> ConnectionInfo
 *       connectPng: Connect to the PNG printer: the test print. Jobs run the real queue, print task and
 *       packets and each page becomes a PNG of the final tag as the printer puts it on paper (see pngPages).
 *       Options:
 *       {"model":"B1","labelWidth","labelHeight","printheadPixels","printDirection","protocolVersion"}.
 *   print {"width","height","options"?} + data -> PrintResult
 *       print: Print an image: pixels row-major, top-left first, format from options ("rgba" default, "rgb",
 *       "gray"). Options as niim_print in include/niimblue.h; {"wait":false} returns the job snapshot right
 *       away.
 *   printBatch {"pages":[{"offset","length","width","height","options"?}],"options"?} + data -> PrintResult
 *       printBatch: Print several different images as one print job (one print task; the job prints the sum
 *       of the page quantities). Returns
 *       {"printTask","pages","jobId","images":[{"cols","rows","quantity"}]}.
 *   printBatch {"wait":false,"pages":[{"offset","length","width","height","options"?}],"options"?} + data -> Job
 *       submit: Queue a print job (printBatch) and return its snapshot right away; wait for it with waitJob.
 *   renderTemplate {"data"?,"options"?} + data -> json
 *       renderTemplate: Render a .niim template package without a printer (the design, not a test print).
 *       Returns {"width","height","printDirection","format":"rgba","pixels":"<base64 RGBA>"}.
 *   printTemplate {"data"?,"options"?} + data -> json
 *       printTemplate: Print a .niim template package as one queued job; data is one object of tag values or
 *       an array of objects (one label each). Options: threshold, strict, quantity, density, labelType,
 *       printTask, wait, label, ...
 *   isConnected -> bool
 *       isConnected: Whether a printer is connected.
 *   getPrinterInfo -> PrinterInfo
 *       printerInfo: Printer info fetched during connect (see fetchPrinterInfo to refresh it).
 *   fetchPrinterInfo -> PrinterInfo
 *       fetchPrinterInfo: Fetch the printer info from the printer again.
 *   getModelMetadata -> ModelMetadata?
 *       modelMetadata: Metadata of the detected printer model (null when unknown).
 *   getPrintTaskType -> string
 *       printTaskType: Print task detected for the printer, e.g. "B1" (null when unknown).
 *   fetchHeartbeat -> HeartbeatData
 *       heartbeat: Fetch the printer status (battery, lid, paper).
 *   getHeartbeatData -> HeartbeatData
 *       lastHeartbeat: Printer status of the last heartbeat (no printer request).
 *   fetchRfidInfo -> json
 *       rfidInfo: Fetch the RFID info of the inserted label roll.
 *   getRfidInfo -> json
 *       lastRfidInfo: RFID info of the last fetch (no printer request).
 *   startHeartbeat
 *       startHeartbeat: Start the periodic heartbeat.
 *   stopHeartbeat
 *       stopHeartbeat: Stop the periodic heartbeat.
 *   setHeartbeatInterval {"ms"}
 *       setHeartbeatInterval: Heartbeat interval in milliseconds.
 *   setPacketInterval {"ms"}
 *       setPacketInterval: Delay between packets sent to the printer, in milliseconds.
 *   setDebug {"value"}
 *       setDebug: Log protocol details ("log" events).
 *   setVerboseEvents {"value"}
 *       setVerboseEvents: Also emit packet level events.
 *   setSoundEnabled {"type","value"}
 *       setSoundEnabled: Turn a printer sound on or off. type: "BluetoothConnectionSound" or "PowerSound".
 *   setAutoShutdownTime {"value"}
 *       setAutoShutdownTime: Auto shutdown time: "ShutdownTime1" (usually 15 min) to "ShutdownTime4".
 *   listModels -> ModelMetadata[]
 *       models: All printer models known to niimbluelib.
 *   listPrintTasks -> string[]
 *       printTasks: Names of the print tasks (printTask option).
 *   registerFont {"family","weight"?,"italic"?} + data -> FontInfo
 *       registerFont: Register a TrueType / OpenType font (TTF or OTF bytes, not WOFF) for template text
 *       under a CSS family name. weight 100..900 (default 400). Missing bold / italic faces are synthesized;
 *       registering the same face again replaces it.
 *   listFonts -> FontInfo[]
 *       fonts: Fonts available for template text.
 *   templateTags + data -> string[]
 *       templateTags: Tag names a .niim template package uses, e.g. ["sku","url"].
 *   pngPages {"jobId"?} -> PNGPage[]
 *       pngPages: Pages printed by the PNG printer (niim_connect_png), all or of one job (last 200 pages).
 *   clearPngPages -> int
 *       clearPngPages: Forget the PNG printer pages, returns how many there were.
 *   getJob {"id"} -> Job
 *       job: Snapshot of a print job (active or one of the last ~100 finished).
 *   listJobs -> Job[]
 *       jobs: Active jobs and the last ~100 finished ones (oldest first).
 *   cancelJob {"id"} -> Job
 *       cancelJob: Cancel a queued job. A job that is printing can't be cancelled.
 *   clearQueue -> int
 *       clearQueue: Cancel every queued job, returns how many were cancelled.
 *   waitJob {"id"} -> Job
 *       waitJob: Wait until the job finished. Fails with the job error if it failed or was cancelled.
 *   pauseQueue
 *       pauseQueue: The printing job finishes, no new job starts until resumeQueue.
 *   resumeQueue
 *       resumeQueue: Start queued jobs again.
 *   isQueuePaused -> bool
 *       queuePaused: Whether the queue is paused.
 * END GENERATED METHODS
 */
NIIM_API int niim_call(niim_t *h, const char *method, const char *params_json, char **out);

/*
 * niim_call with a binary payload (e.g. registerFont font bytes). `data` may be
 * NULL (then it is niim_call); the bytes are copied, they may be freed when the
 * call returns. Every binding wraps the methods of this API through this one
 * function, see api/api.json.
 */
NIIM_API int niim_call_bin(niim_t *h, const char *method, const char *params_json, const uint8_t *data, size_t len,
                           char **out);

#ifdef __cplusplus
}
#endif

#endif /* NIIMBLUE_H */
