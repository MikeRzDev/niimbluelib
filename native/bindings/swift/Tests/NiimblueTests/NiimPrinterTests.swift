// No printer needed: the virtual printer replays a recorded B1 session. Same fixtures
// as the Go tests (native/go/testdata). `swift test` (macOS), or on an iOS simulator:
// xcodebuild test -scheme Niimblue -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
import Foundation
import Niimblue
import XCTest

private let testdata = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().appendingPathComponent("../../../../go/testdata").standardizedFileURL
private let b1Dump = try! String(contentsOf: testdata.appendingPathComponent("b1_print_dump.txt"), encoding: .utf8)
private let assetTag = try! Data(contentsOf: testdata.appendingPathComponent("asset-tag.niim"))
private let assetData =
    #"{"uuid":"794ad7ca-1ae2-451e-b06a-d93fd303e9d9","asset_name":"Oppenheimer","asset_type":"Compute Node","site":"Manhattan"}"#
private let noHeartbeat = #"{"heartbeat":false}"#

private func object(_ json: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? [:]
}

/// Thread-safe recorder for callbacks.
private final class Recorder<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [T] = []
    func add(_ v: T) { lock.lock(); items.append(v); lock.unlock() }
    var all: [T] { lock.lock(); defer { lock.unlock() }; return items }
}

