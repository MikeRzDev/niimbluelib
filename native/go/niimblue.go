// Package niimblue prints on NIIMBOT label printers.
//
// The printer protocol is niimbluelib (JavaScript) running in an embedded
// QuickJS engine. Both are compiled into this package by cgo, so a Go program
// using it is a single self-contained binary: no Node.js, no shared library.
//
// All methods block until the printer answers and are safe for concurrent use.
//
//	p, err := niimblue.New()
//	if err != nil { ... }
//	defer p.Close()
//	info, err := p.ConnectSerial("/dev/ttyACM0", nil)
//	res, err := p.Print(img, &niimblue.PrintOptions{Quantity: 1})
package niimblue

/*
#cgo CFLAGS: -I${SRCDIR}/../include -I${SRCDIR}/../third_party/quickjs
#cgo CFLAGS: -DNIIM_STATIC -D_GNU_SOURCE -DQUICKJS_NG_BUILD -O2 -w
#cgo windows CFLAGS: -DWIN32_LEAN_AND_MEAN -D_WIN32_WINNT=0x0601
#cgo linux LDFLAGS: -lm -lpthread -ldl
#cgo darwin LDFLAGS: -lm
#cgo freebsd LDFLAGS: -lm -lpthread

#include <stdlib.h>
#include "niimblue.h"

// Implemented in Go (callbacks.go).
extern void niimGoEvent(void *user, char *name, char *json);
extern int niimGoWrite(void *user, uint8_t *data, size_t len);

static void niim_go_set_event(niim_t *h, void *user) {
	niim_set_event_callback(h, user ? (niim_event_cb)niimGoEvent : NULL, user);
}

static int niim_go_connect_custom(niim_t *h, void *user, const char *opts, char **out) {
	return niim_connect_custom(h, (niim_write_cb)niimGoWrite, user, opts, out);
}
*/
import "C"

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"runtime/cgo"
	"sync"
	"sync/atomic"
	"unsafe"
)

// Error codes returned by the C library.
const (
	codeInvalidArg = -1
	codeJS         = -2
	codeTransport  = -3
	codeClosed     = -4
	codeReentrant  = -5
	codeNoMem      = -6
	codeInit       = -7
)

// Sentinel errors, use errors.Is.
var (
	ErrInvalidArgument = errors.New("niimblue: invalid argument")
	ErrOperation       = errors.New("niimblue: operation failed")
	ErrTransport       = errors.New("niimblue: transport error")
	ErrClosed          = errors.New("niimblue: printer handle closed")
	ErrReentrant       = errors.New("niimblue: called from the event handler")
	ErrInit            = errors.New("niimblue: initialization failed")
)

// Error is returned by every failing call.
type Error struct {
	Code    int
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("niimblue: %s (code %d)", e.Message, e.Code) }

func (e *Error) Unwrap() error {
	switch e.Code {
	case codeInvalidArg:
		return ErrInvalidArgument
	case codeJS:
		return ErrOperation
	case codeTransport:
		return ErrTransport
	case codeClosed:
		return ErrClosed
	case codeReentrant:
		return ErrReentrant
	case codeInit:
		return ErrInit
	}
	return nil
}

// EventHandler receives library events: "connect", "disconnect", "heartbeat",
// "printprogress", "printpacketprogress", "printend", "log", ... with a JSON payload.
// It runs on the library thread: do not call Printer methods from it (they
// return ErrReentrant); hand work off to a goroutine instead.
type EventHandler func(name string, payload json.RawMessage)

// Printer is a connection handle.
type Printer struct {
	h *C.niim_t

	mu        sync.Mutex
	closed    bool
	evSlot    *eventSlot
	evHandle  cgo.Handle
	evPtr     unsafe.Pointer
	wrHandle  cgo.Handle
	wrPtr     unsafe.Pointer
	connectMu sync.Mutex
}

// Version of the native library.
func Version() string { return C.GoString(C.niim_version()) }

// NiimbluelibVersion is the version of the embedded niimbluelib.
func NiimbluelibVersion() string { return C.GoString(C.niim_niimbluelib_version()) }

