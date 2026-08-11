/**
 * Slack — the same decision, in a channel.
 *
 * Not a chat feature. This is a **second delivery surface for the same decision**: the
 * question that reaches a phone as an ntfy notification also reaches a Slack channel as
 * a Block Kit message with a button per option, and pressing one writes the same answer
 * on the same bead as tapping it in the app would. The inbox is still the inbox; this is
 * where the conversation about the work already is.
 *
 * Four things are worth knowing before reading the code.
 *
 * **The answer goes back through `/api/respond`, over loopback, with the token.** Not
 * through `bd` and not through a second copy of the answer semantics. Answering is not
 * one write: it can create the beads a proposal asked for, commit an agent's amendment,
 * merge a pull request, start a deploy, refuse the close and hand back a 409, or leave
 * the bead open because the option said `closes: false`. Every one of those is already
 * in that handler, tested, and none of it is a thing to reimplement for a second
 * surface — the ntfy action buttons have called the same endpoint from the notification
 * shade since the beginning, and this is the same caller with a different button on it.
 *
 * **The buttons arrive over Socket Mode, because there is no address Slack can reach.**
 * beadcause serves a tailnet name behind a router; Slack's ordinary interactivity wants
 * a public Request URL, and there is none and should not be one. So the daemon opens an
 * outbound WebSocket to Slack instead (`apps.connections.open` with an app-level token)
 * and interactions arrive down it. That is why there are two tokens rather than one, and
 * why the bot token alone gets you questions in a channel with dead buttons — said at
 * startup, out loud, rather than left to be discovered by pressing one.
 *
 * **A posted message is remembered on disk, and settled when the bead leaves the
 * inbox.** A stale message with live buttons is the failure mode of this whole idea: a
 * question answered on the phone would sit in the channel all week offering to answer it
 * again. So the channel and timestamp go in `state.json` — not in memory, because the
 * router replaces the backend process on every deploy and a lost timestamp is a message
 * nothing can ever settle — and `settleQuestion` rewrites it with what was answered and
 * by whom, buttons gone. It is called from the answer path for the common case and from
 * the poller's sweep as the backstop, so an answer given anywhere at all still settles
 * the message: `bd close` on the Mac, an agent, another client.
 *
 * **Neither token is ever in `config.json`.** That file is committed to the git repo
 * lib/commonrepo.js keeps, after every write, so a token in it would be in a history no
 * rotation can reach back into. They live in files ending `.key`, which that repo both
 * ignores and refuses — the same construction that protects the Google client secret and
 * the tailnet private key. See `botTokenFile` below.
 *
 * What is deliberately not here: replies, foundation requests, landings, deploy and
 * certificate notices. Those are five more push functions in lib/notify.js and each one
 * is a separate decision about what a channel should carry. This is the question channel
 * and nothing else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, OBSERVING, loadState, saveState } from './config.js';
import { slackChannelFor, slackDetailFor } from './spaces.js';

/**
 * Where the two tokens are read from when the config does not name a file.
 *
 * `.key`, and the extension is the entire reason for the names — see the note on
 * `DEFAULT_SECRET_FILE` in lib/auth.js, which chose its own for exactly this. Both are
 * matched by `*.key`, which `~/.config/beadcause`'s ignore file lists *and* which
 * lib/commonrepo.js's denylist refuses at commit time, so a token kept in the default
 * place is protected by construction rather than by anybody choosing well.
 */
const DEFAULT_BOT_TOKEN_FILE = 'slack-bot.key';
const DEFAULT_APP_TOKEN_FILE = 'slack-app.key';

const fromFile = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
};

/** The file the bot token is read from — yours if you named one, ours if you did not. */
export const botTokenFile = (cfg = {}) =>
  cfg.slack?.botTokenFile || path.join(CONFIG_DIR, DEFAULT_BOT_TOKEN_FILE);

/** And the app-level token, which is what makes the buttons work. */
export const appTokenFile = (cfg = {}) =>
  cfg.slack?.appTokenFile || path.join(CONFIG_DIR, DEFAULT_APP_TOKEN_FILE);

/** The bot token: the env var, or a file. There is no third place, by design. */
export const botToken = (cfg = {}) =>
  process.env.BEADCAUSE_SLACK_BOT_TOKEN?.trim() || fromFile(botTokenFile(cfg)) || null;

