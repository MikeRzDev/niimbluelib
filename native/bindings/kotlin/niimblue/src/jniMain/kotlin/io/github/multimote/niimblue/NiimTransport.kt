package io.github.multimote.niimblue

/**
 * A transport you implement (e.g. Bluetooth LE), see [NiimPrinter.connectCustom].
 * [write] sends bytes to the printer and returns true on success. It runs on
 * the library's thread; pass every chunk received from the printer to
 * [NiimPrinter.feed].
 */
fun interface NiimTransport {
    fun write(data: ByteArray): Boolean
}
