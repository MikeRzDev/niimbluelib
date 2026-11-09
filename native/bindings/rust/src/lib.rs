//! Rust bindings for libniimblue: NIIMBOT label printers from Rust.
//!
//! The printer protocol is niimbluelib (JavaScript) running inside an embedded
//! QuickJS engine, compiled into this crate as a static C library. All calls
//! block until the printer answers and can be made from any thread.
//!
//! Results are returned as JSON strings (parse them with your JSON library of
//! choice, e.g. `serde_json`).
//!
//! ```no_run
//! let printer = niimblue::Printer::new()?;
//! let info = printer.connect_serial("/dev/ttyACM0", None)?;
//! println!("{info}");
//! let (w, h) = (384i64, 240i64);
//! let pixels = vec![255u8; (w * h) as usize]; // white, "gray" format
//! printer.print(&pixels, w, h, Some(r#"{"format":"gray","quantity":1}"#))?;
//! # Ok::<(), niimblue::Error>(())
//! ```

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::fmt;
use std::ptr;
use std::sync::{Arc, Mutex, RwLock};

mod api;
pub use api::*;

/// Raw C API (generated from include/niimblue.h).
pub mod sys;

/// Error kind, mirrors the `NIIM_E_*` codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    InvalidArgument,
    /// The operation failed inside niimbluelib (timeout, printer error, bad params, ...).
    Operation,
    Transport,
    Closed,
    /// Called from inside the event handler (would deadlock).
    Reentrant,
    OutOfMemory,
    Init,
    Unknown(i32),
}

#[derive(Debug, Clone)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

fn kind(code: c_int) -> ErrorKind {
    match code {
        sys::NIIM_E_INVALID_ARG => ErrorKind::InvalidArgument,
        sys::NIIM_E_JS => ErrorKind::Operation,
        sys::NIIM_E_TRANSPORT => ErrorKind::Transport,
        sys::NIIM_E_CLOSED => ErrorKind::Closed,
        sys::NIIM_E_REENTRANT => ErrorKind::Reentrant,
        sys::NIIM_E_NOMEM => ErrorKind::OutOfMemory,
        sys::NIIM_E_INIT => ErrorKind::Init,
        c => ErrorKind::Unknown(c),
    }
}

/// Take ownership of a C string returned by the library.
unsafe fn take(s: *mut c_char) -> String {
    if s.is_null() {
        return String::new();
    }
    let r = CStr::from_ptr(s).to_string_lossy().into_owned();
    sys::niim_string_free(s);
    r
}

fn result(code: c_int, out: *mut c_char) -> Result<String> {
    let s = unsafe { take(out) };
    if code == sys::NIIM_OK {
        Ok(s)
    } else {
        Err(Error { kind: kind(code), message: s })
    }
}

fn cstr(s: &str) -> Result<CString> {
    CString::new(s).map_err(|_| Error { kind: ErrorKind::InvalidArgument, message: "string contains NUL".into() })
}

fn opt_cstr(s: Option<&str>) -> Result<Option<CString>> {
    s.map(cstr).transpose()
}

fn opt_ptr(s: &Option<CString>) -> *const c_char {
    s.as_ref().map_or(ptr::null(), |c| c.as_ptr())
}

/// Library version.
pub fn version() -> String {
    unsafe { CStr::from_ptr(sys::niim_version()).to_string_lossy().into_owned() }
}

/// Embedded niimbluelib version.
pub fn niimbluelib_version() -> String {
    unsafe { CStr::from_ptr(sys::niim_niimbluelib_version()).to_string_lossy().into_owned() }
}

/// JSON array of candidate serial ports.
pub fn list_serial_ports() -> String {
    unsafe { take(sys::niim_list_serial_ports()) }
}

type EventHandler = Arc<dyn Fn(&str, &str) + Send + Sync>;
type WriteFn = Box<dyn FnMut(&[u8]) -> bool + Send>;

/// What the C event callback points at, for the whole life of the handle: the
/// library may still run a callback with the old `user` pointer after
/// `niim_set_event_callback` returned, so handlers are swapped inside the slot
/// instead of replacing (and freeing) the pointer.
struct EventSlot(RwLock<Option<EventHandler>>);

unsafe extern "C" fn event_trampoline(user: *mut c_void, name: *const c_char, json: *const c_char) {
    let slot = &*(user as *const EventSlot);
    // Clone and release the lock before calling: the handler may replace itself.
    let handler = match slot.0.read() {
        Ok(h) => h.clone(),
        Err(_) => None,
    };
    let Some(handler) = handler else { return };
    let name = CStr::from_ptr(name).to_string_lossy();
    let json = CStr::from_ptr(json).to_string_lossy();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(&name, &json)));
}

unsafe extern "C" fn write_trampoline(user: *mut c_void, data: *const u8, len: usize) -> c_int {
    let w = &*(user as *const Mutex<WriteFn>);
    let bytes = std::slice::from_raw_parts(data, len);
    let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match w.lock() {
        Ok(mut f) => f(bytes),
        Err(_) => false,
    }))
    .unwrap_or(false);
    if ok {
        0
    } else {
        1
    }
}

