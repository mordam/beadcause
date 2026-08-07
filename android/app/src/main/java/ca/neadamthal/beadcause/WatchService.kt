package ca.neadamthal.beadcause

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import kotlin.math.min

/**
 * The whole point of going native: one connection, held open, so a question reaches
 * the phone as a real notification without the ntfy relay in the middle.
 *
 * It parks on `/api/poll`, which returns the moment the server's poller sees a new
 * question or an agent reply. Off the tailnet the poll simply fails and backs off,
 * so walking out of range costs battery equal to one failed connect every couple of
 * minutes, not a spin loop.
 */
class WatchService : Service() {

    companion object {
        private const val TAG = "Beadcause"
        private const val WAIT_SECONDS = 25

        /** Backoff ladder, in ms, for a server that isn't answering. */
        private val BACKOFF = longArrayOf(2_000, 5_000, 15_000, 30_000, 60_000, 120_000)

        fun start(ctx: Context) {
            if (!Prefs.isPaired(ctx)) return
            val intent = Intent(ctx, WatchService::class.java)
            try {
                ctx.startForegroundService(intent)
            } catch (e: Exception) {
                // Android 12+ refuses a foreground start from the background. Nothing
                // is lost — the next time the app is opened it starts cleanly.
                Log.w(TAG, "could not start watcher from background: ${e.message}")
            }
        }

        fun stop(ctx: Context) = ctx.stopService(Intent(ctx, WatchService::class.java))
    }

    private val job = SupervisorJob()
    private val scope = CoroutineScope(job + Dispatchers.IO)
    private var loop: Job? = null

    /** Keys currently showing a notification, so a resync can clear stale ones. */
    private val showing = mutableSetOf<String>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notifications.ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        goForeground("Connecting…")
        if (loop?.isActive != true) loop = scope.launch { watch() }
        // The watcher is the app's reason to exist — bring it back if we're killed.
        return START_STICKY
    }

    override fun onDestroy() {
        job.cancel()
        super.onDestroy()
    }

    private fun goForeground(text: String) {
        val notification = Notifications.service(this, text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(
                this, Notifications.SERVICE_NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(Notifications.SERVICE_NOTIFICATION_ID, notification)
        }
    }

    private fun status(text: String) {
        try {
            goForeground(text)
        } catch (e: Exception) {
            Log.w(TAG, "status update dropped: ${e.message}")
        }
    }

    private suspend fun watch() {
        val conn = Prefs.connection(this) ?: return stopSelfSafely()
        var since = Prefs.seq(this)
        var failures = 0

        // Cold start: read current state without an event backlog, exactly as the
        // server's own poller does on boot. Otherwise a fresh install would fire a
        // notification for every question already waiting — which on a normal day
        // is nine at once.
        if (since == 0L) {
            try {
                val cold = withContext(Dispatchers.IO) { Api.poll(conn, since = null, waitSeconds = 0) }
                since = cold.seq
                Prefs.setSeq(this, since)
                status(idleText(cold.questions?.size))
            } catch (e: Exception) {
                Log.w(TAG, "cold start failed: ${e.message}")
            }
        }

        var openCount: Int? = null

        while (scope.isActive) {
            try {
                val poll = withContext(Dispatchers.IO) { Api.poll(conn, since, WAIT_SECONDS) }
                failures = 0
                poll.questions?.let { openCount = it.size }
                handle(poll)
                // Only persist on an actual move. A timed-out poll returns the same
                // sequence every 25 seconds, and each write is a keystore-backed
                // encrypt — not something to do 3,000 times a day for no change.
                if (poll.seq != since) {
                    since = poll.seq
                    Prefs.setSeq(this, since)
                }
                status(idleText(openCount))
            } catch (e: Exception) {
                if (Api.isUnauthorized(e)) {
                    // The token was rotated or the config regenerated. Retrying forever
                    // would just log 401s, and the failure is invisible otherwise —
                    // questions would simply stop arriving — so say so out loud.
                    Log.w(TAG, "token rejected — stopping watcher")
                    Notifications.repairNeeded(this)
                    status("Token rejected — tap to re-pair")
                    return
                }
                failures++
                val wait = BACKOFF[min(failures - 1, BACKOFF.size - 1)]
                if (failures == 1) Log.i(TAG, "poll failed (${e.javaClass.simpleName}: ${e.message}) — backing off")
                status(if (e is IOException) "Offline — retrying" else "Retrying: ${e.message}")
                delay(wait)
            }
        }
    }

    private fun idleText(open: Int?) = when {
        open == null -> "Watching for questions"
        open == 0 -> "Watching · nothing waiting"
        open == 1 -> "Watching · 1 question open"
        else -> "Watching · $open questions open"
    }

    private fun handle(poll: Poll) {
        val byKey = poll.questions?.associateBy { it.key }.orEmpty()

        // Missed more than the server's event log holds, or the daemon restarted and
        // its sequence went backwards. Either way the event stream can't be trusted,
        // so reconcile against the question list instead of replaying.
        if (poll.resync && poll.questions != null) {
            dropStaleNotifications(byKey.values.map { it.notificationId }.toSet())
            showing.retainAll(byKey.keys)
            return
        }

        for (event in poll.events) {
            val key = event.key ?: continue
            when (event.type) {
                "question" -> byKey[key]?.let {
                    Notifications.question(this, it)
                    showing += key
                }
                "reply" -> Notifications.reply(this, event)
                // Answered here, on another device, or by an agent closing the bead.
                // Either way the decision is made and the row should go.
                "answered", "commented" -> {
                    Notifications.cancel(this, key)
                    showing -= key
                }
                // "created" is a question filed from this phone's own share sheet, and
                // "activity" is an agent progress chip — neither is worth a buzz.
                else -> Unit
            }
        }
    }

    /**
     * Clear notifications for questions that are no longer open.
     *
     * This asks the system what's actually in the shade rather than trusting
     * [showing], because that set is empty after a service restart — and a restart
     * is exactly when a stale notification is most likely to be sitting there with
     * buttons that would answer an already-closed bead.
     */
    private fun dropStaleNotifications(liveIds: Set<Int>) {
        val mgr = getSystemService(android.app.NotificationManager::class.java) ?: return
        val active = runCatching { mgr.activeNotifications }.getOrNull() ?: return
        for (sbn in active) {
            if (sbn.id == Notifications.SERVICE_NOTIFICATION_ID) continue
            if (sbn.id !in liveIds) mgr.cancel(sbn.id)
        }
    }

    private fun stopSelfSafely() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }
}
