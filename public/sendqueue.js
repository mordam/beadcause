/* Keep typing while the last thing you said is still being answered.
 *
 * Both chat surfaces here — the bead console and the agent chat on the agents
 * screen — used to treat a running turn as a reason to shut the composer down: the
 * console disabled the box and the button, and the agents screen let you type but
 * refused to send. On the CLI you can type the whole time an agent is working, and
 * losing that on a phone is worse rather than better, because a turn that spends
 * ninety seconds reading files is ninety seconds of a thought you have to hold in
 * your head.
 *
 * So the composer never closes, and what changes is where the words go. This is the
 * one place that decides, shared by both callers rather than written twice — the two
 * screens render a queued message differently, but "what happens when you say
 * something mid-turn" is one behaviour and it belongs in one file.
 *
 * Three rules it holds:
 *
 *   - **Nothing pushes through the server's refusal.** `sendTurn` still answers 409
 *     while a console is mid-turn, and that stays the truth: this waits for the turn
 *     to land and sends after it, rather than trying to deliver into a turn already
 *     running. Delivering *into* a live turn needs a persistent stream-json process
 *     and is a different piece of work.
 *   - **Nothing is lost.** A queued message is held here, shown by the caller above
 *     its composer, and can be pulled back out and edited until it goes. A delivery
 *     that fails puts the words back rather than dropping them.
 *   - **Everything said during one turn arrives as one turn.** Two messages queued
 *     while the agent is working concatenate; firing them as two `claude -p` runs
 *     back to back would answer the first without knowing the second exists.
 */
(() => {
  'use strict';

  /** How queued messages join into a single turn. A blank line, as if typed. */
  const JOIN = '\n\n';
  /** A delivery that failed is retried this soon — a blip, not a policy. */
  const RETRY_MS = 2500;
  /** …and only this many times, so a genuine refusal cannot spin forever. */
  const MAX_TRIES = 4;

  let counter = 0;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /**
   * One queue for one composer.
   *
   * `deliver(text)` sends for real and must throw if it did not. `onChange(items)`
   * is called with the queue every time it moves — including with an empty list, so
   * a caller can hide its pending strip without tracking that itself. `onError(err,
   * { willRetry })` says a delivery failed; the words are already back in the queue
   * by the time it runs.
   */
  function create({ deliver, onChange = () => {}, onError = () => {} }) {
    /** What has been said and not yet delivered, oldest first. */
    const pending = [];
    let busy = false;
    let flushing = false;
    let tries = 0;
    let retryTimer = null;

    /** Everyone who wants to know when the queue moves. `attach` adds the strip. */
    const listeners = [onChange];
    const list = () => pending.map((e) => ({ ref: e.ref, text: e.text }));
    const announce = () => {
      const items = list();
      for (const fn of listeners) fn(items);
    };

    /** Say something. Delivered now if nothing is running, queued if something is. */
    function say(text) {
      const body = String(text || '').trim();
      if (!body) return null;
      const entry = { ref: `q${++counter}`, text: body };
      pending.push(entry);
      // A new message is a fresh reason to try: whatever went wrong last time may
      // well be over, and the alternative is a queue that stays stuck after one blip.
      tries = 0;
      announce();
      flush();
      return entry;
    }

    /**
     * Pull a queued message back out — the caller puts it in the composer.
     *
     * Removal and editing are the same operation on purpose: a queued line you can
     * only delete makes fixing a typo mean retyping the sentence.
     */
    function take(ref) {
      const i = pending.findIndex((e) => e.ref === ref);
      if (i < 0) return '';
      const [entry] = pending.splice(i, 1);
      announce();
      return entry.text;
    }

    function remove(ref) {
      return Boolean(take(ref));
    }

    async function flush() {
      clearTimeout(retryTimer);
      retryTimer = null;
      if (flushing || busy || !pending.length) return;
      flushing = true;

      // Taken out before the send, not after: the caller shows it in the thread the
      // moment it goes, and a message drawn both as pending and as said reads like
      // it was sent twice.
      const batch = pending.splice(0, pending.length);
      announce();

      let failed = null;
      try {
        await deliver(batch.map((e) => e.text).join(JOIN));
      } catch (err) {
        failed = err || new Error('could not send');
      }
      // Cleared before anything is told about the failure, so a caller that repaints
      // from `onError` — and repainting is how `sync` gets called — can retry rather
      // than bounce off a flush that is technically still in progress.
      flushing = false;
      if (!failed) {
        tries = 0;
        return;
      }

      pending.unshift(...batch);
      announce();
      tries += 1;
      const willRetry = tries < MAX_TRIES;
      if (willRetry) retryTimer = setTimeout(flush, RETRY_MS);
      onError(failed, { willRetry });
    }

    /**
     * Tell the queue what the conversation is doing, as often as you like.
     *
     * Callers pass this on every repaint, so it has to be cheap and idempotent. It
     * sends on the falling edge only: a turn *ending* is the event worth acting on,
     * and flushing on every idle repaint would retry a failed send in a loop against
     * whatever repaints in response to the failure.
     */
    function sync(nowBusy) {
      const was = busy;
      busy = Boolean(nowBusy);
      if (was && !busy) {
        tries = 0;
        flush();
      }
    }

    /**
     * Draw the queue above a composer, and wire it back into that composer.
     *
     * Here rather than on each screen because the two are the same strip: a line in
     * your own words per message, tap the words to get them back, tap the ✕ to drop
     * them. The screens differ in how they draw a *conversation*, which is why they
     * each render their own thread — but a message that has not gone yet is not part
     * of a conversation, and two hand-written copies of this would drift.
     *
     * `onRestore` is called with the composer after text is put back into it, for a
     * box that grows with what is in it.
     */
    function attach({ el, box, onRestore }) {
      const strip = typeof el === 'string' ? () => document.querySelector(el) : () => el;
      const input = typeof box === 'string' ? () => document.querySelector(box) : () => box;

      listeners.push((items) => {
        const node = strip();
        if (!node) return;
        node.hidden = !items.length;
        if (!items.length) return (node.innerHTML = '');
        node.innerHTML =
          `<div class="queued-note">${
            items.length === 1 ? 'Sending when this turn finishes' : 'Sending as one message when this turn finishes'
          }</div>` +
          items
            .map(
              (q) => `<div class="queued-row">
                <button class="queued-text" data-edit="${esc(q.ref)}" type="button"
                  aria-label="Edit this message before it is sent">${esc(q.text)}</button>
                <button class="row-x" data-drop="${esc(q.ref)}" type="button" aria-label="Delete this message">✕</button>
              </div>`
            )
            .join('');

        for (const b of node.querySelectorAll('[data-edit]')) {
          b.addEventListener('click', () => {
            const text = take(b.dataset.edit);
            if (!text) return;
            const boxEl = input();
            // Above whatever is half-typed rather than over it: taking a message
            // back to fix a word must not cost the sentence you were in the middle
            // of writing.
            boxEl.value = boxEl.value.trim() ? `${text}\n\n${boxEl.value}` : text;
            onRestore?.(boxEl);
            boxEl.focus();
            boxEl.setSelectionRange(text.length, text.length);
          });
        }
        for (const b of node.querySelectorAll('[data-drop]')) {
          b.addEventListener('click', () => remove(b.dataset.drop));
        }
      });
      announce();
    }

    return {
      say,
      take,
      remove,
      sync,
      attach,
      list,
      size: () => pending.length,
      /** True while a delivery is in the air — for a caller that wants to say so. */
      sending: () => flushing,
    };
  }

  window.beadcause = window.beadcause || {};
  window.beadcause.sendQueue = { create, JOIN };
})();
