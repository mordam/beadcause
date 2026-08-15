/* Answer the next card without waiting for the last one to be written.
 *
 * submit() in app.js has been optimistic since the flight landed: it takes the card
 * out of the list and repaints *before* the write goes out, so the list is already
 * one card shorter by the time `bd` hears about it. What still blocked the thumb was
 * everything downstream — every caller awaited submit(), and submit() awaited the
 * write and then the flight's absorb. Answer four cards in a row and that is four
 * sequential round trips against a tracker that can spend seconds retrying the Dolt
 * lock, with the second tap unable to start until the first one is on the record.
 *
 * So the write moves off the tap and onto here. The tap enqueues and returns; this
 * drains one job at a time in the order they were tapped; the list, the composer and
 * the next card stay live throughout.
 *
 * **Why this is not public/sendqueue.js**, which is the same shape one screen over:
 * that queue exists to *join*. Two things said to an agent mid-turn are concatenated
 * and delivered as one turn, because two `claude -p` runs back to back would answer
 * the first without knowing the second exists. Submits are the opposite — each entry
 * is its own write against its own bead, and joining two of them would be answering
 * one question with another question's words. The failure modes differ the same way:
 * a refused message goes back into a composer, a refused submit hands a whole card
 * back to the list. One file each rather than a mode flag, because almost nothing but
 * "run them in order" is actually shared.
 *
 * Three rules it holds:
 *
 *   - **Serial, on the wire.** `bd` is a single Dolt writer; two writes in the air at
 *     once buy nothing and cost lock contention. What is parallel is the *thumb* and
 *     the writes, not the writes and each other.
 *   - **Order is tap order.** A queue that reordered would file the answers in a
 *     sequence you never chose, and the beads created by one answer can be what the
 *     next one is about.
 *   - **A job owns its own outcome.** `run()` is expected to handle its own failure —
 *     in app.js that means flying the beads home and giving the card back — so a
 *     throw here is caught and the queue simply moves on. It must never stop the
 *     drain, or one refused write would strand every answer tapped behind it.
 *
 * What is deliberately *not* here is a retry. sendqueue retries because a 409 from a
 * mid-turn console is a blip that clears on its own; a refused submit is usually the
 * tracker saying no on purpose (a close gate, a bead that moved), and re-sending it
 * would be re-asking a question already answered. Nothing is lost by not retrying:
 * the card comes back with the draft in it, marked, and the retry is your tap.
 */
(() => {
  'use strict';

  let counter = 0;

  /**
   * One queue for the whole inbox.
   *
   * `add(key, run)` puts a job on the end and returns its ref. `run()` sends for real
   * and is awaited; whether it resolves or throws, the next one starts. `onChange` is
   * called with the queue every time it moves — including with an empty list, so a
   * caller can drop its pending marker without tracking that itself — and each item
   * says whether it is merely waiting or actually on the wire.
   */
  function create({ onChange = () => {} } = {}) {
    /** Tapped and not yet started, oldest first. */
    const pending = [];
    /** The one job whose write is actually out. */
    let active = null;

    const list = () => [
      ...(active ? [{ ref: active.ref, key: active.key, sending: true }] : []),
      ...pending.map((e) => ({ ref: e.ref, key: e.key, sending: false })),
    ];
    const announce = () => onChange(list());

    function add(key, run) {
      const entry = { ref: `s${++counter}`, key, run };
      pending.push(entry);
      announce();
      // Not awaited: the whole point is that the tap returns before this does.
      pump();
      return entry.ref;
    }

    async function pump() {
      // One drain at a time. A second call while one is running is a no-op, because
      // the loop below will reach whatever it just pushed.
      if (active) return;
      while (pending.length) {
        active = pending.shift();
        announce();
        try {
          await active.run();
        } catch {
          // The job said what went wrong to whoever it belongs to. Swallowed here on
          // purpose: see the note above about one refusal stranding the queue.
        }
        active = null;
        announce();
      }
    }

    /**
     * Everything tapped and not yet written — the one on the wire included.
     *
     * That inclusion is the whole reason this is not `pending.length`: the guard that
     * asks the phone not to close mid-drain has to count the write that is out, which
     * is precisely the one that would be lost.
     */
    const size = () => pending.length + (active ? 1 : 0);

    return {
      add,
      list,
      size,
      /** True while a write is genuinely out, as opposed to merely queued behind one. */
      sending: () => Boolean(active),
      /** Is this card's write still owed? For a caller that wants to say so on the card. */
      has: (key) => (active && active.key === key) || pending.some((e) => e.key === key),
    };
  }

  window.beadcause = window.beadcause || {};
  window.beadcause.submitQueue = { create };
})();
