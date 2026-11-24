// Swift API for libniimblue: NIIMBOT label printers from Swift (macOS, iOS, Linux).
//
// The printer protocol is niimbluelib (JavaScript) running in an embedded QuickJS
// engine; SwiftPM compiles both into the package (CNiimblue). All calls block until
// the printer answers and may be made from any thread, so call them off the main
// thread. Options, data and results are JSON strings, as documented in
// include/niimblue.h. Failures throw NiimError.
//
//     let printer = try NiimPrinter()
//     try printer.connectSerial("/dev/cu.usbmodem1101")   // or connectCustom for CoreBluetooth
//     try printer.printTemplate(Data(contentsOf: labelURL), data: #"{"uuid":"..."}"#)   // .niim package

import CNiimblue
import Foundation

/// A failed call. `code` is one of the `NIIM_E_*` codes (constants below).
public struct NiimError: Error, Equatable, CustomStringConvertible, Sendable {
    public let code: Int32
    public let message: String

    public init(code: Int32, message: String) {
        self.code = code
        self.message = message
    }

    public static let invalidArgument: Int32 = -1
    /// The operation failed inside niimbluelib (timeout, printer error, bad parameters, ...).
    public static let operation: Int32 = -2
    public static let transport: Int32 = -3
    public static let closed: Int32 = -4
    /// Called from inside the event handler or the transport (would deadlock).
    public static let reentrant: Int32 = -5
    public static let noMemory: Int32 = -6
    public static let initFailed: Int32 = -7

    public var description: String { "NiimError(\(code)): \(message)" }
}

/// A template rendered without a printer (`renderTemplateRGBA`).
public struct RenderedLabel: Sendable {
    public let width: Int
    public let height: Int
    public let printDirection: String
    /// RGBA, width * height * 4 bytes, only white / black / red.
    public let pixels: Data
}

/// Library events: name ("connect", "disconnect", "heartbeat", "printprogress",
/// "printend", "log", ...) and JSON payload. Runs on the library's thread.
public typealias NiimEventHandler = @Sendable (_ name: String, _ json: String) -> Void

/// Sends bytes to the printer (custom transport); return false on failure. Runs on the library's thread.
public typealias NiimWriter = @Sendable (_ data: Data) -> Bool

/// What a C callback's `user` pointer refers to, for the whole life of the handle: the
/// library may still run a callback with the old pointer after it was replaced, so only
/// the closure inside the box is swapped.
private final class CallbackBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T?

    func get() -> T? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set(_ v: T?) {
        lock.lock()
        value = v
        lock.unlock()
    }
}

private func eventTrampoline(user: UnsafeMutableRawPointer?, name: UnsafePointer<CChar>?, json: UnsafePointer<CChar>?) {
    guard let user, let name, let json else { return }
    let box = Unmanaged<CallbackBox<NiimEventHandler>>.fromOpaque(user).takeUnretainedValue()
    guard let handler = box.get() else { return }
    handler(String(cString: name), String(cString: json))
}

private func writeTrampoline(user: UnsafeMutableRawPointer?, data: UnsafePointer<UInt8>?, len: Int) -> Int32 {
    guard let user else { return 1 }
    let box = Unmanaged<CallbackBox<NiimWriter>>.fromOpaque(user).takeUnretainedValue()
    guard let write = box.get() else { return 1 }
    let bytes = data.map { Data(bytes: $0, count: len) } ?? Data()
    return write(bytes) ? 0 : 1
}

/// Copy and free a string returned by the library.
private func take(_ s: UnsafeMutablePointer<CChar>?) -> String {
    guard let s else { return "" }
    defer { niim_string_free(s) }
    return String(cString: s)
}

private func check(_ s: String) throws {
    if s.utf8.contains(0) {
        throw NiimError(code: NiimError.invalidArgument, message: "string contains a NUL character")
    }
}

/// Run `body` with a C string (or NULL for nil).
private func withOptionalCString<R>(_ s: String?, _ body: (UnsafePointer<CChar>?) throws -> R) throws -> R {
    guard let s else { return try body(nil) }
    try check(s)
    return try s.withCString { try body($0) }
}

