/*
 * libniimblue test program. No printer required:
 *   - virtual transport (JS side simulator)
 *   - custom transport with a fake printer implemented here in C
 *   - serial transport over a pseudo terminal (POSIX only), fake printer on the master side
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "niimblue.h"
#include "../src/plat.h"
#include "b1_print_dump.h"

#ifndef _WIN32
#include <fcntl.h>
#include <poll.h>
#include <termios.h>
#include <unistd.h>
#endif

static int failures = 0;
static int checks = 0;

#define CHECK(cond, ...)                                    \
    do {                                                    \
        checks++;                                           \
        if (cond) {                                         \
            printf("  ok   ");                              \
        } else {                                            \
            printf("  FAIL ");                              \
            failures++;                                     \
        }                                                   \
        printf(__VA_ARGS__);                                \
        printf("\n");                                       \
    } while (0)

/* ------------------------------------------------------------------ */
/* Event recorder                                                      */
/* ------------------------------------------------------------------ */

typedef struct {
    plat_mutex_t mu;
    niim_t *h;
    int connect, disconnect, printprogress, printend, packetprogress, log_errors;
    int jobqueued, jobstarted, jobdone, progress_with_job;
    int reentrant_rc;
    int try_reentrant;
} events_t;

static void on_event(void *user, const char *name, const char *json) {
    events_t *e = (events_t *)user;
    plat_mutex_lock(&e->mu);
    if (!strcmp(name, "connect")) e->connect++;
    else if (!strcmp(name, "disconnect")) e->disconnect++;
    else if (!strcmp(name, "printprogress")) {
        e->printprogress++;
        if (strstr(json, "\"jobId\":")) e->progress_with_job++;
    }
    else if (!strcmp(name, "jobqueued")) e->jobqueued++;
    else if (!strcmp(name, "jobstarted")) e->jobstarted++;
    else if (!strcmp(name, "jobdone")) e->jobdone++;
    else if (!strcmp(name, "printend")) e->printend++;
    else if (!strcmp(name, "printpacketprogress")) e->packetprogress++;
    else if (!strcmp(name, "log") && strstr(json, "\"level\":\"error\"")) {
        e->log_errors++;
        printf("       log: %s\n", json);
    }
    plat_mutex_unlock(&e->mu);

    if (e->try_reentrant && !strcmp(name, "connect")) {
        char *out = NULL;
        e->reentrant_rc = niim_call(e->h, "isConnected", NULL, &out);
        niim_string_free(out);
    }
}

/* ------------------------------------------------------------------ */
/* Fake printer: request/response table parsed from the hex dump       */
/* ------------------------------------------------------------------ */

typedef struct {
    uint8_t req[64];
    size_t req_len;
    int prefix;
    uint8_t resp[128];
    size_t resp_len; /* 0 = no response */
} entry_t;

static entry_t table[128];
static size_t table_len = 0;

static size_t parse_hex(const char *s, const char *end, uint8_t *out, size_t cap, int *star) {
    size_t n = 0;
    int hi = -1;
    *star = 0;
    for (; s < end && *s && *s != '('; s++) {
        int v = -1;
        if (*s == '*') { *star = 1; break; }
        if (*s >= '0' && *s <= '9') v = *s - '0';
        else if (*s >= 'a' && *s <= 'f') v = *s - 'a' + 10;
        else if (*s >= 'A' && *s <= 'F') v = *s - 'A' + 10;
        if (v < 0) continue;
        if (hi < 0) hi = v;
        else {
            if (n < cap) out[n++] = (uint8_t)(hi << 4 | v);
            hi = -1;
        }
    }
    return n;
}

