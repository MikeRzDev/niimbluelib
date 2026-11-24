/*
 * libniimblue core.
 *
 * Threading model
 * ---------------
 * Each handle owns one worker thread. The worker owns the QuickJS runtime and
 * runs an event loop: API requests, received transport bytes and timers are
 * all processed there. Public API functions enqueue a request, wake the worker
 * and block on a condition variable until the JS promise settles.
 *
 * A serial transport additionally has a reader thread that pushes received
 * chunks into the handle's rx queue.
 */

#define NIIM_BUILDING
#include "niimblue.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "plat.h"
#include "quickjs.h"
#include "sbuf.h"
#include "serial.h"

#define NIIM_LIB_VERSION "0.1.0"

extern const unsigned char niim_bundle[];
extern const size_t niim_bundle_size;
extern const char niim_bundle_version[];

/* ------------------------------------------------------------------------ */
/* Types                                                                    */
/* ------------------------------------------------------------------------ */

typedef enum { REQ_JS, REQ_CLOSE_TRANSPORT } req_kind_t;

typedef struct req {
    struct req *next;
    req_kind_t kind;
    uint32_t id;
    char *method;
    char *params;
    uint8_t *bin;
    size_t bin_len;
    int has_bin;
    /* completion (guarded by h->mu) */
    int done;
    int code;
    char *result;
} req_t;

typedef struct chunk {
    struct chunk *next;
    size_t len;
    uint8_t data[1];
} chunk_t;

typedef struct {
    uint32_t id;
    int64_t due;
} ntimer_t;

typedef enum { TR_NONE, TR_SERIAL, TR_CUSTOM } transport_t;

struct niim {
    plat_mutex_t mu;
    plat_cond_t loop_cv; /* wakes the worker */
    plat_cond_t done_cv; /* wakes API callers */
    plat_thread_t thread;
    plat_thread_id_t thread_id;

    int ready;
    char *init_error;
    int stopping;

    /* request queue (mu) */
    req_t *q_head, *q_tail;
    uint32_t next_req_id;

    /* worker only: dispatched requests waiting for __native.done */
    req_t *inflight;

    /* rx queue (mu) */
    chunk_t *rx_head, *rx_tail;
    int rx_closed;

    /* transport (installed under mu; written/closed by the worker) */
    transport_t tr;
    serial_port_t *serial;
    plat_thread_t reader;
    int reader_running;
    niim_write_cb write_cb;
    void *write_user;

    /* events (mu) */
    niim_event_cb event_cb;
    void *event_user;

    /* worker only: JS */
    JSRuntime *rt;
    JSContext *ctx;
    JSValue fn_dispatch, fn_ondata, fn_onclosed, fn_firetimer;
    ntimer_t *timers;
    size_t ntimers, ctimers;
};

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

static char *xstrdup(const char *s) {
    size_t n;
    char *d;
    if (!s) return NULL;
    n = strlen(s);
    d = (char *)malloc(n + 1);
    if (d) memcpy(d, s, n + 1);
    return d;
}

static void set_out(char **out, char *s) {
    if (out) *out = s;
    else free(s);
}

static int fail(char **out, int code, const char *msg) {
    set_out(out, xstrdup(msg));
    return code;
}

static void req_free(req_t *r) {
    if (!r) return;
    free(r->method);
    free(r->params);
    free(r->bin);
    free(r->result);
    free(r);
}

/* Complete a request and wake its waiter. Takes ownership of `result`. */
static void req_complete(niim_t *h, req_t *r, int code, char *result) {
    plat_mutex_lock(&h->mu);
    r->code = code;
    r->result = result;
    r->done = 1;
    plat_cond_broadcast(&h->done_cv);
    plat_mutex_unlock(&h->mu);
}

/* Emit an event to the host callback (worker thread). */
static void emit_event(niim_t *h, const char *name, const char *json) {
    niim_event_cb cb;
    void *user;
    plat_mutex_lock(&h->mu);
    cb = h->event_cb;
    user = h->event_user;
    plat_mutex_unlock(&h->mu);

    if (cb) {
        cb(user, name, json);
    } else if (strcmp(name, "log") == 0 && (strstr(json, "\"level\":\"error\"") || strstr(json, "\"level\":\"warn\""))) {
        fprintf(stderr, "[niimblue] %s\n", json);
    }
}

static void emit_log(niim_t *h, const char *level, const char *msg) {
    sbuf_t b = {0};
    char *s;
    sb_puts(&b, "{\"level\":");
    sb_json_str(&b, level);
    sb_puts(&b, ",\"message\":");
    sb_json_str(&b, msg);
    sb_putc(&b, '}');
    s = sb_take(&b);
    if (s) {
        emit_event(h, "log", s);
        free(s);
    }
}