final class NiimPrinterTests: XCTestCase {
    func testVersions() {
        XCTAssertFalse(NiimPrinter.version.isEmpty)
        XCTAssertNotNil(NiimPrinter.niimbluelibVersion.range(of: #"^\d+\.\d+\.\d+"#, options: .regularExpression))
        _ = NiimPrinter.listSerialPorts()
    }

    func testRenderTemplate() throws {
        let p = try NiimPrinter()
        let label = try p.renderTemplateRGBA(assetTag, data: assetData)
        XCTAssertEqual(label.width, 240)
        XCTAssertEqual(label.height, 160)
        XCTAssertEqual(label.printDirection, "top")
        XCTAssertEqual(label.pixels.count, 240 * 160 * 4)
        let black = stride(from: 0, to: label.pixels.count, by: 4).filter { label.pixels[$0] == 0 }.count
        XCTAssertGreaterThan(black, 2000)
    }

    func testTemplateTags() throws {
        let p = try NiimPrinter()
        XCTAssertEqual(try p.callBinary("templateTags", data: assetTag),
                       #"["uuid","asset_name","asset_type","site"]"#)
        // Only .niim packages, not template JSON
        XCTAssertThrowsError(try p.templateTags(Data(#"{"format":"niimblue-template"}"#.utf8))) {
            XCTAssertTrue(($0 as? NiimError)?.message.contains(".niim template package") ?? false, "\($0)")
        }
    }

    func testGeneratedMethods() throws {
        let p = try NiimPrinter()
        XCTAssertTrue(try p.printTasks().contains(#""B1""#))
        XCTAssertFalse(try p.isConnected())
        XCTAssertFalse(try p.queuePaused())
        try p.pauseQueue()
        XCTAssertTrue(try p.queuePaused())
        try p.resumeQueue()
        XCTAssertEqual(try p.clearQueue(), 0)
        XCTAssertThrowsError(try p.printerInfo())
        XCTAssertEqual(try p.templateTags(assetTag), #"["uuid","asset_name","asset_type","site"]"#)
        // Binary payload through niim_call_bin
        XCTAssertThrowsError(try p.registerFont(family: "Junk", data: Data("not a font".utf8)))
    }

    func testPrintTemplateOnVirtualPrinter() throws {
        let p = try NiimPrinter()
        let events = Recorder<String>()
        p.onEvent { name, _ in events.add(name) }

        XCTAssertThrowsError(try p.printTemplate(assetTag, data: assetData)) {
            XCTAssertEqual(($0 as? NiimError)?.code, NiimError.operation)
        }
        XCTAssertEqual(object(try p.connectVirtual(b1Dump, options: noHeartbeat))["printTask"] as? String, "B1")
        let res = object(try p.printTemplate(assetTag, data: "[\(assetData)]", options: #"{"statusPollIntervalMs":20}"#))
        XCTAssertEqual(res["labels"] as? Int, 1)
        XCTAssertEqual(res["pages"] as? Int, 1)
        XCTAssertTrue(events.all.contains("connect") && events.all.contains("printend"), "\(events.all)")

        XCTAssertThrowsError(try p.printTemplate(assetTag, data: #"[\#(assetData),{"uuid":"x"}]"#)) {
            XCTAssertTrue(($0 as? NiimError)?.message.contains("asset_name") == true, "\($0)")
        }
        try p.disconnect()
    }

    func testUnicodeRoundTrip() throws {
        let p = try NiimPrinter()
        let method = "nö-such-mëthod-😀"
        XCTAssertThrowsError(try p.call(method)) {
            XCTAssertTrue(($0 as? NiimError)?.message.hasSuffix(method) == true, "\($0)")
        }
        XCTAssertThrowsError(try p.call("a\u{0}b")) {
            XCTAssertEqual(($0 as? NiimError)?.code, NiimError.invalidArgument)
        }
    }

    func testCustomTransportRunsOnLibraryThread() throws {
        let p = try NiimPrinter()
        let caller = Thread.current
        let threads = Recorder<Bool>()
        XCTAssertThrowsError(try p.connectCustom(options: noHeartbeat) { _ in
            threads.add(Thread.current == caller)
            return false // fail every write
        }) {
            let code = ($0 as? NiimError)?.code
            XCTAssertTrue(code == NiimError.operation || code == NiimError.transport, "\($0)")
        }
        XCTAssertFalse(threads.all.isEmpty)
        XCTAssertFalse(threads.all.contains(true))
    }

    func testReentrantCallFails() throws {
        let p = try NiimPrinter()
        let codes = Recorder<Int32>()
        p.onEvent { [unowned p] name, _ in
            guard name == "connect" else { return }
            do { _ = try p.call("isConnected") } catch let e as NiimError { codes.add(e.code) } catch {}
        }
        try p.connectVirtual(b1Dump, options: noHeartbeat)
        XCTAssertEqual(codes.all, [NiimError.reentrant])
        p.onEvent(nil)
    }

    func testSwapHandlersWhileEventsFire() throws {
        let p = try NiimPrinter()
        let b = Recorder<Int>()
        let handlerB: NiimEventHandler = { _, _ in b.add(1) }
        let handlerA: NiimEventHandler = { [unowned p] name, _ in
            if name == "heartbeat" { p.onEvent(handlerB) } // from inside a handler
        }
        p.onEvent(handlerA)
        try p.connectVirtual(b1Dump, options: #"{"heartbeatIntervalMs":10}"#)
        let end = Date().addingTimeInterval(0.3)
        var i = 0
        while Date() < end {
            p.onEvent([handlerA, nil, handlerB][i % 3])
            i += 1
            Thread.sleep(forTimeInterval: 0.001)
        }
        p.onEvent(handlerB)
        let before = b.all.count
        Thread.sleep(forTimeInterval: 0.15)
        XCTAssertGreaterThan(b.all.count, before)
        p.close()
    }

    func testClosedPrinterThrows() throws {
        let p = try NiimPrinter()
        p.close()
        p.close()
        XCTAssertThrowsError(try p.call("isConnected")) {
            XCTAssertEqual(($0 as? NiimError)?.code, NiimError.closed)
        }
    }

    func testParallelPrinters() {
        let errors = Recorder<Error>()
        DispatchQueue.concurrentPerform(iterations: 4) { _ in
            do {
                let p = try NiimPrinter()
                try p.connectVirtual(b1Dump, options: noHeartbeat)
                _ = try p.renderTemplate(assetTag, data: assetData)
            } catch {
                errors.add(error)
            }
        }
        XCTAssertTrue(errors.all.isEmpty, "\(errors.all)")
    }

    func testPrintBatchAndQueue() throws {
        let p = try NiimPrinter()
        try p.connectVirtual(b1Dump, options: noHeartbeat)
        var px = Data(count: 120 * 64)
        for y in 0..<64 { for x in 0..<120 { px[y * 120 + x] = (x / 8 + y / 8) % 2 == 0 ? 0 : 255 } }
        let page = NiimPage(pixels: px, width: 120, height: 64, options: #"{"format":"gray"}"#)
        let opts = #"{"statusPollIntervalMs":20}"#

        // The virtual printer always reports "page 1 of 1": single page jobs only.
        let res = object(try p.printBatch([page], options: opts))
        XCTAssertEqual(res["pages"] as? Int, 1)
        XCTAssertEqual((res["images"] as? [[String: Int]])?.first?["cols"], 120)
        XCTAssertGreaterThan(res["jobId"] as? Int ?? 0, 0)

        var short = page
        short.pixels = px.prefix(10)
        XCTAssertThrowsError(try p.printBatch([page, short], options: opts)) {
            XCTAssertTrue(($0 as? NiimError)?.message.contains("page 2") ?? false, "\($0)")
        }
        XCTAssertThrowsError(try p.printBatch([], options: opts)) {
            XCTAssertTrue(String(describing: $0).contains("no pages"), "\($0)")
        }

        let job = object(try p.submit([page], options: opts))
        let id = job["id"] as? Int ?? 0
        XCTAssertEqual(object(try p.waitJob(id))["state"] as? String, "done")

        try p.pauseQueue()
        let a = object(try p.submit([page]))["id"] as? Int ?? 0
        let b = object(try p.submit([page]))["id"] as? Int ?? 0
        XCTAssertEqual(object(try p.job(a))["state"] as? String, "queued")
        XCTAssertEqual(object(try p.cancelJob(a))["state"] as? String, "cancelled")
        XCTAssertEqual(try p.clearQueue(), 1)
        XCTAssertThrowsError(try p.waitJob(b)) {
            XCTAssertTrue(($0 as? NiimError)?.message.contains("cancelled") ?? false, "\($0)")
        }
        try p.resumeQueue()
        XCTAssertTrue(try p.jobs().contains(#""id":\#(b)"#))
    }

    func testPNGPrinter() throws {
        let p = try NiimPrinter()
        XCTAssertEqual(object(try p.connectPNG(options: #"{"model":"B1"}"#))["printTask"] as? String, "B1")
        let res = object(try p.printTemplate(assetTag, data: assetData, options: #"{"statusPollIntervalMs":5}"#))
        let pages = try p.pngPages(jobId: res["jobId"] as? Int)
        XCTAssertEqual(pages.count, 1)
        XCTAssertEqual(pages.first?.width, 240)
        XCTAssertEqual(pages.first?.height, 160)
        XCTAssertEqual(pages.first?.png.prefix(8), Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        XCTAssertEqual(try p.clearPNGPages(), 1)
    }
}
