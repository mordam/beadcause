package ca.neadamthal.beadcause

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Bring the watcher back after a reboot or an app update.
 *
 * `WatchService.start` swallows the background-start refusal that newer Android
 * versions can throw here, so the worst case is that the watcher waits until the
 * app is next opened rather than the phone crashing on boot.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> WatchService.start(context)
        }
    }
}
