package m4m.beadcause

import android.content.Context

/**
 * One card in the shade, however many things are waiting.
 *
 * Before this, every question and every reply posted its own notification. On a
 * morning where an agent labels thirty beads `human` that is thirty cards, and the
 * shade stops being glanceable at about three.
 *
 * So the tray keeps the last few arrivals and renders them as a **single**
 * notification that expands to show them individually (Android's `InboxStyle`,
 * which is the one template built for exactly this). The ongoing "Watching" row is
 * separate and unavoidable — the platform demands it of a foreground service — so
 * "one card" means one card of *news*.
 *
 * Two decisions worth knowing:
 *
 * - **The action buttons target the newest question**, and the card names it in the
 *   subtext so the target is never a guess. One-tap answering from the shade is the
 *   whole reason this app is native rather than a web page, and dropping the buttons
 *   whenever two things stacked would have thrown that away on exactly the busy
 *   mornings it is most useful.
 * - **State is in memory only.** If the process dies the tray empties, which is
 *   correct: the shade should not be repopulated from a list that may be hours
 *   stale, and the inbox is the source of truth the moment you open it.
 */
object Tray {

    /** Android's inbox template renders about five lines; four leaves a summary line. */
    private const val MAX_LINES = 4

    /**
     * Which card an entry lands in — and there are four, split by what the arrival
     * asks of you rather than by what produced it.
     *
     * [WORK] is the tray as it was: questions and agent replies, stacked into one
     * glanceable card. [FOUNDATION] is an agent asking to change what it is, and it
     * gets a card of its own for the same reason it gets a pane of its own in the
     * app: it is not a question about work, it does not compete with one, and it must
     * not be the fourth line of an inbox summary about something else.
     *
     * [NEWS] and [STUCK] arrived with bc-ka5y.15.1, and the ceiling this file used to
     * declare — two cards, because the shade stops being glanceable at about three —
     * is the reason they are two rather than four. A merge landing, a release and an
     * epic completing are three sizes of the same good news and share one card; a
     * deploy that failed and a tracker that stopped syncing are not news at all.
     *
     * **Why that is still two cards in practice, most of the time.** [NEWS] carries
     * [Entry.expires], so a card of landings takes itself away rather than sitting
     * under a waiting question all day, and [STUCK] exists only while something
     * actually is — its entries arrive with a `clear` that removes them, not with a
     * timer. So the steady state of a working morning is [WORK] and [FOUNDATION],
     * exactly as before, and the other two are transient by construction.
     *
     * **What must never happen is a landing pushing a question off a summary**, which
     * is why they are separate cards and not four more lines of [WORK].
     */
    enum class Chan { WORK, FOUNDATION, NEWS, STUCK }

    /**
     * The two decks whose entries are beads the server still lists as open.
     *
     * [retain] is driven by the question list off `/api/poll`, so it may only ever
     * judge decks whose keys are in that list. A news entry's key is `news/…` and a
     * blockage's is `stuck/…` — neither is a bead, both would be missing from every
     * live set, and sweeping them here would have cleared the shade of them on the
     * first resync after they arrived.
     */
    private val BEAD_DECKS = setOf(Chan.WORK, Chan.FOUNDATION)

    data class Entry(
        val key: String,
        val line: String,
        val subtitle: String,
        /** What the card shows when it is the only thing waiting. */
        val big: String,
        val question: Question?,
        val isReply: Boolean,
        val chan: Chan = Chan.WORK,
        /**
         * How long the platform should keep this card before clearing it itself, in
         * milliseconds, or 0 to keep it until it is dismissed or removed.
         *
         * Only [Chan.NEWS] sets it. Nothing on that card is waiting on you and nothing
         * on it can be acted on, so a landing from Tuesday still in the shade on
         * Thursday is not a record, it is clutter competing with a question — and
         * clutter is how a shade stops being read at all. A blockage is the opposite
         * case and deliberately has no timer: it goes when the daemon says the state
         * cleared, or when you take it away yourself.
         */
        val expires: Long = 0L,
    )

    private val decks = mapOf(
        Chan.WORK to ArrayDeque<Entry>(),
        Chan.FOUNDATION to ArrayDeque<Entry>(),
        Chan.NEWS to ArrayDeque<Entry>(),
        Chan.STUCK to ArrayDeque<Entry>(),
    )

    private fun deck(chan: Chan) = decks.getValue(chan)

    @Synchronized
    fun add(ctx: Context, entry: Entry) {
        // Same bead twice means the newer render wins and keeps its place at the
        // top, rather than the card listing one question twice. Swept from *both*
        // decks: a bead that gained the foundation label after it was first seen
        // would otherwise sit in the shade twice, in two different cards.
        val moved = decks.keys.count { it != entry.chan && deck(it).removeAll { e -> e.key == entry.key } }
        val d = deck(entry.chan)
        d.removeAll { it.key == entry.key }
        d.addFirst(entry)
        while (d.size > MAX_LINES) d.removeLast()
        render(ctx, entry.chan)
        if (moved > 0) decks.keys.filter { it != entry.chan }.forEach { render(ctx, it) }
    }

    @Synchronized
    fun remove(ctx: Context, key: String) {
        for (chan in decks.keys) if (deck(chan).removeAll { it.key == key }) render(ctx, chan)
    }

    /**
     * Keep only what the server still says is open.
     *
     * The old sweep cancelled every notification id it did not recognise, which with
     * a single tray card would have cancelled the tray on every poll. The live set
     * spans both bead channels, so it is passed whole rather than per card — and it
     * reaches only those two, because [BEAD_DECKS] is the whole of what that list can
     * speak about.
     */
    @Synchronized
    fun retain(ctx: Context, liveKeys: Set<String>) {
        for (chan in BEAD_DECKS) if (deck(chan).removeAll { it.key !in liveKeys }) render(ctx, chan)
    }

    @Synchronized
    fun clear(ctx: Context) {
        for (chan in decks.keys) {
            deck(chan).clear()
            render(ctx, chan)
        }
    }

    /**
     * What is in the shade, optionally narrowed to some of the cards.
     *
     * The narrowing is what [Notifications.acknowledged] needs: it posts a "sent"
     * confirmation only when nothing is left waiting, and a landing from ten minutes
     * ago is not something waiting. Unnarrowed it is every deck, which is what a
     * caller asking "is anything in the shade at all" means.
     */
    @Synchronized
    fun snapshot(vararg chans: Chan): List<Entry> =
        (if (chans.isEmpty()) decks.keys else chans.toSet()).flatMap { deck(it) }

    private fun render(ctx: Context, chan: Chan) = Notifications.renderTray(ctx, chan, deck(chan).toList())
}
