/**
 * Accounts — which of your lives the whole app is currently about.
 *
 * **The failure this exists for.** One Mac reads every tracker on it, so the inbox, the
 * board, the pull requests, the advocate console and the space picker have always shown
 * work and everything-that-is-not-work in one list. `spaces` (lib/spaces.js) groups them
 * for *interruption* — "don't buzz me about work at the weekend" — and that is a real
 * question with a real answer, but it is not this one. Between them, the two words
 * "Personal" and "Climative" sat side by side in a dropdown all day: a work laptop on a
 * screen share showing six personal repos, a Saturday afternoon showing forty services.
 * A notification policy cannot fix that, because the beads are not the problem — being
 * *shown* them is.
 *
 * So there is a level above the space now, and it is an address:
 *
 *   "accounts": [
 *     { "email": "you@gmail.com", "label": "Personal",
 *       "workspaces": ["beadcause", "sophab"] },
 *     { "email": "you@work.example", "label": "Work",
 *       "workspaces": ["architecture"],
 *       "repos": { "architecture": ["architecture", "athena-service"] } }
 *   ]
 *
 * One account is active at a time. What it owns is what every screen shows; the rest of
 * the config may as well not be installed. The email is the name of the thing on purpose
 * — it is what the top bar draws, and it is the handle a filing is stamped with, so the
 * two can never say different things about who you are being right now.
 *
 * ## Four properties everything below is shaped around
 *
 * **No accounts means no accounts.** An install that has never configured one — which is
 * every install that exists on the day this shipped — resolves to `null` here, and every
 * predicate answers "yes, in scope" for it. Not a default that happens to be permissive:
 * a branch that cannot be entered, the same guarantee lib/addressee.js gives for a Mac
 * that has not been told who it is. The scoping is off until you ask for it.
 *
 * **One account is still everything, unless it says otherwise.** An account with no
 * `workspaces` key (or `["*"]`) owns every workspace there is. That is what makes adding
 * the *first* account a cosmetic change — an address in the top bar and a handle on a
 * filing — and the *second* one the change that separates anything.
 *
 * **It is a view scope, not a credential.** Switching is one tap and no sign-in: the
 * pairing token is unchanged and still sufficient for everything, which it has to be —
 * an ntfy action button, the Android app and bin/router.js all call this daemon with no
 * browser and no session anywhere near them (lib/auth.js). Anything here that read as a
 * permission boundary would be a lie to whoever believed it. What it buys is what was
 * actually wrong: not being shown the other life. `accountFor` is nonetheless the one
 * place the resolution happens, so an install that later wants the signed-in session to
 * *decide* the account rather than merely name it has one function to tighten.
 *
 * **A bead outside the account is never lost, only quiet.** The sweep still reads every
 * workspace and the poller still files every arrival; `quietReasonFor` in lib/spaces.js
 * answers `'account'` and the phone stays dark, exactly as it does for a narrowed filter
 * or a muted space. Switch account and the bead is there, in the list, with its badge.
 * Losing a question is the one failure this app exists to prevent, and a scope that could
 * lose one would not be worth having.
 *
 * ## Why the repos are here as well as the workspaces
 *
 * Almost every workspace is one repo, and for those the workspace list is the whole of
 * it. Climative is the shape that is not (lib/repos.js): forty checkouts sharing one `cl-`
 * graph, because only `architecture` has beads installed. "Which repos does this account
 * have access to" has to be answerable at that grain or the answer for a Climative
 * account is the meaningless "architecture, and everything the org has ever cloned". So
 * an account may name a subset of one workspace's approved repos, and `repoInAccount`
 * is what the screens ask. An absent entry means the whole workspace, because that is
 * true of every workspace but one.
 *
 * This module imports nothing but the handle normaliser, and takes the config and the
 * saved state as arguments rather than reading either — the same discipline lib/spaces.js
 * keeps, and for the same reason: it is asked from inside the push loop, from a request
 * handler and from a test with a hand-made config, and a module that read `state.json`
 * for itself could not be any of those three.
 */

