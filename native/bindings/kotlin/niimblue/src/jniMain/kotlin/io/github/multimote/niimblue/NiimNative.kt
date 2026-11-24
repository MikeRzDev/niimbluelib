package io.github.multimote.niimblue

/** Loads the JNI library (differs per platform: jar resource on the desktop, APK on Android). */
internal expect fun loadNativeLibrary()

/**
 * The JNI layer (native/bindings/jni/niimblue_jni.c registers these in JNI_OnLoad).
 * Every String result is the library's JSON; failures throw [NiimException].
 */
internal object NiimNative {
    init {
        loadNativeLibrary()
    }

    @JvmStatic external fun version(): String
    @JvmStatic external fun niimbluelibVersion(): String
    @JvmStatic external fun listSerialPorts(): String
    @JvmStatic external fun create(): Long
    @JvmStatic external fun destroy(handle: Long)
    @JvmStatic external fun setEventListener(handle: Long, listener: NiimEventListener?)
    @JvmStatic external fun connectSerial(handle: Long, port: String, options: String?): String
    @JvmStatic external fun connectCustom(handle: Long, transport: NiimTransport, options: String?): String
    @JvmStatic external fun feed(handle: Long, data: ByteArray, offset: Int, length: Int)
    @JvmStatic external fun transportClosed(handle: Long)
    @JvmStatic external fun disconnect(handle: Long)
    @JvmStatic external fun call(handle: Long, method: String, params: String?): String
    @JvmStatic external fun callBinary(handle: Long, method: String, params: String?, data: ByteArray?): String
}
