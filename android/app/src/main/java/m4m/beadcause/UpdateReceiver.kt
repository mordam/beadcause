package m4m.beadcause

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log

/**
 * How an install ends — and how the app comes back afterwards.
 *
 * `PackageInstaller` answers into a broadcast rather than returning, because the process
 * that asked is very often not there to return to: replacing a package kills the app that
 * *is* that package. So this receiver runs in a process the platform started specifically
 * to deliver it, sometimes in a build that did not exist when the session was committed —
 * which is exactly the point, and is why nothing here reads state from memory.
 *
 * Three answers, and all three are ordinary:
 *
 * - **Pending user action.** The platform wants its own confirm screen: the first update
 *   applied through this path always does, because the installed copy came from a browser
 *   download and this app is not yet its installer of record (see [Updater]). The intent
 *   to show is handed back on the broadcast and is started here.
 * - **Success.** The app is now the new build, and this process is a fresh one. The
 *   watcher is restarted for the same reason [BootReceiver] restarts it after
 *   `MY_PACKAGE_REPLACED`, and the activity is brought back.
 * - **Anything else.** A failure with a message, or somebody declining the confirm
 *   screen, which is `STATUS_FAILURE_ABORTED` and is not a failure at all.
 *
 * ## Coming back up is asked for twice, on purpose
 *
 * `startActivity` from a broadcast receiver is subject to the background-activity-launch
 * restrictions, and whether it is allowed depends on state this code cannot see — whether
 * the task is still on the Recents screen, whether the update was applied while the app
 * was in front. It very often works, because an update the user just tapped through is
 * about as foreground as an app gets. When it does not, the platform drops it silently.
 *
 * A silent drop is not an acceptable ending for "the app restarts itself", so the
 * notification goes out as well, every time, and MainActivity cancels it the moment it is
 * actually on screen. The cost of the pair is a notification that flashes and clears on
 * the phones where the relaunch worked; the cost of trusting the launch alone is an app
 * that quietly does not come back on the phones where it did not.
 */
class UpdateReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_STATUS = "m4m.beadcause.INSTALL_STATUS"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_STATUS) return
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)

        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            @Suppress("DEPRECATION")
            val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
            if (confirm == null) {
                Updater.onInstallStatus(context, PackageInstaller.STATUS_FAILURE, "the installer asked for confirmation and sent no way to give it")
                return
            }
            try {
                context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e: Exception) {
                Log.w("Beadcause", "confirm screen would not open: ${e.message}")
                Updater.onInstallStatus(context, PackageInstaller.STATUS_FAILURE, e.message)
            }
            return
        }

        Updater.onInstallStatus(context, status, message)
        if (status != PackageInstaller.STATUS_SUCCESS) return

        // A new build, and a new process. Everything the app was holding went with the old
        // one, so both of these are starts rather than resumes.
        WatchService.start(context)
        Notifications.updated(context)
        try {
            context.startActivity(
                Intent(context, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            )
        } catch (e: Exception) {
            // Background-activity-launch, almost certainly. The notification above is the
            // whole reason that is survivable.
            Log.w("Beadcause", "could not reopen after the update: ${e.message}")
        }
    }
}