import { meHandles, normalizeHandle } from './addressee.js';

/** `workspaces: ["*"]` — an account that owns whatever is configured, now and later. */
export const EVERY = '*';

/** Addresses are case-insensitive and a config file is typed by hand. */
export const normalizeEmail = (v) => normalizeHandle(v);

/**
 * The configured accounts, normalised, in config order.
 *
 * An entry with no usable email is dropped rather than repaired: the address is the
 * account's identity, the thing the top bar draws and the handle a filing is stamped
 * with, and an account nobody can name is not one. A duplicate address is dropped for
 * the same reason — two rows claiming one identity would make "which account am I in"
 * depend on which of them was found first.
 */
export function accountList(cfg) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(cfg?.accounts) ? cfg.accounts : []) {
    const email = normalizeEmail(raw?.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({
      email,
      // The local part is a better name than nothing — "adam" over an empty chip — and a
      // label is only ever a display string, so a bad one costs a word and no behaviour.
      label: String(raw?.label ?? '').trim() || email.split('@')[0],
      workspaces: workspacesOn(raw),
      repos: reposOn(raw),
    });
  }
  return out;
}

/** `["*"]` and an absent key are the same answer: everything there is. */
function workspacesOn(raw) {
  if (raw?.workspaces === undefined || raw?.workspaces === null) return [EVERY];
  const list = (Array.isArray(raw.workspaces) ? raw.workspaces : [raw.workspaces])
    .map((w) => String(w ?? '').trim())
    .filter(Boolean);
  return list.includes(EVERY) ? [EVERY] : [...new Set(list)];
}

/** `{ workspace: [repo, …] }`, keyed like `cfg.repos`. An absent workspace is all of it. */
function reposOn(raw) {
  const src = raw?.repos && typeof raw.repos === 'object' ? raw.repos : {};
  const out = {};
  for (const [ws, list] of Object.entries(src)) {
    const names = (Array.isArray(list) ? list : [list]).map((r) => String(r ?? '').trim()).filter(Boolean);
    // An empty array would mean "this account may work none of this workspace's repos",
    // which is a workspace it should not have been given. Read as "all of them", so the
    // narrowing has to be written down to happen.
    if (names.length) out[ws] = [...new Set(names)];
  }
  return out;
}

/**
 * The account in force — or `null`, which means the config has none and every predicate
 * below is a yes.
 *
 * `state.account` names it by address. A stored address that names nothing (an account
 * deleted from the config while a phone in a pocket still had it selected) falls back to
 * the first configured account rather than to "everything": falling back to everything
 * would answer a question about *which* life by showing all of them, which is the state
 * this module exists to end. The fallback is silent and self-correcting — the picker
 * redraws with the real one selected on the next paint.
 */
export function activeAccount(cfg, state) {
  const list = accountList(cfg);
  if (!list.length) return null;
  const want = normalizeEmail(state?.account);
  return list.find((a) => a.email === want) || list[0];
}

/** The account with this address, or null. Nothing is guessed at. */
export function accountFor(cfg, email) {
  const want = normalizeEmail(email);
  return accountList(cfg).find((a) => a.email === want) || null;
}

/**
 * Does this account own the whole configuration? True for a null account (nothing is
 * configured) and for one that says `["*"]` — the two ways of not having separated
 * anything yet, which every caller wants to treat alike.
 */
export const ownsEverything = (account) => !account || (account.workspaces || []).includes(EVERY);

/**
 * The workspace names this account can see, out of the ones that exist.
 *
 * Intersected with `known` rather than returned as written, so an account naming a repo
 * that has been retired (or that lives on another Mac, since this config is snapshotted
 * into a git repo) does not put a dead name into a picker. The stored rule is left alone
 * — see `reconcileWorkspaces` in lib/config.js for why a rule outlives the directory it
 * mentions.
 */
export function accountWorkspaces(account, known = []) {
  const all = [...known];
  if (ownsEverything(account)) return all;
  const mine = new Set(account.workspaces || []);
  return all.filter((w) => mine.has(w));
}