// ListSerialPorts returns candidate serial ports (USB and Bluetooth serial).
func ListSerialPorts() ([]string, error) {
	s := C.niim_list_serial_ports()
	if s == nil {
		return nil, ErrInvalidArgument
	}
	defer C.niim_string_free(s)
	var ports []string
	err := json.Unmarshal([]byte(C.GoString(s)), &ports)
	return ports, err
}

// New creates a printer handle. Call Close when done.
func New() (*Printer, error) {
	var out *C.char
	h := C.niim_new(&out)
	if h == nil {
		return nil, &Error{Code: codeInit, Message: takeString(out)}
	}
	return &Printer{h: h}, nil
}

// Close disconnects and frees the handle. Do not use p afterwards.
func (p *Printer) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	p.mu.Unlock()

	C.niim_free(p.h) // stops the library thread: no callbacks after this
	freeHandle(&p.evHandle, &p.evPtr)
	freeHandle(&p.wrHandle, &p.wrPtr)
}

// eventSlot is what the C event callback points at. It is installed once and
// lives until Close: the library may still be running a callback with the
// previous user pointer after niim_set_event_callback returns, so handlers are
// swapped inside the slot instead of replacing (and freeing) the pointer.
type eventSlot struct {
	fn atomic.Pointer[EventHandler]
}

// OnEvent installs (or with nil removes) the event handler. It may be called
// from inside the handler.
func (p *Printer) OnEvent(fn EventHandler) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return
	}
	if p.evSlot == nil {
		if fn == nil {
			return
		}
		p.evSlot = &eventSlot{}
		p.evSlot.fn.Store(&fn)
		p.evHandle, p.evPtr = newHandle(p.evSlot)
		C.niim_go_set_event(p.h, p.evPtr) // freed in Close, after niim_free
		return
	}
	if fn == nil {
		p.evSlot.fn.Store(nil)
	} else {
		p.evSlot.fn.Store(&fn)
	}
}

// ConnectSerial connects over a USB or Bluetooth serial port
// ("/dev/ttyACM0", "/dev/cu.usbmodem1101", "COM3").
func (p *Printer) ConnectSerial(port string, opts *ConnectOptions) (*ConnectionInfo, error) {
	cport := C.CString(port)
	defer C.free(unsafe.Pointer(cport))
	copts, free := optionsJSON(opts)
	defer free()

	p.connectMu.Lock()
	defer p.connectMu.Unlock()
	var out *C.char
	rc := C.niim_connect_serial(p.h, cport, copts, &out)
	return decodeConnect(rc, out)
}

// ConnectCustom connects over a transport implemented by the caller
// (e.g. Bluetooth LE). write sends bytes to the printer; pass every chunk
// received from the printer to Feed. write runs on the library thread.
func (p *Printer) ConnectCustom(write func(data []byte) error, opts *ConnectOptions) (*ConnectionInfo, error) {
	if write == nil {
		return nil, &Error{Code: codeInvalidArg, Message: "write is nil"}
	}
	copts, free := optionsJSON(opts)
	defer free()

	p.connectMu.Lock()
	defer p.connectMu.Unlock()

	h, ptr := newHandle(write)
	var out *C.char
	rc := C.niim_go_connect_custom(p.h, ptr, copts, &out)

	// The previous writer is no longer referenced: niim_connect_custom closed
	// the old transport before installing the new one.
	p.mu.Lock()
	oldH, oldP := p.wrHandle, p.wrPtr
	p.wrHandle, p.wrPtr = h, ptr
	p.mu.Unlock()
	freeHandle(&oldH, &oldP)

	return decodeConnect(rc, out)
}

// Feed passes bytes received by a custom transport to the library.
func (p *Printer) Feed(data []byte) {
	if len(data) == 0 {
		return
	}
	C.niim_feed(p.h, (*C.uint8_t)(unsafe.Pointer(&data[0])), C.size_t(len(data)))
}

// TransportClosed reports that the custom transport was closed by the device.
func (p *Printer) TransportClosed() { C.niim_transport_closed(p.h) }

// Disconnect closes the connection (no-op when not connected).
func (p *Printer) Disconnect() error {
	if rc := C.niim_disconnect(p.h); rc != 0 {
		return &Error{Code: int(rc), Message: "disconnect failed"}
	}
	return nil
}

