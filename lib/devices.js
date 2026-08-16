import crypto from 'node:crypto';
import fs from 'node:fs';
import { STATE_PATH, loadState, saveState } from './config.js';

/**
 * Which browsers are signed in, and the button that ends one of them.
 *
 * **The gap this closes.** The session is a signed cookie with no server-side store
 * (lib/auth.js), chosen because bin/router.js replaces the backend several times an
 * hour and a store in memory would sign everybody out on every swap. What that cost
 * was per-device revocation: signing out ended the browser you were holding, deleting
 * `~/.config/beadcause/session.key` ended every session on every device, and there
 * was nothing in between. A phone left in a taxi therefore cost a global key rotation
 * and a re-pair of everything — including the Android app and every ntfy button,
 * which had done nothing wrong.
 *
 * Worse, and less obvious: **signing out was cosmetic.** `/auth/signout` cleared the
 * cookie in the browser that asked, and the cookie *value* stayed valid for its full
 * thirty days — so anything that had copied it kept working. Nothing there is what a
 * person means by "sign that device out".
 *
 * **The shape that survives a swap.** A small list of issued session ids in
 * `state.json`, which every backend already reads and which outlives both a swap and a
 * `launchctl kickstart`. The id is minted when the cookie is, stamped into the signed
 * payload as `sid`, and the record beside it holds the address, a label read off the
 * user-agent, when it was first seen and when it was last seen. Revoking is deleting
 * the record: the cookie still verifies, and its `sid` is now a name for nothing, so
 * the gate refuses it. There is no tombstone to keep because there is nothing to
 * distinguish — an id this list has never heard of and an id it has forgotten are the
 * same fact, and both are "no".
 *
 * **A cookie with no `sid` is refused, and that is deliberate.** Anything issued
 * before this existed is a session that cannot appear in the list and cannot be
 * revoked from it, which is precisely the hole being closed — a list that quietly
 * omits a live device is worse than no list, because the one thing you would use it
 * for is deciding you have accounted for everything. So they stop working when this
 * lands, once, and the cost is one Google sign-in per browser. Every non-browser
 * caller is untouched: none of them holds a cookie, they all carry the shared token,
 * and the token is asked first and answered on its own (lib/server.js).
 *
 * **Why the writes are rare enough to live in `state.json`.** `saveState` is an atomic
 * rewrite plus a snapshot commit in the config repo, which is far too expensive to do
 * per request. So there are exactly two kinds of write: one when a session is minted
 * or revoked, and one *at most every five minutes per device* to move `last`. "Last
 * seen" to the nearest five minutes is the resolution the question actually has —
 * nobody looking at that list is deciding anything on the strength of a minute.
 *
 * **Why the read re-stats the file.** Two backends are alive at once during a swap,
 * and the daemon is not the only writer of its own state. A revocation pressed on the
 * new backend has to bite on the old one before it dies, so the cache is keyed on the
 * file's mtime and size rather than on a TTL: one `stat` per session request, and a
 * revoke takes effect on the next request anywhere.
 */

/** The most devices kept. Well past what one person owns; a bound, not a policy. */
export const DEVICE_MAX = 50;

/**
 * How stale `last` is allowed to get before a request pays for a write.
 *
 * The trade is a `state.json` rewrite against the precision of a sentence on a screen.
 * Five minutes is plainly enough for "is this the phone I lost this morning", and it
 * keeps a browser polling every 25 seconds down to twelve writes an hour rather than
 * a hundred and forty.
 */
export const SEEN_MS = 5 * 60 * 1000;

/**
 * A session id: 96 random bits, and it is a *name* rather than a secret.
 *
 * It authorises nothing on its own, it appears in a list on screen, and forging one
 * gets you nowhere because the cookie carrying it is signed. What it must be is
 * unguessable enough that two sessions never collide, since a collision would revoke
 * somebody else's browser.
 */
export const newDeviceId = () => crypto.randomBytes(12).toString('base64url');