/**
 * Is this workspace in scope? Yes for every workspace when nothing is configured.
 *
 * **A row that names no workspace at all is in scope everywhere**, and that is the one
 * judgement here that could have gone the other way. The space picker's `matches()`
 * hides such a row while anything is selected, and it can afford to: **All** is one tap
 * away and puts it back. An account has no *All* — once two are configured one of them
 * is always in force — so the same rule would make a chat session started outside every
 * repo invisible in every account, permanently, with no widening left that could reach
 * it. That is the losing-a-question failure, and it is worth an occasional row in both
 * accounts to not have it.
 */
export function inAccount(account, workspace) {
  if (ownsEverything(account)) return true;
  const name = String(workspace ?? '');
  if (!name) return true;
  return (account.workspaces || []).includes(name);
}

/**
 * Is this checkout in scope — the second grain, for the one workspace that is forty
 * repos?
 *
 * A repo is judged only once its workspace already is: an account that cannot see
 * `architecture` cannot see `athena-service` either, whatever the repo map says. And a
 * workspace with no entry in that map is entirely in scope, which is the answer for
 * every workspace that is one repo — that is to say, all but one of them.
 */
export function repoInAccount(account, workspace, repo) {
  if (!inAccount(account, workspace)) return false;
  if (ownsEverything(account)) return true;
  const allowed = (account.repos || {})[String(workspace ?? '')];
  if (!allowed) return true;
  const name = String(repo ?? '');
  // No repo named at all is the workspace itself — a bead that never said which checkout
  // it was about. Those belong to whoever holds the workspace; the alternative is a bead
  // that is invisible in every account, which is the losing-a-question failure again.
  return !name || allowed.includes(name);
}

/**
 * The spaces this account can see, with any workspace it cannot removed from them.
 *
 * Takes `summarise()`'s rows rather than `cfg.spaces`, because the synthetic "Other"
 * group is a space you can filter by and a picker built from the config alone would drop
 * it. A space left holding nothing is dropped: a group whose every repo belongs to your
 * other life is not a place this account can go, and drawing it would be an empty menu
 * item that filters to an empty list.
 */
export function accountSpaces(account, rows = []) {
  if (ownsEverything(account)) return rows;
  const out = [];
  for (const row of rows) {
    const workspaces = (row?.workspaces || []).filter((w) => inAccount(account, w));
    if (!workspaces.length) continue;
    out.push({ ...row, workspaces });
  }
  return out;
}

/**
 * The handle a filing is stamped with — the active account's address.
 *
 * This is the "identity follows the account" half, and it is the reason the account is
 * named by an email rather than by a label. A bead filed while you are in the work
 * account is owned by, addressed to and signed with the work address; the same tap an
 * hour later on the personal account writes the personal one. Before accounts existed
 * that was `meHandles(cfg)[0]` — the first of however many addresses `me` held, which on
 * a two-address Mac meant every filing was stamped with whichever one happened to be
 * written first, forever.
 *
 * Falls back to exactly that when no account is configured, so an install with no
 * accounts stamps what it always stamped.
 *
 * Note what does *not* change: `meHandles` still answers with every address, because it
 * answers a different question — "is this bead addressed to me", which is true of a
 * question sent to either of your addresses whichever account you are looking at. See
 * lib/addressee.js.
 */
export function accountHandle(cfg, state, fallback = null) {
  const account = activeAccount(cfg, state);
  return account?.email || fallback;
}