/** The app-level token, same two places. */
export const appToken = (cfg = {}) =>
  process.env.BEADCAUSE_SLACK_APP_TOKEN?.trim() || fromFile(appTokenFile(cfg)) || null;

/**
 * Can this daemon post at all — and if not, which gate stopped it?
 *
 * The order of the gates is the contract, not an implementation detail. `enabled` is
 * asked first and answered without touching the filesystem, because "unconfigured means
 * no code path runs" has to include *not reading the token*: a daemon that stats a
 * secret file on every sweep of a feature nobody turned on is a daemon doing something
 * with a credential it was never given permission to look at.
 *
 * The reason travels because it is the whole of what a startup line or a log has to say.
 * "Slack is off" and "Slack is on and has no token" are the same silence and completely
 * different problems.
 */
export function slackReady(cfg = {}) {
  if (OBSERVING) return { ok: false, reason: 'observing' };
  if (!cfg.slack?.enabled) return { ok: false, reason: 'disabled' };
  if (!botToken(cfg)) return { ok: false, reason: 'no-bot-token' };
  return { ok: true, reason: null };
}

/** One line for the startup log, which is where a half-configured install is noticed. */
export function slackStatusLine(cfg = {}) {
  const { ok, reason } = slackReady(cfg);
  if (reason === 'observing') return '(observing — nothing is posted)';
  if (reason === 'disabled') return '(disabled)';
  if (reason === 'no-bot-token') return `on, but no bot token in ${botTokenFile(cfg)} — nothing will post`;
  if (!ok) return `(off — ${reason})`;
  const where = cfg.slack.channel || '(per space only)';
  // The half-configured case that is worth a sentence of its own: questions arrive and
  // the buttons do nothing, which reads as a broken app rather than a missing token.
  if (!appToken(cfg)) return `${where} — no app token in ${appTokenFile(cfg)}, so the buttons will not answer`;
  return `${where} (Socket Mode)`;
}

/* -------------------------------------------------------------------- the API */

/**
 * One call to Slack's Web API.
 *
 * Slack answers `200 {ok:false, error:"channel_not_found"}` far more often than it
 * answers a non-2xx, so both are turned into the same thrown Error with the reason in
 * it. Every caller here is already wrapped in a `catch` that logs — a channel that has
 * been archived must not be able to stop a question reaching the phone.
 */
