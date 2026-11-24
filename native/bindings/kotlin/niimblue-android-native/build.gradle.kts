// libniimblue_jni.so for Android, built from native/CMakeLists.txt with the NDK.
// Contains no Kotlin: the API lives in :niimblue, whose androidMain depends on this module.
plugins {
    alias(libs.plugins.androidLibrary)
    `maven-publish`
}

android {
    namespace = "io.github.multimote.niimblue.nativelib"
    compileSdk = libs.versions.android.compileSdk.get().toInt()
    ndkVersion = libs.versions.android.ndk.get()

    defaultConfig {
        minSdk = libs.versions.android.minSdk.get().toInt()
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64", "x86")
        }
        externalNativeBuild {
            cmake {
                arguments += listOf(
                    "-DNIIM_BUILD_JNI=ON",
                    "-DNIIM_BUILD_SHARED=OFF",
                    "-DNIIM_BUILD_STATIC=OFF",
                    "-DNIIM_BUILD_TESTS=OFF",
                    "-DNIIM_INSTALL=OFF",
                    "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON",
                )
                targets += "niimblue_jni"
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("../../../CMakeLists.txt")
            version = libs.versions.android.cmake.get()
        }
    }

    publishing {
        singleVariant("release")
    }
}

publishing {
    publications {
        register<MavenPublication>("release") {
            artifactId = "niimblue-android-native"
            afterEvaluate { from(components["release"]) }
        }
    }
}
