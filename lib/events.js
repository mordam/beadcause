/**
 * In-process change feed.
 *
 * The PWA can afford to re-poll `/api/questions` every 25s because a foreground
 * browser tab is already awake. A phone can't: the Android watch service holds
 * one connection open and must be told the moment something changes, without
 * spinning up `bd` across five workspaces every tick just to learn that nothing
 * did. So writes and the poller emit here, and `/api/poll` parks a request until
 * the sequence moves.
 *
 * Deliberately in-memory and un-persisted. A client that has been away long
 * enough to fall off the end of the log gets told to resync rather than handed a
 * partial history — see `since()`.
 */
export function createEventBus({ keep = 256 } = {}) {
  let seq = 0;
  const log = [];
  const waiters = new Set();

  function emit(event) {
    seq += 1;
    log.push({ ...event, seq, at: new Date().toISOString() });
    if (log.length > keep) log.splice(0, log.length - keep);
    for (const w of [...waiters]) w.done(seq);
    return seq;
  }

  /**
   * Events after `from`, or null if `from` predates the log — the caller has
   * missed events it can't reconstruct and needs the full question list instead.
   */
  function since(from) {
    if (from >= seq) return [];
    if (log.length && from < log[0].seq - 1) return null;
    return log.filter((e) => e.seq > from);
  }

  /**
   * Resolve when the sequence passes `from`, or after `ms`. `.cancel()` drops the
   * waiter — the HTTP handler calls it when the phone hangs up, so a flapping
   * connection can't leak a waiter per attempt.
   */
  function wait(from, ms) {
    if (seq > from) return { promise: Promise.resolve(seq), cancel() {} };
    let waiter;
    const promise = new Promise((resolve) => {
      waiter = {
        done(v) {
          clearTimeout(waiter.timer);
          waiters.delete(waiter);
          resolve(v);
        },
      };
      waiter.timer = setTimeout(() => waiter.done(seq), ms);
      waiters.add(waiter);
    });
    return { promise, cancel: () => waiter.done(seq) };
  }

  return { emit, since, wait, get seq() { return seq; }, get waiting() { return waiters.size; } };
}
