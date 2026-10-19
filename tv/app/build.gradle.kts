plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Where the screensaver page and feed live, and the feed's token. Set as
// GitHub secrets (FEED_BASE, FEED_TOKEN) for CI builds, or pass
// -PfeedBase=… -PfeedToken=… for a local build.
fun setting(env: String, prop: String): String =
    System.getenv(env)?.takeIf { it.isNotBlank() } ?: (project.findProperty(prop) as String?) ?: ""

android {
    namespace = "com.raadfxrd.tvlauncher"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.raadfxrd.tvlauncher"
        minSdk = 26 // Bravia A1 shipped on Android TV 8.0
        targetSdk = 34
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "0.1.${System.getenv("GITHUB_RUN_NUMBER") ?: "0"}"
        buildConfigField("String", "FEED_BASE", "\"${setting("FEED_BASE", "feedBase").trimEnd('/')}\"")
        buildConfigField("String", "FEED_TOKEN", "\"${setting("FEED_TOKEN", "feedToken")}\"")
    }

    // One fixed key, kept in this private repo, so every build installs over
    // the previous one. Fine for a sideloaded personal app; never publish it.
    signingConfigs {
        create("tv") {
            storeFile = file("tvlauncher.keystore")
            storePassword = "tvlauncher"
            keyAlias = "tvlauncher"
            keyPassword = "tvlauncher"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("tv")
        }
        debug {
            signingConfig = signingConfigs.getByName("tv")
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
    implementation("androidx.core:core-ktx:1.13.1")
}
