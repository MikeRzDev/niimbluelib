package io.github.multimote.niimblue

import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

// Runs on the desktop JVM (jvmTest) and on Android (connectedAndroidDeviceTest).
// Same fixtures as the Go tests (native/go/testdata, on the test classpath): a recorded
// B1 session for the virtual printer and the 30x20 mm asset tag from the NiimBlue editor.
private fun fixtureBytes(name: String): ByteArray =
    NiimPrinterTest::class.java.classLoader!!.getResourceAsStream(name)?.use { it.readBytes() }
        ?: error("test resource $name missing")

private fun fixture(name: String): String = fixtureBytes(name).decodeToString()

private val b1Dump = fixture("b1_print_dump.txt")
private val assetTag = fixtureBytes("asset-tag.niim")
private const val ASSET_DATA =
    """{"uuid":"794ad7ca-1ae2-451e-b06a-d93fd303e9d9","asset_name":"Oppenheimer","asset_type":"Compute Node","site":"Manhattan"}"""
private const val NO_HEARTBEAT = """{"heartbeat":false}"""

private fun intField(json: String, name: String): Int =
    Regex("\"$name\"\\s*:\\s*(-?\\d+)").find(json)?.groupValues?.get(1)?.toInt() ?: error("no $name in $json")

private fun stringField(json: String, name: String): String =
    Regex("\"$name\"\\s*:\\s*\"([^\"]*)\"").find(json)?.groupValues?.get(1) ?: error("no $name in $json")

class NiimPrinterTest {
    @Test
    fun versions() {
        assertTrue(NiimPrinter.version().isNotEmpty())
        assertTrue(NiimPrinter.niimbluelibVersion().matches(Regex("""\d+\.\d+\.\d+.*""")))
        assertTrue(NiimPrinter.listSerialPorts().startsWith("["))
    }

    @Test
    fun generatedMethods() = NiimPrinter().use { p ->
        assertTrue(p.printTasks().contains("\"B1\""))
        assertFalse(p.isConnected())
        assertFalse(p.queuePaused())
        p.pauseQueue()
        assertTrue(p.queuePaused())
        p.resumeQueue()
        assertEquals(0, p.clearQueue())
        assertFailsWith<NiimException> { p.printerInfo() }
        assertEquals("""["uuid","asset_name","asset_type","site"]""", p.templateTags(assetTag))
        // Binary payload through niim_call_bin
        assertFailsWith<NiimException> { p.registerFont("Junk", "not a font".toByteArray()) }
        Unit
    }

    @Test
    fun renderTemplate() = NiimPrinter().use { p ->
        val out = p.renderTemplate(assetTag, ASSET_DATA)
        assertEquals(240, intField(out, "width"))
        assertEquals(160, intField(out, "height"))
        assertEquals("top", stringField(out, "printDirection"))
        val rgba = Base64.getDecoder().decode(stringField(out, "pixels"))
        assertEquals(240 * 160 * 4, rgba.size)
        val black = (rgba.indices step 4).count { rgba[it].toInt() == 0 }
        assertTrue(black > 2000, "rendered label has only $black black pixels")
    }

    @Test
    fun templateTags() = NiimPrinter().use { p ->
        val tags = p.callBinary("templateTags", null, assetTag)
        assertEquals("""["uuid","asset_name","asset_type","site"]""", tags)
        // Only .niim packages, not template JSON
        val e = assertFailsWith<NiimException> { p.templateTags("""{"format":"niimblue-template"}""".encodeToByteArray()) }
        assertTrue(e.message!!.contains(".niim template package"), e.message)
    }

    @Test
    fun printTemplateOnVirtualPrinter() = NiimPrinter().use { p ->
        val events = CopyOnWriteArrayList<String>()
        p.setEventListener { name, _ -> events += name }

        val e = assertFailsWith<NiimException> { p.printTemplate(assetTag, ASSET_DATA) }
        assertEquals(NiimException.OPERATION, e.code)

        val info = p.connectVirtual(b1Dump, NO_HEARTBEAT)
        assertEquals("B1", stringField(info, "printTask"))
        val res = p.printTemplate(assetTag, ASSET_DATA, """{"quantity":1,"statusPollIntervalMs":20}""")
        assertEquals(1, intField(res, "labels"))
        assertEquals(1, intField(res, "pages"))
        assertTrue("connect" in events && "printend" in events, "events: $events")

        // missing field: fails before printing
        val bad = assertFailsWith<NiimException> { p.printTemplate(assetTag, """[$ASSET_DATA,{"uuid":"x"}]""") }
        assertTrue("asset_name" in bad.message!!, bad.message)
        p.disconnect()
    }

    @Test
    fun unicodeRoundTrip() = NiimPrinter().use { p ->
        // Java -> UTF-8 -> library -> UTF-8 -> Java, with a character outside the BMP
        val method = "nö-such-mëthod-😀"
        val e = assertFailsWith<NiimException> { p.call(method) }
        assertTrue(e.message!!.endsWith(method), e.message)
        assertEquals(NiimException.OPERATION, e.code)
        assertEquals(NiimException.INVALID_ARG, assertFailsWith<NiimException> { p.call("a\u0000b") }.code)
    }

