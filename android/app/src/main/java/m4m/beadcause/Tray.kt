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

    data class Entry(
        val key: String,
        val line: String,
        val subtitle: String,
        /** What the card shows when it is the only thing waiting. */
        val big: String,
        val question: Question?,
        val isReply: Boolean,
    )

    private val entries = ArrayDeque<Entry>()

    @Synchronized
    fun add(ctx: Context, entry: Entry) {
        // Same bead twice means the newer render wins and keeps its place at the
        // top, rather than the card listing one question twice.
        entries.removeAll { it.key == entry.key }
        entries.addFirst(entry)
        while (entries.size > MAX_LINES) entries.removeLast()
        render(ctx)
    }

    @Synchronized
    fun remove(ctx: Context, key: String) {
        if (entries.removeAll { it.key == key }) render(ctx)
    }

    /**
     * Keep only what the server still says is open.
     *
     * The old sweep cancelled every notification id it did not recognise, which with
     * a single tray card would have cancelled the tray on every poll.
     */
    @Synchronized
    fun retain(ctx: Context, liveKeys: Set<String>) {
        if (entries.removeAll { it.key !in liveKeys }) render(ctx)
    }

    @Synchronized
    fun clear(ctx: Context) {
        entries.clear()
        render(ctx)
    }

    @Synchronized
    fun snapshot(): List<Entry> = entries.toList()

    private fun render(ctx: Context) = Notifications.renderTray(ctx, entries.toList())
}
