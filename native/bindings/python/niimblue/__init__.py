"""NIIMBOT label printers from Python.

niimbluelib (JavaScript) and a QuickJS engine are compiled into the native
library libniimblue; this module calls its C API (include/niimblue.h) through
ctypes. All calls block until the printer answers and may be made from any
thread (the GIL is released while the library works).

    import niimblue

    with niimblue.Printer() as p:
        p.connect_serial("/dev/ttyACM0")
        p.print_template(open("label.niim", "rb").read(), {"uuid": "..."})

Options, data and results are dicts / lists (JSON strings are accepted as
input too). Failures raise NiimError.
"""

from __future__ import annotations

import base64
import ctypes
import ctypes.util
import glob
import json
import os
import sys
import threading
from dataclasses import dataclass
from typing import Any, Callable, Optional, Union

from . import _ffi
from ._api import _PrinterAPI

__all__ = [
    "NiimError",
    "Printer",
    "RenderedLabel",
    "list_serial_ports",
    "niimbluelib_version",
    "version",
]

__version__ = "0.1.0"

JSONInput = Union[str, bytes, dict, list, None]
EventHandler = Callable[[str, Any], None]
WriteFn = Callable[[bytes], Optional[bool]]

# ---------------------------------------------------------------------------
# Library loading
# ---------------------------------------------------------------------------


def _find_library() -> str:
    env = os.environ.get("NIIMBLUE_LIBRARY")
    if env:
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    if sys.platform == "win32":
        patterns = ["niimblue.dll"]
    elif sys.platform == "darwin":
        patterns = ["libniimblue.dylib", "libniimblue.*.dylib"]
    else:
        patterns = ["libniimblue.so", "libniimblue.so.*"]
    for pattern in patterns:
        found = sorted(glob.glob(os.path.join(here, pattern)))
        if found:
            return found[0]
    system = ctypes.util.find_library("niimblue")
    if system:
        return system
    raise OSError(
        "niimblue: native library not found next to the package or on the system; "
        "reinstall the package or set NIIMBLUE_LIBRARY=/path/to/libniimblue"
    )


_lib = ctypes.CDLL(_find_library())

_c = _ffi.bind(_lib)
_EVENT_CB = _ffi.NIIM_EVENT_CB
_WRITE_CB = _ffi.NIIM_WRITE_CB
_OUT = _ffi.OUT

# ---------------------------------------------------------------------------
# Errors and conversions
# ---------------------------------------------------------------------------


class NiimError(Exception):
    """A failed call. `code` is one of the NIIM_E_* codes (class attributes)."""

    INVALID_ARG = -1
    OPERATION = -2  # failed inside niimbluelib (timeout, printer error, bad parameters, ...)
    TRANSPORT = -3
    CLOSED = -4
    REENTRANT = -5  # called from inside the event handler / transport
    NO_MEMORY = -6
    INIT = -7

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    def __repr__(self) -> str:
        return f"NiimError({self.code}, {self.message!r})"


def _take(ptr: Optional[int]) -> str:
    """Copy and free a string returned by the library."""
    if not ptr:
        return ""
    try:
        return ctypes.string_at(ptr).decode("utf-8", "replace")
    finally:
        _c.string_free(ptr)


def _cstr(s: Optional[str]) -> Optional[bytes]:
    if s is None:
        return None
    b = s.encode("utf-8")
    if b"\0" in b:
        raise NiimError(NiimError.INVALID_ARG, "string contains a NUL character")
    return b


def _json_arg(v: JSONInput) -> Optional[bytes]:
    if v is None:
        return None
    if isinstance(v, bytes):
        v = v.decode("utf-8")
    if not isinstance(v, str):
        v = json.dumps(v, ensure_ascii=False)
    return _cstr(v)


def _result(rc: int, out: ctypes.c_void_p) -> Any:
    text = _take(out.value)
    if rc != 0:
        raise NiimError(rc, text or "unknown error")
    return json.loads(text) if text else None


def version() -> str:
    """Version of the native library."""
    return _c.version().decode()


def niimbluelib_version() -> str:
    """Version of the embedded niimbluelib."""
    return _c.niimbluelib_version().decode()


def list_serial_ports() -> list:
    """Candidate serial port paths."""
    return json.loads(_take(_c.list_serial_ports()) or "[]")


@dataclass(frozen=True)
class RenderedLabel:
    width: int
    height: int
    print_direction: str
    pixels: bytes  # RGBA, width * height * 4 bytes, only white / black / red


# ---------------------------------------------------------------------------
# Printer
# ---------------------------------------------------------------------------


