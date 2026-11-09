/*
 * niim_cli - small command line tool on top of libniimblue.
 *
 *   niim_cli ports
 *   niim_cli info  <port>
 *   niim_cli print <port> <image.pgm|image.ppm> [print-options-json]
 *
 * Images: binary PGM (P5) or PPM (P6), 8 bit. Create one with ImageMagick:
 *   magick -size 384x240 xc:white -gravity center -pointsize 60 \
 *          -annotate 0 "Hello World" -depth 8 hello.pgm
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "niimblue.h"

static void on_event(void *user, const char *name, const char *json) {
    (void)user;
    if (!strcmp(name, "heartbeat")) return;
    fprintf(stderr, "event %-20s %s\n", name, json);
}

static int skip_ws_comments(FILE *f) {
    int c;
    for (;;) {
        c = fgetc(f);
        if (c == '#') {
            while (c != '\n' && c != EOF) c = fgetc(f);
        } else if (c != ' ' && c != '\t' && c != '\n' && c != '\r') {
            return c;
        }
    }
}

static int read_uint(FILE *f, unsigned *v) {
    int c = skip_ws_comments(f);
    *v = 0;
    if (c < '0' || c > '9') return -1;
    while (c >= '0' && c <= '9') {
        *v = *v * 10 + (unsigned)(c - '0');
        c = fgetc(f);
    }
    return 0;
}

/* Load P5/P6. Returns pixels, sets format to "gray" or "rgb". */
static uint8_t *load_pnm(const char *path, unsigned *w, unsigned *h, const char **format, size_t *len) {
    FILE *f = fopen(path, "rb");
    char magic[3] = {0};
    unsigned maxval, bpp;
    uint8_t *px;

    if (!f) { perror(path); return NULL; }
    if (fread(magic, 1, 2, f) != 2 || magic[0] != 'P' || (magic[1] != '5' && magic[1] != '6')) {
        fprintf(stderr, "%s: only binary PGM (P5) / PPM (P6) supported\n", path);
        fclose(f);
        return NULL;
    }
    if (read_uint(f, w) || read_uint(f, h) || read_uint(f, &maxval) || maxval != 255) {
        fprintf(stderr, "%s: bad header (need maxval 255)\n", path);
        fclose(f);
        return NULL;
    }
    bpp = magic[1] == '5' ? 1 : 3;
    *format = bpp == 1 ? "gray" : "rgb";
    *len = (size_t)(*w) * (*h) * bpp;
    px = (uint8_t *)malloc(*len);
    if (!px || fread(px, 1, *len, f) != *len) {
        fprintf(stderr, "%s: truncated image\n", path);
        free(px);
        fclose(f);
        return NULL;
    }
    fclose(f);
    return px;
}

static niim_t *open_printer(const char *port) {
    char *out = NULL;
    niim_t *h = niim_new(&out);
    int rc;
    if (!h) {
        fprintf(stderr, "init failed: %s\n", out);
        niim_string_free(out);
        return NULL;
    }
    niim_set_event_callback(h, on_event, NULL);
    rc = niim_connect_serial(h, port, "{\"heartbeat\":false}", &out);
    if (rc != NIIM_OK) {
        fprintf(stderr, "connect failed (%d): %s\n", rc, out);
        niim_string_free(out);
        niim_free(h);
        return NULL;
    }
    printf("%s\n", out);
    niim_string_free(out);
    return h;
}

int main(int argc, char **argv) {
    if (argc >= 2 && !strcmp(argv[1], "ports")) {
        char *p = niim_list_serial_ports();
        printf("%s\n", p);
        niim_string_free(p);
        return 0;
    }

    if (argc >= 3 && !strcmp(argv[1], "info")) {
        niim_t *h = open_printer(argv[2]);
        char *out = NULL;
        if (!h) return 1;
        if (niim_call(h, "fetchRfidInfo", NULL, &out) == NIIM_OK) printf("rfid: %s\n", out);
        niim_string_free(out);
        if (niim_call(h, "fetchHeartbeat", NULL, &out) == NIIM_OK) printf("heartbeat: %s\n", out);
        niim_string_free(out);
        niim_free(h);
        return 0;
    }

    if (argc >= 4 && !strcmp(argv[1], "print")) {
        unsigned w, hgt;
        const char *format;
        size_t len;
        char opts[1024], *out = NULL;
        uint8_t *px = load_pnm(argv[3], &w, &hgt, &format, &len);
        niim_t *h;
        int rc;

        if (!px) return 1;
        if (argc >= 5) {
            /* merge format into the user options: {"format":..., <user fields>} */
            const char *u = argv[4];
            while (*u == ' ') u++;
            if (*u != '{') { fprintf(stderr, "options must be a JSON object\n"); return 1; }
            u++;
            while (*u == ' ') u++;
            snprintf(opts, sizeof(opts), "{\"format\":\"%s\"%s%s", format, *u == '}' ? "" : ",", u);
        } else {
            snprintf(opts, sizeof(opts), "{\"format\":\"%s\"}", format);
        }

        h = open_printer(argv[2]);
        if (!h) { free(px); return 1; }
        printf("printing %ux%u %s image, options %s\n", w, hgt, format, opts);
        rc = niim_print(h, px, len, w, hgt, opts, &out);
        printf("print %s: %s\n", rc == NIIM_OK ? "ok" : "FAILED", out);
        niim_string_free(out);
        niim_free(h);
        free(px);
        return rc == NIIM_OK ? 0 : 1;
    }

    fprintf(stderr,
            "libniimblue %s (niimbluelib %s)\n"
            "usage:\n"
            "  %s ports\n"
            "  %s info  <port>\n"
            "  %s print <port> <image.pgm|ppm> ['{\"quantity\":1,\"density\":3}']\n",
            niim_version(), niim_niimbluelib_version(), argv[0], argv[0], argv[0]);
    return 2;
}