/// A NIIMBOT printer handle. Freed when released, or earlier with `close()`.
public final class NiimPrinter: @unchecked Sendable {
    private var handle: OpaquePointer?
    private let state = NSCondition() // guards handle / busy
    private var busy = 0
    private let connectLock = NSLock()
    private let events = CallbackBox<NiimEventHandler>()
    private let writer = CallbackBox<NiimWriter>()

    /// Version of the native library.
    public static var version: String { String(cString: niim_version()) }

    /// Version of the embedded niimbluelib.
    public static var niimbluelibVersion: String { String(cString: niim_niimbluelib_version()) }

    /// Candidate serial port paths.
    public static func listSerialPorts() -> [String] {
        let json = take(niim_list_serial_ports())
        return (try? JSONDecoder().decode([String].self, from: Data(json.utf8))) ?? []
    }

    public init() throws {
        var out: UnsafeMutablePointer<CChar>?
        guard let h = niim_new(&out) else {
            throw NiimError(code: NiimError.initFailed, message: take(out))
        }
        niim_string_free(out)
        handle = h
        // Installed once; the box outlives the handle (freed in close / deinit after niim_free).
        niim_set_event_callback(h, eventTrampoline, Unmanaged.passUnretained(events).toOpaque())
    }

    deinit {
        close()
    }

    // MARK: plumbing

    private func withHandle<R>(_ body: (OpaquePointer) throws -> R) throws -> R {
        state.lock()
        guard let h = handle else {
            state.unlock()
            throw NiimError(code: NiimError.closed, message: "printer is closed")
        }
        busy += 1
        state.unlock()
        defer {
            state.lock()
            busy -= 1
            if busy == 0 { state.broadcast() }
            state.unlock()
        }
        return try body(h)
    }

    private func result(_ rc: Int32, _ out: UnsafeMutablePointer<CChar>?) throws -> String {
        let s = take(out)
        if rc != NIIM_OK { throw NiimError(code: rc, message: s.isEmpty ? "unknown error" : s) }
        return s
    }

