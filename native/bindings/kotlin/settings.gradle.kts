pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "niimblue-kotlin"

// :niimblue                 Kotlin Multiplatform library (jvm + android), the public API
// :niimblue-android-native  com.android.library that builds libniimblue_jni.so with the NDK
//                           (the KMP Android plugin can't build native code)
// :examples-java            plain Java program using :niimblue (Java interop check)
include(":niimblue", ":niimblue-android-native", ":examples-java")
