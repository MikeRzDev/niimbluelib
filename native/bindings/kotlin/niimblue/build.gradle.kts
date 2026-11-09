// Kotlin Multiplatform library: one Kotlin API (src/jniMain) for the desktop JVM
// and Android, on top of the JNI layer in native/bindings/jni.
//
//   jvm     -> the JNI library for this machine is built with CMake and packed into
//              the jar under natives/<os>-<arch>/ (plus anything in prebuilt/natives/)
//   android -> libniimblue_jni.so comes from :niimblue-android-native (NDK build)
//
// Only NativeLibrary.load() differs between the two (src/jvmMain, src/androidMain).
import org.jetbrains.kotlin.gradle.ExperimentalKotlinGradlePluginApi
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion
import org.jetbrains.kotlin.gradle.plugin.KotlinPlatformType

plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.androidMultiplatformLibrary)
    `maven-publish`
}

val nativeRoot: File = rootDir.resolve("../..").canonicalFile // niimbluelib/native

// ---- desktop JNI library ----

val hostOs: String = System.getProperty("os.name").lowercase().let {
    when {
        it.startsWith("mac") || it.startsWith("darwin") -> "macos"
        it.startsWith("windows") -> "windows"
        else -> "linux"
    }
}
val hostArch: String = when (val a = System.getProperty("os.arch").lowercase()) {
    "aarch64", "arm64" -> "aarch64"
    "amd64", "x86_64", "x64" -> "x86_64"
    else -> a
}
val skipDesktopNative = providers.gradleProperty("niimblue.skipDesktopNative").map { it.toBoolean() }.getOrElse(false)
val cmakeExe = providers.gradleProperty("niimblue.cmake").getOrElse("cmake")
val desktopBuildDir = layout.buildDirectory.dir("native-desktop")
val nativeResources = layout.buildDirectory.dir("generated/native-resources")

val configureDesktopNative = tasks.register<Exec>("configureDesktopNative") {
    description = "Configures the desktop JNI library build (CMake)."
    val out = desktopBuildDir.get().asFile
    inputs.file(nativeRoot.resolve("CMakeLists.txt"))
    outputs.file(out.resolve("CMakeCache.txt"))
    // FindJNI needs a JDK; default to the one running Gradle
    environment("JAVA_HOME", System.getenv("JAVA_HOME") ?: System.getProperty("java.home"))
    commandLine(
        cmakeExe, "-S", nativeRoot.path, "-B", out.path,
        "-DCMAKE_BUILD_TYPE=Release",
        "-DNIIM_BUILD_JNI=ON", "-DNIIM_BUILD_SHARED=OFF", "-DNIIM_BUILD_STATIC=OFF",
        "-DNIIM_BUILD_TESTS=OFF", "-DNIIM_INSTALL=OFF",
    )
}

val buildDesktopNative = tasks.register<Exec>("buildDesktopNative") {
    description = "Builds the JNI library for this machine ($hostOs-$hostArch)."
    dependsOn(configureDesktopNative)
    val out = desktopBuildDir.get().asFile
    inputs.files(
        fileTree(nativeRoot) {
            include("CMakeLists.txt", "src/**", "include/**", "generated/niim_bundle.c", "third_party/quickjs/**", "bindings/jni/**")
        },
    )
    outputs.dir(out)
    commandLine(cmakeExe, "--build", out.path, "--config", "Release", "--target", "niimblue_jni", "--parallel")
}

val desktopNativeResources = tasks.register<Sync>("desktopNativeResources") {
    description = "Puts the desktop JNI library under natives/<os>-<arch>/ for the jar."
    into(nativeResources.map { it.dir("natives/$hostOs-$hostArch") })
    if (!skipDesktopNative) {
        dependsOn(buildDesktopNative)
        from(desktopBuildDir) {
            include("libniimblue_jni.dylib", "libniimblue_jni.so", "niimblue_jni.dll", "Release/niimblue_jni.dll")
            eachFile { path = name }
        }
    }
    includeEmptyDirs = false
}

kotlin {
    jvmToolchain(libs.versions.jvmToolchain.get().toInt())

    // Consumers on older Kotlin (1.9+) can read the published metadata and stdlib
    coreLibrariesVersion = "2.0.21"
    compilerOptions {
        apiVersion = KotlinVersion.KOTLIN_2_0
        languageVersion = KotlinVersion.KOTLIN_2_0
    }

    jvm()

    android {
        namespace = "io.github.multimote.niimblue"
        compileSdk = libs.versions.android.compileSdk.get().toInt()
        minSdk = libs.versions.android.minSdk.get().toInt()

        optimization {
            consumerKeepRules.apply {
                publish = true
                file("consumer-rules.pro")
            }
        }

        // src/jniTest runs on a device / emulator too: ./gradlew :niimblue:connectedAndroidDeviceTest
        withDeviceTestBuilder {
            sourceSetTreeName = "test"
        }.configure {
            instrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        }
    }

    // jniMain: shared by jvm and android. Both are JVM platforms, so `external`,
    // java.* and kotlin.jvm.* are available there.
    @OptIn(ExperimentalKotlinGradlePluginApi::class)
    applyDefaultHierarchyTemplate {
        common {
            group("jni") {
                withCompilations {
                    it.target.platformType == KotlinPlatformType.jvm || it.target.platformType == KotlinPlatformType.androidJvm
                }
            }
        }
    }

    sourceSets {
        androidMain.dependencies {
            implementation(project(":niimblue-android-native"))
        }
        jvmMain {
            // prebuilt/natives/<os>-<arch>/: libraries built on other machines (other OSes / CPUs)
            resources.srcDir("prebuilt")
            resources.srcDir(nativeResources)
        }
        getByName("jniTest") {
            resources.srcDir(nativeRoot.resolve("go/testdata"))
            dependencies {
                implementation(kotlin("test"))
            }
        }
        getByName("androidDeviceTest").dependencies {
            implementation(libs.androidx.test.runner)
            implementation(libs.androidx.test.junit)
        }
    }
}

tasks.named("jvmProcessResources") { dependsOn(desktopNativeResources) }

tasks.named<Test>("jvmTest") {
    jvmArgs("-Xcheck:jni") // the JVM validates every JNI call of the native layer
    testLogging { showStandardStreams = true }
}
