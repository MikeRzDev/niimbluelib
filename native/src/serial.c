#include "serial.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sbuf.h"

static int cmp_str(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

static char *names_to_json(char **names, size_t n) {
    sbuf_t b = {0};
    size_t i;
    qsort(names, n, sizeof(char *), cmp_str);
    sb_putc(&b, '[');
    for (i = 0; i < n; i++) {
        if (i) sb_putc(&b, ',');
        sb_json_str(&b, names[i]);
    }
    sb_putc(&b, ']');
    return sb_take(&b);
}

#ifdef _WIN32
/* ======================================================================= */
/* Windows                                                                 */
/* ======================================================================= */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

struct serial_port {
    HANDLE h;
    OVERLAPPED rov, wov, eov;
    volatile LONG interrupted;
};

static void win_err(char *err, size_t len, const char *what, const char *path) {
    char msg[256] = {0};
    FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, NULL, GetLastError(), 0, msg,
                   sizeof(msg) - 1, NULL);
    snprintf(err, len, "%s %s: %s", what, path, msg);
}

serial_port_t *serial_open(const char *path, char *err, size_t err_len) {
    char full[300];
    serial_port_t *p;
    DCB dcb;
    COMMTIMEOUTS to;

    if (strncmp(path, "\\\\.\\", 4) == 0) snprintf(full, sizeof(full), "%s", path);
    else snprintf(full, sizeof(full), "\\\\.\\%s", path);

    p = (serial_port_t *)calloc(1, sizeof(*p));
    if (!p) { snprintf(err, err_len, "out of memory"); return NULL; }

    p->h = CreateFileA(full, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
    if (p->h == INVALID_HANDLE_VALUE) { win_err(err, err_len, "cannot open", path); free(p); return NULL; }

    memset(&dcb, 0, sizeof(dcb));
    dcb.DCBlength = sizeof(dcb);
    if (!GetCommState(p->h, &dcb)) { win_err(err, err_len, "GetCommState", path); goto fail; }
    dcb.BaudRate = 115200;
    dcb.ByteSize = 8;
    dcb.Parity = NOPARITY;
    dcb.StopBits = ONESTOPBIT;
    dcb.fBinary = TRUE;
    dcb.fParity = FALSE;
    dcb.fOutxCtsFlow = FALSE;
    dcb.fOutxDsrFlow = FALSE;
    dcb.fDtrControl = DTR_CONTROL_ENABLE;
    dcb.fRtsControl = RTS_CONTROL_ENABLE;
    dcb.fOutX = FALSE;
    dcb.fInX = FALSE;
    dcb.fNull = FALSE;
    dcb.fAbortOnError = FALSE;
    if (!SetCommState(p->h, &dcb)) { win_err(err, err_len, "SetCommState", path); goto fail; }

    /* ReadFile returns immediately with whatever is buffered */
    memset(&to, 0, sizeof(to));
    to.ReadIntervalTimeout = MAXDWORD;
    to.WriteTotalTimeoutConstant = 5000;
    SetCommTimeouts(p->h, &to);
    SetCommMask(p->h, EV_RXCHAR);
    PurgeComm(p->h, PURGE_RXCLEAR | PURGE_TXCLEAR);

    p->rov.hEvent = CreateEventA(NULL, TRUE, FALSE, NULL);
    p->wov.hEvent = CreateEventA(NULL, TRUE, FALSE, NULL);
    p->eov.hEvent = CreateEventA(NULL, TRUE, FALSE, NULL);
    if (!p->rov.hEvent || !p->wov.hEvent || !p->eov.hEvent) { win_err(err, err_len, "CreateEvent", path); goto fail; }
    return p;

fail:
    serial_close(p);
    return NULL;
}

static int win_read_now(serial_port_t *p, uint8_t *buf, size_t cap) {
    DWORD n = 0;
    ResetEvent(p->rov.hEvent);
    if (!ReadFile(p->h, buf, (DWORD)cap, &n, &p->rov)) {
        if (GetLastError() != ERROR_IO_PENDING) return -1;
        if (!GetOverlappedResult(p->h, &p->rov, &n, TRUE)) return -1;
    }
    return (int)n;
}

int serial_read(serial_port_t *p, uint8_t *buf, size_t cap, int timeout_ms) {
    DWORD mask = 0, x = 0, r;
    int n;

    if (p->interrupted) return -1;
    n = win_read_now(p, buf, cap);
    if (n != 0) return n;

    ResetEvent(p->eov.hEvent);
    if (!WaitCommEvent(p->h, &mask, &p->eov)) {
        if (GetLastError() != ERROR_IO_PENDING) return -1;
        r = WaitForSingleObject(p->eov.hEvent, (DWORD)timeout_ms);
        if (r == WAIT_TIMEOUT) {
            CancelIoEx(p->h, &p->eov);
            GetOverlappedResult(p->h, &p->eov, &x, TRUE);
            return p->interrupted ? -1 : 0;
        }
        if (!GetOverlappedResult(p->h, &p->eov, &x, FALSE)) return -1;
    }
    if (p->interrupted) return -1;
    return win_read_now(p, buf, cap);
}

int serial_write(serial_port_t *p, const uint8_t *data, size_t len) {
    while (len > 0) {
        DWORD n = 0;
        ResetEvent(p->wov.hEvent);
        if (!WriteFile(p->h, data, (DWORD)len, &n, &p->wov)) {
            if (GetLastError() != ERROR_IO_PENDING) return -1;
            if (!GetOverlappedResult(p->h, &p->wov, &n, TRUE)) return -1;
        }
        if (n == 0) return -1;
        data += n;
        len -= n;
    }
    return 0;
}

void serial_interrupt(serial_port_t *p) {
    InterlockedExchange(&p->interrupted, 1);
    SetCommMask(p->h, 0); /* completes a pending WaitCommEvent */
}

void serial_close(serial_port_t *p) {
    if (!p) return;
    if (p->h != INVALID_HANDLE_VALUE) CloseHandle(p->h);
    if (p->rov.hEvent) CloseHandle(p->rov.hEvent);
    if (p->wov.hEvent) CloseHandle(p->wov.hEvent);
    if (p->eov.hEvent) CloseHandle(p->eov.hEvent);
    free(p);
}

char *serial_list_ports_json(void) {
    DWORD cap = 65536;
    char *buf = NULL, *it;
    char *names[256];
    size_t n = 0, i;
    char *json;

    for (;;) {
        char *nb = (char *)realloc(buf, cap);
        if (!nb) { free(buf); return NULL; }
        buf = nb;
        if (QueryDosDeviceA(NULL, buf, cap) != 0) break;
        if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || cap > (1u << 24)) { buf[0] = 0; buf[1] = 0; break; }
        cap *= 2;
    }
    for (it = buf; *it && n < 256; it += strlen(it) + 1) {
        if (strncmp(it, "COM", 3) == 0 && it[3] >= '0' && it[3] <= '9') names[n++] = it;
    }
    json = names_to_json(names, n);
    (void)i;
    free(buf);
    return json;
}

