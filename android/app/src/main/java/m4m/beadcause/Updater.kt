package m4m.beadcause

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File

/**
 * The shell replacing itself.
 *
 * A beadcause deploy that touched `android/` rebuilds the APK and republishes it to
 * `public/beadcause.apk` — and until now that was where it stopped. The pages inside this
 * WebView were current within seconds of the daemon restarting, because they are fetched
 * over the tailnet every time; the WebView *itself* was however many builds old you last
 * remembered to install by hand, from a QR printed into a terminal you were not looking
 * at. The two drift, and the drift is invisible from the inside: everything looks fine
 * until a page calls a bridge method this build does not have.
 *
 * So this closes the loop the deploy opened. public/update.js hears that the APK was
 * rebuilt, this fetches it, and the user is asked once — after the bytes have landed, so
 * that saying yes costs a moment rather than a minute of watching a bar.
 *
 * ## Downloading is not installing, and only one of them is automatic
 *
 * Downloading 28 MB onto a phone over a private tailnet costs nothing anybody notices,
 * and doing it before the ask is the whole reason the ask can be answered instantly.
 * Installing restarts the app — losing whatever is on screen, and the notification the
 * watcher is holding with it — and is therefore never done without being asked, however
 * plainly correct the update is.
 *
 * ## The two ways an install can go, and why both are kept
 *
 * `PackageInstaller` is used rather than an `ACTION_VIEW` on a `content://` URI, because
 * only the session API can report what happened: the intent form hands the file to the
 * system installer and never hears another word, so "did it work?" becomes "did the
 * version change next time somebody looked". The session commits with a status receiver
 * (see [UpdateReceiver]) and every ending has a name.
 *
 * On Android 12 and up an *update to a package this app itself installed* may be applied
 * with `USER_ACTION_NOT_REQUIRED`, so the second update onward needs no system dialog at
 * all — the tap in the app is the whole of it. The first one goes through the platform's
 * confirm screen, because the installed copy came from a browser download or `adb` and
 * this app is not yet its installer of record. Both paths are live and neither is a
 * fallback for a bug: `STATUS_PENDING_USER_ACTION` is an ordinary answer and is handled
 * by starting the intent the installer hands back.
 *
 * ## What it will not do
 *
 * It will not install anything it was told about by the page. The page says *that* there
 * is an update; the version, the size and the URL are read from `/api/update` here, over
 * the paired connection, by the same code that then fetches the bytes. A WebView that
 * could name the file to install would be a WebView that could talk the phone into
 * installing something else, and the pages it renders come off a server this app is
 * deliberately incurious about.
 */
object Updater {

    /** Where a download lives until it is installed. Cache, because it is disposable. */
    private fun dir(ctx: Context) = File(ctx.cacheDir, "update")

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** `idle`, `downloading`, `ready`, `installing`, `failed`. Read by the page. */
    @Volatile private var phase: String = "idle"
    @Volatile private var versionName: String = ""
    @Volatile private var versionCode: Int = 0
    @Volatile private var error: String? = null
    @Volatile private var file: File? = null

    /** Whoever is showing this to somebody — MainActivity, while it is alive. */
    @Volatile private var watcher: ((String) -> Unit)? = null

    fun watch(fn: (String) -> Unit) {
        watcher = fn
        // Immediately, so a page that has just loaded over a download already in flight
        // draws the state rather than waiting for the next thing to change.
        fn(state())
    }

    fun unwatch() {
        watcher = null
    }

    /** Everything the page needs, in the shape public/update.js reads. */
    fun state(): String = JSONObject()
        .put("phase", phase)
        .put("versionName", versionName)
        .put("versionCode", versionCode)
        .put("error", error ?: JSONObject.NULL)
        .toString()

    private fun report(next: String, err: String? = null) {
        phase = next
        error = err
        watcher?.let { fn ->
            try {
                fn(state())
            } catch (e: Exception) {
                Log.w("Beadcause", "update state not delivered: ${e.message}")
            }
        }
    }

    /** This build, as the daemon numbers it. */
    fun installedVersion(): Int = BuildConfig.VERSION_CODE

