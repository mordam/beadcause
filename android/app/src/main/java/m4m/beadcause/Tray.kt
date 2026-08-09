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
     * Which card an entry lands in — and there are two, deliberately.
     *
     * [WORK] is the tray as it was: questions and agent replies, stacked into one
     * glanceable card. [FOUNDATION] is an agent asking to change what it is, and it
     * gets a card of its own for the same reason it gets a pane of its own in the
     * app: it is not a question about work, it does not compete with one, and it must
     * not be the fourth line of an inbox summary about something else.
     *
     * Two cards is the ceiling, not a pattern to extend. Beyond about three the shade
     * stops being glanceable, which is the whole reason [Tray] exists.
     */
    enum class Chan { WORK, FOUNDATION }

    data class Entry(
        val key: String,
        val line: String,
        val subtitle: String,
        /** What the card shows when it is the only thing waiting. */
        val big: String,
        val question: Question?,
        val isReply: Boolean,
        val chan: Chan = Chan.WORK,
    )

    private val decks = mapOf(
        Chan.WORK to ArrayDeque<Entry>(),
        Chan.FOUNDATION to ArrayDeque<Entry>(),
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
     * spans both channels, so it is passed whole rather than per card.
     */
    @Synchronized
    fun retain(ctx: Context, liveKeys: Set<String>) {
        for (chan in decks.keys) if (deck(chan).removeAll { it.key !in liveKeys }) render(ctx, chan)
    }

    @Synchronized
    fun clear(ctx: Context) {
        for (chan in decks.keys) {
            deck(chan).clear()
            render(ctx, chan)
        }
    }

    @Synchronized
    fun snapshot(): List<Entry> = decks.values.flatten()

    private fun render(ctx: Context, chan: Chan) = Notifications.renderTray(ctx, chan, deck(chan).toList())
}
