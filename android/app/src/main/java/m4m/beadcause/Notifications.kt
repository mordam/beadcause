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
     * means publishing a *new id* and deleting the old one, which is what the version
     * suffix on each of these is; the alternative is asking every existing install to fix
     * it by hand in system settings.
     */
    const val CHANNEL_ANSWERS = "answers_v1"
    const val CHANNEL_REPLIES = "replies_v2"
    const val CHANNEL_SERVICE = "service"

    /**
     * The four cut by bc-ka5y.15.4, and the reason the id above stopped being
     * `questions_v2`: its buzz went from 40ms to 20ms, and a channel that changes its
     * vibration has to change its id or the change is not made.
     *
     * One channel per class is not decoration — it is where the *options* live. Android's
     * own notification settings screen already has a volume, a vibration toggle, an
     * importance and a "silent until 8am" per channel, so five channels means Adam can
     * mute merges for a week without touching whether a question can reach him, and no
     * screen of beadcause's own has to be built or maintained to offer it.
     *
     * [CHANNEL_REPLIES] is deliberately **not** re-cut. bc-ka5y.15.4 names it as one of
     * the two that change, but nothing about it does: an agent's reply keeps the same pip
     * and the same silence it has always had, and republishing it as `_v3` would throw
     * away whatever has been set on it by hand in exchange for nothing. What changes is
     * only what it no longer carries — news borrowed it until this bead, and now does not.
     */
    const val CHANNEL_STUCK = "stuck_v1"
    const val CHANNEL_MERGED = "merged_v1"
    const val CHANNEL_RELEASED = "released_v1"
    const val CHANNEL_EPICDONE = "epicdone_v1"

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

    /**
     * Deleted on every start, so an existing install does not keep an old sound.
     *
     * `questions_v2` is here because [CHANNEL_ANSWERS] replaces it. Deleting is the only
     * way to retire a channel — leave it behind and it stays in the settings screen as a
     * dead row the user can still turn on, and on some versions of Android re-creating an
     * id that was merely abandoned resurrects the *old* settings rather than the new ones.
     */
    private val RETIRED_CHANNELS = listOf("questions", "replies", "questions_v2")

    /**
     * The smallest buzz a channel can ask for. `longArrayOf(0, 20)` is wait 0ms, buzz
     * 20ms, stop.
     *
     * A channel's `vibrationPattern` is durations only — there is no amplitude in it — so
     * "smaller" can only mean "shorter", and below about 20ms most phones never get the
     * motor moving enough to be felt at all. That is the floor this bottoms out at, and it
     * is a floor of the mechanism rather than a number picked for taste: the way past it
     * is [android.os.VibrationEffect.Composition.PRIMITIVE_TICK], which the app has to
     * fire itself with channel vibration off, and which is bc-ka5y.15.6 rather than this.
     */
    private val SMALLEST_BUZZ = longArrayOf(0, 20)

    /**
     * Two of them, and the only insistent thing this app does.
     *
     * Wait 0, buzz 60, pause 140, buzz 60 — long enough each to be a shove rather than a
     * tap, and far enough apart to be felt as two. Everything else here is trying to be
     * the smallest signal that still arrives; a blockage is the one class where being
     * missed is the failure, because nothing else is going to say it.
     */
    private val DOUBLE_KNOCK = longArrayOf(0, 60, 140, 60)

    const val SERVICE_NOTIFICATION_ID = 1

    /** The card questions and replies land in. */
    private const val TRAY_NOTIFICATION_ID = 3

    /** And the card foundation requests land in — separate, so neither hides the other. */
    private const val FOUNDATION_NOTIFICATION_ID = 4

    /**
     * A merge landing, a release going out, an epic finishing — one card of good news.
     *
     * Three sizes of the same thing (bc-ka5y.15), so one card rather than three, and it
     * self-expires: nothing on it is waiting on you and nothing on it can be answered,
     * so its whole job is to have been seen once.
     */
    private const val NEWS_NOTIFICATION_ID = 6

    /**
     * And the one that is not news: a deploy that failed, a tracker that stopped
     * syncing.
     *
     * Its own card because it must not be swept up with the good news it looks nothing
     * like, and because it is the only one here that has to stay until the state behind
     * it clears. See [Tray.Entry.expires].
     */
    private const val STUCK_NOTIFICATION_ID = 7

    /**
     * Which Android channel each card is currently posted on, so that a change of channel
     * can be a new card rather than an update.
     *
     * In memory, like [Tray] itself and for the same reason: if the process died the cards
     * went with it, and the first render after a restart is a fresh post anyway.
     */
    private val posted = mutableMapOf<Int, String>()
    const val REPLY_RESULT_KEY = "beadcause.reply.text"

    /** Notification actions are one tap, unlike the app's two-tap confirm. */
    private const val MAX_OPTION_ACTIONS = 2

    /** `android.resource://…/<id>` for one of the files in res/raw. */
    private fun rawSound(ctx: Context, res: Int): Uri =
        Uri.parse("${ContentResolver.SCHEME_ANDROID_RESOURCE}://${ctx.packageName}/$res")

    fun ensureChannels(ctx: Context) {
        val mgr = ctx.getSystemService(NotificationManager::class.java) ?: return

        // A 75ms pip (res/raw/blip.wav) rather than the system default, which on this
        // phone is a second and a half of chime for a one-line question. The other four
        // are generated — scripts/sounds.mjs is where their pitches and their loudness
        // are argued, and /sounds on the phone is where they are heard side by side.
        val blip = rawSound(ctx, R.raw.blip)
        val audio = AudioAttributes.Builder()
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .build()

        RETIRED_CHANNELS.forEach(mgr::deleteNotificationChannel)

        mgr.createNotificationChannel(
            // Still IMPORTANCE_HIGH: a question waiting on you has earned the peek.
            // What it has not earned is the noise, so the peek keeps a pip and the
            // smallest buzz a pattern can express instead of the default chime and
            // three-pulse pattern.
            NotificationChannel(CHANNEL_ANSWERS, "Decisions", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "A question is waiting on you"
                setSound(blip, audio)
                enableVibration(true)
                vibrationPattern = SMALLEST_BUZZ
            }
        )
        mgr.createNotificationChannel(
            // The only insistent one, and the only one that is a *state* rather than an
            // arrival: a deploy that failed or a tracker that stopped syncing is still
            // true an hour later, and nothing else is going to mention it. IMPORTANCE_HIGH
            // for the peek, the double knock, and the double buzz to go with it.
            NotificationChannel(CHANNEL_STUCK, "Work is stuck", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "A deploy failed, a tracker stopped syncing, something is not moving"
                setSound(rawSound(ctx, R.raw.knock), audio)
                enableVibration(true)
                vibrationPattern = DOUBLE_KNOCK
            }
        )
        mgr.createNotificationChannel(
            // The three sizes of good news, and all three are IMPORTANCE_DEFAULT with the
            // vibration off: none of them is waiting on you and none of them can be acted
            // on, so a peek over what is on screen would be an interruption bought with
            // nothing. They are separate channels rather than one because the pipeline is
            // audible if they differ — four blips, then a drop, then eventually a chime —
            // and because muting merges for a week must not also mute the milestone.
            NotificationChannel(CHANNEL_MERGED, "Merges landed", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "A pull request merged"
                setSound(rawSound(ctx, R.raw.land), audio)
                enableVibration(false)
            }
        )
        mgr.createNotificationChannel(
            NotificationChannel(CHANNEL_RELEASED, "Releases", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "A release went out"
                setSound(rawSound(ctx, R.raw.drop), audio)
                enableVibration(false)
            }
        )
        mgr.createNotificationChannel(
            NotificationChannel(CHANNEL_EPICDONE, "Epics completed", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Every bead under an epic is closed"
                setSound(rawSound(ctx, R.raw.chime), audio)
                enableVibration(false)
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

    /**
     * And tapping a card that is not about a bead opens a page instead.
     *
     * A landing and a release have no row in the inbox to scroll to — the bead is
     * closed, that is what the card is *saying* — so the useful destination is the pull
     * request board, which is where the ntfy push these replace also pointed and where
     * the Ship button lives. `data` still distinguishes the PendingIntents, because
     * equality ignores extras.
     */
    private fun pageIntent(ctx: Context, path: String): PendingIntent {
        val intent = Intent(ctx, MainActivity::class.java).apply {
            data = Uri.parse("beadcause://page$path")
            putExtra(MainActivity.EXTRA_PATH, path)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            ctx, path.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
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

    /**
     * "an hour ago", for a card that says when you last answered this bead.
     *
     * Coarse deliberately: what is being judged is whether this came straight back
     * (the reopen this guards against) or has been away long enough to be a new
     * question. Empty for a timestamp that will not parse, so the caller leaves the
     * phrase out rather than printing a stack trace's worth of nothing.
     */
    private fun ago(iso: String?): String {
        val then = try {
            java.time.Instant.parse(iso ?: return "")
        } catch (e: Exception) {
            return ""
        }
        val mins = java.time.Duration.between(then, java.time.Instant.now()).toMinutes()
        return when {
            mins < 2L -> "just now"
            mins < 60L -> "$mins minutes ago"
            mins < 48L * 60L -> "${mins / 60L} hours ago"
            else -> "${mins / (60L * 24L)} days ago"
        }
    }

    fun question(ctx: Context, q: Question) {
        val body = buildString {
            // First, above everything — including the title and the option list. The
            // buttons on this card answer and close from the lock screen, so anything
            // that could stop you sending the same answer twice has to be read before
            // the thumb moves. See [Question.answeredBefore].
            if (q.answeredBefore) {
                val when_ = ago(q.answeredAt)
                append("⟳ You answered this ").append(if (when_.isBlank()) "before" else when_)
                if (q.answeredCount > 1) append(" · answered ${q.answeredCount} times already")
                append(":\n")
                append(q.answeredResponse ?: "(the answer is on the bead)")
                append("\n\n")
            }
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
                // The one-line summary is what a stacked card shows, so the marker goes
                // here too: with three questions in the shade the body above is not on
                // screen at all until the card is expanded.
                subtitle = "${q.workspace}${q.priority?.let { " · P$it" } ?: ""}" +
                    if (q.answeredBefore) " · asked again" else "",
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
     * How long a card of good news stays in the shade before the platform clears it.
     *
     * Six hours: long enough that a landing at 3am is still there at breakfast, short
     * enough that Tuesday's merges are not competing with Thursday's question. The
     * number is a judgement rather than a measurement, and it is the only thing here
     * that would be worth changing after living with it for a week.
     */
    private const val NEWS_TIMEOUT_MS = 6L * 60L * 60L * 1000L

    /**
     * Good news, in one card: a merge landed, a release went out, an epic finished.
     *
     * All three go through one function because the difference between them is entirely
     * in the words the server already wrote — [Event.title] and [Event.text] arrive
     * composed (lib/news.js), for the same reason the ntfy bodies they replace were
     * composed on that side: the sentence explaining a refused deploy or a stuck tracker
     * is the product of an argument that lives in the daemon, and a second copy of it in
     * Kotlin would be a second copy to drift.
     *
     * **No action buttons, on any of them.** The only button a landed merge could offer
     * is a revert, and a revert is not a thing to hand somebody on a lock screen with
     * one line of context. That was `pushLanded`'s reasoning and it holds unchanged on
     * a card this app draws itself.
     */
    fun news(ctx: Context, event: Event) {
        val key = event.key ?: return
        Tray.add(
            ctx,
            Tray.Entry(
                key = key,
                line = event.title.orEmpty().ifBlank { "Something landed" },
                subtitle = newsSubtitle(event),
                big = listOf(event.title.orEmpty(), event.text.orEmpty()).filter { it.isNotBlank() }.joinToString("\n"),
                // No bead to answer and nothing to type into: `question` being null is
                // what stops [renderTray] offering either.
                question = null,
                isReply = true,
                chan = Tray.Chan.NEWS,
                voice = voiceFor(event.type),
                expires = NEWS_TIMEOUT_MS,
            ),
        )
    }

    /**
     * Which of the three good-news channels an arrival sounds on.
     *
     * A `when` with a fallback rather than an enum because the type is a string off the
     * wire: a type this build has never heard of must still land in the shade, silently
     * wrong about its sound rather than absent. [CHANNEL_MERGED] is the fallback because a
     * merge landing is the smallest of the three, and being too quiet about news is the
     * survivable direction.
     */
    private fun voiceFor(type: String?): String = when (type) {
        "released" -> CHANNEL_RELEASED
        "epic-done" -> CHANNEL_EPICDONE
        else -> CHANNEL_MERGED
    }

    /** "beadcause · landed", so the card says which of the three it is without expanding. */
    private fun newsSubtitle(event: Event): String {
        val what = when (event.type) {
            "landed" -> "landed"
            "released" -> "released"
            "epic-done" -> "epic finished"
            else -> event.type
        }
        return listOfNotNull(event.workspace?.takeIf { it.isNotBlank() }, what).joinToString(" · ")
    }

    /**
     * Work is stuck — and the other half, which takes the card away again.
     *
     * The only class in this file that is a *state* rather than an arrival, which is
     * what both halves are about. A deploy that failed and a tracker that is not syncing
     * stay true until something changes, so the card stays too: no timeout, and the row
     * only leaves when the daemon says the state cleared or you swipe it away.
     *
     * It is also the only one this app is allowed to be insistent about, which is why it
     * is not a fourth line on the news card: news you have already read must never be
     * able to push this off a summary.
     */
    fun stuck(ctx: Context, event: Event) {
        val key = event.key ?: return
        if (event.state == "clear") {
            Tray.remove(ctx, key)
            return
        }
        Tray.add(
            ctx,
            Tray.Entry(
                key = key,
                line = "⚠ ${event.title.orEmpty().ifBlank { "Something is stuck" }}",
                subtitle = listOfNotNull(event.workspace?.takeIf { it.isNotBlank() }, event.source).joinToString(" · "),
                big = listOf(event.title.orEmpty(), event.text.orEmpty()).filter { it.isNotBlank() }.joinToString("\n\n"),
                question = null,
                isReply = true,
                chan = Tray.Chan.STUCK,
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
        val trayId = when (chan) {
            Tray.Chan.FOUNDATION -> FOUNDATION_NOTIFICATION_ID
            Tray.Chan.NEWS -> NEWS_NOTIFICATION_ID
            Tray.Chan.STUCK -> STUCK_NOTIFICATION_ID
            else -> TRAY_NOTIFICATION_ID
        }
        if (entries.isEmpty()) {
            posted.remove(trayId)
            mgr.cancel(trayId)
            return
        }

        val newest = entries.first()
        val target = entries.firstOrNull { !it.isReply }?.question
        val questions = entries.count { !it.isReply }

        /**
         * The foundation card stays on its own channel whatever is in it — a reply
         * about a request is still part of that conversation, and moving it to the
         * replies channel would put it back under the settings for work.
         *
         * **The news card is the one that moves.** It is a single card holding three
         * classes that now have three channels, so the channel comes from the entry that
         * *caused this render* — the arrival is what makes the sound, and the sound the
         * arrival should make is its own. A card of four landings that a release joins
         * therefore sounds the drop, which is the pipeline being audible and is the whole
         * of why the three are separate ([Tray.Entry.voice]).
         *
         * That is also why the card is re-posted rather than updated when the channel
         * changes: a notification's channel is fixed at the moment it is posted, and an
         * update to a live id has no defined way to move it. `cancel` first and the next
         * `notify` is a new card on the new channel — the entries survive because they
         * live in [Tray], not in the notification.
         */
        val androidChannel = when {
            chan == Tray.Chan.FOUNDATION -> CHANNEL_FOUNDATION
            chan == Tray.Chan.NEWS -> newest.voice ?: CHANNEL_MERGED
            chan == Tray.Chan.STUCK -> CHANNEL_STUCK
            questions == 0 -> CHANNEL_REPLIES
            else -> CHANNEL_ANSWERS
        }
        val wasOn = posted.put(trayId, androidChannel)
        if (wasOn != null && wasOn != androidChannel) mgr.cancel(trayId)
        val builder = NotificationCompat.Builder(ctx, androidChannel)
            .setSmallIcon(R.drawable.ic_notification)
            .setCategory(if (chan == Tray.Chan.STUCK) NotificationCompat.CATEGORY_ERROR else NotificationCompat.CATEGORY_MESSAGE)
            // A card about a bead scrolls the inbox to it; one about a merge or a deploy
            // has no bead left to scroll to and opens the pull request board instead.
            .setContentIntent(
                if (chan == Tray.Chan.NEWS || chan == Tray.Chan.STUCK) pageIntent(ctx, "/prs")
                else openIntent(ctx, newest.key)
            )
            .setAutoCancel(true)
            .setOngoing(false)
            // Only the arrival that caused this render should make a sound; a
            // re-render after answering one of four must not buzz for the other three.
            .setOnlyAlertOnce(false)

        // Good news takes itself away; a blockage does not. See [Tray.Entry.expires] —
        // the longest live entry wins, so a landing arriving on top of an older one does
        // not shorten the card the older one is still sitting in.
        entries.maxOf { it.expires }.takeIf { it > 0L }?.let { builder.setTimeoutAfter(it) }

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
        //
        // The two news cards get their own sentence rather than a noun swap, because
        // "waiting" is wrong for both of them in opposite ways: nothing on the news card
        // is waiting on you at all, and what is on the stuck card is not waiting either
        // — it is already happening.
        when (entries.first().chan) {
            Tray.Chan.NEWS -> return "${entries.size} thing${if (entries.size == 1) "" else "s"} happened"
            Tray.Chan.STUCK -> return "${entries.size} thing${if (entries.size == 1) " is" else "s are"} stuck"
            else -> Unit
        }
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
                // See ActionReceiver.EXTRA_OPTION: without the id, an option that
                // commissions work would close the bead from the shade and hand it
                // back from the app.
                putExtra(ActionReceiver.EXTRA_OPTION, option.id)
            }
            builder.addAction(
                NotificationCompat.Action.Builder(
                    R.drawable.ic_check,
                    // "↪" rather than a second line, because an action is a label and
                    // nothing else. It is the same mark the card in the app carries.
                    if (option.closes) option.label else "↪ ${option.label}",
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
        val builder = NotificationCompat.Builder(ctx, CHANNEL_ANSWERS)
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
        //
        // Narrowed to the two decks that hold things waiting on you: a landing from ten
        // minutes ago sitting on the news card is not a confirmation of anything, and
        // counting it here would swallow the "Answered" row on any morning something
        // happened to merge.
        Tray.remove(ctx, key)
        if (Tray.snapshot(Tray.Chan.WORK, Tray.Chan.FOUNDATION).isNotEmpty()) return

        val notification = NotificationCompat.Builder(ctx, CHANNEL_ANSWERS)
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
        val notification = NotificationCompat.Builder(ctx, CHANNEL_ANSWERS)
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

    /**
     * The app has just replaced itself and is coming back — or is trying to.
     *
     * Posted on every successful self-update, beside the relaunch rather than instead of
     * it: whether a broadcast receiver may start an activity depends on state it cannot
     * see (see [UpdateReceiver]), and the one ending that is not acceptable is the app
     * silently not coming back. [MainActivity] cancels this as soon as it is on screen,
     * so on the phones where the relaunch worked this is a row that appears and clears.
     */
    fun updated(ctx: Context) {
        val intent = Intent(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val notification = NotificationCompat.Builder(ctx, CHANNEL_REPLIES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Beadcause updated")
            .setContentText("Now on ${BuildConfig.VERSION_NAME}. Tap to reopen.")
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setContentIntent(
                PendingIntent.getActivity(
                    ctx, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            )
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(ctx).notifySafely(UPDATE_NOTIFICATION_ID, notification)
    }

    fun clearUpdated(ctx: Context) = NotificationManagerCompat.from(ctx).cancel(UPDATE_NOTIFICATION_ID)

    const val UPDATE_NOTIFICATION_ID = 5

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
