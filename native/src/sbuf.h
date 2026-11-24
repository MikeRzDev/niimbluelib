/* Growable string buffer + JSON string escaping. */
#ifndef NIIM_SBUF_H
#define NIIM_SBUF_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { char *s; size_t len, cap; int oom; } sbuf_t;

static inline void sb_putn(sbuf_t *b, const char *s, size_t n) {
    if (b->oom) return;
    if (b->len + n + 1 > b->cap) {
        size_t ncap = b->cap ? b->cap : 128;
        char *ns;
        while (b->len + n + 1 > ncap) ncap *= 2;
        ns = (char *)realloc(b->s, ncap);
        if (!ns) { b->oom = 1; return; }
        b->s = ns;
        b->cap = ncap;
    }
    memcpy(b->s + b->len, s, n);
    b->len += n;
    b->s[b->len] = 0;
}
static inline void sb_putc(sbuf_t *b, char c) { sb_putn(b, &c, 1); }
static inline void sb_puts(sbuf_t *b, const char *s) { sb_putn(b, s, strlen(s)); }

/* Append `s` as a quoted JSON string. */
static inline void sb_json_str(sbuf_t *b, const char *s) {
    sb_putc(b, '"');
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        switch (c) {
        case '"': sb_puts(b, "\\\""); break;
        case '\\': sb_puts(b, "\\\\"); break;
        case '\n': sb_puts(b, "\\n"); break;
        case '\r': sb_puts(b, "\\r"); break;
        case '\t': sb_puts(b, "\\t"); break;
        default:
            if (c < 0x20) {
                char tmp[8];
                snprintf(tmp, sizeof(tmp), "\\u%04x", c);
                sb_puts(b, tmp);
            } else {
                sb_putc(b, (char)c);
            }
        }
    }
    sb_putc(b, '"');
}

/* Take ownership of the buffer (never NULL unless out of memory). */
static inline char *sb_take(sbuf_t *b) {
    char *s;
    if (b->oom) { free(b->s); return NULL; }
    if (!b->s) { s = (char *)malloc(1); if (s) s[0] = 0; return s; }
    s = b->s;
    b->s = NULL;
    b->len = b->cap = 0;
    return s;
}

#endif