class Printer(_PrinterAPI):
    """A printer handle. Close it (or use `with`) when done.

    Don't call close() from inside the event handler or the transport.
    """

    def __init__(self) -> None:
        out = ctypes.c_void_p()
        h = _c.new(ctypes.byref(out))
        if not h:
            raise NiimError(NiimError.INIT, _take(out.value) or "niim_new failed")
        self._h = h
        self._cond = threading.Condition()
        self._busy = 0
        self._closed = False
        self._connect_lock = threading.Lock()
        self._handler: Optional[EventHandler] = None
        self._writer: Optional[WriteFn] = None
        # Installed once for the handle's lifetime: the library may still run a
        # callback with the old pointer after it was replaced, so only the Python
        # handler is swapped. The ctypes objects must stay referenced.
        self._event_cb = _EVENT_CB(self._on_event)
        self._write_cb = _WRITE_CB(self._on_write)
        _c.set_event_callback(h, self._event_cb, None)

    # -- callbacks (library thread) --

    def _on_event(self, _user, name: bytes, payload: bytes) -> None:
        handler = self._handler
        if handler is None:
            return
        try:
            text = payload.decode("utf-8", "replace")
            try:
                data = json.loads(text)
            except ValueError:
                data = text
            handler(name.decode("utf-8", "replace"), data)
        except BaseException:  # a failing handler must not break the library
            sys.excepthook(*sys.exc_info())

    def _on_write(self, _user, data, length: int) -> int:
        writer = self._writer
        if writer is None:
            return 1
        try:
            ok = writer(ctypes.string_at(data, length))
        except BaseException:
            sys.excepthook(*sys.exc_info())
            return 1
        return 1 if ok is False else 0

    # -- plumbing --

    def _enter(self) -> int:
        with self._cond:
            if self._closed:
                raise NiimError(NiimError.CLOSED, "printer is closed")
            self._busy += 1
            return self._h

    def _leave(self) -> None:
        with self._cond:
            self._busy -= 1
            if self._busy == 0:
                self._cond.notify_all()

    def _call(self, fn, *args) -> Any:
        h = self._enter()
        try:
            out = ctypes.c_void_p()
            rc = fn(h, *args, ctypes.byref(out))
            return _result(rc, out)
        finally:
            self._leave()

    # -- API --

    def on_event(self, handler: Optional[EventHandler]) -> None:
        """Receive events (name, payload): "connect", "disconnect", "heartbeat",
        "printprogress", "printend", "log", ... or stop with None. The handler
        runs on the library thread; Printer methods called from it raise
        NiimError(REENTRANT)."""
        self._enter()
        self._handler = handler
        self._leave()

    def connect_serial(self, port: str, options: JSONInput = None) -> dict:
        """Connect over a USB / Bluetooth serial port ("/dev/ttyACM0", "COM3")."""
        with self._connect_lock:
            return self._call(_c.connect_serial, _cstr(port), _json_arg(options))

    def connect_custom(self, write: WriteFn, options: JSONInput = None) -> dict:
        """Connect over a transport you implement (e.g. Bluetooth LE). `write(data)`
        sends bytes to the printer (return False or raise on failure); pass every
        chunk received from the printer to feed()."""
        with self._connect_lock:
            h = self._enter()
            try:
                _c.disconnect(h)  # the old transport closes while its writer is installed
                self._writer = write
                out = ctypes.c_void_p()
                rc = _c.connect_custom(h, self._write_cb, None, _json_arg(options), ctypes.byref(out))
                return _result(rc, out)
            finally:
                self._leave()

    def feed(self, data: bytes) -> None:
        """Bytes received by a custom transport."""
        h = self._enter()
        try:
            _c.feed(h, bytes(data), len(data))
        finally:
            self._leave()

    def transport_closed(self) -> None:
        """The custom transport was closed by the device."""
        h = self._enter()
        try:
            _c.transport_closed(h)
        finally:
            self._leave()

    def disconnect(self) -> None:
        with self._connect_lock:
            h = self._enter()
            try:
                rc = _c.disconnect(h)
            finally:
                self._leave()
        if rc != 0:
            raise NiimError(rc, "disconnect failed")

    # -- print queue (see "Print queue" in include/niimblue.h) --

    def render_template_rgba(
        self, template: bytes, data: JSONInput = None, options: JSONInput = None
    ) -> RenderedLabel:
        """render_template() with the pixels decoded. template: the .niim package bytes."""
        r = self.render_template(template, data, options)
        return RenderedLabel(r["width"], r["height"], r["printDirection"], base64.b64decode(r["pixels"]))

    def _call_binary(self, method: str, params: Optional[dict], data: Optional[bytes]) -> Any:
        if data is None:
            return self.call(method, params)
        return self._call(_c.call_bin, _cstr(method), _json_arg(params), data, len(data))

    def call(self, method: str, params: JSONInput = None) -> Any:
        """Generic call: getPrinterInfo, fetchRfidInfo, fetchHeartbeat, setSoundEnabled,
        listFonts, templateTags, ..."""
        return self._call(_c.call, _cstr(method), _json_arg(params))

    def close(self) -> None:
        """Disconnect and free the handle (waits for calls running on other threads)."""
        with self._cond:
            if self._closed:
                return
            self._closed = True
            while self._busy:
                self._cond.wait()
            h, self._h = self._h, None
        _c.free(h)  # stops the library thread: no callbacks after this
        self._handler = None
        self._writer = None

    def __enter__(self) -> "Printer":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass
