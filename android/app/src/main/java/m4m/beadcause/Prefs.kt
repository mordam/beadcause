package m4m.beadcause

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Where the pairing lives.
 *
 * The token is a bearer credential for every workspace at once, so it goes in
 * EncryptedSharedPreferences (keystore-backed) rather than plain prefs — a rooted
 * or backed-up device shouldn't hand it over. `allowBackup="false"` in the manifest
 * matters for the same reason: an encrypted blob restored onto a different device
 * can't be decrypted anyway, and would just look like corruption.
 */
object Prefs {
    private const val FILE = "beadcause.secure"
    private const val BASE_URL = "baseUrl"
    private const val TOKEN = "token"
    private const val SEQ = "seq"
    private const val LAST_WORKSPACE = "lastWorkspace"

    @Volatile private var cached: SharedPreferences? = null

    private fun prefs(ctx: Context): SharedPreferences =
        cached ?: synchronized(this) { cached ?: open(ctx.applicationContext).also { cached = it } }

    private fun open(ctx: Context): SharedPreferences {
        val build = {
            EncryptedSharedPreferences.create(
                ctx,
                FILE,
                MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }
        return try {
            build()
        } catch (e: Exception) {
            // The keystore entry can be invalidated out from under the file — by a
            // restore onto another device, or by the user re-enrolling their
            // biometrics. The file is then permanently undecryptable, so throw it
            // away and re-pair rather than crashing on every launch.
            Log.w("Beadcause", "secure prefs unreadable, re-pairing: ${e.message}")
            ctx.deleteSharedPreferences(FILE)
            build()
        }
    }

    fun baseUrl(ctx: Context): String? = prefs(ctx).getString(BASE_URL, null)

    fun token(ctx: Context): String? = prefs(ctx).getString(TOKEN, null)

    fun isPaired(ctx: Context) = !baseUrl(ctx).isNullOrBlank() && !token(ctx).isNullOrBlank()

    /**
     * Paired, but to an address this build will no longer talk to.
     *
     * A phone paired before HTTPS holds `http://100.x.y.z:4318`, and every request to
     * it now fails at the socket — the platform refuses cleartext, so the app cannot
     * even follow the 307 the Mac would answer with. Nothing here is broken and the
     * token is still good; only the origin moved. So this is deliberately not an
     * unpair: the pairing is kept, MainActivity sends you to the QR screen with
     * [PairActivity.EXTRA_STALE], and the screen says which address it is refusing and
     * why. Silently clearing the token instead would present as "the app forgot", and
     * an address policy with a bug in it would then have destroyed the evidence.
     */
    fun needsRepair(ctx: Context) = isPaired(ctx) && !Address.isPairable(baseUrl(ctx))

    /** Paired, and somewhere we can actually reach. What every caller but the QR screen wants. */
    fun isLive(ctx: Context) = isPaired(ctx) && !needsRepair(ctx)

    fun connection(ctx: Context): Conn? {
        val url = baseUrl(ctx) ?: return null
        val token = token(ctx) ?: return null
        return Conn(url, token)
    }

    fun pair(ctx: Context, baseUrl: String, token: String) {
        prefs(ctx).edit()
            .putString(BASE_URL, baseUrl.trimEnd('/'))
            .putString(TOKEN, token)
            // A new pairing may be a different server; the old sequence number is
            // meaningless against it and would skip or replay events.
            .putLong(SEQ, 0)
            .apply()
    }

    fun unpair(ctx: Context) = prefs(ctx).edit().clear().apply()

    /**
     * Last event sequence the watch service has acted on. Persisted so a service
     * restart resumes where it left off instead of re-notifying, or worse, cold-
     * starting and silently swallowing everything that arrived while it was down.
     */
    fun seq(ctx: Context): Long = prefs(ctx).getLong(SEQ, 0)

    fun setSeq(ctx: Context, value: Long) = prefs(ctx).edit().putLong(SEQ, value).apply()

    fun lastWorkspace(ctx: Context): String? = prefs(ctx).getString(LAST_WORKSPACE, null)

    fun setLastWorkspace(ctx: Context, name: String) =
        prefs(ctx).edit().putString(LAST_WORKSPACE, name).apply()
}

/** A paired server: where it is, and the shared secret it wants on every call. */
data class Conn(val baseUrl: String, val token: String)
