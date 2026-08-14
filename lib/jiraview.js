/**
 * The ticket, read — what the view over the tab draws, and the half a row cannot carry.
 *
 * A JIRA row says the key, the summary, the status and when it last moved (bc-0i27.3),
 * which is deliberately everything you need to decide *whether to open it* and nothing
 * like enough to decide *about it*. This is what opening it fetches: the ticket's own
 * description and thread out of JIRA, and the beads that have been written under its
 * epic so far.
 *
 * ## Why the bead half is not here, and only the *children* are
 *
 * The epic's id, whether it is still held, and how the reading is going all ride the
 * inbox payload already — `bead`, `held` and `ingest` on every ticket row, stamped in
 * lib/server.js off maps that cost nothing to read. So the view draws those from the row
 * it was opened from, and they **fill themselves in on the ordinary inbox poll**: a
 * ticket opened in the minute before its epic is filed shows the epic the moment the
 * next payload carries it, with no second request and nothing here to poll. That is the
 * whole of bc-0i27.6's *tappable before ingestion has finished* — not a spinner that
 * resolves, but a screen drawn from what is known, whose unknown half arrives on a clock
 * that was already running.
 *
 * What the row cannot carry is the **children**: which beads the ticket decomposed into
 * is a `bd list --parent`, the most expensive call in the app, and a payload every parked
 * phone rebuilds is exactly where it must not go. Behind a tap it is fine — the same
 * bargain lib/jiragate.js makes for its own reads.
 *
 * ## One GET at JIRA, and nothing written anywhere
 *
 * `issue()` with the reading fields, `descriptionText()` and `threadOf()` — all three out
 * of lib/jira.js, the same three lib/jiraingest.js reads a ticket with, because a view
 * that fetched the ticket its own way would be a second answer to "what is in this
 * ticket" that could drift from the one the decomposition was made from. Nothing here
 * writes: not to JIRA, which is the standing rule (see lib/jira.js), and not to any of
 * beadcause's own state either — opening a ticket is a read, and a read that recorded
 * that it happened would be a state file growing a row per tap.
 *
 * ## A failure is a field, never a throw
 *
 * JIRA being unreachable must not stop the view from opening: the row's own facts, the
 * epic and its children are all still worth having, and the one thing you lose is the
 * description. So the JIRA half reports `read: { ok: false, error }` and the rest of the
 * answer is built anyway — the same shape lib/jirapoll.js's `trouble()` takes, for the
 * same reason. The reverse holds too: a tracker that will not answer costs the children
 * and not the ticket.
 */
import { descriptionText, issue as fetchIssue, settingsFor, threadOf } from './jira.js';
import { cancelledRecord } from './jiracancel.js';

/**
 * How much of a thread the view carries.
 *
 * A cap rather than the whole of it, because this is a phone on a poll-shaped budget and
 * a five-year-old ticket can hold three hundred comments. The **newest** are kept, which
 * is the opposite of the order they are drawn in and the right end to keep: what was said
 * last week is what the decision is about, and the first comment on an old ticket is
 * usually the automation that filed it. What is dropped is counted and said out loud —
 * a thread silently missing its middle is worse than a thread that says it is.
 */
export const THREAD_LIMIT = 40;

const clean = (v) => String(v ?? '').trim();

/**
 * The ticket's own text, out of JIRA — or the reason there is none.
 *
 * Split out from `ticketView` because it is the only part that touches the network, and
 * a caller with a fixture (test/jiraview.mjs, and the browser check) wants to stand in
 * front of exactly this.
 */
export async function ticketText(bd, workspace, cfg, key, { fetchImpl = undefined } = {}) {
  try {
    const settings = await settingsFor(bd, workspace, cfg);
    if (!settings.enabled) return { ok: false, error: `JIRA is not on for ${workspace?.name || 'this workspace'}` };
    if (settings.problem) return { ok: false, error: settings.problem };
    const raw = await fetchIssue(settings, key, fetchImpl ? { fetchImpl } : {});
    const fields = raw?.fields || {};
    const thread = threadOf(fields);
    return {
      ok: true,
      error: null,
      description: descriptionText(fields),
      // Oldest first is `threadOf`'s order and the order a thread is read in. The cap
      // comes off the front, so the tail that survives is still in that order.
      comments: thread.slice(Math.max(0, thread.length - THREAD_LIMIT)),
      omitted: Math.max(0, thread.length - THREAD_LIMIT),
      type: clean(fields.issuetype?.name),
      priority: clean(fields.priority?.name),
      labels: Array.isArray(fields.labels) ? fields.labels.map(clean).filter(Boolean) : [],
      // The epic or story this ticket sits under *in JIRA*, which is a different thing
      // from the epic beadcause filed for it and is drawn as such. Null on the tickets
      // that have no parent, which is most of them.
      parent: fields.parent?.key
        ? { key: clean(fields.parent.key), summary: clean(fields.parent.fields?.summary) }
        : null,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).split('\n')[0] };
  }
}

/**
 * Everything the ticket view draws that the row could not already carry.
 *
 * `{ workspace, key, read, children, cancelled }` — and the reason there is no `ticket`
 * field beside those is the argument in the header: the ticket's own row facts are on
 * the row this was opened from, and merging a second copy of them into this answer would
 * be two sources for one summary, disagreeing by exactly one poll interval.
 *
 * `epic` is what the caller already knows — the row's `bead`, or null. It is passed in
 * rather than looked up because this must not re-answer a question lib/jiraepic.js owns,
 * and because a `bd list --all` is not something to spend on a tap that already has the
 * id in hand. With no epic there are no children, which is the honest answer during the
 * minute before one is filed rather than an empty list that reads as a decomposition
 * into nothing.
 */
export async function ticketView(bd, workspace, cfg, key, { epic = null, fetchImpl = undefined } = {}) {
  const name = workspace?.name || '';
  const ticketKey = clean(key);
  const read = await ticketText(bd, workspace, cfg, ticketKey, { fetchImpl });

  let children = [];
  let childrenError = null;
  if (clean(epic)) {
    try {
      // `--all`, so a child closed since the decomposition is drawn as closed rather than
      // silently absent — an epic whose children were revoked is a thing worth seeing.
      children = await bd.children(workspace, clean(epic));
    } catch (err) {
      childrenError = String(err?.message || err).split('\n')[0];
    }
  }

  return {
    workspace: name,
    key: ticketKey,
    read,
    epic: clean(epic) || null,
    children,
    childrenError,
    // The earmark, if there is one — what turns the view's actions into a single Beadify
    // (bc-0i27.6). Read here rather than trusted from the client for the reason every
    // other decision in this app is: `state.json` is the record, and a phone holding a
    // payload from before the cancel would otherwise offer a cancel a second time.
    cancelled: cancelledRecord(name, ticketKey),
  };
}