async function api(cfg, method, body, { token, form = false } = {}) {
  const base = String(cfg.slack?.apiBase || 'https://slack.com/api').replace(/\/$/, '');
  const res = await fetch(`${base}/${method}`, {
    method: 'POST',
    headers: {
      // `apps.connections.open` takes no arguments and is documented as a form post;
      // everything else here is JSON.
      'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: form ? '' : JSON.stringify(body || {}),
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* not JSON — the error below carries the body instead */
  }
  if (!res.ok) throw new Error(`slack ${method} ${res.status}: ${text.slice(0, 200)}`);
  if (!payload?.ok) throw new Error(`slack ${method}: ${payload?.error || text.slice(0, 200)}`);
  return payload;
}

/* ----------------------------------------------------------------- the message */

/** Slack mrkdwn's three reserved characters. Everything else is safe as typed. */
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * What the buttons stand for, and why the payload is an index rather than the answer.
 *
 * A Slack button carries a `value` string that comes back verbatim when it is pressed,
 * and the obvious thing to put in it is the answer. That would make the *client* the
 * source of truth for what a button means: a value is 2000 characters, an answer can be
 * longer, and a payload that came back from outside this process would be deciding what
 * gets written on a bead.
 *
 * So the value is the bead key and an index, the options are written down beside the
 * message timestamp, and the answer is read back out of our own state when the button is
 * pressed. It also survives the thing that made this worth doing: the bead's text may
 * have changed since the message was posted, and the answer the button offered is the
 * one it should still give.
 */
export function optionsFor(q, max) {
  return (q.decision?.options || []).slice(0, Math.max(1, max || 5)).map((o) => ({
    id: o.id,
    label: clip(o.label, 74),
    response: o.response,
    closes: o.closes !== false,
  }));
}

/** The value a button carries, and the reader for it. Tiny on purpose — see above. */
const buttonValue = (key, index) => JSON.stringify({ k: key, n: index });

/**
 * The live message: what a question looks like in a channel while it is still a question.
 *
 * `minimal` is the same bargain as ntfy's, for the case where the channel has people in
 * it who should know a decision is waiting without reading it: no text, no options, one
 * link. Unlike ntfy it is not the default — a channel you named in your own config is not
 * a public relay. See `slackDetailFor`.
 */
export function liveBlocks(cfg, q, options) {
  const link = `${cfg.baseUrl}/#${encodeURIComponent(q.key)}`;
  const minimal = slackDetailFor(cfg, q.workspace) === 'minimal';
  const open = {
    type: 'button',
    action_id: 'bc-open',
    text: { type: 'plain_text', text: 'Open in beadcause' },
    url: link,
  };

  if (minimal) {
    return [
      { type: 'section', text: { type: 'mrkdwn', text: '*A decision is waiting.*' } },
      { type: 'actions', block_id: 'bc-actions', elements: [open] },
    ];
  }

  const blocks = [
    {
      type: 'section',
      // 3000 is the API's ceiling for a section; the clip is well inside it so a long
      // brief becomes a readable message with a link rather than a rejected post.
      text: { type: 'mrkdwn', text: `*${esc(clip(q.question || q.title, 600))}*` },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${esc(q.workspace)} · \`${esc(q.id)}\`${q.space ? ` · ${esc(q.space)}` : ''}${
            q.answeredBefore ? ' · *asked again*' : ''
          }`,
        },
      ],
    },
  ];

  // A question that has been round this loop before says so above the options, not only
  // in the context line — the mistake this prevents is answering it a second time
  // without noticing, and by the time your eye is on the buttons the context has gone
  // past. Same reasoning as the title in lib/notify.js.
  if (q.answeredBefore?.response) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `You answered this before: ${esc(clip(q.answeredBefore.response, 300))}` }],
    });
  }

  const elements = [];
  if (cfg.slack?.buttons !== false) {
    for (const [i, o] of options.entries()) {
      elements.push({
        type: 'button',
        action_id: `bc-opt-${i}`,
        text: { type: 'plain_text', text: clip(o.label, 74) },
        value: buttonValue(q.key, i),
      });
    }
  }
  elements.push(open);
  blocks.push({ type: 'actions', block_id: 'bc-actions', elements });

  // Said once, on the message, because it is the thing about this surface that is not
  // obvious: these are not a poll. Pressing one writes on the bead and closes it.
  const dropped = (q.decision?.options || []).length - options.length;
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text:
          (elements.length > 1
            ? 'Pressing an option answers the bead, exactly as answering in the app does.'
            : 'Answer it in the app — this question has no options to press.') +
          (dropped > 0 ? ` ${dropped} more option${dropped === 1 ? '' : 's'} in the app.` : ''),
      },
    ],
  });
  return blocks;
}

/**
 * The settled message: what it looks like once the bead has left the inbox.
 *
 * No buttons, ever — that is the whole point of rewriting it. Everything else here is
 * the record: what was answered, who pressed it, and the link, which still works because
 * a closed bead is still a bead worth opening.
 *
 * `by` is the Slack user who pressed the button and is left out when nobody here did —
 * an answer given on the phone settles this message too, and inventing an author for it
 * would be the one sentence on the message that is not true.
 */
export function settledBlocks(entry, { response = '', by = null, verb = 'Answered' } = {}) {
  const head = `*${esc(clip(entry.title || entry.id, 600))}*`;
  const who = by ? ` by <@${esc(by)}>` : '';
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `~${head}~` } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${esc(entry.workspace)} · \`${esc(entry.id)}\` · ✅ ${esc(verb)}${who}` }],
    },
  ];
  if (response) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `> ${esc(clip(response, 1200)).replace(/\n/g, '\n> ')}` } });
  }
  return blocks;
}

/** The one-line fallback every Slack message needs, for notifications and screen readers. */
const fallback = (q) => clip(`${q.workspace} ${q.id}: ${q.question || q.title || 'a decision is waiting'}`, 180);

/* ------------------------------------------------------------------ the registry */

