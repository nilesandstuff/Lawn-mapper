/*
 * THE YARD AR APP (core session, 2026-11-07; docs/SCAN-PLAN.md section 10, android/README.md).
 *
 * A thin native shell: ARCore and the camera here, everything the user sees and does in the scan site's own page,
 * loaded into a WebView over the camera. So a change to what the app does is a deploy of the scan site, not a new
 * APK; the APK changes only when the bridge between the two needs something new (BRIDGE below).
 *
 * TWO BUILDS, dev and store (productFlavors below): the dev one carries the USB thermal camera, the store one cannot.
 *
 * Built by workflow "A. Android app" (.github/workflows/android.yml); the inputs come as Gradle properties:
 *   -PscanUrl=https://scan.<home domain>   the page it opens (never written into the repository)
 *   -PversionCode=<n> -PversionName=<s>      from the workflow run
 *   -PkeystorePath=... -PkeystorePass=...    the release key, kept in the private R2 bucket
 *   -ParcoreApiKey=...                       optional: ARCore's Geospatial API (a GitHub secret)
 */
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun prop(name: String, fallback: String = ""): String = (project.findProperty(name) as String?) ?: fallback

android {
    namespace = "app.lawnmapper.ar"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.lawnmapper.ar"
        minSdk = 26
        targetSdk = 35
        versionCode = prop("versionCode", "1").toInt()
        versionName = prop("versionName", "dev")
        // the bridge's own version: the page reads it and asks for an update when it needs a newer one
        buildConfigField("int", "BRIDGE", "10")
        buildConfigField("String", "SCAN_URL", "\"${prop("scanUrl", "https://scan.example.com")}\"")
        val key = prop("arcoreApiKey")
        buildConfigField("boolean", "GEO_KEY", if (key.isNotEmpty()) "true" else "false")
        manifestPlaceholders["arcoreApiKey"] = key
    }

    /* TWO BUILDS (2026-11-15; the owner: "thermal will not be packaged in the public release app... keep the code
       neatly marked so that it's not accidentally copied over to the production version"):
         dev    what the owner installs today: everything, plus src/dev/ (the USB thermal camera; src/dev/README.md)
         store  what a Play Store release is built from: src/store/ in its place, which holds an empty Extras.kt
       Workflow "A. Android app" builds dev. Nothing under src/main/ may import from src/dev/. */
    flavorDimensions += "kind"
    productFlavors {
        create("dev") { dimension = "kind" }
        create("store") { dimension = "kind" }
    }

    signingConfigs {
        create("release") {
            val path = prop("keystorePath")
            if (path.isNotEmpty()) {
                storeFile = file(path)
                storePassword = prop("keystorePass")
                keyAlias = "lawnar"
                keyPassword = prop("keystorePass")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (prop("keystorePath").isNotEmpty()) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("com.google.ar:core:1.57.0")
    // the Geospatial API needs Google's fused location provider linked in (ARCore throws at configure without it)
    implementation("com.google.android.gms:play-services-location:21.3.0")
}
