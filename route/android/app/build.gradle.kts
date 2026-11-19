plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The planner's address and the version come from the deploy (route-deploy.yml): the domain is
// never written into the repository. A local build points at an example address.
val plannerUrl = (findProperty("plannerUrl") as String?) ?: "https://route.example.com"
val buildNumber = ((findProperty("buildNumber") as String?) ?: "1").toInt()
val keystore: String? = System.getenv("RR_KEYSTORE")

android {
    namespace = "app.routereader"
    compileSdk = 34
    defaultConfig {
        applicationId = "app.routereader"
        minSdk = 26
        targetSdk = 34
        versionCode = buildNumber
        versionName = "1.$buildNumber"
        buildConfigField("String", "PLANNER_URL", "\"$plannerUrl\"")
    }
    buildFeatures { buildConfig = true }
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("RR_KEYSTORE_PASS")
                keyAlias = "routereader"
                keyPassword = System.getenv("RR_KEYSTORE_PASS")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            // the same key every build, so an update installs over the last one
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