/// A printer connection handle. `Send + Sync`: share it with `Arc`.
pub struct Printer {
    h: *mut sys::niim_t,
    // Installed once in new(), freed in drop() after niim_free.
    event: Box<EventSlot>,
    // Kept alive for the C side; replaced under the lock.
    writer: Mutex<Option<Box<Mutex<WriteFn>>>>,
}

unsafe impl Send for Printer {}
unsafe impl Sync for Printer {}

impl Printer {
    pub fn new() -> Result<Self> {
        let mut out = ptr::null_mut();
        let h = unsafe { sys::niim_new(&mut out) };
        if h.is_null() {
            return Err(Error { kind: ErrorKind::Init, message: unsafe { take(out) } });
        }
        let event = Box::new(EventSlot(RwLock::new(None)));
        unsafe { sys::niim_set_event_callback(h, Some(event_trampoline), &*event as *const EventSlot as *mut c_void) };
        Ok(Printer { h, event, writer: Mutex::new(None) })
    }

    /// Receive events (`connect`, `disconnect`, `heartbeat`, `printprogress`, `printend`, `log`, ...).
    /// The handler runs on the library thread: other `Printer` methods called from it fail with
    /// [`ErrorKind::Reentrant`]. Replacing the handler from inside a handler is fine.
    pub fn set_event_handler<F: Fn(&str, &str) + Send + Sync + 'static>(&self, f: F) {
        *self.event.0.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(f));
    }

    /// Stop receiving events.
    pub fn clear_event_handler(&self) {
        *self.event.0.write().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Connect over USB / Bluetooth serial port. Returns connection info JSON.
    pub fn connect_serial(&self, port: &str, options: Option<&str>) -> Result<String> {
        let port = cstr(port)?;
        let opts = opt_cstr(options)?;
        let mut out = ptr::null_mut();
        let rc = unsafe { sys::niim_connect_serial(self.h, port.as_ptr(), opt_ptr(&opts), &mut out) };
        result(rc, out)
    }

    /// Connect over a transport you implement (e.g. Bluetooth LE).
    /// `write` sends bytes to the printer and returns `true` on success; feed
    /// every received chunk with [`Printer::feed`].
    pub fn connect_custom<W: FnMut(&[u8]) -> bool + Send + 'static>(&self, write: W, options: Option<&str>) -> Result<String> {
        let opts = opt_cstr(options)?;
        let boxed: Box<Mutex<WriteFn>> = Box::new(Mutex::new(Box::new(write)));
        let user = &*boxed as *const Mutex<WriteFn> as *mut c_void;
        // Hold the slot for the whole call so concurrent connects cannot drop a writer in use.
        let mut slot = self.writer.lock().unwrap();
        let mut out = ptr::null_mut();
        let rc = unsafe { sys::niim_connect_custom(self.h, Some(write_trampoline), user, opt_ptr(&opts), &mut out) };
        // niim_connect_custom closed the previous transport before installing ours.
        *slot = Some(boxed);
        result(rc, out)
    }

    /// Bytes received from a custom transport.
    pub fn feed(&self, data: &[u8]) {
        unsafe { sys::niim_feed(self.h, data.as_ptr(), data.len()) }
    }

    /// The custom transport was closed by the device.
    pub fn transport_closed(&self) {
        unsafe { sys::niim_transport_closed(self.h) }
    }

    pub fn disconnect(&self) -> Result<()> {
        let rc = unsafe { sys::niim_disconnect(self.h) };
        result(rc, ptr::null_mut()).map(|_| ())
    }

    /// Generic call (getPrinterInfo, fetchRfidInfo, fetchHeartbeat, setSoundEnabled, listFonts, templateTags, ...).
    pub fn call(&self, method: &str, params: Option<&str>) -> Result<String> {
        let m = cstr(method)?;
        let p = opt_cstr(params)?;
        let mut out = ptr::null_mut();
        let rc = unsafe { sys::niim_call(self.h, m.as_ptr(), opt_ptr(&p), &mut out) };
        result(rc, out)
    }

    /// Generic call with a binary payload (`niim_call_bin`); the bytes are copied.
    /// The typed methods (generated from api/api.json into `api.rs`) use it.
    pub fn call_binary(&self, method: &str, params: Option<&str>, data: Option<&[u8]>) -> Result<String> {
        let Some(data) = data else { return self.call(method, params) };
        let m = cstr(method)?;
        let p = opt_cstr(params)?;
        let mut out = ptr::null_mut();
        let rc = unsafe { sys::niim_call_bin(self.h, m.as_ptr(), opt_ptr(&p), data.as_ptr(), data.len(), &mut out) };
        result(rc, out)
    }
}

impl Drop for Printer {
    fn drop(&mut self) {
        // Stops the library thread; callbacks are not used after this returns.
        unsafe { sys::niim_free(self.h) };
    }
}