    private func call2(
        _ a: String?, _ b: String?,
        _ fn: (OpaquePointer, UnsafePointer<CChar>?, UnsafePointer<CChar>?, UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Int32
    ) throws -> String {
        try withHandle { h in
            try withOptionalCString(a) { ca in
                try withOptionalCString(b) { cb in
                    var out: UnsafeMutablePointer<CChar>?
                    let rc = fn(h, ca, cb, &out)
                    return try result(rc, out)
                }
            }
        }
    }

    // MARK: API

    /// Receive library events, or stop with nil. The handler runs on the library thread;
    /// other calls made from it throw `NiimError.reentrant`. Replacing the handler from
    /// inside a handler is fine.
    public func onEvent(_ handler: NiimEventHandler?) {
        events.set(handler)
    }

    /// Connect over a USB / Bluetooth serial port ("/dev/cu.usbmodem1101", "/dev/ttyACM0").
    /// Returns the connection info JSON.
    @discardableResult
    public func connectSerial(_ port: String, options: String? = nil) throws -> String {
        connectLock.lock()
        defer { connectLock.unlock() }
        return try call2(port, options) { niim_connect_serial($0, $1, $2, $3) }
    }

    /// Connect over a transport you implement (e.g. CoreBluetooth): `write` sends bytes to
    /// the printer; pass every chunk received from it to `feed(_:)`.
    @discardableResult
    public func connectCustom(options: String? = nil, write: @escaping NiimWriter) throws -> String {
        connectLock.lock()
        defer { connectLock.unlock() }
        return try withHandle { h in
            try withOptionalCString(options) { co in
                _ = niim_disconnect(h) // the old transport closes while its writer is installed
                writer.set(write)
                var out: UnsafeMutablePointer<CChar>?
                let rc = niim_connect_custom(h, writeTrampoline, Unmanaged.passUnretained(writer).toOpaque(), co, &out)
                return try result(rc, out)
            }
        }
    }

    /// One label printed by the PNG printer.
    public struct PNGPage: Sendable {
        public let jobId: Int
        public let page: Int
        public let copies: Int
        public let width: Int
        public let height: Int
        /// PNG file of the final tag.
        public let png: Data
    }

    /// Pages printed by the PNG printer (all, or of one job).
    public func pngPages(jobId: Int? = nil) throws -> [PNGPage] {
        struct Raw: Decodable {
            let jobId: Int?, page: Int, copies: Int, width: Int, height: Int, png: String
        }
        let json = try call("pngPages", params: jobId.map { #"{"jobId":\#($0)}"# })
        let raw = try JSONDecoder().decode([Raw].self, from: Data(json.utf8))
        return try raw.map {
            guard let png = Data(base64Encoded: $0.png) else {
                throw NiimError(code: NiimError.operation, message: "invalid PNG data")
            }
            return PNGPage(jobId: $0.jobId ?? 0, page: $0.page, copies: $0.copies, width: $0.width, height: $0.height, png: png)
        }
    }


    /// Bytes received by a custom transport.
    public func feed(_ data: Data) throws {
        try withHandle { h in
            data.withUnsafeBytes { raw in
                if let p = raw.bindMemory(to: UInt8.self).baseAddress { niim_feed(h, p, raw.count) }
            }
        }
    }

    /// The custom transport was closed by the device.
    public func transportClosed() throws {
        try withHandle { niim_transport_closed($0) }
    }

    public func disconnect() throws {
        connectLock.lock()
        defer { connectLock.unlock() }
        let rc = try withHandle { niim_disconnect($0) }
        if rc != NIIM_OK { throw NiimError(code: rc, message: "disconnect failed") }
    }

    /// `renderTemplate` with the pixels decoded. `template` is the .niim package.
    public func renderTemplateRGBA(_ template: Data, data: String? = nil, options: String? = nil) throws -> RenderedLabel {
        struct Raw: Decodable {
            let width: Int, height: Int, printDirection: String, pixels: String
        }
        let json = try renderTemplate(template, data: data, options: options)
        let raw = try JSONDecoder().decode(Raw.self, from: Data(json.utf8))
        guard let pixels = Data(base64Encoded: raw.pixels) else {
            throw NiimError(code: NiimError.operation, message: "invalid pixel data")
        }
        return RenderedLabel(width: raw.width, height: raw.height, printDirection: raw.printDirection, pixels: pixels)
    }

    /// Generic call: getPrinterInfo, fetchRfidInfo, fetchHeartbeat, setSoundEnabled, listFonts, templateTags, ...
    @discardableResult
    public func call(_ method: String, params: String? = nil) throws -> String {
        try call2(method, params) { niim_call($0, $1, $2, $3) }
    }

    /// Generic call with a binary payload (`niim_call_bin`, the bytes are copied).
    /// The typed methods generated from api/api.json (NiimPrinter+API.swift) use it.
    @discardableResult
    public func callBinary(_ method: String, params: String? = nil, data: Data?) throws -> String {
        guard let data else { return try call(method, params: params) }
        return try withHandle { h in
            try withOptionalCString(method) { cm in
                try withOptionalCString(params) { cp in
                    try data.withUnsafeBytes { raw in
                        var out: UnsafeMutablePointer<CChar>?
                        let rc = niim_call_bin(h, cm, cp, raw.bindMemory(to: UInt8.self).baseAddress, raw.count, &out)
                        return try result(rc, out)
                    }
                }
            }
        }
    }

    /// Disconnect and free the handle now (waits for calls running on other threads).
    /// Later calls throw `NiimError.closed`. Don't call it from the event handler or the transport.
    public func close() {
        state.lock()
        guard let h = handle else {
            state.unlock()
            return
        }
        handle = nil
        while busy > 0 { state.wait() }
        state.unlock()
        niim_free(h) // stops the library thread: no callbacks after this
        events.set(nil)
        writer.set(nil)
    }
}
