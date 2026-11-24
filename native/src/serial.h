/* Minimal cross-platform serial port (115200 8N1, raw). */
#ifndef NIIM_SERIAL_H
#define NIIM_SERIAL_H

#include <stddef.h>
#include <stdint.h>

typedef struct serial_port serial_port_t;

/* Open port. On failure returns NULL and writes a message into err. */
serial_port_t *serial_open(const char *path, char *err, size_t err_len);

/* Write all bytes. Returns 0 on success. */
int serial_write(serial_port_t *p, const uint8_t *data, size_t len);

/*
 * Read up to `cap` bytes, waiting at most `timeout_ms`.
 * Returns >0 bytes read, 0 on timeout, -1 when the port is closed / failed.
 */
int serial_read(serial_port_t *p, uint8_t *buf, size_t cap, int timeout_ms);

/* Make a blocked serial_read() return -1 soon (thread-safe). */
void serial_interrupt(serial_port_t *p);

void serial_close(serial_port_t *p);

/* JSON array of likely printer ports. Caller frees with free(). */
char *serial_list_ports_json(void);

#endif