/**
 * The posted messages, keyed `workspace/id`, in `state.json`.
 *
 * Read-modify-write through `saveState`, which merges rather than replacing the file —
 * the same contract every other key in there is written under, and the reason four
 * writers can share it.
 */
const remember = (key, entry) => {
  const all = { ...loadState().slack };
  all[key] = entry;
  saveState({ slack: all });
};

const forget = (key) => {
  const all = { ...loadState().slack };
  if (!(key in all)) return false;
  delete all[key];
  saveState({ slack: all });
  return true;
};

/** What we posted for this bead, or null. Exported for the tests and the interaction path. */
export const postedFor = (key) => loadState().slack[key] || null;

/* -------------------------------------------------------------------- posting */

/**
 * Post a question to its channel.
 *
 * `{skipped: <reason>}` for everything that is not a post, and the reason is always a
 * word rather than a boolean, because the four ways this does nothing — off, no token,
 * no channel for this workspace, already posted — are four different things to read in a
 * log at midnight.
 *
 * Called from the same place in the sweep as the ntfy push and *after* the quiet check,
 * which is what makes a space's quiet policy apply to both surfaces without this file
 * knowing anything about hours or filters. See lib/server.js.
 */
export async function postQuestion(cfg, q) {
  const ready = slackReady(cfg);
  if (!ready.ok) return { skipped: ready.reason };
  const channel = slackChannelFor(cfg, q.workspace);
  if (!channel) return { skipped: 'no-channel' };
  // Posting twice for one bead would leave two messages with live buttons and settle
  // only the second. The sweep will not normally ask twice — `notified` is what stops it
  // — but a state file restored from a snapshot can, and one of the two would then be
  // permanently stale.
  if (postedFor(q.key)) return { skipped: 'already-posted' };

  const options = optionsFor(q, cfg.slack?.maxButtons);
  const res = await api(
    cfg,
    'chat.postMessage',
    { channel, text: fallback(q), blocks: liveBlocks(cfg, q, options) },
    { token: botToken(cfg) }
  );

  remember(q.key, {
    channel: res.channel || channel,
    ts: res.ts,
    workspace: q.workspace,
    id: q.id,
    // Kept because the settled message is drawn from this and not from the bead: by the
    // time it is rewritten the bead is closed, and re-reading it would mean a `bd` call
    // on a path whose whole job is to tidy up a message.
    title: q.question || q.title || '',
    options,
    postedAt: new Date().toISOString(),
  });
  return { ok: true, channel: res.channel || channel, ts: res.ts, options: options.length };
}

/**
 * Rewrite the message for a bead that has been answered, and forget it.
 *
 * Idempotent by construction: the registry entry is what this works from, and it is
 * deleted whether or not Slack accepted the edit. A retry loop around `chat.update` would
 * be the wrong shape — the message being one edit out of date is a cosmetic problem, and
 * an entry that never clears is a message that gets rewritten every thirty seconds
 * forever.
 *
 * The buttons go even if the edit fails, in the sense that matters: the entry is gone, so
 * a press on the stale message finds nothing to answer with and says so rather than
 * answering a bead that has already been closed. That is the failure this whole path is
 * about, and it is closed on our side rather than on Slack's.
 */
export async function settleQuestion(cfg, key, { response = '', by = null, verb = 'Answered' } = {}) {
  // The same guard as `postQuestion`, and it matters for the same reason it matters in
  // lib/notify.js: `BEADCAUSE_CONFIG_DIR` isolates a second instance's state file, but an
  // observer booted from a *copy* of a live one starts life holding the live instance's
  // posted-message registry — and would rewrite messages it did not post, over beads it
  // is only watching.
  if (OBSERVING) return { skipped: 'observing' };
  const entry = postedFor(key);
  if (!entry) return { skipped: 'not-posted' };
  forget(key);
  const token = botToken(cfg);
  if (!token) return { skipped: 'no-bot-token' };

  await api(
    cfg,
    'chat.update',
    {
      channel: entry.channel,
      ts: entry.ts,
      text: clip(`${entry.workspace} ${entry.id}: ${verb.toLowerCase()}`, 180),
      blocks: settledBlocks(entry, { response, by, verb }),
    },
    { token }
  );
  return { ok: true, channel: entry.channel, ts: entry.ts };
}

