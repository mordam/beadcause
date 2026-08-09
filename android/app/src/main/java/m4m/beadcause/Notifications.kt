package m4m.beadcause

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
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

    /**
     * **A channel's sound and vibration are immutable once created.** Android takes
     * the settings from the first `createNotificationChannel` and ignores every one
     * after it, forever — the user owns them from that moment. So changing either
     * means publishing a *new id* and deleting the old one, which is what the `_v2`
     * suffix is; the alternative is asking every existing install to fix it by hand
     * in system settings.
     */
    const val CHANNEL_QUESTIONS = "questions_v2"
    const val CHANNEL_REPLIES = "replies_v2"
    const val CHANNEL_SERVICE = "service"

    /**
     * An agent asking to change what it is.
     *
     * Its own Android channel, which is worth more here than anywhere else in this
     * file: a channel is the unit the *user* controls. Adam can set this one to
     * silent, or to peek, or turn it off for a fortnight, without touching whether a
     * question about work can reach him — and that is the real content of "a separate
     * channel". A tag on a shared channel would have looked the same in the shade and
     * given him nothing to hold.
     */
    const val CHANNEL_FOUNDATION = "foundation_v1"

    private val RETIRED_CHANNELS = listOf("questions", "replies")

    /** One short shake. `longArrayOf(0, 40)` is wait 0ms, buzz 40ms, stop. */
    private val ONE_SHAKE = longArrayOf(0, 40)

    const val SERVICE_NOTIFICATION_ID = 1

    /** The card questions and replies land in. */
    private const val TRAY_NOTIFICATION_ID = 3

    /** And the card foundation requests land in — separate, so neither hides the other. */
    private const val FOUNDATION_NOTIFICATION_ID = 4
    const val REPLY_RESULT_KEY = "beadcause.reply.text"

    /** Notification actions are one tap, unlike the app's two-tap confirm. */
    private const val MAX_OPTION_ACTIONS = 2

    fun ensureChannels(ctx: Context) {
        val mgr = ctx.getSystemService(NotificationManager::class.java) ?: return

        // A 75ms pip (res/raw/blip.wav) rather than the system default, which on this
        // phone is a second and a half of chime for a one-line question.
        val blip = Uri.parse("${ContentResolver.SCHEME_ANDROID_RESOURCE}://${ctx.packageName}/${R.raw.blip}")
        val audio = AudioAttributes.Builder()
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .build()

        RETIRED_CHANNELS.forEach(mgr::deleteNotificationChannel)

        mgr.createNotificationChannel(
            // Still IMPORTANCE_HIGH: a question waiting on you has earned the peek.
            // What it has not earned is the noise, so the peek keeps a pip and a
            // single shake instead of the default chime and three-pulse pattern.
            NotificationChannel(CHANNEL_QUESTIONS, "Decisions", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "A question is waiting on you"
                setSound(blip, audio)
                enableVibration(true)
                vibrationPattern = ONE_SHAKE
            }
        )
        mgr.createNotificationChannel(
            // A reply is news, not a summons: same pip, no buzz at all.
            NotificationChannel(CHANNEL_REPLIES, "Agent replies", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "An agent answered a thread you commented on"
                setSound(blip, audio)
                enableVibration(false)
            }
        )
        mgr.createNotificationChannel(
            // IMPORTANCE_DEFAULT, not HIGH, and that is the judgement in this whole
            // feature: a constitutional request is important and never urgent. It has
            // been waiting for a session already and will keep. So it lands in the
            // shade with the same pip and no buzz — noticed when the phone is looked
            // at, never a peek over what is on screen.
            NotificationChannel(CHANNEL_FOUNDATION, "Foundation requests", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "An agent is asking to change what it is"
                setSound(blip, audio)
                enableVibration(false)
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
        val body = buildString {
            if (q.title.isNotBlank() && q.title != q.question) append(q.title).append("\n\n")
            if (q.options.size > MAX_OPTION_ACTIONS) {
                append("Options:\n")
                q.options.forEach { append("• ").append(it.label).append('\n') }
                append('\n').append("Only the first $MAX_OPTION_ACTIONS are buttons — open to pick another.")
            }
        }.trim()

        Tray.add(
            ctx,
            Tray.Entry(
                key = q.key,
                line = q.question.ifBlank { q.title },
                subtitle = "${q.workspace}${q.priority?.let { " · P$it" } ?: ""}",
                big = body.ifBlank { q.question },
                question = q,
                isReply = false,
            ),
        )
    }

    /**
     * An agent asking to change what it is.
     *
     * Same buttons as a question — approve and decline are two options and both fit
     * — but a different card, a different Android channel, and a line that says who
     * is asking before it says what for. The scope is what the card leads with in the
     * body: it is the half of a request that decides most of them, and the argument
     * for it needs the app.
     */
    fun foundationRequest(ctx: Context, q: Question) {
        val who = q.amendmentAgent ?: "An agent"
        val body = buildString {
            q.amendmentScope?.let { append("Scoped to: ").append(it).append("\n\n") }
            if (q.title.isNotBlank()) append(q.title)
        }.trim()

        Tray.add(
            ctx,
            Tray.Entry(
                key = q.key,
                line = "$who asks to change what it is",
                subtitle = "${q.workspace} · foundation",
                big = body.ifBlank { q.question },
                question = q,
                isReply = false,
                chan = Tray.Chan.FOUNDATION,
            ),
        )
    }

    /** The agent answering a question you put to it about its own request. */
    fun foundationReply(ctx: Context, event: Event) {
        val key = event.key ?: return
        Tray.add(
            ctx,
            Tray.Entry(
                key = key,
                line = "${event.author ?: "The agent"} on its own request: " +
                    event.text.orEmpty().lineSequence().firstOrNull().orEmpty(),
                subtitle = key,
                big = event.text.orEmpty(),
                // No question object, so no buttons — deliberately. A reply is
                // something to read before deciding, and the decision is one tap
                // away in the app where the whole thread is.
                question = null,
                isReply = true,
                chan = Tray.Chan.FOUNDATION,
            ),
        )
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
        Tray.add(
            ctx,
            Tray.Entry(
                key = key,
                line = "${event.author ?: "An agent"} replied: ${event.text.orEmpty().lineSequence().firstOrNull().orEmpty()}",
                subtitle = key,
                big = event.text.orEmpty(),
                question = q,
                isReply = true,
            ),
        )
    }

    /**
     * The whole tray, as one notification.
     *
     * One entry renders as the card it always was — a question with its buttons, or
     * a reply with a typed "Reply". More than one collapses into `InboxStyle`: a
     * count in the title, the entries as lines newest-first, and the buttons still
     * bound to the newest question with its key in the subtext so the target is
     * never a guess.
     */
    fun renderTray(ctx: Context, chan: Tray.Chan, entries: List<Tray.Entry>) {
        val mgr = NotificationManagerCompat.from(ctx)
        val trayId = if (chan == Tray.Chan.FOUNDATION) FOUNDATION_NOTIFICATION_ID else TRAY_NOTIFICATION_ID
        if (entries.isEmpty()) {
            mgr.cancel(trayId)
            return
        }

        val newest = entries.first()
        val target = entries.firstOrNull { !it.isReply }?.question
        val questions = entries.count { !it.isReply }

        // The foundation card stays on its own channel whatever is in it — a reply
        // about a request is still part of that conversation, and moving it to the
        // replies channel would put it back under the settings for work.
        val androidChannel = when {
            chan == Tray.Chan.FOUNDATION -> CHANNEL_FOUNDATION
            questions == 0 -> CHANNEL_REPLIES
            else -> CHANNEL_QUESTIONS
        }
        val builder = NotificationCompat.Builder(ctx, androidChannel)
            .setSmallIcon(R.drawable.ic_notification)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(openIntent(ctx, newest.key))
            .setAutoCancel(true)
            .setOngoing(false)
            // Only the arrival that caused this render should make a sound; a
            // re-render after answering one of four must not buzz for the other three.
            .setOnlyAlertOnce(false)

        if (entries.size == 1) {
            builder
                .setContentTitle(newest.line)
                .setContentText(newest.big.lineSequence().firstOrNull().orEmpty().ifBlank { newest.subtitle })
                .setSubText(newest.subtitle)
                .setStyle(NotificationCompat.BigTextStyle().bigText(newest.big.ifBlank { newest.line }))
        } else {
            val style = NotificationCompat.InboxStyle().setBigContentTitle(summary(entries))
            entries.forEach { style.addLine(it.line) }
            builder
                .setContentTitle(summary(entries))
                .setContentText(newest.line)
                .setSubText(target?.let { "buttons answer ${it.key}" } ?: newest.subtitle)
                .setStyle(style)
                .setNumber(entries.size)
        }

        // `question` is nullable now — a reply about a foundation request carries no
        // bead to answer, because the answering happens in the thread. `?.let` rather
        // than `!!`: a card with no Reply button is a small loss, a crash in the
        // notification path takes the watcher down with it.
        if (newest.isReply && entries.size == 1) {
            newest.question?.let { builder.addAction(typedAction(ctx, it, slot = 7, label = "Reply", close = false)) }
        } else if (target != null) {
            addQuestionActions(ctx, builder, target)
        }

        mgr.notifySafely(trayId, builder.build())
    }

    private fun summary(entries: List<Tray.Entry>): String {
        // Counted in the words of whichever channel this card is: "2 requests · 1
        // reply waiting" is a summary of the foundation card, and calling those
        // questions would undo the separation in the one line that summarises it.
        val foundation = entries.first().chan == Tray.Chan.FOUNDATION
        val questions = entries.count { !it.isReply }
        val replies = entries.size - questions
        val noun = if (foundation) "request" else "question"
        val parts = buildList {
            if (questions > 0) add("$questions $noun" + if (questions == 1) "" else "s")
            if (replies > 0) add("$replies repl" + if (replies == 1) "y" else "ies")
        }
        return parts.joinToString(" · ") + " waiting"
    }

    /** The three-action budget, spent on one question — see the note at the top. */
    private fun addQuestionActions(ctx: Context, builder: NotificationCompat.Builder, q: Question) {
        q.options.take(MAX_OPTION_ACTIONS).forEachIndexed { index, option ->
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
            if (q.options.isEmpty()) {
                builder.addAction(typedAction(ctx, q, slot = 5, label = "Answer & close", close = true))
                builder.addAction(typedAction(ctx, q, slot = 6, label = "Comment", close = false))
            } else {
                builder.addAction(typedAction(ctx, q, slot = 5, label = "Answer…", close = true))
            }
        }
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

        NotificationManagerCompat.from(ctx).notifySafely(TRAY_NOTIFICATION_ID, builder.build())
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
        // Drop the answered line first. If anything is still waiting, the re-rendered
        // tray IS the confirmation — and whatever SystemUI restores afterwards is a
        // card whose buttons belong to a question that is still open, which is safe.
        Tray.remove(ctx, key)
        if (Tray.snapshot().isNotEmpty()) return

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
        NotificationManagerCompat.from(ctx).notifySafely(TRAY_NOTIFICATION_ID, notification)
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

    /** Answered, commented, or gone: drop its line and re-render what's left. */
    fun cancel(ctx: Context, key: String) = Tray.remove(ctx, key)

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
