package io.github.multimote.niimblue

import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

/**
 * A NIIMBOT printer handle (libniimblue: niimbluelib running in an embedded
 * QuickJS engine). Same API on the desktop JVM and Android, usable from Java.
 *
 * All calls block until the printer answers and may be made from any thread.
 * Options, data and results are JSON strings, as documented in
 * native/include/niimblue.h; parse them with the JSON library you already use.
 * Failures throw [NiimException].
 *
 * ```kotlin
 * NiimPrinter().use { p ->
 *     p.connectSerial("/dev/ttyACM0")
 *     p.printTemplate(File("label.niim").readBytes(), """{"uuid":"..."}""")
 * }
 * ```
 *
 * Don't call [close] from inside the event listener or the transport.
 */
class NiimPrinter : NiimPrinterApi(), AutoCloseable {
    private val lock = ReentrantReadWriteLock()
    private val connectLock = Any()
    private var handle: Long = NiimNative.create()

    private inline fun <T> withHandle(block: (Long) -> T): T = lock.read {
        val h = handle
        if (h == 0L) throw NiimException(NiimException.CLOSED, "printer is closed")
        block(h)
    }

    /** Receive library events (or stop with null). May be called from inside the listener. */
    fun setEventListener(listener: NiimEventListener?) = withHandle { NiimNative.setEventListener(it, listener) }

    /** Connect over a USB / Bluetooth serial port ("/dev/ttyACM0", "COM3"). Returns the connection info JSON. */
    @JvmOverloads
    fun connectSerial(port: String, optionsJson: String? = null): String = withHandle { h ->
        synchronized(connectLock) { NiimNative.connectSerial(h, port, optionsJson) }
    }

    /** Connect over a transport you implement (e.g. Bluetooth LE); feed received bytes with [feed]. */
    @JvmOverloads
    fun connectCustom(transport: NiimTransport, optionsJson: String? = null): String = withHandle { h ->
        synchronized(connectLock) { NiimNative.connectCustom(h, transport, optionsJson) }
    }

    /** Bytes received by a custom transport. */
    @JvmOverloads
    fun feed(data: ByteArray, offset: Int = 0, length: Int = data.size - offset) =
        withHandle { NiimNative.feed(it, data, offset, length) }

    /** The custom transport was closed by the device. */
    fun transportClosed() = withHandle { NiimNative.transportClosed(it) }

    fun disconnect() = withHandle { h -> synchronized(connectLock) { NiimNative.disconnect(h) } }

    /** Generic call: getPrinterInfo, fetchRfidInfo, fetchHeartbeat, setSoundEnabled, listFonts, templateTags, ... */
    @JvmOverloads
    fun call(method: String, paramsJson: String? = null): String = withHandle { NiimNative.call(it, method, paramsJson) }

    /** Generic call with a binary payload (niim_call_bin, the bytes are copied); [data] may be null. */
    @JvmOverloads
    fun callBinary(method: String, paramsJson: String? = null, data: ByteArray? = null): String =
        withHandle { NiimNative.callBinary(it, method, paramsJson, data) }

    // The typed methods (job, cancelJob, pngPages, registerFont, ...) are generated: NiimPrinterApi.kt
    override fun apiCall(method: String, paramsJson: String?, data: ByteArray?): String = callBinary(method, paramsJson, data)

    /** Disconnect and free the handle. Waits for calls still running on other threads. */
    override fun close() {
        lock.write {
            val h = handle
            handle = 0L
            if (h != 0L) NiimNative.destroy(h)
        }
    }

    companion object {
        /** Version of the native library. */
        @JvmStatic
        fun version(): String = NiimNative.version()

        /** Version of the embedded niimbluelib. */
        @JvmStatic
        fun niimbluelibVersion(): String = NiimNative.niimbluelibVersion()

        /** JSON array of candidate serial port paths. */
        @JvmStatic
        fun listSerialPorts(): String = NiimNative.listSerialPorts()
    }
}