/* Convert the pending JS exception to a heap string (message + stack). */
static char *take_exception(JSContext *ctx) {
    JSValue exc = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, exc);
    sbuf_t b = {0};
    sb_puts(&b, msg ? msg : "unknown JS exception");
    if (msg) JS_FreeCString(ctx, msg);
    if (JS_IsError(exc)) {
        JSValue stack = JS_GetPropertyStr(ctx, exc, "stack");
        if (JS_IsString(stack)) {
            const char *st = JS_ToCString(ctx, stack);
            if (st && *st) {
                sb_putc(&b, '\n');
                sb_puts(&b, st);
            }
            if (st) JS_FreeCString(ctx, st);
        }
        JS_FreeValue(ctx, stack);
    }
    JS_FreeValue(ctx, exc);
    return sb_take(&b);
}

static void log_exception(niim_t *h, const char *where) {
    char *e = take_exception(h->ctx);
    sbuf_t b = {0};
    char *s;
    sb_puts(&b, where);
    sb_puts(&b, ": ");
    sb_puts(&b, e ? e : "?");
    s = sb_take(&b);
    emit_log(h, "error", s ? s : where);
    free(s);
    free(e);
}

static void run_jobs(niim_t *h) {
    for (;;) {
        JSContext *c = NULL;
        int r = JS_ExecutePendingJob(h->rt, &c);
        if (r == 0) break;
        if (r < 0) log_exception(h, "job");
    }
}

/* ------------------------------------------------------------------------ */
/* Transport (worker side)                                                  */
/* ------------------------------------------------------------------------ */

static void *reader_main(void *arg) {
    niim_t *h = (niim_t *)arg;
    serial_port_t *p;
    uint8_t buf[512];

    plat_mutex_lock(&h->mu);
    p = h->serial;
    plat_mutex_unlock(&h->mu);

    for (;;) {
        int n = serial_read(p, buf, sizeof(buf), 100);
        if (n == 0) continue;
        plat_mutex_lock(&h->mu);
        if (n < 0) {
            h->rx_closed = 1;
        } else {
            chunk_t *c = (chunk_t *)malloc(sizeof(chunk_t) + (size_t)n);
            if (c) {
                c->next = NULL;
                c->len = (size_t)n;
                memcpy(c->data, buf, (size_t)n);
                if (h->rx_tail) h->rx_tail->next = c;
                else h->rx_head = c;
                h->rx_tail = c;
            }
        }
        plat_cond_broadcast(&h->loop_cv);
        plat_mutex_unlock(&h->mu);
        if (n < 0) break;
    }
    return NULL;
}

static void rx_flush_locked(niim_t *h) {
    chunk_t *c = h->rx_head;
    while (c) {
        chunk_t *n = c->next;
        free(c);
        c = n;
    }
    h->rx_head = h->rx_tail = NULL;
    h->rx_closed = 0;
}

/* Close the active transport. Worker thread only (or after the worker exited). */
static void transport_close(niim_t *h) {
    serial_port_t *p = NULL;
    int join = 0;
    plat_thread_t reader;

    plat_mutex_lock(&h->mu);
    if (h->tr == TR_SERIAL) {
        p = h->serial;
        join = h->reader_running;
        reader = h->reader;
        h->reader_running = 0;
        h->serial = NULL;
        if (p) serial_interrupt(p);
    }
    h->tr = TR_NONE;
    h->write_cb = NULL;
    h->write_user = NULL;
    plat_mutex_unlock(&h->mu);

    if (join) plat_thread_join(reader);
    if (p) serial_close(p);

    plat_mutex_lock(&h->mu);
    rx_flush_locked(h);
    plat_mutex_unlock(&h->mu);
}

/* ------------------------------------------------------------------------ */
/* __native functions                                                       */
/* ------------------------------------------------------------------------ */

static niim_t *H(JSContext *ctx) { return (niim_t *)JS_GetContextOpaque(ctx); }

/* Throw a plain, catchable Error. (quickjs-ng makes InternalError uncatchable,
 * so JS_ThrowInternalError must not be used for recoverable failures.) */
static JSValue throw_error(JSContext *ctx, const char *msg) {
    JSValue err = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, msg));
    return JS_Throw(ctx, err);
}

static JSValue js_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    niim_t *h = H(ctx);
    size_t len = 0;
    uint8_t *data;
    transport_t tr;
    serial_port_t *p;
    niim_write_cb cb;
    void *user;
    int rc = -1;
    (void)this_val;

    if (argc < 1) return JS_ThrowTypeError(ctx, "write: missing data");
    data = JS_GetUint8Array(ctx, &len, argv[0]);
    if (!data) return JS_EXCEPTION;

    plat_mutex_lock(&h->mu);
    tr = h->tr;
    p = h->serial;
    cb = h->write_cb;
    user = h->write_user;
    plat_mutex_unlock(&h->mu);

    /* Only the worker closes transports, so p / cb stay valid here. */
    if (tr == TR_SERIAL && p) rc = serial_write(p, data, len);
    else if (tr == TR_CUSTOM && cb) rc = cb(user, data, len);
    else return throw_error(ctx, "write: transport is not open");

    if (rc != 0) return throw_error(ctx, "write: transport write failed");
    return JS_UNDEFINED;
}