static void load_table(const char *dump) {
    const char *line = dump;
    entry_t *cur = NULL;
    while (*line) {
        const char *eol = strchr(line, '\n');
        int star;
        if (!eol) eol = line + strlen(line);
        if (!strncmp(line, ">> ", 3) && table_len < 128) {
            cur = &table[table_len++];
            memset(cur, 0, sizeof(*cur));
            cur->req_len = parse_hex(line + 3, eol, cur->req, sizeof(cur->req), &star);
            cur->prefix = star;
        } else if (!strncmp(line, "<< ", 3) && cur) {
            if (strncmp(line + 3, "NA", 2) != 0)
                cur->resp_len = parse_hex(line + 3, eol, cur->resp, sizeof(cur->resp), &star);
            cur = NULL;
        }
        line = *eol ? eol + 1 : eol;
    }
}

static const uint8_t NOT_SUPPORTED[] = {0x55, 0x55, 0x00, 0x01, 0x01, 0x00, 0xaa, 0xaa};

/* Returns response length (0 = none). */
static size_t fake_respond(const uint8_t *req, size_t len, const uint8_t **resp) {
    size_t i;
    for (i = 0; i < table_len; i++) {
        entry_t *e = &table[i];
        if (e->prefix ? (len >= e->req_len && !memcmp(req, e->req, e->req_len))
                      : (len == e->req_len && !memcmp(req, e->req, len))) {
            *resp = e->resp;
            return e->resp_len;
        }
    }
    *resp = NOT_SUPPORTED;
    return sizeof(NOT_SUPPORTED);
}

/* custom transport: answer synchronously through niim_feed */
typedef struct {
    niim_t *h;
    int writes;
} custom_t;

