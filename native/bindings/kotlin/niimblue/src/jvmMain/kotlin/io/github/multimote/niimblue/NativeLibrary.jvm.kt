package io.github.multimote.niimblue

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

/**
 * Desktop: load the JNI library, first match wins:
 *  1. system property `niimblue.library.path` (absolute path to the library file)
 *  2. `natives/<os>-<arch>/` in the jar, extracted once to a cache directory
 *  3. `System.loadLibrary("niimblue_jni")` (java.library.path)
 */
internal actual fun loadNativeLibrary() {
    System.getProperty("niimblue.library.path")?.let {
        System.load(File(it).absolutePath)
        return
    }
    val resource = "natives/${hostPlatform()}/${System.mapLibraryName("niimblue_jni")}"
    val bytes = NiimNative::class.java.classLoader?.getResourceAsStream(resource)?.use { it.readBytes() }
    if (bytes != null) {
        System.load(extract(bytes, File(resource).name).absolutePath)
        return
    }
    try {
        System.loadLibrary("niimblue_jni")
    } catch (e: UnsatisfiedLinkError) {
        throw UnsatisfiedLinkError(
            "niimblue: no JNI library for ${hostPlatform()} in the jar ($resource) or on java.library.path; " +
                "set -Dniimblue.library.path=/path/to/${System.mapLibraryName("niimblue_jni")}",
        ).apply { initCause(e) }
    }
}

private fun hostPlatform(): String {
    val os = System.getProperty("os.name").lowercase().let {
        when {
            it.startsWith("mac") || it.startsWith("darwin") -> "macos"
            it.startsWith("windows") -> "windows"
            else -> "linux"
        }
    }
    val arch = when (val a = System.getProperty("os.arch").lowercase()) {
        "aarch64", "arm64" -> "aarch64"
        "amd64", "x86_64", "x64" -> "x86_64"
        else -> a
    }
    return "$os-$arch"
}

/** Write the library to <tmp>/niimblue-<sha256 prefix>/<name>, reusing an identical copy. */
private fun extract(bytes: ByteArray, name: String): File {
    val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }.take(16)
    val dir = File(System.getProperty("java.io.tmpdir"), "niimblue-$hash")
    val target = File(dir, name)
    if (target.isFile && target.length() == bytes.size.toLong()) return target
    if (!dir.isDirectory && !dir.mkdirs() && !dir.isDirectory) throw IOException("cannot create $dir")
    // write to a temp file and move, so concurrent processes never load a partial file
    val tmp = File.createTempFile(name, ".tmp", dir)
    try {
        tmp.writeBytes(bytes)
        Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    } catch (e: IOException) {
        tmp.delete()
        if (!(target.isFile && target.length() == bytes.size.toLong())) throw e
    }
    return target
}