static JSValue js_close(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    transport_close(H(ctx));
    return JS_UNDEFINED;
}

static JSValue js_timer_start(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    niim_t *h = H(ctx);
    uint32_t id;
    double ms = 0;
    size_t i;
    (void)this_val;

    if (argc < 2 || JS_ToUint32(ctx, &id, argv[0]) || JS_ToFloat64(ctx, &ms, argv[1])) return JS_EXCEPTION;
    if (ms < 0) ms = 0;

    for (i = 0; i < h->ntimers; i++) {
        if (h->timers[i].id == id) {
            h->timers[i].due = plat_now_ms() + (int64_t)ms;
            return JS_UNDEFINED;
        }
    }
    if (h->ntimers == h->ctimers) {
        size_t nc = h->ctimers ? h->ctimers * 2 : 16;
        ntimer_t *nt = (ntimer_t *)realloc(h->timers, nc * sizeof(ntimer_t));
        if (!nt) return JS_ThrowOutOfMemory(ctx);
        h->timers = nt;
        h->ctimers = nc;
    }
    h->timers[h->ntimers].id = id;
    h->timers[h->ntimers].due = plat_now_ms() + (int64_t)ms;
    h->ntimers++;
    return JS_UNDEFINED;
}

static JSValue js_timer_cancel(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    niim_t *h = H(ctx);
    uint32_t id;
    size_t i;
    (void)this_val;

    if (argc < 1 || JS_ToUint32(ctx, &id, argv[0])) return JS_EXCEPTION;
    for (i = 0; i < h->ntimers; i++) {
        if (h->timers[i].id == id) {
            h->timers[i] = h->timers[h->ntimers - 1];
            h->ntimers--;
            break;
        }
    }
    return JS_UNDEFINED;
}