static int custom_write(void *user, const uint8_t *data, size_t len) {
    custom_t *c = (custom_t *)user;
    const uint8_t *resp;
    size_t n = fake_respond(data, len, &resp);
    c->writes++;
    if (n) niim_feed(c->h, resp, n);
    return 0;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

static uint8_t *make_image(uint32_t w, uint32_t hgt) {
    uint8_t *px = (uint8_t *)malloc((size_t)w * hgt * 4);
    uint32_t x, y;
    for (y = 0; y < hgt; y++) {
        for (x = 0; x < w; x++) {
            uint8_t *p = px + ((size_t)y * w + x) * 4;
            int black = (x >= 4 && x < w - 4 && y >= 4 && y < hgt - 4) && ((x / 8 + y / 8) % 2 == 0);
            p[0] = p[1] = p[2] = black ? 0 : 255;
            p[3] = 255;
        }
    }
    return px;
}

static void print_and_check(niim_t *h, events_t *ev, const char *label) {
    uint32_t w = 120, hgt = 64;
    uint8_t *px = make_image(w, hgt);
    char *out = NULL;
    int before_end = ev->printend;
    int rc = niim_print(h, px, (size_t)w * hgt * 4, w, hgt, "{\"quantity\":1,\"density\":3,\"statusPollIntervalMs\":20}", &out);
    CHECK(rc == NIIM_OK, "%s: print rc=%d %s", label, rc, out ? out : "");
    CHECK(out && strstr(out, "\"printTask\":\"B1\""), "%s: print task B1 auto detected", label);
    CHECK(ev->printend == before_end + 1, "%s: printend event received", label);
    niim_string_free(out);
    free(px);
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

static void test_basics(void) {
    char *out = NULL, *ports;
    niim_t *h;
    int rc;
    int64_t t0 = plat_now_ms();

    printf("basics\n");
    h = niim_new(&out);
    CHECK(h != NULL, "niim_new (%lld ms) %s", (long long)(plat_now_ms() - t0), out ? out : "");
    niim_string_free(out);
    if (!h) return;

    printf("       version %s, niimbluelib %s\n", niim_version(), niim_niimbluelib_version());

    rc = niim_call(h, "listModels", NULL, &out);
    CHECK(rc == NIIM_OK && strstr(out, "\"model\":\"B1\""), "listModels contains B1");
    niim_string_free(out);

    rc = niim_call(h, "listPrintTasks", NULL, &out);
    CHECK(rc == NIIM_OK && strstr(out, "D110M_V4"), "listPrintTasks: %s", out);
    niim_string_free(out);

    rc = niim_call(h, "noSuchMethod", NULL, &out);
    CHECK(rc == NIIM_E_JS && strstr(out, "Unknown method"), "unknown method -> error: %s", out);
    niim_string_free(out);

    rc = niim_call(h, "getPrinterInfo", NULL, &out);
    CHECK(rc == NIIM_E_JS && strstr(out, "Not connected"), "getPrinterInfo before connect -> %s", out);
    niim_string_free(out);

    rc = niim_call(h, "isConnected", "{not json", &out);
    CHECK(rc == NIIM_E_JS, "invalid params JSON -> error: %s", out);
    niim_string_free(out);

    /* niim_call_bin: the payload reaches the method, NULL data is a plain call */
    rc = niim_call_bin(h, "registerFont", "{\"family\":\"Junk\"}", (const uint8_t *)"not a font", 10, &out);
    CHECK(rc == NIIM_E_JS && out && !strstr(out, "data missing"), "call_bin with junk font -> %s", out);
    niim_string_free(out);
    rc = niim_call_bin(h, "registerFont", "{\"family\":\"Junk\"}", NULL, 0, &out);
    CHECK(rc == NIIM_E_JS && out && strstr(out, "font data missing"), "call_bin without data -> %s", out);
    niim_string_free(out);
    rc = niim_call_bin(h, "listPrintTasks", NULL, NULL, 0, &out);
    CHECK(rc == NIIM_OK && strstr(out, "\"B1\""), "call_bin as plain call: %s", out);
    niim_string_free(out);
    rc = niim_call_bin(h, "listPrintTasks", NULL, NULL, 3, &out);
    CHECK(rc == NIIM_E_INVALID_ARG, "call_bin with NULL data and len > 0 -> %d", rc);
    niim_string_free(out);

    /* connect through niim_call (JS-only transports), twice: the second replaces the first */
    rc = niim_call(h, "connect", "{\"transport\":\"png\",\"options\":{\"model\":\"B1\"}}", &out);
    CHECK(rc == NIIM_OK && strstr(out, "PNG printer"), "connect png via niim_call: %s", out);
    niim_string_free(out);
    rc = niim_call_bin(h, "connect", "{\"transport\":\"png\"}", (const uint8_t *)"x", 1, &out);
    CHECK(rc == NIIM_OK, "connect again via niim_call_bin: %d", rc);
    niim_string_free(out);
    rc = niim_call(h, "isConnected", NULL, &out);
    CHECK(rc == NIIM_OK && !strcmp(out, "true"), "connected: %s", out);
    niim_string_free(out);
    niim_disconnect(h);

    rc = niim_connect_serial(h, "/dev/does-not-exist-niim", NULL, &out);
    CHECK(rc == NIIM_E_TRANSPORT, "serial open failure -> %s", out);
    niim_string_free(out);

    ports = niim_list_serial_ports();
    CHECK(ports && ports[0] == '[', "list serial ports: %s", ports);
    niim_string_free(ports);

    niim_free(h);
}

static void test_virtual(void) {
    events_t ev;
    char *out = NULL;
    niim_t *h;
    int rc;

    printf("virtual transport\n");
    memset(&ev, 0, sizeof(ev));
    plat_mutex_init(&ev.mu);
    h = niim_new(NULL);
    ev.h = h;
    ev.try_reentrant = 1;
    niim_set_event_callback(h, on_event, &ev);

    rc = niim_connect_virtual(h, B1_PRINT_DUMP, "{\"heartbeat\":false}", &out);
    CHECK(rc == NIIM_OK, "connect rc=%d", rc);
    CHECK(out && strstr(out, "\"serial\":\"G327071185\""), "printer serial in connect result");
    CHECK(out && strstr(out, "\"modelId\":4096"), "modelId 4096 (B1)");
    niim_string_free(out);
    CHECK(ev.connect == 1, "connect event");
    CHECK(ev.reentrant_rc == NIIM_E_REENTRANT, "call from event callback -> NIIM_E_REENTRANT");

    rc = niim_call(h, "getModelMetadata", NULL, &out);
    CHECK(rc == NIIM_OK && strstr(out, "\"printheadPixels\":384"), "model metadata printhead 384");
    niim_string_free(out);

    rc = niim_call(h, "fetchHeartbeat", NULL, &out);
    CHECK(rc == NIIM_OK && strstr(out, "batteryPercents"), "fetchHeartbeat: %s", out);
    niim_string_free(out);

    print_and_check(h, &ev, "virtual");
    CHECK(ev.printprogress > 0, "printprogress events (%d)", ev.printprogress);
    CHECK(ev.packetprogress > 0, "printpacketprogress events (%d)", ev.packetprogress);

    rc = niim_print(h, (const uint8_t *)"\0\0\0\0", 4, 10, 10, NULL, &out);
    CHECK(rc == NIIM_E_JS && strstr(out, "too small"), "short pixel buffer -> %s", out);
    niim_string_free(out);

    rc = niim_disconnect(h);
    CHECK(rc == NIIM_OK && ev.disconnect == 1, "disconnect event");

    rc = niim_call(h, "isConnected", NULL, &out);
    CHECK(rc == NIIM_OK && !strcmp(out, "false"), "isConnected after disconnect = %s", out);
    niim_string_free(out);

    niim_free(h);
    CHECK(ev.log_errors == 0, "no error logs");
    plat_mutex_destroy(&ev.mu);
}

static void test_custom(void) {
    events_t ev;
    custom_t c;
    char *out = NULL;
    niim_t *h;
    int rc;

    printf("custom transport (fake printer in C)\n");
    memset(&ev, 0, sizeof(ev));
    plat_mutex_init(&ev.mu);
    h = niim_new(NULL);
    c.h = h;
    c.writes = 0;
    niim_set_event_callback(h, on_event, &ev);

    rc = niim_connect_custom(h, custom_write, &c, "{\"heartbeat\":false}", &out);
    CHECK(rc == NIIM_OK && out && strstr(out, "\"printTask\":\"B1\""), "connect rc=%d", rc);
    niim_string_free(out);
    CHECK(c.writes > 5, "transport writes during handshake (%d)", c.writes);

    print_and_check(h, &ev, "custom");

    niim_transport_closed(h);
    /* the close is asynchronous; a following call is processed after it */
    rc = niim_call(h, "isConnected", NULL, &out);
    CHECK(rc == NIIM_OK && !strcmp(out, "false"), "device-side close -> isConnected = %s", out);
    niim_string_free(out);
    CHECK(ev.disconnect == 1, "disconnect event on device-side close");

    niim_free(h);
    CHECK(ev.log_errors == 0, "no error logs");
    plat_mutex_destroy(&ev.mu);
}

/* Print queue and batch API (virtual printer: single page jobs only, its dump always reports page 1 of 1) */
static void test_queue(void) {
    events_t ev;
    char *out = NULL;
    niim_t *h;
    int rc;
    uint32_t w = 120, hgt = 64;
    size_t len = (size_t)w * hgt * 4;
    uint8_t *px = make_image(w, hgt);
    niim_image_t pages[2];
    const char *opts = "{\"statusPollIntervalMs\":20}";

    printf("print queue\n");
    memset(&ev, 0, sizeof(ev));
    plat_mutex_init(&ev.mu);
    h = niim_new(NULL);
    niim_set_event_callback(h, on_event, &ev);
    rc = niim_connect_virtual(h, B1_PRINT_DUMP, "{\"heartbeat\":false}", NULL);
    CHECK(rc == NIIM_OK, "connect rc=%d", rc);

    memset(pages, 0, sizeof(pages));
    pages[0].pixels = px;
    pages[0].len = len;
    pages[0].width = w;
    pages[0].height = hgt;

    /* one page batch */
    rc = niim_print_batch(h, pages, 1, opts, &out);
    CHECK(rc == NIIM_OK && out && strstr(out, "\"images\":[{\"cols\":120,\"rows\":64,\"quantity\":1}]") &&
              strstr(out, "\"jobId\":1"),
          "print_batch one page: %s", out ? out : "");
    niim_string_free(out);
    CHECK(ev.jobqueued == 1 && ev.jobstarted == 1 && ev.jobdone == 1, "job events %d/%d/%d", ev.jobqueued,
          ev.jobstarted, ev.jobdone);
    CHECK(ev.progress_with_job > 0, "printprogress carries jobId");

    /* niim_print is a queued job too */
    rc = niim_print(h, px, len, w, hgt, opts, &out);
    CHECK(rc == NIIM_OK && out && strstr(out, "\"cols\":120") && strstr(out, "\"jobId\":2"), "print job 2: %s",
          out ? out : "");
    niim_string_free(out);

    /* validation at submit time */
    rc = niim_print_batch(h, NULL, 1, NULL, &out);
    CHECK(rc == NIIM_E_INVALID_ARG, "batch without images -> %d", rc);
    niim_string_free(out);
    pages[1] = pages[0];
    pages[1].len = 0;
    rc = niim_print_batch(h, pages, 2, NULL, &out);
    CHECK(rc == NIIM_E_INVALID_ARG && out && strstr(out, "page 2"), "empty page 2 -> %s", out ? out : "");
    niim_string_free(out);
    pages[1].len = 16;
    rc = niim_print_batch(h, pages, 2, NULL, &out);
    CHECK(rc == NIIM_E_JS && out && strstr(out, "page 2") && strstr(out, "too small"), "short page 2 -> %s",
          out ? out : "");
    niim_string_free(out);

    /* wait:false returns the snapshot, waitJob the result */
    rc = niim_print(h, px, len, w, hgt, "{\"wait\":false,\"label\":\"bg\",\"statusPollIntervalMs\":20}", &out);
    CHECK(rc == NIIM_OK && out && strstr(out, "\"id\":3") && strstr(out, "\"label\":\"bg\""),
          "wait:false snapshot: %s", out ? out : "");
    niim_string_free(out);
    rc = niim_call(h, "waitJob", "{\"id\":3}", &out);
    CHECK(rc == NIIM_OK && out && strstr(out, "\"state\":\"done\"") && strstr(out, "\"result\":"), "waitJob: %s",
          out ? out : "");
    niim_string_free(out);

    /* pause, queue two, clear */
    rc = niim_call(h, "pauseQueue", NULL, NULL);
    CHECK(rc == NIIM_OK, "pauseQueue");
    niim_print(h, px, len, w, hgt, "{\"wait\":false}", NULL);
    niim_print(h, px, len, w, hgt, "{\"wait\":false}", NULL);
    rc = niim_call(h, "getJob", "{\"id\":5}", &out);
    CHECK(rc == NIIM_OK && out && strstr(out, "\"state\":\"queued\""), "paused job stays queued: %s",
          out ? out : "");
    niim_string_free(out);
    rc = niim_call(h, "cancelJob", "{\"id\":5}", &out);
    CHECK(rc == NIIM_OK && out && strstr(out, "\"state\":\"cancelled\""), "cancelJob: %s", out ? out : "");
    niim_string_free(out);
    rc = niim_call(h, "clearQueue", NULL, &out);
    CHECK(rc == NIIM_OK && out && !strcmp(out, "1"), "clearQueue cancelled %s", out ? out : "");
    niim_string_free(out);
    rc = niim_call(h, "waitJob", "{\"id\":4}", &out);
    CHECK(rc == NIIM_E_JS && out && strstr(out, "job 4 cancelled"), "waitJob on cancelled job -> %s", out ? out : "");
    niim_string_free(out);
    rc = niim_call(h, "resumeQueue", NULL, NULL);
    CHECK(rc == NIIM_OK, "resumeQueue");
    rc = niim_call(h, "listJobs", NULL, &out);
    CHECK(rc == NIIM_OK && out && strstr(out, "\"id\":5"), "listJobs");
    niim_string_free(out);

    niim_free(h);
    free(px);
    CHECK(ev.log_errors == 0, "no error logs");
    plat_mutex_destroy(&ev.mu);
}

#ifndef _WIN32
/* Fake printer on the master side of a pty. */
typedef struct {
    int fd;
    volatile int stop;
    int frames;
} pty_printer_t;

static void *pty_printer_main(void *arg) {
    pty_printer_t *p = (pty_printer_t *)arg;
    uint8_t buf[8192];
    size_t len = 0;

    while (!p->stop) {
        struct pollfd pfd = {p->fd, POLLIN, 0};
        ssize_t n;
        if (poll(&pfd, 1, 50) <= 0) continue;
        n = read(p->fd, buf + len, sizeof(buf) - len);
        if (n <= 0) continue;
        len += (size_t)n;

        /* split frames: [03] 55 55 cmd len data.. crc aa aa */
        for (;;) {
            size_t start = 0, total;
            const uint8_t *resp;
            size_t rl;
            while (start + 1 < len && !(buf[start] == 0x55 && buf[start + 1] == 0x55)) start++;
            if (start + 4 > len) break;
            total = 2 + 1 + 1 + buf[start + 3] + 1 + 2;
            if (start + total > len) break;
            /* include a leading 0x03 (connect) in the request bytes */
            if (start > 0 && buf[start - 1] == 0x03) rl = fake_respond(buf + start - 1, total + 1, &resp);
            else rl = fake_respond(buf + start, total, &resp);
            p->frames++;
            if (rl && write(p->fd, resp, rl) < 0) break;
            memmove(buf, buf + start + total, len - start - total);
            len -= start + total;
        }
    }
    return NULL;
}

static void test_serial_pty(void) {
    events_t ev;
    pty_printer_t pp;
    plat_thread_t th;
    struct termios tio;
    char *out = NULL;
    const char *slave;
    niim_t *h;
    int rc;

    printf("serial transport (pseudo terminal)\n");
    memset(&pp, 0, sizeof(pp));
    pp.fd = posix_openpt(O_RDWR | O_NOCTTY);
    if (pp.fd < 0 || grantpt(pp.fd) != 0 || unlockpt(pp.fd) != 0 || !(slave = ptsname(pp.fd))) {
        CHECK(0, "cannot create pty");
        return;
    }
    tcgetattr(pp.fd, &tio);
    cfmakeraw(&tio);
    tcsetattr(pp.fd, TCSANOW, &tio);
    plat_thread_create(&th, pty_printer_main, &pp);

    memset(&ev, 0, sizeof(ev));
    plat_mutex_init(&ev.mu);
    h = niim_new(NULL);
    niim_set_event_callback(h, on_event, &ev);

    rc = niim_connect_serial(h, slave, "{\"heartbeat\":false}", &out);
    CHECK(rc == NIIM_OK, "connect over %s rc=%d %s", slave, rc, rc ? out : "");
    niim_string_free(out);

    if (rc == NIIM_OK) {
        print_and_check(h, &ev, "serial");
        rc = niim_disconnect(h);
        CHECK(rc == NIIM_OK && ev.disconnect == 1, "disconnect");
    }
    CHECK(pp.frames > 10, "fake printer handled %d frames", pp.frames);

    niim_free(h);
    pp.stop = 1;
    plat_thread_join(th);
    close(pp.fd);
    CHECK(ev.log_errors == 0, "no error logs");
    plat_mutex_destroy(&ev.mu);
}
#endif

static void test_many_handles(void) {
    niim_t *hs[4];
    int i, ok = 1;
    printf("handle lifecycle\n");
    for (i = 0; i < 4; i++) ok &= (hs[i] = niim_new(NULL)) != NULL;
    for (i = 0; i < 4; i++) niim_free(hs[i]);
    CHECK(ok, "create/free 4 concurrent handles");
    niim_free(NULL);
    CHECK(1, "niim_free(NULL) is a no-op");
}

int main(void) {
    load_table(B1_PRINT_DUMP);
    test_basics();
    test_virtual();
    test_custom();
    test_queue();
#ifndef _WIN32
    test_serial_pty();
#endif
    test_many_handles();
    printf("\n%d/%d checks passed\n", checks - failures, checks);
    return failures ? 1 : 0;
}
