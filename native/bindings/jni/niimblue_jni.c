/*
 * JNI layer for the Kotlin / Java bindings (bindings/kotlin).
 *
 * One C file for every JVM: desktop (built by CMake with NIIM_BUILD_JNI=ON)
 * and Android (built by the NDK through bindings/kotlin/niimblue-android-native).
 * The native methods are registered on io.github.multimote.niimblue.NiimNative in
 * JNI_OnLoad, so nothing depends on JNI name mangling.
 *
 * Strings: Java strings are converted from / to real UTF-8 by hand. JNI's
 * "modified UTF-8" (GetStringUTFChars / NewStringUTF) encodes characters
 * outside the BMP (emoji) differently and would corrupt template text.
 *
 * Callbacks (events, custom transport writes) arrive on the library's worker
 * thread. It is attached to the JVM on first use and detached when the thread
 * exits (Android aborts if a native thread exits while still attached).
 */
#include <jni.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "niimblue.h"
#include "plat.h"

#define CLS_NATIVE "io/github/multimote/niimblue/NiimNative"
#define CLS_EXCEPTION "io/github/multimote/niimblue/NiimException"
#define CLS_LISTENER "io/github/multimote/niimblue/NiimEventListener"
#define CLS_TRANSPORT "io/github/multimote/niimblue/NiimTransport"

static JavaVM *g_vm;
static jclass g_exception_cls;
static jmethodID g_exception_ctor; /* (ILjava/lang/String;)V */
static jmethodID g_on_event;       /* NiimEventListener.onEvent(String, String) */
static jmethodID g_write;          /* NiimTransport.write(byte[]): boolean */

/* ------------------------------------------------------------------------ */
/* Thread attach / detach                                                   */
/* ------------------------------------------------------------------------ */

#ifdef _WIN32
static DWORD g_tls = FLS_OUT_OF_INDEXES;
static void WINAPI detach_thread(void *p) {
    if (p && g_vm) (*g_vm)->DetachCurrentThread(g_vm);
}
static int tls_init(void) {
    g_tls = FlsAlloc(detach_thread);
    return g_tls == FLS_OUT_OF_INDEXES ? -1 : 0;
}
static void tls_mark_attached(void) { FlsSetValue(g_tls, (void *)1); }
#else
static pthread_key_t g_tls;
static void detach_thread(void *p) {
    if (p && g_vm) (*g_vm)->DetachCurrentThread(g_vm);
}
static int tls_init(void) { return pthread_key_create(&g_tls, detach_thread); }
static void tls_mark_attached(void) { pthread_setspecific(g_tls, (void *)1); }
#endif

/* JNIEnv for the current thread, attaching it (as a daemon) if needed. */
static JNIEnv *thread_env(void) {
    JNIEnv *env = NULL;
    JavaVMAttachArgs args;
    if ((*g_vm)->GetEnv(g_vm, (void **)&env, JNI_VERSION_1_6) == JNI_OK) return env;
    args.version = JNI_VERSION_1_6;
    args.name = (char *)"niimblue";
    args.group = NULL;
#ifdef __ANDROID__
    if ((*g_vm)->AttachCurrentThreadAsDaemon(g_vm, &env, &args) != JNI_OK) return NULL;
#else
    if ((*g_vm)->AttachCurrentThreadAsDaemon(g_vm, (void **)&env, &args) != JNI_OK) return NULL;
#endif
    tls_mark_attached();
    return env;
}

/* ------------------------------------------------------------------------ */
/* Strings: Java (UTF-16) <-> UTF-8                                         */
/* ------------------------------------------------------------------------ */

static void throw_niim(JNIEnv *env, int code, const char *msg);

/* Java string -> malloc'd UTF-8 (NULL for a null string). Sets *err on failure
 * (and throws). Unpaired surrogates become U+FFFD; NUL characters are rejected
 * because the C API takes NUL-terminated strings. */