/* ---------------------------------------------------------------- interaction */

/**
 * Read a `block_actions` payload, or `null` if it is not one of ours.
 *
 * Pure, and separate from the socket for that reason: everything that can be got wrong
 * about an interaction — a link button coming back as an action, a value from an older
 * version of this file, a press on a message whose bead is long closed — is decided here,
 * where a test can hand it a payload without a WebSocket.
 */
export function parseAction(payload) {
  if (!payload || payload.type !== 'block_actions') return null;
  const action = (payload.actions || []).find((a) => /^bc-opt-\d+$/.test(String(a?.action_id || '')));
  // `bc-open` is a link button: Slack sends an interaction for it too, and it means
  // "somebody followed the link", not "somebody answered". Acked and dropped.
  if (!action) return null;
  let value = null;
  try {
    value = JSON.parse(action.value);
  } catch {
    return null;
  }
  if (!value || typeof value.k !== 'string' || !Number.isInteger(value.n)) return null;
  return {
    key: value.k,
    index: value.n,
    user: payload.user?.id || null,
    userName: payload.user?.username || payload.user?.name || null,
    responseUrl: payload.response_url || null,
  };
}

/** Say something back to just the person who pressed, without a token or a channel. */
async function ephemeral(url, text) {
  if (!url) return;
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
  }).catch(() => {});
}

/** Where the answer is POSTed: this daemon's own API, over loopback. */
const answerUrl = (cfg) => `${cfg.slack?.answerBase || `http://127.0.0.1:${cfg.port}`}/api/respond`;

/**
 * A button was pressed: answer the bead, then settle the message.
 *
 * The answer goes through `/api/respond` rather than through `bd`, and over **loopback
 * rather than `cfg.baseUrl`** — the tailnet name is what a phone is told and it changes
 * shape when a certificate arrives, while `127.0.0.1:<port>` is the router, which is the
 * same process tree that is running this. The token goes in the header exactly as an
 * ntfy action button sends it.
 *
 * The three answers that endpoint can give are three different messages back:
 *
 * - **200** — the handler has already settled the message on its way out, with the name
 *   of whoever pressed. The Slack user is named on the *message*, not on the bead: a
 *   token caller has no face, which is `actorFor` in lib/server.js and true of every
 *   ntfy button too. Attributing the comment would need a Slack-user-to-email mapping
 *   and a scope to read it, and is worth doing on purpose rather than as a side effect
 *   of this.
 * - **409** — bd will not close the bead. The message keeps its buttons, because the
 *   question is still open and still answerable, and the reason goes back privately to
 *   whoever pressed.
 * - **anything else** — say so privately and leave the message alone. An answer that did
 *   not land must never look like one that did.
 */
