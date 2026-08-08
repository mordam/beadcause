package m4m.beadcause

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat

/**
 * Links out of a brief.
 *
 * A brief is mostly links — a GitHub PR, a claude.ai artifact, a dashboard — and
 * handing each one to `ACTION_VIEW` threw you out of the app entirely. You came
 * back to a relaunched WebView, scrolled to the top, with no memory of which card
 * you had open.
 *
 * A Custom Tab fixes that without paying the obvious alternative's cost. Hosting
 * the page in a WebView of our own would also keep you in the app, but a WebView is
 * a fresh, logged-out browser with its own cookie jar — so a private GitHub page or
 * a claude.ai artifact, which is exactly what these links are, would greet you with
 * a login wall. A Custom Tab *is* Chrome: the same cookies, the same signed-in
 * session, and the back button returns to the card you were reading.
 */
object Links {

    private const val TAG = "Beadcause"

    fun open(context: Context, url: Uri) {
        if (url.scheme == "http" || url.scheme == "https") {
            try {
                customTabsIntent(context).launchUrl(context, url)
                return
            } catch (e: ActivityNotFoundException) {
                // No Custom Tabs provider, or no browser at all. Fall through: some
                // other installed app may still claim the URL.
                Log.w(TAG, "no custom tab for $url: ${e.message}")
            }
        }
        // mailto:, tel:, geo:, an app deep link — none of these are web pages and a
        // Custom Tab cannot show them. Only the system knows who wants them.
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            Log.w(TAG, "nothing can open $url: ${e.message}")
        }
    }

    /**
     * Painted from the PWA's own surface colours so the tab reads as part of
     * Beadcause rather than a jump out of it, and following the system's light/dark
     * choice for the same reason the WebView does.
     */
    private fun customTabsIntent(context: Context): CustomTabsIntent {
        fun params(color: Int) = CustomTabColorSchemeParams.Builder()
            .setToolbarColor(ContextCompat.getColor(context, color))
            .build()

        return CustomTabsIntent.Builder()
            .setShowTitle(true)
            .setUrlBarHidingEnabled(true)
            .setShareState(CustomTabsIntent.SHARE_STATE_ON)
            .setColorScheme(CustomTabsIntent.COLOR_SCHEME_SYSTEM)
            .setDefaultColorSchemeParams(params(R.color.tab_light))
            .setColorSchemeParams(CustomTabsIntent.COLOR_SCHEME_DARK, params(R.color.tab_dark))
            .build()
    }
}
