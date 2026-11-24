package io.github.multimote.niimblue

/**
 * A failed libniimblue call. [code] is one of the `NIIM_E_*` codes
 * (constants below), [message] the library's error text.
 */
class NiimException(val code: Int, message: String) : RuntimeException(message) {
    companion object {
        const val INVALID_ARG = -1

        /** The operation failed inside niimbluelib (timeout, printer error, bad parameters, ...). */
        const val OPERATION = -2
        const val TRANSPORT = -3
        const val CLOSED = -4

        /** Called from inside the event listener or transport (would deadlock). */
        const val REENTRANT = -5
        const val NO_MEMORY = -6
        const val INIT = -7
    }
}
