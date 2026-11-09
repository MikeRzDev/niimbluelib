package io.github.multimote.niimblue

// libniimblue_jni.so is packaged in the APK by :niimblue-android-native.
internal actual fun loadNativeLibrary() {
    System.loadLibrary("niimblue_jni")
}
