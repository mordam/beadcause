import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/**
 * Sideload signing key.
 *
 * The keystore lives beside the server's token in ~/.config/beadcause rather than
 * in the project, so the repo never carries a signing secret. `npm run android:key`
 * creates it. Without it the build still works — it just falls back to the debug
 * key, which is fine for `adb install` but means a rebuilt APK can't upgrade an
 * installed one signed the other way.
 */
val keystoreProps = Properties().apply {
    val f = File(System.getProperty("user.home"), ".config/beadcause/android-keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val hasSideloadKey = keystoreProps.getProperty("storeFile")?.let { File(it).exists() } == true

/**
 * Which build this is — and why it cannot go on being `1`.
 *
 * The app updates itself now (see `Updater.kt`): a deploy that touches `android/`
 * republishes the APK, and the phone compares what is published against what it is
 * running. A fixed `versionCode` makes that comparison meaningless — every build is the
 * same build, so either the phone never updates or it reinstalls the same one forever —
 * and it is also what Android's own downgrade check reads, so a monotonic number is what
 * lets the platform tell an upgrade from a replay.
 *
 * `scripts/build-android.sh` passes both in, derived from the commit count, and writes
 * the *same* pair into `public/beadcause.apk.json` beside the published file, which is
 * how the daemon can answer "which build is this?" without parsing an APK. The fallbacks
 * here are for a build run by hand from Android Studio or a bare `./gradlew`: `1` and
 * `1.0`, exactly what this said before, so nothing about that path changes — but such a
 * build publishes no sidecar either, and `apkInfo` in lib/update.js reports an unknown
 * version rather than a wrong one.
 */
val buildNumber = (project.findProperty("beadcauseVersionCode") as String?)?.toIntOrNull() ?: 1
val buildName = (project.findProperty("beadcauseVersionName") as String?)?.takeIf { it.isNotBlank() } ?: "1.0"

android {
    namespace = "m4m.beadcause"
    compileSdk = 35

    defaultConfig {
        applicationId = "m4m.beadcause"
        minSdk = 26
        targetSdk = 35
        versionCode = buildNumber
        versionName = buildName
    }

    signingConfigs {
        if (hasSideloadKey) {
            create("sideload") {
                storeFile = File(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // R8 would need keep rules for the @JavascriptInterface bridge and for
            // ML Kit; not worth it for a single-user app that is already only a few MB.
            isMinifyEnabled = false
            signingConfig =
                if (hasSideloadKey) signingConfigs.getByName("sideload")
                else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        viewBinding = true
        // Off by default since AGP 8; MainActivity stamps VERSION_NAME into the
        // WebView's user agent so the PWA can tell it's running inside the shell.
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf("META-INF/*.version", "DebugProbesKt.bin")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.2.0")
    implementation("androidx.activity:activity-ktx:1.9.3")

    // Chrome Custom Tabs. A link in a brief is usually a signed-in page — a GitHub
    // PR, a claude.ai artifact — and a Custom Tab borrows Chrome's cookie jar, so
    // it opens the way it does in Chrome. Our own WebView would be logged out.
    implementation("androidx.browser:browser:1.8.0")
    implementation("androidx.lifecycle:lifecycle-service:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // The whole network layer. Responses are parsed with org.json (in the platform),
    // because native only reads a handful of fields — the WebView renders everything.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Pairing by QR. The bundled barcode model keeps this working on a phone with
    // no Play Services update, at the cost of a few MB.
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
}