static char *to_utf8(JNIEnv *env, jstring s, int *err) {
    jsize n, i;
    const jchar *u;
    char *out, *o;
    if (!s) return NULL;
    n = (*env)->GetStringLength(env, s);
    u = (*env)->GetStringChars(env, s, NULL);
    if (!u) {
        *err = 1;
        return NULL;
    }
    out = (char *)malloc((size_t)n * 3 + 1);
    if (!out) {
        (*env)->ReleaseStringChars(env, s, u);
        throw_niim(env, NIIM_E_NOMEM, "out of memory");
        *err = 1;
        return NULL;
    }
    o = out;
    for (i = 0; i < n; i++) {
        uint32_t c = u[i];
        if (c == 0) {
            (*env)->ReleaseStringChars(env, s, u);
            free(out);
            throw_niim(env, NIIM_E_INVALID_ARG, "string contains a NUL character");
            *err = 1;
            return NULL;
        }
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < n && u[i + 1] >= 0xDC00 && u[i + 1] <= 0xDFFF) {
            c = 0x10000 + ((c - 0xD800) << 10) + (u[i + 1] - 0xDC00);
            i++;
        } else if (c >= 0xD800 && c <= 0xDFFF) {
            c = 0xFFFD;
        }
        if (c < 0x80) {
            *o++ = (char)c;
        } else if (c < 0x800) {
            *o++ = (char)(0xC0 | (c >> 6));
            *o++ = (char)(0x80 | (c & 0x3F));
        } else if (c < 0x10000) {
            *o++ = (char)(0xE0 | (c >> 12));
            *o++ = (char)(0x80 | ((c >> 6) & 0x3F));
            *o++ = (char)(0x80 | (c & 0x3F));
        } else {
            *o++ = (char)(0xF0 | (c >> 18));
            *o++ = (char)(0x80 | ((c >> 12) & 0x3F));
            *o++ = (char)(0x80 | ((c >> 6) & 0x3F));
            *o++ = (char)(0x80 | (c & 0x3F));
        }
    }
    *o = 0;
    (*env)->ReleaseStringChars(env, s, u);
    return out;
}

/* UTF-8 -> Java string. Invalid sequences become U+FFFD. */
static jstring from_utf8(JNIEnv *env, const char *s) {
    const unsigned char *p = (const unsigned char *)(s ? s : "");
    size_t len = strlen((const char *)p), n = 0;
    jchar small[256], *buf = small;
    jstring r;
    if (len + 1 > sizeof(small) / sizeof(small[0])) {
        buf = (jchar *)malloc((len + 1) * sizeof(jchar)); /* UTF-16 units <= UTF-8 bytes */
        if (!buf) return NULL;
    }
    while (*p) {
        uint32_t c = *p, min;
        int extra;
        if (c < 0x80) {
            buf[n++] = (jchar)c;
            p++;
            continue;
        }
        if ((c & 0xE0) == 0xC0) extra = 1, c &= 0x1F, min = 0x80;
        else if ((c & 0xF0) == 0xE0) extra = 2, c &= 0x0F, min = 0x800;
        else if ((c & 0xF8) == 0xF0) extra = 3, c &= 0x07, min = 0x10000;
        else {
            buf[n++] = 0xFFFD;
            p++;
            continue;
        }
        p++;
        while (extra > 0 && (*p & 0xC0) == 0x80) {
            c = (c << 6) | (*p++ & 0x3F);
            extra--;
        }
        if (extra > 0 || c < min || c > 0x10FFFF || (c >= 0xD800 && c <= 0xDFFF)) {
            buf[n++] = 0xFFFD;
        } else if (c >= 0x10000) {
            c -= 0x10000;
            buf[n++] = (jchar)(0xD800 + (c >> 10));
            buf[n++] = (jchar)(0xDC00 + (c & 0x3FF));
        } else {
            buf[n++] = (jchar)c;
        }
    }
    r = (*env)->NewString(env, buf, (jsize)n);
    if (buf != small) free(buf);
    return r;
}

static void throw_niim(JNIEnv *env, int code, const char *msg) {
    jstring m;
    jthrowable ex;
    if ((*env)->ExceptionCheck(env)) return;
    m = from_utf8(env, msg ? msg : "unknown error");
    if (!m) return;
    ex = (jthrowable)(*env)->NewObject(env, g_exception_cls, g_exception_ctor, (jint)code, m);
    if (ex) (*env)->Throw(env, ex);
}

/* Return the JSON result or throw NiimException. Frees `out`. */
static jstring finish(JNIEnv *env, int rc, char *out) {
    jstring r = NULL;
    if (rc == NIIM_OK) r = from_utf8(env, out ? out : "");
    else throw_niim(env, rc, out);
    niim_string_free(out);
    return r;
}

