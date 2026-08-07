package ca.neadamthal.beadcause

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import android.widget.Toast
import androidx.core.app.RemoteInput
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Answers a question straight from the notification shade.
 *
 * Two ways in: a tapped option button (the response is already in the extras) and a
 * typed `RemoteInput` reply. Both land here, both end in one `bd` write.
 */
class ActionReceiver : BroadcastReceiver() {

    companion object {
        const val EXTRA_WORKSPACE = "workspace"
        const val EXTRA_ID = "id"
        const val EXTRA_KEY = "key"
        const val EXTRA_RESPONSE = "response"
        const val EXTRA_CLOSE = "close"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onReceive(context: Context, intent: Intent) {
        val ctx = context.applicationContext
        val workspace = intent.getStringExtra(EXTRA_WORKSPACE) ?: return
        val id = intent.getStringExtra(EXTRA_ID) ?: return
        val key = intent.getStringExtra(EXTRA_KEY) ?: "$workspace/$id"
        val close = intent.getBooleanExtra(EXTRA_CLOSE, true)

        val typed = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifications.REPLY_RESULT_KEY)?.toString()
        val text = (intent.getStringExtra(EXTRA_RESPONSE) ?: typed)?.trim()
        if (text.isNullOrEmpty()) return

        val conn = Prefs.connection(ctx) ?: return
        // A skeleton is enough: the only reason to reconstruct a Question here is so
        // a failure notification can be rebuilt with a working "Try again" action.
        val stub = Question(workspace, id, key, key, key, null, emptyList(), true, false)

        // The receiver's process can be killed the instant onReceive returns; the
        // write goes through `bd`, which retries against the Dolt lock and can take
        // a second or two. goAsync() keeps the process alive for it.
        val pending = goAsync()
        scope.launch {
            try {
                if (close) Api.respond(conn, workspace, id, text) else Api.comment(conn, workspace, id, text)
                // Not cancel(): SystemUI can restore a notification whose reply
                // session it was holding. Replacing it with an action-less receipt
                // is the only way to be sure the buttons are gone.
                Notifications.acknowledged(ctx, key, text, close)
                toast(ctx, if (close) "Answered $id" else "Comment added to $id")
            } catch (e: Exception) {
                Log.w("Beadcause", "action on $key failed", e)
                val reason = if (Api.isUnauthorized(e)) "The server rejected the token — re-pair the app." else e.message ?: "Send failed"
                Notifications.sendFailed(ctx, stub, text, reason)
            } finally {
                pending.finish()
            }
        }
    }

    private suspend fun toast(ctx: Context, message: String) = withContext(Dispatchers.Main) {
        Toast.makeText(ctx, message, Toast.LENGTH_SHORT).show()
    }
}
