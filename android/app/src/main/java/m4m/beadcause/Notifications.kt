package m4m.beadcause

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput

/**
 * Everything that appears in the shade.
 *
 * The one thing to know before changing this: **Android's standard notification
 * template renders at most three actions.** Extra `addAction` calls are silently
 * dropped. So going native does not lift ntfy's three-button cap — what it buys is
 * `RemoteInput`, a typed answer straight from the shade, which ntfy cannot do at
 * all. The budget is therefore spent deliberately:
 *
 *   - question with options → the first two options, then "Answer…" (typed, closes)
 *   - question without options → "Answer & close" and "Comment" (both typed)
 *
 * Every option is still listed in the expanded body, so a question with five
 * choices is readable in the shade even though only two are one tap away; the rest
 * are one tap into the app, which is where the two-tap confirm lives.
 */
object Notifications {

    const val CHANNEL_QUESTIONS = "questions"
    const val CHANNEL_REPLIES = "replies"
    const val CHANNEL_SERVICE = "service"

    const val SERVICE_NOTIFICATION_ID = 1
    const val REPLY_RESULT_KEY = "beadcause.reply.text"

    /** Notification actions are one tap, unlike the app's two-tap confirm. */
    private const val MAX_OPTION_ACTIONS = 2

    fun ensureChannels(ctx: Context) {
        val mgr = ctx.getSystemService(NotificationManager::class.java) ?: return
        mgr.createNotificationChannel(
            NotificationChannel(CHANNEL_QUESTIONS, "Decisions", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "A question is waiting on you"
                enableVibration(true)
            }
        )
        mgr.createNotificationChannel(
            NotificationChannel(CHANNEL_REPLIES, "Agent replies", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "An agent answered a thread you commented on"
            }
        )
        mgr.createNotificationChannel(
            // Silent and un-dismissable by design: this is the "the watcher is alive"
            // row Android requires a foreground service to show.
            NotificationChannel(CHANNEL_SERVICE, "Watching", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Ongoing: connection to the beadcause server"
                setShowBadge(false)
            }
        )
    }

    /* --------------------------------------------------------------- intents */

    /**
     * PendingIntent equality ignores extras — two intents for the same class with
     * the same request code are the *same* PendingIntent, so a second question would
     * quietly reuse the first one's payload. Distinct request codes plus a distinct
     * data URI per (question, slot) is what keeps them apart.
     */
    private fun actionIntent(ctx: Context, q: Question, slot: Int, configure: Intent.() -> Unit): Intent =
        Intent(ctx, ActionReceiver::class.java).apply {
            data = Uri.parse("beadcause://action/${Uri.encode(q.key)}/$slot")
            putExtra(ActionReceiver.EXTRA_WORKSPACE, q.workspace)
            putExtra(ActionReceiver.EXTRA_ID, q.id)
            putExtra(ActionReceiver.EXTRA_KEY, q.key)
            configure()
        }

    private fun broadcast(ctx: Context, intent: Intent, requestCode: Int, mutable: Boolean): PendingIntent =
        PendingIntent.getBroadcast(
            ctx,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or
                if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE,
        )