/* Copy a Java byte array into malloc'd memory (*len receives its length). */
static uint8_t *copy_bytes(JNIEnv *env, jbyteArray a, jint off, jint len, size_t *out_len) {
    uint8_t *buf;
    jsize n;
    if (!a) {
        throw_niim(env, NIIM_E_INVALID_ARG, "byte array is null");
        return NULL;
    }
    n = (*env)->GetArrayLength(env, a);
    if (off < 0 || len < 0 || off > n || len > n - off) {
        throw_niim(env, NIIM_E_INVALID_ARG, "byte range out of bounds");
        return NULL;
    }
    buf = (uint8_t *)malloc(len > 0 ? (size_t)len : 1);
    if (!buf) {
        throw_niim(env, NIIM_E_NOMEM, "out of memory");
        return NULL;
    }
    (*env)->GetByteArrayRegion(env, a, off, len, (jbyte *)buf);
    *out_len = (size_t)len;
    return buf;
}

/* ------------------------------------------------------------------------ */
/* Handle                                                                   */
/* ------------------------------------------------------------------------ */

/* The C callbacks always get this struct as `user`. It lives as long as the
 * handle, so a callback still running after the listener / writer changed
 * never sees freed memory; it holds its own local reference to the object. */
typedef struct {
    niim_t *h;
    plat_mutex_t mu;
    jobject listener; /* global ref or NULL */
    jobject writer;   /* global ref or NULL */
} jhandle_t;

static jhandle_t *H(JNIEnv *env, jlong p) {
    jhandle_t *j = (jhandle_t *)(intptr_t)p;
    if (!j) throw_niim(env, NIIM_E_CLOSED, "printer is closed");
    return j;
}

/* Take a local reference to a slot's object under the lock. */
static jobject slot_get(JNIEnv *env, jhandle_t *j, jobject *slot) {
    jobject r = NULL;
    plat_mutex_lock(&j->mu);
    if (*slot) r = (*env)->NewLocalRef(env, *slot);
    plat_mutex_unlock(&j->mu);
    return r;
}

/* Replace a slot's object (obj may be NULL). */
static void slot_set(JNIEnv *env, jhandle_t *j, jobject *slot, jobject obj) {
    jobject ref = obj ? (*env)->NewGlobalRef(env, obj) : NULL, old;
    plat_mutex_lock(&j->mu);
    old = *slot;
    *slot = ref;
    plat_mutex_unlock(&j->mu);
    if (old) (*env)->DeleteGlobalRef(env, old);
}

static void on_event(void *user, const char *name, const char *json) {
    jhandle_t *j = (jhandle_t *)user;
    JNIEnv *env;
    jobject l;
    if (!j->listener) return; /* racy peek, only to skip attaching when nobody listens */
    env = thread_env();
    if (!env || (*env)->PushLocalFrame(env, 8) != JNI_OK) return;
    l = slot_get(env, j, &j->listener);
    if (l) {
        jstring n = from_utf8(env, name), d = from_utf8(env, json);
        if (n && d) (*env)->CallVoidMethod(env, l, g_on_event, n, d);
        if ((*env)->ExceptionCheck(env)) {
            (*env)->ExceptionDescribe(env); /* a throwing listener must not break the library */
            (*env)->ExceptionClear(env);
        }
    }
    (*env)->PopLocalFrame(env, NULL);
}

static int on_write(void *user, const uint8_t *data, size_t len) {
    jhandle_t *j = (jhandle_t *)user;
    JNIEnv *env = thread_env();
    jobject w;
    int rc = 1;
    if (!env || (*env)->PushLocalFrame(env, 8) != JNI_OK) return 1;
    w = slot_get(env, j, &j->writer);
    if (w) {
        jbyteArray a = (*env)->NewByteArray(env, (jsize)len);
        if (a) {
            (*env)->SetByteArrayRegion(env, a, 0, (jsize)len, (const jbyte *)data);
            if ((*env)->CallBooleanMethod(env, w, g_write, a)) rc = 0;
        }
        if ((*env)->ExceptionCheck(env)) {
            (*env)->ExceptionDescribe(env);
            (*env)->ExceptionClear(env);
            rc = 1;
        }
    }
    (*env)->PopLocalFrame(env, NULL);
    return rc;
}