    /**
     * Fetch the published APK, if it is newer than this build.
     *
     * Everything is decided here rather than by the caller, so that a second tap, a
     * second page, and the shell's own boot all converge on one download: already
     * downloading is a no-op, already downloaded at this version is a no-op, and a
     * version that is not ahead of ours is a no-op with a log line rather than an error
     * on screen — a phone running a *newer* build than the Mac has published is an
     * ordinary state during a session that is mid-flight, not a fault.
     */
    fun download(ctx: Context) {
        if (phase == "downloading" || phase == "installing") return
        val app = ctx.applicationContext
        scope.launch {
            try {
                val conn = Prefs.connection(app) ?: return@launch
                val apk = Api.update(conn).optJSONObject("apk") ?: return@launch
                val code = apk.optInt("versionCode", 0)
                val name = apk.optString("versionName", "")
                val size = apk.optLong("size", 0)
                val path = apk.optString("url", "/beadcause.apk")
                if (code <= 0) return@launch // No sidecar, or one that does not match the file.
                if (code <= installedVersion()) {
                    if (phase == "ready" && versionCode <= installedVersion()) {
                        // The build we were holding is the build that is now running.
                        file?.delete()
                        file = null
                        versionCode = 0
                        versionName = ""
                        report("idle")
                    }
                    return@launch
                }
                if (phase == "ready" && versionCode == code && file?.exists() == true) return@launch

                versionCode = code
                versionName = name.ifBlank { code.toString() }
                report("downloading")

                val dest = File(dir(app), "beadcause-$code.apk")
                Api.downloadTo(conn, path, dest, size)
                // Anything else in here is a build we are never going to install.
                dir(app).listFiles()?.forEach { if (it != dest) it.delete() }
                file = dest
                report("ready")
            } catch (e: Exception) {
                Log.w("Beadcause", "update download failed: ${e.message}")
                report("failed", e.message ?: "the download failed")
            }
        }
    }

    /**
     * Apply what was downloaded.
     *
     * The permission check is first and it is not a formality: without "install unknown
     * apps" for this app the commit below fails with a `SecurityException` from inside a
     * coroutine, which is the worst possible place for it to happen — invisible, and
     * indistinguishable from a download that did not work. So it is checked, said, and
     * the settings screen that grants it is opened.
     */
    fun install(ctx: Context) {
        val apk = file
        if (phase != "ready" || apk == null || !apk.exists()) {
            // The cache was evicted under us, which the platform is entitled to do.
            report("idle")
            return download(ctx)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.packageManager.canRequestPackageInstalls()) {
            report("failed", "Beadcause needs permission to install apps — allow it on the screen that just opened, then tap Update app again.")
            try {
                ctx.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (e: Exception) {
                Log.w("Beadcause", "no unknown-sources screen: ${e.message}")
            }
            return
        }

        report("installing")
        val app = ctx.applicationContext
        scope.launch {
            try {
                val installer = app.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
                params.setAppPackageName(app.packageName)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    // Silent from the second update onward — see the header. Declined by
                    // the platform where it does not apply, which arrives back as
                    // STATUS_PENDING_USER_ACTION and is handled like any other answer.
                    params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                }
                val id = installer.createSession(params)
                installer.openSession(id).use { session ->
                    session.openWrite("beadcause", 0, apk.length()).use { out ->
                        apk.inputStream().use { it.copyTo(out, 64 * 1024) }
                        session.fsync(out)
                    }
                    session.commit(statusIntent(app, id).intentSender)
                }
                // Nothing after this is guaranteed to run: replacing the package kills
                // this process, which is the *expected* ending. UpdateReceiver is what
                // reports on the other side of that.
            } catch (e: Exception) {
                Log.w("Beadcause", "install failed: ${e.message}")
                report("failed", e.message ?: "the install failed")
            }
        }
    }

    /**
     * Where the installer reports back to.
     *
     * Mutable, because the whole point is that the platform fills in the status extras;
     * an immutable PendingIntent would arrive at [UpdateReceiver] with nothing on it.
     * That is safe here in the way the docs intend: it is an explicit intent naming a
     * component of this app that is not exported, so nothing else can receive it and
     * nothing else can send one.
     */
    private fun statusIntent(ctx: Context, sessionId: Int): PendingIntent = PendingIntent.getBroadcast(
        ctx,
        sessionId,
        Intent(UpdateReceiver.ACTION_STATUS).setPackage(ctx.packageName),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
    )

    /** The installer's verdict, from [UpdateReceiver]. */
    fun onInstallStatus(ctx: Context, status: Int, message: String?) {
        when (status) {
            PackageInstaller.STATUS_SUCCESS -> {
                file?.delete()
                file = null
                report("idle")
            }
            PackageInstaller.STATUS_FAILURE_ABORTED ->
                // Somebody said no on the platform's confirm screen. Not a failure: the
                // download is still good and the button goes back to offering it.
                report("ready")
            else -> report("failed", message?.takeIf { it.isNotBlank() } ?: "the installer refused it")
        }
    }
}
