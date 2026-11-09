package niimblue

/*
#include <stdint.h>
#include <stddef.h>
*/
import "C"

import (
	"encoding/json"
	"runtime/cgo"
	"unsafe"
)

func handleFrom(user unsafe.Pointer) (cgo.Handle, bool) {
	if user == nil {
		return 0, false
	}
	h := cgo.Handle(*(*uintptr)(user))
	return h, h != 0
}

//export niimGoEvent
func niimGoEvent(user unsafe.Pointer, name *C.char, payload *C.char) {
	h, ok := handleFrom(user)
	if !ok {
		return
	}
	slot, ok := h.Value().(*eventSlot)
	if !ok {
		return
	}
	fn := slot.fn.Load()
	if fn == nil {
		return
	}
	defer func() { _ = recover() }()
	(*fn)(C.GoString(name), json.RawMessage(C.GoString(payload)))
}

//export niimGoWrite
func niimGoWrite(user unsafe.Pointer, data *C.uint8_t, length C.size_t) C.int {
	h, ok := handleFrom(user)
	if !ok {
		return 1
	}
	write, ok := h.Value().(func([]byte) error)
	if !ok {
		return 1
	}
	buf := C.GoBytes(unsafe.Pointer(data), C.int(length))
	rc := C.int(0)
	func() {
		defer func() {
			if recover() != nil {
				rc = 1
			}
		}()
		if write(buf) != nil {
			rc = 1
		}
	}()
	return rc
}