/**
 * What to call this browser, from its user-agent.
 *
 * Not a fingerprint and not a parse: three words on a card, so the row you are about
 * to revoke is the one you meant. The order of the browser tests is the whole trick —
 * Edge claims to be Chrome *and* Safari, Chrome claims to be Safari, and testing them
 * the other way round labels every phone "Safari". The device half is asked first
 * because "iPhone" is the word you would actually use for the thing in the taxi.
 *
 * An empty or unrecognised agent is said plainly rather than guessed at: a wrong label
 * on this screen is worse than no label, because it is the label you would revoke by.
 */
export function deviceLabel(userAgent) {
  const ua = String(userAgent || '').trim();
  if (!ua) return 'an unnamed browser';
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux|X11/.test(ua)
              ? 'Linux'
              : '';
  const app = /Beadcause\//.test(ua)
    ? 'the beadcause app'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\/|Opera/.test(ua)
        ? 'Opera'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : '';
  if (device && app) return `${device} · ${app}`;
  return device || app || 'an unrecognised browser';
}

/** One record, or null for anything not shaped like one. */
function record(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const exp = Number(raw.exp);
  return {
    email: typeof raw.email === 'string' ? raw.email : '',
    label: typeof raw.label === 'string' ? raw.label : '',
    first: typeof raw.first === 'string' ? raw.first : '',
    last: typeof raw.last === 'string' ? raw.last : '',
    // Epoch seconds, to match the cookie's own `exp` — the two are the same instant,
    // and keeping the units the same is what stops one of them being a thousand times
    // the other on the day somebody compares them.
    exp: Number.isFinite(exp) ? exp : 0,
  };
}

/**
 * The map, with everything that is not a record dropped.
 *
 * A half-written or hand-edited `state.json` must read as *fewer* devices rather than
 * as a device that cannot be revoked, so anything unreadable is left out — which
 * refuses the session it belonged to, and refusing is the safe direction here.
 */
export function normalizeDevices(devices) {
  const src = devices && typeof devices === 'object' && !Array.isArray(devices) ? devices : {};
  const out = {};
  for (const [id, raw] of Object.entries(src)) {
    const rec = record(raw);
    if (id && rec) out[id] = rec;
  }
  return out;
}

/**
 * The live record for this id, or null.
 *
 * Expiry is checked here too, so a stale file cannot outlive the cookie it describes —
 * the two carry the same instant and the cookie's own check is the one that matters,
 * but a list that shows a device the gate would refuse is a list that lies.
 */
export function liveDevice(devices, id, now = new Date()) {
  const rec = normalizeDevices(devices)[String(id || '')];
  if (!rec) return null;
  if (rec.exp && rec.exp * 1000 <= now.getTime()) return null;
  return rec;
}

/**
 * Write down a session that has just been issued. Returns a new map.
 *
 * Pruned on the way in rather than on a timer: the moment a device is added is the
 * only moment this file grows, so it is the only moment it needs bounding.
 */
export function rememberDevice(devices, { id, email, label, exp }, now = new Date()) {
  const at = now.toISOString();
  const kept = pruneDevices(devices, now);
  return {
    ...kept,
    [String(id)]: {
      email: String(email || ''),
      label: String(label || ''),
      first: at,
      last: at,
      exp: Number(exp) || 0,
    },
  };
}

/**
 * Move `last`, or say there is nothing worth writing.
 *
 * Null means "do not write" — an unknown id, or a `last` that is younger than
 * `SEEN_MS`. Returning null rather than an unchanged map is what keeps the decision
 * here, in a function a test can drive, instead of in the caller's head.
 */
export function touchDevice(devices, id, now = new Date()) {
  const all = normalizeDevices(devices);
  const rec = all[String(id || '')];
  if (!rec) return null;
  const since = now.getTime() - Date.parse(rec.last || '');
  // An unreadable `last` is written rather than kept: NaN is not "recent", and a row
  // that can never update its own timestamp is a row that reads as abandoned forever.
  if (Number.isFinite(since) && since < SEEN_MS) return null;
  return { ...all, [String(id)]: { ...rec, last: now.toISOString() } };
}

