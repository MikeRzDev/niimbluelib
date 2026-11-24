plugins {
    alias(libs.plugins.kotlinMultiplatform) apply false
    alias(libs.plugins.androidMultiplatformLibrary) apply false
    alias(libs.plugins.androidLibrary) apply false
}

allprojects {
    group = "io.github.multimote"
    version = "0.1.0"
}

