/**
 * Whose beadcause wrote this — the byline every daemon write carries.
 *
 * **The failure this exists for.** `cfg.actor` is the string `beadcause`, and every
 * filing path passes it: the daemon, `beadcause-ask`, `beadcause-file`,
 * `beadcause-propose`, `beadcause-deliver`. On one Mac that is a perfectly good byline —
 * there is one beadcause and it is yours. On six Macs sharing a tracker it is the same
 * string on all of them, so `created_by` on every bead and `author` on every comment
 * says `beadcause` and nothing anywhere records **which** engineer's machine did it. Six
 * people, one byline; the history ledger, the session log and every comment thread are
 * unanimous and useless.
 *
 * **It cannot be recovered at read time, which is why it is written here.** `owner`
 * comes from the git identity of the workspace directory and is the same for everyone
 * working the same shared checkout; `updated_at` says when, not who. The machine doing
 * the writing is the only thing that knows, exactly as it is for the addressee label
 * (lib/addressee.js) — and it is the same fact, `cfg.me`, answering both questions.
 *
 * **The shape is `beadcause (carol@example.com)`, and the base comes first on purpose.**
 * It still reads as beadcause at a glance and as a *particular* beadcause on inspection.
 * Base-first also makes it recoverable: `bylineBase` strips the parenthesis back off, so
 * anything that used to ask "is this author us?" can still ask it of a byline it has
 * never seen before, from a machine it has never heard of. Suffix-first
 * (`carol@example.com via beadcause`) would have read as a person in every list that
 * truncates, which is the one thing a byline must never do.
 *
 * **With `me` unset — the default, and every install that has never heard of this — the
 * byline is the bare base and nothing changes at all.** Not a default that happens to
 * look the same: `bylineFor` cannot produce a suffix without a handle to put in it. A
 * one-Mac install writes byte-for-byte what it wrote before, which is what keeps
 * `test/attribution.mjs`'s token-caller half honest.
 *
 * **The one thing that must not break is the reply test.** `checkReplies` in
 * lib/server.js decides "is this comment an agent talking back, or is it our own daemon
 * relaying something?" by comparing the author against `cfg.actor`. A byline that no
 * longer equals `cfg.actor` would make the daemon's own writes read as agent replies and
 * buzz the phone about its own comments — so that comparison moves to `writtenByDaemon`,
 * which compares *bases* rather than strings. That also fixes a case the old test could
 * not have seen coming: on a shared tracker a comment authored `beadcause (bob@…)` is
 * another engineer's daemon, and it is not an agent talking back to you either.
 */
import { meHandles } from './addressee.js';

/** What a byline says before it says whose. Every install ships with this. */
export const BYLINE_BASE = 'beadcause';

/**
 * The byline this machine writes under.
 *
 * `base` is `cfg.actor`, so an install that renamed its actor keeps the name it chose
 * and gains the suffix; `handle` is the first of `cfg.me`, for the same reason
 * `ownAddresseeLabels` takes the first — one person answers to two addresses, and a
 * byline naming both would read as two people having written one comment.
 */
export function bylineFor(cfg) {
  const base = String(cfg?.actor ?? '').trim() || BYLINE_BASE;
  const handle = meHandles(cfg)[0];
  return handle ? `${base} (${handle})` : base;
}

/**
 * The base of a byline, with any `(who)` taken back off. Anything else is returned as
 * it came, so an author that is a person's address is left alone rather than mangled.
 */
export function bylineBase(author) {
  const s = String(author ?? '').trim();
  const m = /^(.*?)\s*\(([^()]*)\)$/.exec(s);
  return m ? m[1].trim() : s;
}

/** Who a byline names, or `null` when it names nobody. Display only — see below. */
export function bylineHandle(author) {
  const s = String(author ?? '').trim();
  const m = /^(.*?)\s*\(([^()]*)\)$/.exec(s);
  const handle = m ? m[2].trim() : '';
  return handle || null;
}

/**
 * Did a beadcause daemon write this, rather than a person or an agent?
 *
 * True for our own byline in either form, and true for **any** machine's — the base is
 * `beadcause` on every install that has not renamed it, so a comment from another
 * engineer's daemon is recognised as one. That is deliberate rather than incidental: the
 * question `checkReplies` is really asking is "is there something here for me to hear
 * about", and a second daemon relaying a second person's tap is bookkeeping, not an
 * answer to your question.
 *
 * False for everything without a byline shape, which is the load-bearing half: an agent
 * comments as its shell's `BEADS_ACTOR` (an address) or as `--actor <agent-id>`, and
 * both must keep reading as somebody talking back.
 *
 * **This is never an authorisation test.** `created_by` and `author` are fields an agent
 * can write anything it likes into (see `Bd.create`), so this decides whether to buzz a
 * phone and nothing more. Provenance is the `agent-filed` label — see lib/history.js.
 */
export function writtenByDaemon(author, cfg) {
  const base = bylineBase(author);
  if (!base) return false;
  const ours = String(cfg?.actor ?? '').trim() || BYLINE_BASE;
  return base === ours || base === BYLINE_BASE;
}
