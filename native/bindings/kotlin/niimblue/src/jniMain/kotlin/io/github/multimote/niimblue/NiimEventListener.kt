package io.github.multimote.niimblue

/**
 * Library events: `connect`, `disconnect`, `heartbeat`, `printprogress`,
 * `printpacketprogress`, `printend`, `log`, ... with a JSON payload.
 *
 * Runs on the library's thread: don't call [NiimPrinter] methods from it
 * (they fail with [NiimException.REENTRANT]); hand work off to another thread.
 */
fun interface NiimEventListener {
    fun onEvent(name: String, json: String)
}