/* ------------------------------------------------------------------------ */
/* Native methods (io.github.multimote.niimblue.NiimNative)                       */
/* ------------------------------------------------------------------------ */

static jstring n_version(JNIEnv *env, jclass c) { return from_utf8(env, niim_version()); }

static jstring n_niimbluelib_version(JNIEnv *env, jclass c) { return from_utf8(env, niim_niimbluelib_version()); }

static jstring n_list_serial_ports(JNIEnv *env, jclass c) {
    char *s = niim_list_serial_ports();
    jstring r = from_utf8(env, s ? s : "[]");
    niim_string_free(s);
    return r;
}

static jlong n_create(JNIEnv *env, jclass c) {
    char *out = NULL;
    jhandle_t *j = (jhandle_t *)calloc(1, sizeof(*j));
    if (!j) {
        throw_niim(env, NIIM_E_NOMEM, "out of memory");
        return 0;
    }
    j->h = niim_new(&out);
    if (!j->h) {
        throw_niim(env, NIIM_E_INIT, out ? out : "niim_new failed");
        niim_string_free(out);
        free(j);
        return 0;
    }
    niim_string_free(out);
    plat_mutex_init(&j->mu);
    niim_set_event_callback(j->h, on_event, j); /* installed once, for the handle's lifetime */
    return (jlong)(intptr_t)j;
}

static void n_destroy(JNIEnv *env, jclass c, jlong p) {
    jhandle_t *j = (jhandle_t *)(intptr_t)p;
    if (!j) return;
    niim_free(j->h); /* stops the worker: no callbacks after this */
    if (j->listener) (*env)->DeleteGlobalRef(env, j->listener);
    if (j->writer) (*env)->DeleteGlobalRef(env, j->writer);
    plat_mutex_destroy(&j->mu);
    free(j);
}

static void n_set_event_listener(JNIEnv *env, jclass c, jlong p, jobject listener) {
    jhandle_t *j = H(env, p);
    if (j) slot_set(env, j, &j->listener, listener);
}

/* Shared shape of the (handle, string, string) -> JSON calls. */
typedef int (*call2_fn)(niim_t *h, const char *a, const char *b, char **out);

static jstring call2(JNIEnv *env, jlong p, jstring a, jstring b, call2_fn fn) {
    jhandle_t *j = H(env, p);
    int err = 0, rc;
    char *sa, *sb, *out = NULL;
    if (!j) return NULL;
    sa = to_utf8(env, a, &err);
    sb = err ? NULL : to_utf8(env, b, &err);
    if (err) {
        free(sa);
        return NULL;
    }
    rc = fn(j->h, sa, sb, &out);
    free(sa);
    free(sb);
    return finish(env, rc, out);
}

static jstring n_connect_serial(JNIEnv *env, jclass c, jlong p, jstring port, jstring opts) {
    if (!port) {
        throw_niim(env, NIIM_E_INVALID_ARG, "port is null");
        return NULL;
    }
    return call2(env, p, port, opts, niim_connect_serial);
}

static jstring n_call(JNIEnv *env, jclass c, jlong p, jstring method, jstring params) {
    if (!method) {
        throw_niim(env, NIIM_E_INVALID_ARG, "method is null");
        return NULL;
    }
    return call2(env, p, method, params, niim_call);
}

static jstring n_connect_custom(JNIEnv *env, jclass c, jlong p, jobject writer, jstring opts) {
    jhandle_t *j = H(env, p);
    int err = 0, rc;
    char *so, *out = NULL;
    if (!j) return NULL;
    if (!writer) {
        throw_niim(env, NIIM_E_INVALID_ARG, "transport is null");
        return NULL;
    }
    so = to_utf8(env, opts, &err);
    if (err) return NULL;
    /* Close the old transport while its writer is still installed, then swap. */
    niim_disconnect(j->h);
    slot_set(env, j, &j->writer, writer);
    rc = niim_connect_custom(j->h, on_write, j, so, &out);
    free(so);
    return finish(env, rc, out);
}