export async function answerFromSlack(cfg, action) {
  const entry = postedFor(action.key);
  if (!entry) {
    await ephemeral(action.responseUrl, 'That question is no longer open — it was answered or dismissed somewhere else.');
    return { skipped: 'not-posted' };
  }
  const option = entry.options?.[action.index];
  if (!option) {
    await ephemeral(action.responseUrl, 'That button is from an older version of this message. Open it in beadcause to answer.');
    return { skipped: 'no-option' };
  }

  const res = await fetch(answerUrl(cfg), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-beadcause-token': cfg.token },
    body: JSON.stringify({
      workspace: entry.workspace,
      id: entry.id,
      response: option.response,
      option: option.id,
      // Who pressed, for the message and for nothing else. The handler settles the
      // message itself — every answer from every surface goes through it, so that is
      // the one place it can be settled exactly once — and this is how it knows there
      // was a person on this one. It never reaches the bead: whose answer this is on
      // the tracker is `actorFor`, and a token caller has no face.
      slackUser: action.user || undefined,
    }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* the error below carries the raw body */
  }

  if (res.status === 409) {
    await ephemeral(action.responseUrl, `bd will not close ${entry.id}: ${body?.gate?.reason || 'it is blocked'}. Open it in beadcause to answer with a comment instead.`);
    return { refused: true, reason: body?.gate?.reason || 'blocked' };
  }
  if (!res.ok) {
    await ephemeral(action.responseUrl, `That did not get through: ${clip(body?.error || text, 300)}`);
    return { error: body?.error || `HTTP ${res.status}` };
  }

  // Nothing to settle here: `/api/respond` has already rewritten the message, with the
  // presser's name on it, on its way out. See the `slackUser` note above.
  return { ok: true, handedBack: Boolean(body?.handedBack) };
}

/* --------------------------------------------------------------- socket mode */

const SOCKET_RETRY_MS = 5000;
const SOCKET_RETRY_MAX_MS = 300000;

/**
 * Hold a Socket Mode connection open, and answer what comes down it.
 *
 * Started and stopped with the poller, in bin/beadcause.js, for the same reason the
 * poller is: exactly one process may be the active backend. Slack delivers an
 * interaction to one connection, so two would not double-answer — but a standby holding
 * a connection is a standby doing work, and the swap machinery is built on the idea that
 * it does none.
 *
 * Everything here is best-effort and nothing throws out of it. Slack being unreachable
 * has to cost the buttons and nothing else: the questions still push, the phone still
 * works, the daemon stays up. A connection that cannot be opened is retried with a
 * backoff and said once per attempt in the log, because the alternative — a silent
 * reconnect loop — is how you find out by pressing a button in a week's time.
 */
export function startSlack(cfg, { log = console.log, error = console.error } = {}) {
  const ready = slackReady(cfg);
  if (!ready.ok) return null;
  const token = appToken(cfg);
  if (!token) {
    log(`[slack] no app token in ${appTokenFile(cfg)} — questions will post, and their buttons will not answer`);
    return null;
  }
  if (typeof WebSocket !== 'function') {
    error('[slack] this node has no WebSocket — Socket Mode is off, so the buttons will not answer');
    return null;
  }

  let stopped = false;
  let socket = null;
  let timer = null;
  let backoff = SOCKET_RETRY_MS;

  const retry = (why) => {
    if (stopped) return;
    error(`[slack] ${why} — reconnecting in ${Math.round(backoff / 1000)}s`);
    timer = setTimeout(open, backoff);
    timer.unref?.();
    backoff = Math.min(backoff * 2, SOCKET_RETRY_MAX_MS);
  };

  async function open() {
    if (stopped) return;
    let url;
    try {
      ({ url } = await api(cfg, 'apps.connections.open', null, { token, form: true }));
    } catch (err) {
      return retry(`could not open a Socket Mode connection (${err.message})`);
    }
    if (stopped) return;

    const ws = new WebSocket(url);
    socket = ws;

    ws.addEventListener('open', () => {
      backoff = SOCKET_RETRY_MS;
      log('[slack] Socket Mode connected — option buttons will answer');
    });

    ws.addEventListener('message', (event) => {
      let envelope = null;
      try {
        envelope = JSON.parse(event.data);
      } catch {
        return;
      }
      // Slack asks for the ack inside three seconds and re-delivers without one, so it
      // goes out before anything is done with the payload rather than after. An answer
      // that took four seconds to write would otherwise be delivered again and written
      // twice.
      if (envelope.envelope_id) {
        try {
          ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        } catch {
          /* the socket is going; the reconnect below picks it up */
        }
      }
      // A disconnect is routine: Slack refreshes these connections, and says so first.
      if (envelope.type === 'disconnect') {
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        return;
      }
      const action = parseAction(envelope.payload);
      if (!action) return;
      answerFromSlack(cfg, action)
        .then((r) => {
          if (r?.ok) log(`[slack] ${action.key} answered by ${action.userName || action.user || 'someone'} from Slack`);
          else if (r?.refused) log(`[slack] ${action.key} not answered from Slack — ${r.reason}`);
          else if (r?.error) error(`[slack] ${action.key} could not be answered from Slack — ${r.error}`);
        })
        .catch((err) => error(`[slack] ${action.key} could not be answered from Slack — ${err.message}`));
    });

    ws.addEventListener('error', () => {
      /* `close` always follows, and it is where the reconnect lives */
    });
    ws.addEventListener('close', () => {
      if (socket === ws) socket = null;
      retry('Socket Mode connection closed');
    });
  }

  open();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        socket?.close();
      } catch {
        /* already gone */
      }
      socket = null;
    },
  };
}
