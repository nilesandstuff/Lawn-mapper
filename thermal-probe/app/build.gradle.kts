/*
 * THERMAL PROBE: a throwaway test app for the AccuMEMS SK02 (thermal-probe/README.md).
 *
 * No libraries: Android's own USB host API speaks UVC to the camera (its stream is a bulk endpoint, so no native
 * libusb is needed). Built by workflow "T. Thermal probe" (.github/workflows/thermal-probe.yml) and signed with the
 * probe's own debug key (debug.keystore here, password "android"), so a new build installs over the old one.
 */
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun prop(name: String, fallback: String = ""): String = (project.findProperty(name) as String?) ?: fallback

android {
    namespace = "app.lawnmapper.thermalprobe"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.lawnmapper.thermalprobe"
        minSdk = 29
        targetSdk = 35
        versionCode = prop("versionCode", "1").toInt()
        versionName = prop("versionName", "dev")
    }

    signingConfigs {
        getByName("debug") {
            storeFile = file("../debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        debug { isMinifyEnabled = false }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