#else
/* ======================================================================= */
/* POSIX (Linux, macOS, BSD)                                               */
/* ======================================================================= */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

struct serial_port {
    int fd;
    volatile int interrupted;
};

serial_port_t *serial_open(const char *path, char *err, size_t err_len) {
    struct termios tio;
    int fd, flags, bits;
    serial_port_t *p;

    fd = open(path, O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (fd < 0) {
        snprintf(err, err_len, "cannot open %s: %s", path, strerror(errno));
        return NULL;
    }
    if (tcgetattr(fd, &tio) != 0) {
        snprintf(err, err_len, "%s is not a serial port: %s", path, strerror(errno));
        close(fd);
        return NULL;
    }
    cfmakeraw(&tio);
    tio.c_cflag |= CLOCAL | CREAD;
    tio.c_cflag &= ~(CSTOPB | PARENB | CRTSCTS);
    tio.c_cc[VMIN] = 0;
    tio.c_cc[VTIME] = 0;
    cfsetispeed(&tio, B115200);
    cfsetospeed(&tio, B115200);
    if (tcsetattr(fd, TCSANOW, &tio) != 0) {
        snprintf(err, err_len, "cannot configure %s: %s", path, strerror(errno));
        close(fd);
        return NULL;
    }
    /* Assert DTR/RTS like Web Serial does; some CDC devices only talk with DTR set */
    bits = TIOCM_DTR | TIOCM_RTS;
    ioctl(fd, TIOCMBIS, &bits);
    tcflush(fd, TCIOFLUSH);

    /* Blocking writes, reads are driven by poll() */
    flags = fcntl(fd, F_GETFL);
    fcntl(fd, F_SETFL, flags & ~O_NONBLOCK);

    p = (serial_port_t *)calloc(1, sizeof(*p));
    if (!p) { close(fd); snprintf(err, err_len, "out of memory"); return NULL; }
    p->fd = fd;
    return p;
}

int serial_read(serial_port_t *p, uint8_t *buf, size_t cap, int timeout_ms) {
    struct pollfd pfd;
    int r;
    ssize_t n;

    if (p->interrupted) return -1;
    pfd.fd = p->fd;
    pfd.events = POLLIN;
    pfd.revents = 0;
    r = poll(&pfd, 1, timeout_ms);
    if (p->interrupted) return -1;
    if (r < 0) return errno == EINTR ? 0 : -1;
    if (r == 0) return 0;
    if (pfd.revents & POLLIN) {
        n = read(p->fd, buf, cap);
        if (n > 0) return (int)n;
        if (n < 0 && (errno == EAGAIN || errno == EINTR)) return 0;
        return -1; /* EOF: device unplugged */
    }
    if (pfd.revents & (POLLHUP | POLLERR | POLLNVAL)) return -1;
    return 0;
}

int serial_write(serial_port_t *p, const uint8_t *data, size_t len) {
    while (len > 0) {
        ssize_t n = write(p->fd, data, len);
        if (n < 0) {
            if (errno == EINTR || errno == EAGAIN) continue;
            return -1;
        }
        data += n;
        len -= (size_t)n;
    }
    return 0;
}

void serial_interrupt(serial_port_t *p) { p->interrupted = 1; }

void serial_close(serial_port_t *p) {
    if (!p) return;
    if (p->fd >= 0) close(p->fd);
    free(p);
}

char *serial_list_ports_json(void) {
    /* USB CDC/serial adapters + Bluetooth serial ports (macOS creates
     * /dev/cu.<device name> for paired SPP devices, e.g. /dev/cu.B1-H8082...). */
    static const char *prefixes[] = {
#ifdef __APPLE__
        "cu.",
#else
        "ttyACM", "ttyUSB", "rfcomm",
#endif
        NULL};
    static const char *excluded[] = {"cu.Bluetooth-Incoming-Port", "cu.debug-console", "cu.wlan-debug", NULL};
    DIR *d = opendir("/dev");
    struct dirent *e;
    char *names[256];
    size_t n = 0, i;
    char *json;

    if (d) {
        while ((e = readdir(d)) != NULL && n < 256) {
            int skip = 0;
            for (i = 0; excluded[i]; i++) skip |= strcmp(e->d_name, excluded[i]) == 0;
            if (skip) continue;
            for (i = 0; prefixes[i]; i++) {
                if (strncmp(e->d_name, prefixes[i], strlen(prefixes[i])) == 0) {
                    size_t l = strlen(e->d_name) + 6;
                    char *s = (char *)malloc(l);
                    if (s) {
                        snprintf(s, l, "/dev/%s", e->d_name);
                        names[n++] = s;
                    }
                    break;
                }
            }
        }
        closedir(d);
    }
    json = names_to_json(names, n);
    for (i = 0; i < n; i++) free(names[i]);
    return json;
}
#endif