static void n_feed(JNIEnv *env, jclass c, jlong p, jbyteArray data, jint off, jint len) {
    jhandle_t *j = H(env, p);
    size_t n = 0;
    uint8_t *buf;
    if (!j) return;
    buf = copy_bytes(env, data, off, len, &n);
    if (!buf) return;
    niim_feed(j->h, buf, n);
    free(buf);
}

static void n_transport_closed(JNIEnv *env, jclass c, jlong p) {
    jhandle_t *j = H(env, p);
    if (j) niim_transport_closed(j->h);
}

static void n_disconnect(JNIEnv *env, jclass c, jlong p) {
    jhandle_t *j = H(env, p);
    int rc;
    if (!j) return;
    rc = niim_disconnect(j->h);
    if (rc != NIIM_OK) throw_niim(env, rc, "disconnect failed");
}

/* printBatch(handle, byte[][] pixels, int[] widths, int[] heights, String[] pageOptions, String options) */
/* niim_call_bin: data may be null (plain call). */
static jstring n_call_binary(JNIEnv *env, jclass c, jlong p, jstring method, jstring params, jbyteArray data) {
    jhandle_t *j = H(env, p);
    int err = 0, rc;
    size_t n = 0;
    uint8_t *buf = NULL;
    char *sm, *sp, *out = NULL;
    if (!j) return NULL;
    if (!method) {
        throw_niim(env, NIIM_E_INVALID_ARG, "method is null");
        return NULL;
    }
    if (data) {
        buf = copy_bytes(env, data, 0, (*env)->GetArrayLength(env, data), &n);
        if (!buf) return NULL;
    }
    sm = to_utf8(env, method, &err);
    sp = err ? NULL : to_utf8(env, params, &err);
    if (err) {
        free(buf);
        free(sm);
        return NULL;
    }
    rc = niim_call_bin(j->h, sm, sp, buf, n, &out);
    free(buf);
    free(sm);
    free(sp);
    return finish(env, rc, out);
}

#define STR "Ljava/lang/String;"

static const JNINativeMethod g_methods[] = {
    {"version", "()" STR, (void *)n_version},
    {"niimbluelibVersion", "()" STR, (void *)n_niimbluelib_version},
    {"listSerialPorts", "()" STR, (void *)n_list_serial_ports},
    {"create", "()J", (void *)n_create},
    {"destroy", "(J)V", (void *)n_destroy},
    {"setEventListener", "(JL" CLS_LISTENER ";)V", (void *)n_set_event_listener},
    {"connectSerial", "(J" STR STR ")" STR, (void *)n_connect_serial},
    {"connectCustom", "(JL" CLS_TRANSPORT ";" STR ")" STR, (void *)n_connect_custom},
    {"feed", "(J[BII)V", (void *)n_feed},
    {"transportClosed", "(J)V", (void *)n_transport_closed},
    {"disconnect", "(J)V", (void *)n_disconnect},
    {"callBinary", "(J" STR STR "[B)" STR, (void *)n_call_binary},
    {"call", "(J" STR STR ")" STR, (void *)n_call},
};

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved) {
    JNIEnv *env;
    jclass c;
    (void)reserved;
    g_vm = vm;
    if ((*vm)->GetEnv(vm, (void **)&env, JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
    if (tls_init() != 0) return JNI_ERR;

    c = (*env)->FindClass(env, CLS_EXCEPTION);
    if (!c) return JNI_ERR;
    g_exception_cls = (jclass)(*env)->NewGlobalRef(env, c);
    g_exception_ctor = (*env)->GetMethodID(env, c, "<init>", "(I" STR ")V");
    if (!g_exception_ctor) return JNI_ERR;

    c = (*env)->FindClass(env, CLS_LISTENER);
    if (!c || !(g_on_event = (*env)->GetMethodID(env, c, "onEvent", "(" STR STR ")V"))) return JNI_ERR;
    c = (*env)->FindClass(env, CLS_TRANSPORT);
    if (!c || !(g_write = (*env)->GetMethodID(env, c, "write", "([B)Z"))) return JNI_ERR;

    c = (*env)->FindClass(env, CLS_NATIVE);
    if (!c) return JNI_ERR;
    if ((*env)->RegisterNatives(env, c, g_methods, (jint)(sizeof(g_methods) / sizeof(g_methods[0]))) != 0)
        return JNI_ERR;
    return JNI_VERSION_1_6;
}