/**
 * End one session and no other.
 *
 * `revoked` says whether there was anything there, so the screen can tell "done" from
 * "somebody else already did that" — two presses on a phone with a slow connection is
 * the normal way to reach the second one.
 */
export function revokeDevice(devices, id) {
  const all = normalizeDevices(devices);
  const key = String(id || '');
  if (!(key in all)) return { devices: all, revoked: false };
  delete all[key];
  return { devices: all, revoked: true };
}

/**
 * Drop what is dead, then cap what is left.
 *
 * Expiry first, because those records describe cookies the browser has already thrown
 * away. The cap is a backstop against a file that grows forever, and it evicts the
 * *least recently seen* — the only defensible order, since evicting a record silently
 * signs that device out and the oldest is the one least likely to be in somebody's
 * hand. At fifty, for one person's devices, it should never fire.
 */
export function pruneDevices(devices, now = new Date()) {
  const rows = Object.entries(normalizeDevices(devices))
    .filter(([, rec]) => !rec.exp || rec.exp * 1000 > now.getTime())
    .sort((a, b) => (Date.parse(b[1].last) || 0) - (Date.parse(a[1].last) || 0))
    .slice(0, DEVICE_MAX);
  return Object.fromEntries(rows);
}

/** The list a screen draws: newest-seen first, with the browser reading it marked. */
export function deviceRows(devices, { current = null, now = new Date() } = {}) {
  return Object.entries(pruneDevices(devices, now))
    .map(([id, rec]) => ({ id, ...rec, current: id === current }))
    .sort((a, b) => (Date.parse(b.last) || 0) - (Date.parse(a.last) || 0));
}

/**
 * The list as the daemon holds it: a cache over `state.json` that re-reads when the
 * file moves under it.
 *
 * `load`/`save`/`statePath` are injectable so the tests can drive this without a
 * config directory, and so an observer instance — which shares the real daemon's
 * `state.json` — is doing the same thing to the same file rather than something
 * subtly different.
 */
export function createDeviceStore({ load = loadState, save = saveState, statePath = STATE_PATH } = {}) {
  let cache = null;

  /** mtime *and* size, because two writes in one millisecond are possible and a
   *  changed length is the cheap tell that distinguishes them. */
  const stamp = () => {
    try {
      const st = fs.statSync(statePath);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return 'none';
    }
  };

  function read() {
    const now = stamp();
    if (cache && cache.stamp === now) return cache.devices;
    let devices = {};
    try {
      devices = normalizeDevices(load().devices);
    } catch (err) {
      // An unreadable state file signs sessions out rather than letting them through,
      // which is the safe direction — and the token, which is every non-browser
      // caller, is unaffected either way.
      console.warn(`[devices] could not read ${statePath} — ${err.message}`);
    }
    cache = { stamp: now, devices };
    return devices;
  }

  /** Write, and adopt what was written so the next read does not need the disk. */
  function write(devices) {
    save({ devices });
    cache = { stamp: stamp(), devices };
  }

  return {
    /** Is this session id still one of ours? The question the gate asks. */
    live(id, now = new Date()) {
      return liveDevice(read(), id, now);
    },
    list({ current = null, now = new Date() } = {}) {
      return deviceRows(read(), { current, now });
    },
    /**
     * Register a session that has just been minted. Throws if it cannot be written —
     * the caller must not hand out a cookie whose id is in no list, because the very
     * next request would refuse it and the screen would say nothing at all.
     */
    remember(entry, now = new Date()) {
      write(rememberDevice(read(), entry, now));
      return entry.id;
    },
    /** Move `last` if it is stale enough to be worth a write. Never throws: a lost
     *  timestamp is cosmetic, and a failed write must not cost somebody their page. */
    touch(id, now = new Date()) {
      try {
        const next = touchDevice(read(), id, now);
        if (next) write(next);
      } catch (err) {
        console.warn(`[devices] could not record when ${id} was last seen — ${err.message}`);
      }
    },
    revoke(id) {
      const { devices, revoked } = revokeDevice(read(), id);
      if (revoked) write(devices);
      return revoked;
    },
  };
}