    @Test
    fun customTransportCallsBackOnLibraryThread() = NiimPrinter().use { p ->
        val writes = AtomicInteger()
        val threads = CopyOnWriteArrayList<String>()
        val e = assertFailsWith<NiimException> {
            p.connectCustom({ data ->
                writes.incrementAndGet()
                threads += Thread.currentThread().name
                data.isEmpty() // fail every real write
            }, NO_HEARTBEAT)
        }
        assertTrue(writes.get() > 0, "transport was never written to")
        assertTrue(threads.none { it == Thread.currentThread().name }, "write ran on the caller thread")
        assertTrue(e.code == NiimException.OPERATION || e.code == NiimException.TRANSPORT, "code ${e.code}: ${e.message}")
    }

    @Test
    fun reentrantCallsFailInsteadOfDeadlocking() = NiimPrinter().use { p ->
        val codes = CopyOnWriteArrayList<Int>()
        p.setEventListener { name, _ ->
            if (name == "connect") {
                try {
                    p.call("isConnected")
                } catch (e: NiimException) {
                    codes += e.code
                }
            }
        }
        p.connectVirtual(b1Dump, NO_HEARTBEAT)
        assertEquals(listOf(NiimException.REENTRANT), codes)
    }

    @Test
    fun swapListenersWhileEventsFire() = NiimPrinter().use { p ->
        val a = AtomicInteger()
        val b = AtomicInteger()
        val listenerB = NiimEventListener { _, _ -> b.incrementAndGet() }
        val listenerA = NiimEventListener { name, _ ->
            a.incrementAndGet()
            if (name == "heartbeat") p.setEventListener(listenerB) // from inside a listener
        }
        p.setEventListener(listenerA)
        p.connectVirtual(b1Dump, """{"heartbeatIntervalMs":10}""")
        val end = System.nanoTime() + 300_000_000
        var i = 0
        while (System.nanoTime() < end) {
            p.setEventListener(listOf(listenerA, null, listenerB)[i++ % 3])
            Thread.sleep(1)
        }
        p.setEventListener(listenerB)
        val before = b.get()
        Thread.sleep(150)
        assertTrue(b.get() > before, "last listener got no events (a=${a.get()} b=${b.get()})")
    }

    @Test
    fun closedPrinterThrows() {
        val p = NiimPrinter()
        p.close()
        p.close() // twice is fine
        assertEquals(NiimException.CLOSED, assertFailsWith<NiimException> { p.call("isConnected") }.code)
    }

    @Test
    fun manyPrintersInParallel() {
        val threads = (1..4).map {
            Thread {
                NiimPrinter().use { p ->
                    p.connectVirtual(b1Dump, NO_HEARTBEAT)
                    repeat(3) { p.renderTemplate(assetTag, ASSET_DATA) }
                }
            }
        }
        val errors = CopyOnWriteArrayList<Throwable>()
        threads.forEach { t -> t.setUncaughtExceptionHandler { _, e -> errors += e }; t.start() }
        threads.forEach { it.join() }
        assertTrue(errors.isEmpty(), "errors: $errors")
    }

    @Test
    fun printBatchAndQueue() = NiimPrinter().use { p ->
        p.connectVirtual(b1Dump, NO_HEARTBEAT)
        val px = ByteArray(120 * 64) { i -> if (((i % 120) / 8 + (i / 120) / 8) % 2 == 0) 0 else 255.toByte() }
        val page = NiimPage(px, 120, 64, """{"format":"gray"}""")
        val opts = """{"statusPollIntervalMs":20}"""

        // The virtual printer always reports "page 1 of 1": single page jobs only.
        val res = p.printBatch(listOf(page), opts)
        assertEquals(1, intField(res, "pages"))
        assertTrue(res.contains(""""images":[{"cols":120,"rows":64,"quantity":1}]"""), res)
        assertTrue(intField(res, "jobId") > 0)

        val short = NiimPage(px.copyOf(10), 120, 64, """{"format":"gray"}""")
        val bad = assertFailsWith<NiimException> { p.printBatch(listOf(page, short), opts) }
        assertTrue(bad.message!!.contains("page 2"), bad.message)
        assertTrue(assertFailsWith<NiimException> { p.printBatch(emptyList(), opts) }.message!!.contains("no pages"))

        val id = intField(p.submit(listOf(page), opts), "id")
        assertEquals("done", stringField(p.waitJob(id), "state"))

        p.pauseQueue()
        val a = intField(p.submit(listOf(page)), "id")
        val b = intField(p.submit(listOf(page)), "id")
        assertEquals("queued", stringField(p.job(a), "state"))
        assertEquals("cancelled", stringField(p.cancelJob(a), "state"))
        assertEquals(1, p.clearQueue())
        val cancelled = assertFailsWith<NiimException> { p.waitJob(b) }
        assertTrue(cancelled.message!!.contains("cancelled"), cancelled.message)
        p.resumeQueue()
        assertTrue(p.jobs().contains(""""id":$b"""))
    }

    @Test
    fun pngPrinter() = NiimPrinter().use { p ->
        assertEquals("B1", stringField(p.connectPng("""{"model":"B1"}"""), "printTask"))
        val res = p.printTemplate(assetTag, ASSET_DATA, """{"statusPollIntervalMs":5}""")
        val pages = p.pngPages(intField(res, "jobId"))
        assertEquals(240, intField(pages, "width"))
        assertEquals(160, intField(pages, "height"))
        val png = Base64.getDecoder().decode(stringField(pages, "png"))
        assertTrue(png.copyOfRange(0, 8).contentEquals(byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10)))
        assertEquals(1, p.clearPngPages())
    }
}