    /** Tapping the body opens the app scrolled to that question. */
    private fun openIntent(ctx: Context, key: String): PendingIntent {
        val intent = Intent(ctx, MainActivity::class.java).apply {
            data = Uri.parse("beadcause://open/${Uri.encode(key)}")
            putExtra(MainActivity.EXTRA_KEY, key)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            ctx, key.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun typedAction(ctx: Context, q: Question, slot: Int, label: String, close: Boolean): NotificationCompat.Action {
        val intent = actionIntent(ctx, q, slot) { putExtra(ActionReceiver.EXTRA_CLOSE, close) }
        return NotificationCompat.Action.Builder(R.drawable.ic_reply, label, broadcast(ctx, intent, q.key.hashCode() * 8 + slot, mutable = true))
            .addRemoteInput(RemoteInput.Builder(REPLY_RESULT_KEY).setLabel(label).build())
            .setAllowGeneratedReplies(false)
            .build()
    }

    /* ---------------------------------------------------------- notifications */

    fun question(ctx: Context, q: Question) {
        val options = q.options.take(MAX_OPTION_ACTIONS)
        val body = buildString {
            if (q.title.isNotBlank() && q.title != q.question) append(q.title).append("\n\n")
            if (q.options.size > MAX_OPTION_ACTIONS) {
                append("Options:\n")
                q.options.forEach { append("• ").append(it.label).append('\n') }
                append('\n').append("Only the first $MAX_OPTION_ACTIONS are buttons — open to pick another.")
            }
        }.trim()

        val builder = NotificationCompat.Builder(ctx, CHANNEL_QUESTIONS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(q.question.ifBlank { q.title })
            .setContentText(if (body.isNotBlank()) body.lineSequence().first() else q.workspace)
            .setSubText("${q.workspace}${q.priority?.let { " · P$it" } ?: ""}")
            .setStyle(NotificationCompat.BigTextStyle().bigText(body.ifBlank { q.question }))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openIntent(ctx, q.key))
            .setAutoCancel(true)
            // It's a decision, not a headline — leave it in the shade until it's made.
            .setOngoing(false)

        options.forEachIndexed { index, option ->
            val intent = actionIntent(ctx, q, index) {
                putExtra(ActionReceiver.EXTRA_RESPONSE, option.response)
                putExtra(ActionReceiver.EXTRA_CLOSE, true)
            }
            builder.addAction(
                NotificationCompat.Action.Builder(
                    R.drawable.ic_check,
                    option.label,
                    broadcast(ctx, intent, q.key.hashCode() * 8 + index, mutable = false),
                ).build()
            )
        }

        if (q.allowFreeText) {
            if (options.isEmpty()) {
                builder.addAction(typedAction(ctx, q, slot = 5, label = "Answer & close", close = true))
                builder.addAction(typedAction(ctx, q, slot = 6, label = "Comment", close = false))
            } else {
                builder.addAction(typedAction(ctx, q, slot = 5, label = "Answer…", close = true))
            }
        }

        NotificationManagerCompat.from(ctx).notifySafely(q.notificationId, builder.build())
    }

    /** An agent answered a thread you commented on. */
    fun reply(ctx: Context, event: Event) {
        val key = event.key ?: return
        val q = Question(
            workspace = event.workspace.orEmpty(),
            id = event.id.orEmpty(),
            key = key,
            title = event.title.orEmpty(),
            question = event.title.orEmpty(),
            priority = null,
            options = emptyList(),
            allowFreeText = true,
            awaitingAgent = false,
        )
        val builder = NotificationCompat.Builder(ctx, CHANNEL_REPLIES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(event.author?.let { "$it replied" } ?: "An agent replied")
            .setContentText(event.text.orEmpty().lineSequence().firstOrNull().orEmpty())
            .setSubText(key)
            .setStyle(NotificationCompat.BigTextStyle().bigText(event.text.orEmpty()))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(openIntent(ctx, key))
            .setAutoCancel(true)
            .addAction(typedAction(ctx, q, slot = 7, label = "Reply", close = false))

        NotificationManagerCompat.from(ctx).notifySafely(key.hashCode(), builder.build())
    }

    /**
     * A send failed — almost always because the phone walked off the tailnet
     * mid-answer. The typed text is put back in front of you rather than dropped;
     * losing a written answer is the single worst thing this app could do.
     */
    fun sendFailed(ctx: Context, q: Question, text: String, reason: String) {
        val builder = NotificationCompat.Builder(ctx, CHANNEL_QUESTIONS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Couldn't send your answer")
            .setContentText(reason)
            .setSubText(q.key)
            .setStyle(NotificationCompat.BigTextStyle().bigText("$reason\n\nYour answer is kept below — tap to open and paste it in.\n\n$text"))
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .setContentIntent(openIntent(ctx, q.key))
            .setAutoCancel(true)
            .addAction(typedAction(ctx, q, slot = 5, label = "Try again", close = true))

        NotificationManagerCompat.from(ctx).notifySafely(q.notificationId, builder.build())
    }

    /**
     * Confirm an answer sent from the shade, and take the buttons away.
     *
     * A plain `cancel()` is not enough after a typed reply. SystemUI extends the
     * lifetime of a notification with an open `RemoteInput` session, holds the
     * app's cancel, and then **restores the notification** with the reply appended
     * — live action buttons and all. On a question that was just answered and
     * closed, those buttons would fire `/api/respond` against a closed bead.
     *
     * So replace it instead of cancelling it: same id, no actions, and
     * `setTimeoutAfter` so the platform clears the confirmation itself. Whatever
     * SystemUI restores, it restores *this*.
     */
    fun acknowledged(ctx: Context, key: String, text: String, closed: Boolean) {
        val notification = NotificationCompat.Builder(ctx, CHANNEL_QUESTIONS)
            .setSmallIcon(R.drawable.ic_check)
            .setContentTitle(if (closed) "Answered" else "Comment added")
            .setContentText(text.lineSequence().firstOrNull().orEmpty())
            .setSubText(key)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setTimeoutAfter(6_000)
            .build()
        NotificationManagerCompat.from(ctx).notifySafely(key.hashCode(), notification)
    }

    /**
     * The server said 401.
     *
     * Deleting `~/.config/beadcause/config.json` regenerates the token, at which
     * point the phone is holding a dead credential and the watcher has stopped.
     * Without this the app would look fine — the WebView would prompt for a token
     * and the *service* would stay dead, so questions would silently stop arriving.
     * Tapping this goes straight back to the QR screen.
     */
    fun repairNeeded(ctx: Context) {
        val intent = Intent(ctx, PairActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val notification = NotificationCompat.Builder(ctx, CHANNEL_QUESTIONS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Beadcause needs re-pairing")
            .setContentText("The server rejected the saved token. Tap to scan the QR again.")
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .setContentIntent(
                PendingIntent.getActivity(
                    ctx, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            )
            .setAutoCancel(true)
            .setOngoing(false)
            .build()
        NotificationManagerCompat.from(ctx).notifySafely(REPAIR_NOTIFICATION_ID, notification)
    }

    const val REPAIR_NOTIFICATION_ID = 2

    fun cancel(ctx: Context, key: String) = NotificationManagerCompat.from(ctx).cancel(key.hashCode())

    /** The ongoing row the platform demands in exchange for staying alive. */
    fun service(ctx: Context, text: String): Notification =
        NotificationCompat.Builder(ctx, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Beadcause")
            .setContentText(text)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(
                PendingIntent.getActivity(
                    ctx, 0, Intent(ctx, MainActivity::class.java),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            )
            .build()

    /**
     * POST_NOTIFICATIONS can be revoked at any moment, including between the
     * permission check and the post. The watcher must survive that rather than
     * crash in a background coroutine where nobody would see the stack trace.
     */
    private fun NotificationManagerCompat.notifySafely(id: Int, notification: Notification) {
        try {
            notify(id, notification)
        } catch (e: SecurityException) {
            android.util.Log.w("Beadcause", "notification $id suppressed: ${e.message}")
        }
    }
}