/**
 * `cfg.me`, with the active account's address moved to the front.
 *
 * **This is the whole of "identity follows the account", and it is one line because of
 * where it is applied rather than because the feature is small.** Four separate places
 * stamp an identity onto a write — the addressee label (lib/addressee.js), the owner
 * label on a P0 (lib/ownership.js), the byline a comment is written under
 * (lib/byline.js) and the handle a claim leases with (lib/lease.js) — and every one of
 * them already takes `meHandles(cfg)[0]`, the first of the list, for the reason each of
 * them spells out: one person answers to two addresses, and a bead stamped with both is
 * no more owned than one stamped with neither. So the *order* of that list is already
 * the answer to "who am I being"; it was simply fixed at whatever order the config file
 * happened to be typed in. Reorder it and every stamp follows, with no call site
 * knowing accounts exist.
 *
 * What it does not touch is who you *are*: the whole list is returned, so a question
 * addressed to your other address is still recognised as yours (`addressedElsewhere`
 * tests membership, not position) and still reaches the inbox. Only what a new write is
 * signed with moves.
 *
 * An account address that is not in `me` at all is prepended rather than ignored. It has
 * to be: an account you file as is an address you answer to, and leaving it out would
 * stamp beads with a handle the same daemon then read as somebody else's.
 */
export function accountHandles(cfg, state) {
  const all = meHandles(cfg);
  const handle = activeAccount(cfg, state)?.email;
  if (!handle) return all;
  return [handle, ...all.filter((h) => h !== handle)];
}

/**
 * The account list as the picker draws it: every configured account, the active one
 * flagged, each with the workspaces it can actually see.
 *
 * `active` is on the row rather than sent beside the list because the picker's job is to
 * draw a set of radio buttons, and a second field naming the selected one is a second
 * thing that can disagree with the first.
 */
export function accountRoster(cfg, state, known = []) {
  const active = activeAccount(cfg, state);
  return accountList(cfg).map((a) => ({
    email: a.email,
    label: a.label,
    everything: ownsEverything(a),
    workspaces: accountWorkspaces(a, known),
    repos: a.repos,
    active: a.email === active?.email,
  }));
}

/**
 * The accounts array to save when one is added or edited — and, when it is the first one
 * added to a config that had none, the *second* account it implies.
 *
 * That second one is the whole of why this is a function rather than a push. Until now
 * every workspace was in scope, and the person adding "Work — architecture" has not said
 * anything about the eight repos that are not it. Appending only what they typed would
 * leave a config with one account owning one workspace and no account owning the rest:
 * the personal repos would be visible from nowhere. So the identity this Mac already
 * knows itself by (`me`, or whatever the caller hands in as `implicit`) is materialised
 * alongside it, owning everything the new account did not take — which is exactly the
 * split the person was reaching for, written down where they can edit it.
 *
 * It is materialised *explicitly*, with a real workspace list rather than `"*"`, for the
 * reason the block above `reconcileWorkspaces` gives about rules and facts: `"*"` is a
 * rule that would keep sweeping up every workspace added afterwards, and the workspaces
 * added afterwards are as likely to be the new account's as this one's. A list is a fact
 * about the moment the split was made, and a fact is what a person can correct.
 */
export function withAccount(cfg, next, { implicit = null, known = [] } = {}) {
  const email = normalizeEmail(next?.email);
  if (!email) return accountList(cfg);
  const row = {
    email,
    label: String(next?.label ?? '').trim() || email.split('@')[0],
    workspaces: workspacesOn(next),
    repos: reposOn(next),
  };

  const existing = accountList(cfg);
  const at = existing.findIndex((a) => a.email === email);
  if (at >= 0) {
    const out = [...existing];
    out[at] = row;
    return out;
  }

  // The first account on a config that had none, and it does not own everything: the
  // implicit account it leaves behind has to be written down or it is nowhere.
  if (!existing.length && !ownsEverything(row)) {
    const other = normalizeEmail(implicit);
    if (other && other !== email) {
      const rest = known.filter((w) => !inAccount(row, w));
      return [
        { email: other, label: other.split('@')[0], workspaces: rest, repos: {} },
        row,
      ];
    }
  }

  return [...existing, row];
}

/** Everything but this address. Removing the last account turns scoping off again. */
export function withoutAccount(cfg, email) {
  const gone = normalizeEmail(email);
  return accountList(cfg).filter((a) => a.email !== gone);
}

/** "Work (you@work.example)" — for a log line, and for the picker's title attribute. */
export function describeAccount(account) {
  if (!account) return 'every workspace';
  return account.label && account.label !== account.email
    ? `${account.label} (${account.email})`
    : account.email;
}