static JSValue js_done(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    niim_t *h = H(ctx);
    uint32_t id;
    int ok;
    const char *s;
    req_t **pp, *r = NULL;
    (void)this_val;

    if (argc < 3 || JS_ToUint32(ctx, &id, argv[0])) return JS_EXCEPTION;
    ok = JS_ToBool(ctx, argv[1]);
    s = JS_ToCString(ctx, argv[2]);
    if (!s) return JS_EXCEPTION;

    for (pp = &h->inflight; *pp; pp = &(*pp)->next) {
        if ((*pp)->id == id) {
            r = *pp;
            *pp = r->next;
            r->next = NULL;
            break;
        }
    }
    if (r) req_complete(h, r, ok ? NIIM_OK : NIIM_E_JS, xstrdup(s));
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

static JSValue js_emit(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *name, *json;
    (void)this_val;
    if (argc < 2) return JS_UNDEFINED;
    name = JS_ToCString(ctx, argv[0]);
    json = JS_ToCString(ctx, argv[1]);
    if (name && json) emit_event(H(ctx), name, json);
    if (name) JS_FreeCString(ctx, name);
    if (json) JS_FreeCString(ctx, json);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry native_funcs[] = {
    JS_CFUNC_DEF("write", 1, js_write),
    JS_CFUNC_DEF("close", 0, js_close),
    JS_CFUNC_DEF("timerStart", 2, js_timer_start),
    JS_CFUNC_DEF("timerCancel", 1, js_timer_cancel),
    JS_CFUNC_DEF("done", 3, js_done),
    JS_CFUNC_DEF("emit", 2, js_emit),
};

static void promise_rejection_tracker(JSContext *ctx, JSValueConst promise, JSValueConst reason, bool is_handled,
                                      void *opaque) {
    niim_t *h = (niim_t *)opaque;
    const char *s;
    (void)promise;
    if (is_handled) return;
    s = JS_ToCString(ctx, reason);
    emit_log(h, "warn", s ? s : "unhandled promise rejection");
    if (s) JS_FreeCString(ctx, s);
}

/* ------------------------------------------------------------------------ */
/* Worker                                                                   */
/* ------------------------------------------------------------------------ */

static int js_init(niim_t *h) {
    JSValue global, native, niim, r;

    h->rt = JS_NewRuntime();
    if (!h->rt) { h->init_error = xstrdup("JS_NewRuntime failed"); return -1; }
    h->ctx = JS_NewContext(h->rt);
    if (!h->ctx) { h->init_error = xstrdup("JS_NewContext failed"); return -1; }
    JS_SetContextOpaque(h->ctx, h);
    JS_SetHostPromiseRejectionTracker(h->rt, promise_rejection_tracker, h);

    global = JS_GetGlobalObject(h->ctx);
    native = JS_NewObject(h->ctx);
    JS_SetPropertyFunctionList(h->ctx, native, native_funcs, sizeof(native_funcs) / sizeof(native_funcs[0]));
    JS_SetPropertyStr(h->ctx, global, "__native", native);

    r = JS_Eval(h->ctx, (const char *)niim_bundle, niim_bundle_size, "niimblue.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(r)) {
        h->init_error = take_exception(h->ctx);
        JS_FreeValue(h->ctx, global);
        return -1;
    }
    JS_FreeValue(h->ctx, r);

    niim = JS_GetPropertyStr(h->ctx, global, "__niim");
    h->fn_dispatch = JS_GetPropertyStr(h->ctx, niim, "dispatch");
    h->fn_ondata = JS_GetPropertyStr(h->ctx, niim, "onData");
    h->fn_onclosed = JS_GetPropertyStr(h->ctx, niim, "onClosed");
    h->fn_firetimer = JS_GetPropertyStr(h->ctx, niim, "fireTimer");
    JS_FreeValue(h->ctx, niim);
    JS_FreeValue(h->ctx, global);

    if (!JS_IsFunction(h->ctx, h->fn_dispatch) || !JS_IsFunction(h->ctx, h->fn_ondata) ||
        !JS_IsFunction(h->ctx, h->fn_onclosed) || !JS_IsFunction(h->ctx, h->fn_firetimer)) {
        h->init_error = xstrdup("bundle did not register __niim entry points");
        return -1;
    }
    run_jobs(h);
    return 0;
}

static void js_shutdown(niim_t *h) {
    if (h->ctx) {
        JS_FreeValue(h->ctx, h->fn_dispatch);
        JS_FreeValue(h->ctx, h->fn_ondata);
        JS_FreeValue(h->ctx, h->fn_onclosed);
        JS_FreeValue(h->ctx, h->fn_firetimer);
        JS_FreeContext(h->ctx);
        h->ctx = NULL;
    }
    if (h->rt) {
        JS_FreeRuntime(h->rt);
        h->rt = NULL;
    }
}

static void dispatch_req(niim_t *h, req_t *r) {
    JSValue argv[4], ret;
    int argc = 3;

    if (r->kind == REQ_CLOSE_TRANSPORT) {
        transport_close(h);
        req_complete(h, r, NIIM_OK, xstrdup("true"));
        return;
    }

    r->next = h->inflight;
    h->inflight = r;

    argv[0] = JS_NewUint32(h->ctx, r->id);
    argv[1] = JS_NewString(h->ctx, r->method);
    argv[2] = JS_NewString(h->ctx, r->params ? r->params : "");
    if (r->has_bin) {
        argv[3] = JS_NewArrayBufferCopy(h->ctx, r->bin ? r->bin : (const uint8_t *)"", r->bin_len);
        argc = 4;
        free(r->bin); /* JS has its own copy now */
        r->bin = NULL;
    }

    ret = JS_Call(h->ctx, h->fn_dispatch, JS_UNDEFINED, argc, argv);
    if (JS_IsException(ret)) {
        req_t **pp;
        char *e = take_exception(h->ctx);
        for (pp = &h->inflight; *pp; pp = &(*pp)->next) {
            if (*pp == r) { *pp = r->next; break; }
        }
        req_complete(h, r, NIIM_E_JS, e);
    }
    JS_FreeValue(h->ctx, ret);
    while (argc--) JS_FreeValue(h->ctx, argv[argc]);
}

static void call_js_void(niim_t *h, JSValueConst fn, int argc, JSValue *argv, const char *where) {
    JSValue ret = JS_Call(h->ctx, fn, JS_UNDEFINED, argc, argv);
    if (JS_IsException(ret)) log_exception(h, where);
    JS_FreeValue(h->ctx, ret);
    while (argc--) JS_FreeValue(h->ctx, argv[argc]);
}

static void fire_due_timers(niim_t *h) {
    int64_t now = plat_now_ms();
    uint32_t due[64];
    size_t n = 0, i = 0;

    while (i < h->ntimers && n < 64) {
        if (h->timers[i].due <= now) {
            due[n++] = h->timers[i].id;
            h->timers[i] = h->timers[h->ntimers - 1];
            h->ntimers--;
        } else {
            i++;
        }
    }
    for (i = 0; i < n; i++) {
        JSValue arg = JS_NewUint32(h->ctx, due[i]);
        call_js_void(h, h->fn_firetimer, 1, &arg, "timer");
        run_jobs(h);
    }
}

static int64_t next_timer_wait(niim_t *h) {
    int64_t now = plat_now_ms(), best = -1;
    size_t i;
    for (i = 0; i < h->ntimers; i++) {
        int64_t w = h->timers[i].due - now;
        if (w < 0) w = 0;
        if (best < 0 || w < best) best = w;
    }
    return best;
}

static void *worker_main(void *arg) {
    niim_t *h = (niim_t *)arg;
    int ok = js_init(h) == 0;

    plat_mutex_lock(&h->mu);
    h->thread_id = plat_thread_self();
    h->ready = ok ? 1 : -1;
    plat_cond_broadcast(&h->done_cv);
    plat_mutex_unlock(&h->mu);

    while (ok) {
        req_t *reqs;
        chunk_t *rx;
        int closed, stopping;

        plat_mutex_lock(&h->mu);
        for (;;) {
            int64_t wait;
            if (h->stopping || h->q_head || h->rx_head || h->rx_closed) break;
            wait = next_timer_wait(h);
            if (wait == 0) break;
            /* cap the wait: cond_timedwait uses the wall clock on POSIX */
            if (wait < 0 || wait > 1000) wait = 1000;
            plat_cond_timedwait(&h->loop_cv, &h->mu, wait);
        }
        stopping = h->stopping;
        reqs = h->q_head;
        h->q_head = h->q_tail = NULL;
        rx = h->rx_head;
        h->rx_head = h->rx_tail = NULL;
        closed = h->rx_closed;
        h->rx_closed = 0;
        plat_mutex_unlock(&h->mu);

        while (rx) {
            chunk_t *next = rx->next;
            JSValue u8 = JS_NewUint8ArrayCopy(h->ctx, rx->data, rx->len);
            call_js_void(h, h->fn_ondata, 1, &u8, "onData");
            free(rx);
            rx = next;
            run_jobs(h);
        }

        if (closed) {
            transport_close(h);
            call_js_void(h, h->fn_onclosed, 0, NULL, "onClosed");
            run_jobs(h);
        }

        while (reqs) {
            req_t *next = reqs->next;
            reqs->next = NULL;
            if (stopping) req_complete(h, reqs, NIIM_E_CLOSED, xstrdup("handle is shutting down"));
            else dispatch_req(h, reqs);
            reqs = next;
            run_jobs(h);
        }

        fire_due_timers(h);
        run_jobs(h);

        if (stopping) break;
    }

    /* Fail whatever is still in flight */
    while (h->inflight) {
        req_t *r = h->inflight;
        h->inflight = r->next;
        r->next = NULL;
        req_complete(h, r, NIIM_E_CLOSED, xstrdup("handle is shutting down"));
    }
    transport_close(h);
    js_shutdown(h);
    return NULL;
}

/* ------------------------------------------------------------------------ */
/* Request plumbing (API side)                                              */
/* ------------------------------------------------------------------------ */

static int in_worker(niim_t *h) {
    int r;
    plat_mutex_lock(&h->mu);
    r = h->ready == 1 && plat_thread_equal(h->thread_id, plat_thread_self());
    plat_mutex_unlock(&h->mu);
    return r;
}

/* Submit a request and wait for it. Takes ownership of method/params/bin. */
static int submit(niim_t *h, req_kind_t kind, char *method, char *params, uint8_t *bin, size_t bin_len, int has_bin,
                  char **out) {
    req_t *r;
    int code;

    if (in_worker(h)) {
        free(method);
        free(params);
        free(bin);
        return fail(out, NIIM_E_REENTRANT, "niim_* functions cannot be called from the event callback");
    }

    r = (req_t *)calloc(1, sizeof(req_t));
    if (!r) {
        free(method);
        free(params);
        free(bin);
        return fail(out, NIIM_E_NOMEM, "out of memory");
    }
    r->kind = kind;
    r->method = method;
    r->params = params;
    r->bin = bin;
    r->bin_len = bin_len;
    r->has_bin = has_bin;

    plat_mutex_lock(&h->mu);
    if (h->stopping) {
        plat_mutex_unlock(&h->mu);
        req_free(r);
        return fail(out, NIIM_E_CLOSED, "handle is shutting down");
    }
    r->id = ++h->next_req_id;
    if (h->q_tail) h->q_tail->next = r;
    else h->q_head = r;
    h->q_tail = r;
    plat_cond_broadcast(&h->loop_cv);
    while (!r->done) plat_cond_wait(&h->done_cv, &h->mu);
    plat_mutex_unlock(&h->mu);

    code = r->code;
    set_out(out, r->result);
    r->result = NULL;
    req_free(r);
    return code;
}

static int call_js(niim_t *h, const char *method, char *params_owned, char **out) {
    char *m = xstrdup(method);
    if (!m) {
        free(params_owned);
        return fail(out, NIIM_E_NOMEM, "out of memory");
    }
    return submit(h, REQ_JS, m, params_owned, NULL, 0, 0, out);
}

static void close_transport_sync(niim_t *h) { submit(h, REQ_CLOSE_TRANSPORT, NULL, NULL, NULL, 0, 0, NULL); }

/* {"transport":"<t>", <extra>, "options":<opts>} */
static char *connect_params(const char *transport, const char *hexdump, const char *options_json) {
    sbuf_t b = {0};
    sb_puts(&b, "{\"transport\":");
    sb_json_str(&b, transport);
    if (hexdump) {
        sb_puts(&b, ",\"hexdump\":");
        sb_json_str(&b, hexdump);
    }
    sb_puts(&b, ",\"options\":");
    sb_puts(&b, options_json && *options_json ? options_json : "null");
    sb_putc(&b, '}');
    return sb_take(&b);
}

static int do_connect(niim_t *h, char *params, char **out) {
    int rc;
    if (!params) return fail(out, NIIM_E_NOMEM, "out of memory");
    rc = call_js(h, "connect", params, out);
    if (rc != NIIM_OK) close_transport_sync(h);
    return rc;
}

/* ------------------------------------------------------------------------ */
/* Public API                                                               */
/* ------------------------------------------------------------------------ */

NIIM_API const char *niim_version(void) { return NIIM_LIB_VERSION; }

NIIM_API const char *niim_niimbluelib_version(void) { return niim_bundle_version; }

NIIM_API void niim_string_free(char *s) { free(s); }

NIIM_API char *niim_list_serial_ports(void) { return serial_list_ports_json(); }

NIIM_API niim_t *niim_new(char **out) {
    niim_t *h = (niim_t *)calloc(1, sizeof(niim_t));
    if (!h) {
        fail(out, NIIM_E_NOMEM, "out of memory");
        return NULL;
    }
    plat_mutex_init(&h->mu);
    plat_cond_init(&h->loop_cv);
    plat_cond_init(&h->done_cv);

    if (plat_thread_create(&h->thread, worker_main, h) != 0) {
        fail(out, NIIM_E_INIT, "cannot create worker thread");
        plat_cond_destroy(&h->loop_cv);
        plat_cond_destroy(&h->done_cv);
        plat_mutex_destroy(&h->mu);
        free(h);
        return NULL;
    }

    plat_mutex_lock(&h->mu);
    while (h->ready == 0) plat_cond_wait(&h->done_cv, &h->mu);
    plat_mutex_unlock(&h->mu);

    if (h->ready < 0) {
        plat_thread_join(h->thread);
        set_out(out, h->init_error ? h->init_error : xstrdup("initialization failed"));
        h->init_error = NULL;
        js_shutdown(h);
        plat_cond_destroy(&h->loop_cv);
        plat_cond_destroy(&h->done_cv);
        plat_mutex_destroy(&h->mu);
        free(h);
        return NULL;
    }
    if (out) *out = NULL;
    return h;
}

NIIM_API void niim_free(niim_t *h) {
    if (!h) return;
    if (in_worker(h)) {
        emit_log(h, "error", "niim_free() called from the event callback, ignored");
        return;
    }
    niim_disconnect(h);

    plat_mutex_lock(&h->mu);
    h->stopping = 1;
    plat_cond_broadcast(&h->loop_cv);
    plat_mutex_unlock(&h->mu);
    plat_thread_join(h->thread);

    rx_flush_locked(h);
    free(h->timers);
    free(h->init_error);
    plat_cond_destroy(&h->loop_cv);
    plat_cond_destroy(&h->done_cv);
    plat_mutex_destroy(&h->mu);
    free(h);
}

NIIM_API void niim_set_event_callback(niim_t *h, niim_event_cb cb, void *user) {
    if (!h) return;
    plat_mutex_lock(&h->mu);
    h->event_cb = cb;
    h->event_user = user;
    plat_mutex_unlock(&h->mu);
}

NIIM_API int niim_call(niim_t *h, const char *method, const char *params_json, char **out) {
    char *p;
    if (!h || !method) return fail(out, NIIM_E_INVALID_ARG, "invalid argument");
    p = xstrdup(params_json && *params_json ? params_json : "{}");
    if (!p) return fail(out, NIIM_E_NOMEM, "out of memory");
    if (!strcmp(method, "connect")) {
        /* JS-only transports ("virtual", "png"): close the previous connection and
         * its native transport first, like the niim_connect_* functions */
        if (in_worker(h)) {
            free(p);
            return fail(out, NIIM_E_REENTRANT, "niim_* functions cannot be called from the event callback");
        }
        niim_disconnect(h);
        return do_connect(h, p, out);
    }
    return call_js(h, method, p, out);
}

NIIM_API int niim_call_bin(niim_t *h, const char *method, const char *params_json, const uint8_t *data, size_t len,
                           char **out) {
    char *p, *m;
    uint8_t *copy = NULL;
    if (!h || !method || (len > 0 && !data)) return fail(out, NIIM_E_INVALID_ARG, "invalid argument");
    if (!data || !strcmp(method, "connect")) return niim_call(h, method, params_json, out);
    p = xstrdup(params_json && *params_json ? params_json : "{}");
    m = xstrdup(method);
    copy = (uint8_t *)malloc(len > 0 ? len : 1);
    if (!p || !m || !copy) {
        free(p);
        free(m);
        free(copy);
        return fail(out, NIIM_E_NOMEM, "out of memory");
    }
    if (len > 0) memcpy(copy, data, len);
    return submit(h, REQ_JS, m, p, copy, len, 1, out);
}

NIIM_API int niim_disconnect(niim_t *h) {
    int rc;
    if (!h) return NIIM_E_INVALID_ARG;
    rc = call_js(h, "disconnect", xstrdup("{}"), NULL);
    close_transport_sync(h);
    return rc;
}

NIIM_API int niim_connect_serial(niim_t *h, const char *port, const char *options_json, char **out) {
    char err[512];
    serial_port_t *p;
    int rc;

    if (!h || !port || !*port) return fail(out, NIIM_E_INVALID_ARG, "invalid argument");
    if (in_worker(h)) return fail(out, NIIM_E_REENTRANT, "niim_* functions cannot be called from the event callback");

    niim_disconnect(h);

    p = serial_open(port, err, sizeof(err));
    if (!p) return fail(out, NIIM_E_TRANSPORT, err);

    plat_mutex_lock(&h->mu);
    h->tr = TR_SERIAL;
    h->serial = p;
    rx_flush_locked(h);
    rc = plat_thread_create(&h->reader, reader_main, h);
    h->reader_running = rc == 0;
    plat_mutex_unlock(&h->mu);

    if (rc != 0) {
        close_transport_sync(h);
        return fail(out, NIIM_E_TRANSPORT, "cannot create serial reader thread");
    }
    return do_connect(h, connect_params("native", NULL, options_json), out);
}

NIIM_API int niim_connect_custom(niim_t *h, niim_write_cb write, void *user, const char *options_json, char **out) {
    if (!h || !write) return fail(out, NIIM_E_INVALID_ARG, "invalid argument");
    if (in_worker(h)) return fail(out, NIIM_E_REENTRANT, "niim_* functions cannot be called from the event callback");

    niim_disconnect(h);

    plat_mutex_lock(&h->mu);
    h->tr = TR_CUSTOM;
    h->write_cb = write;
    h->write_user = user;
    rx_flush_locked(h);
    plat_mutex_unlock(&h->mu);

    return do_connect(h, connect_params("native", NULL, options_json), out);
}

NIIM_API int niim_connect_virtual(niim_t *h, const char *hexdump, const char *options_json, char **out) {
    if (!h || !hexdump) return fail(out, NIIM_E_INVALID_ARG, "invalid argument");
    if (in_worker(h)) return fail(out, NIIM_E_REENTRANT, "niim_* functions cannot be called from the event callback");
    niim_disconnect(h);
    return do_connect(h, connect_params("virtual", hexdump, options_json), out);
}

NIIM_API int niim_connect_png(niim_t *h, const char *options_json, char **out) {
    if (!h) return fail(out, NIIM_E_INVALID_ARG, "invalid argument");
    if (in_worker(h)) return fail(out, NIIM_E_REENTRANT, "niim_* functions cannot be called from the event callback");
    niim_disconnect(h);
    return do_connect(h, connect_params("png", NULL, options_json), out);
}

NIIM_API void niim_feed(niim_t *h, const uint8_t *data, size_t len) {
    chunk_t *c;
    if (!h || !data || len == 0) return;
    c = (chunk_t *)malloc(sizeof(chunk_t) + len);
    if (!c) return;
    c->next = NULL;
    c->len = len;
    memcpy(c->data, data, len);

    plat_mutex_lock(&h->mu);
    if (h->tr != TR_CUSTOM) {
        plat_mutex_unlock(&h->mu);
        free(c);
        return;
    }
    if (h->rx_tail) h->rx_tail->next = c;
    else h->rx_head = c;
    h->rx_tail = c;
    plat_cond_broadcast(&h->loop_cv);
    plat_mutex_unlock(&h->mu);
}

NIIM_API void niim_transport_closed(niim_t *h) {
    if (!h) return;
    plat_mutex_lock(&h->mu);
    if (h->tr == TR_CUSTOM) {
        h->rx_closed = 1;
        plat_cond_broadcast(&h->loop_cv);
    }
    plat_mutex_unlock(&h->mu);
}

/* {"data":<data>,"options":<opts>} plus the .niim package as binary payload; missing parts become null */
static int template_call(niim_t *h, const char *method, const uint8_t *package, size_t package_len,
                         const char *data_json, const char *options_json, char **out) {
    sbuf_t b = {0};
    char *params, *m;
    uint8_t *copy;

    if (!h || !package || package_len == 0) return fail(out, NIIM_E_INVALID_ARG, "invalid argument");

    sb_puts(&b, "{\"data\":");
    sb_puts(&b, data_json && *data_json ? data_json : "null");
    sb_puts(&b, ",\"options\":");
    sb_puts(&b, options_json && *options_json ? options_json : "null");
    sb_putc(&b, '}');
    params = sb_take(&b);

    copy = (uint8_t *)malloc(package_len);
    m = xstrdup(method);
    if (!params || !copy || !m) {
        free(params);
        free(copy);
        free(m);
        return fail(out, NIIM_E_NOMEM, "out of memory");
    }
    memcpy(copy, package, package_len);
    return submit(h, REQ_JS, m, params, copy, package_len, 1, out);
}

NIIM_API int niim_render_template(niim_t *h, const uint8_t *package, size_t package_len, const char *data_json,
                                  const char *options_json, char **out) {
    return template_call(h, "renderTemplate", package, package_len, data_json, options_json, out);
}

NIIM_API int niim_print_template(niim_t *h, const uint8_t *package, size_t package_len, const char *data_json,
                                 const char *options_json, char **out) {
    return template_call(h, "printTemplate", package, package_len, data_json, options_json, out);
}

NIIM_API int niim_register_font(niim_t *h, const char *family, int weight, int italic, const uint8_t *data,
                                size_t len, char **out) {
    sbuf_t b = {0};
    char tmp[64];
    char *params, *m;
    uint8_t *copy;

    if (!h || !family || !*family || !data || len == 0) return fail(out, NIIM_E_INVALID_ARG, "invalid argument");

    sb_puts(&b, "{\"family\":");
    sb_json_str(&b, family);
    snprintf(tmp, sizeof(tmp), ",\"weight\":%d,\"italic\":%s}", weight > 0 ? weight : 400, italic ? "true" : "false");
    sb_puts(&b, tmp);
    params = sb_take(&b);

    copy = (uint8_t *)malloc(len);
    m = xstrdup("registerFont");
    if (!params || !copy || !m) {
        free(params);
        free(copy);
        free(m);
        return fail(out, NIIM_E_NOMEM, "out of memory");
    }
    memcpy(copy, data, len);
    return submit(h, REQ_JS, m, params, copy, len, 1, out);
}

NIIM_API int niim_print(niim_t *h, const uint8_t *pixels, size_t pixels_len, uint32_t width, uint32_t height,
                        const char *options_json, char **out) {
    sbuf_t b = {0};
    char tmp[64];
    char *params, *m;
    uint8_t *copy;

    if (!h || !pixels || pixels_len == 0 || width == 0 || height == 0)
        return fail(out, NIIM_E_INVALID_ARG, "invalid argument");

    snprintf(tmp, sizeof(tmp), "{\"width\":%u,\"height\":%u,\"options\":", width, height);
    sb_puts(&b, tmp);
    sb_puts(&b, options_json && *options_json ? options_json : "null");
    sb_putc(&b, '}');
    params = sb_take(&b);

    copy = (uint8_t *)malloc(pixels_len);
    m = xstrdup("print");
    if (!params || !copy || !m) {
        free(params);
        free(copy);
        free(m);
        return fail(out, NIIM_E_NOMEM, "out of memory");
    }
    memcpy(copy, pixels, pixels_len);
    return submit(h, REQ_JS, m, params, copy, pixels_len, 1, out);
}

NIIM_API int niim_print_batch(niim_t *h, const niim_image_t *images, size_t count, const char *options_json,
                              char **out) {
    sbuf_t b = {0};
    char tmp[128];
    char *params, *m;
    uint8_t *blob;
    size_t total = 0, offset = 0, i;

    if (!h || !images || count == 0) return fail(out, NIIM_E_INVALID_ARG, "invalid argument");

    for (i = 0; i < count; i++) {
        const niim_image_t *img = &images[i];
        if (!img->pixels || img->len == 0 || img->width == 0 || img->height == 0) {
            snprintf(tmp, sizeof(tmp), "invalid argument: page %u", (unsigned)(i + 1));
            return fail(out, NIIM_E_INVALID_ARG, tmp);
        }
        if (img->len > SIZE_MAX - total) return fail(out, NIIM_E_NOMEM, "pixel data too large");
        total += img->len;
    }

    /* {"options":<job opts>,"pages":[{"width","height","offset","length","options"},...]} */
    sb_puts(&b, "{\"options\":");
    sb_puts(&b, options_json && *options_json ? options_json : "null");
    sb_puts(&b, ",\"pages\":[");
    for (i = 0; i < count; i++) {
        const niim_image_t *img = &images[i];
        snprintf(tmp, sizeof(tmp), "%s{\"width\":%u,\"height\":%u,\"offset\":%llu,\"length\":%llu,\"options\":",
                 i ? "," : "", img->width, img->height, (unsigned long long)offset, (unsigned long long)img->len);
        sb_puts(&b, tmp);
        sb_puts(&b, img->options_json && *img->options_json ? img->options_json : "null");
        sb_putc(&b, '}');
        offset += img->len;
    }
    sb_puts(&b, "]}");
    params = sb_take(&b);

    blob = (uint8_t *)malloc(total);
    m = xstrdup("printBatch");
    if (!params || !blob || !m) {
        free(params);
        free(blob);
        free(m);
        return fail(out, NIIM_E_NOMEM, "out of memory");
    }
    for (i = 0, offset = 0; i < count; i++) {
        memcpy(blob + offset, images[i].pixels, images[i].len);
        offset += images[i].len;
    }
    return submit(h, REQ_JS, m, params, blob, total, 1, out);
}
