// Plain Java consumer of :niimblue (checks the API from Java and that a non-KMP
// JVM project resolves the jvm variant). `./gradlew :examples-java:run`
plugins {
    application
}

java {
    toolchain.languageVersion = JavaLanguageVersion.of(libs.versions.jvmToolchain.get().toInt())
}

dependencies {
    implementation(project(":niimblue"))
}

application {
    mainClass = "io.github.multimote.niimblue.example.Main"
}

tasks.named<JavaExec>("run") {
    val testdata = rootDir.resolve("../../go/testdata").canonicalFile
    args(testdata.resolve("asset-tag.niim").path, testdata.resolve("b1_print_dump.txt").path)
}