// Call invokes a library method with JSON-encodable params and decodes the
// JSON result into result (if non-nil). See include/niimblue.h for methods.
func (p *Printer) Call(method string, params any, result any) error {
	raw, err := p.CallRaw(method, params)
	if err != nil {
		return err
	}
	if result == nil {
		return nil
	}
	return json.Unmarshal(raw, result)
}

// CallRaw is Call returning the raw JSON result.
func (p *Printer) CallRaw(method string, params any) (json.RawMessage, error) {
	cm := C.CString(method)
	defer C.free(unsafe.Pointer(cm))

	var cp *C.char
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return nil, err
		}
		cp = C.CString(string(b))
		defer C.free(unsafe.Pointer(cp))
	}
	var out *C.char
	rc := C.niim_call(p.h, cm, cp, &out)
	return result(rc, out)
}

// CallBinary is CallRaw with a binary payload (niim_call_bin); data may be nil.
func (p *Printer) CallBinary(method string, params any, data []byte) (json.RawMessage, error) {
	if len(data) == 0 {
		return p.CallRaw(method, params)
	}
	cm := C.CString(method)
	defer C.free(unsafe.Pointer(cm))
	var cp *C.char
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return nil, err
		}
		cp = C.CString(string(b))
		defer C.free(unsafe.Pointer(cp))
	}
	// Go memory may be passed for the duration of the call: the library copies it.
	var out *C.char
	rc := C.niim_call_bin(p.h, cm, cp, (*C.uint8_t)(unsafe.Pointer(&data[0])), C.size_t(len(data)), &out)
	return result(rc, out)
}

// callAPI is the entry point of the generated methods (zz_api.go).
func (p *Printer) callAPI(method string, params apiParams, data []byte, out any) error {
	var ps any
	if params != nil {
		ps = params
	}
	raw, err := p.CallBinary(method, ps, data)
	if err != nil || out == nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

// apiParams is the params object of a generated method; opt leaves zero values out.
type apiParams map[string]any

func (a apiParams) set(k string, v any) { a[k] = v }

func (a apiParams) opt(k string, v any) {
	if rv := reflect.ValueOf(v); rv.IsValid() && !rv.IsZero() {
		a[k] = v
	}
}

// IsConnected reports whether a printer is connected.
func (p *Printer) IsConnected() bool {
	var ok bool
	_ = p.Call("isConnected", nil, &ok)
	return ok
}

/* ---- helpers ---- */

func takeString(s *C.char) string {
	if s == nil {
		return ""
	}
	defer C.niim_string_free(s)
	return C.GoString(s)
}

func result(rc C.int, out *C.char) (json.RawMessage, error) {
	s := takeString(out)
	if rc != 0 {
		return nil, &Error{Code: int(rc), Message: s}
	}
	return json.RawMessage(s), nil
}

func decodeConnect(rc C.int, out *C.char) (*ConnectionInfo, error) {
	raw, err := result(rc, out)
	if err != nil {
		return nil, err
	}
	var info ConnectionInfo
	return &info, json.Unmarshal(raw, &info)
}

// optionsJSON marshals v (nil -> NULL) into a C string.
func optionsJSON(v any) (*C.char, func()) {
	if v == nil || (isNilPtr(v)) {
		return nil, func() {}
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, func() {}
	}
	s := C.CString(string(b))
	return s, func() { C.free(unsafe.Pointer(s)) }
}

func isNilPtr(v any) bool {
	switch x := v.(type) {
	case *ConnectOptions:
		return x == nil
	case *PrintOptions:
		return x == nil
	case *TemplateOptions:
		return x == nil
	case *TemplatePrintOptions:
		return x == nil
	case *PNGPrinterOptions:
		return x == nil
	}
	return false
}

// newHandle stores v in a cgo.Handle and returns it with a C-allocated slot
// holding the handle, usable as the C `void *user` pointer.
func newHandle(v any) (cgo.Handle, unsafe.Pointer) {
	h := cgo.NewHandle(v)
	ptr := C.malloc(C.size_t(unsafe.Sizeof(uintptr(0))))
	*(*uintptr)(ptr) = uintptr(h)
	return h, ptr
}

func freeHandle(h *cgo.Handle, ptr *unsafe.Pointer) {
	if *ptr != nil {
		C.free(*ptr)
		*ptr = nil
	}
	if *h != 0 {
		h.Delete()
		*h = 0
	}
}
