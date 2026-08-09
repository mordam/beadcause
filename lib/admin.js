import path from 'node:path';
import fs from 'node:fs';

import { CONFIG_DIR } from './config.js';
import { writeJsonAtomic } from './atomic.js';

/**
 * Pause all / resume all — the one deliberate switch, from an admin screen.
 *
 * Everything else in beadcause is per-repo: an advocate is paused in its own card,
 * a terminal is closed by its own button. That is right when you are attending to
 * one repo and wrong when you are leaving the desk, because "stop everything" then
 * costs one press per advocate plus one per terminal and there is no way to see
 * afterwards whether you got them all.
 *
 * Four things shape this file.
 *
 * **It is never launchd's behaviour.** A `launchctl kickstart -k` must keep doing
 * exactly what it does today. So nothing here runs at boot: the state is loaded so
 * the screen can *report* that things are paused, and no action is ever replayed
 * from it. The advocates' own `paused` flag already survives a restart on its own
 * (lib/advocate.js:212), which is what makes a paused system still paused after a
 * restart without this module lifting a finger.
 *
 * **Advocates and terminals pause separately.** They are different kinds of thing —
 * one is windows on the Mac's screen, the other is ptys you are holding in your
 * hand — and wanting to stop one without the other is the normal case, not the
 * exotic one. `what` selects; `"all"` is both.
 *
 * **Pausing advocates drains, it does not interrupt.** A worker is a `claude` in an
 * iTerm window, mid-edit as often as not. The default stops new launches and leaves
 * the running ones entirely alone: each finishes its bead and closes its own window
 * through the `doneFile; exit` ending in lib/session.js. `mode: "kill"` is the other
 * button — SIGTERM to each worker's pid, which ends `claude`, which lets the same
 * ending close the same window, just now and mid-work.
 *
 * **Resume only undoes what this did.** An advocate you paused by hand last week
 * must not come back because you pressed resume-all today, so every pause records
 * the names it actually changed and resume walks that list rather than the roster.
 * The closed terminals are recorded the same way, and for the stronger reason that
 * there is nothing else left to reopen them from — a closed terminal leaves no trace
 * in lib/terminal.js's registry once it has been reaped.
 */

const STATE_PATH = path.join(CONFIG_DIR, 'admin.json');

const iso = () => new Date().toISOString();

/** The global scope's id. Not a space name — no space may be called this. */
export const GLOBAL = '*';

/**
 * The scopes you can pause: everything, then one per configured space.
 *
 * A workspace in no space appears only under global, which is the honest answer —
 * per-space controls cannot reach it, and pretending otherwise would leave a repo
 * running that the screen said was paused.
 */
export function scopes(cfg) {
  const all = (cfg.workspaces || []).map((w) => w.name);
  const spaces = (cfg.spaces || []).map((s) => ({
    id: String(s.name),
    label: String(s.name),
    workspaces: (s.workspaces || []).filter((n) => all.includes(n)),
  }));
  return [{ id: GLOBAL, label: 'Everything', workspaces: all }, ...spaces];
}

/** Which workspace names a scope covers. Null for a scope that isn't configured. */
function reach(cfg, scope) {
  const found = scopes(cfg).find((s) => s.id === String(scope));
  return found ? found.workspaces : null;
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return {
      // What this module changed, and therefore what resume may change back.
      //
      // This is also the *only* thing the screen's "paused here" is computed from.
      // An earlier version kept a second list of which scopes you had pressed pause
      // on, and it drifted the first time the two disagreed: pause Work, then resume
      // globally, and Work still called itself paused while its advocate was plainly
      // running. Anything derivable from this list is derived from it.
      owned: {
        advocates: Array.isArray(raw?.owned?.advocates) ? raw.owned.advocates.map(String) : [],
        terminals: Array.isArray(raw?.owned?.terminals) ? raw.owned.terminals.filter((t) => t && t.workspace) : [],
      },
      at: raw?.at || null,
    };
  } catch {
    return { owned: { advocates: [], terminals: [] }, at: null };
  }
}

/**
 * The admin controls, over the two subsystems they compose.
 *
 * `advocates` is the object from createAdvocates — its `control()` is called rather
 * than its state written, so the pause takes the same path, the same log line and
 * the same persistence as pressing pause on one card. `terminals.open` is injected
 * rather than imported so the brief a reopened terminal starts with stays in
 * lib/server.js beside the one `POST /api/terminal` writes, and so this module can
 * be tested without a pty.
 */
export function createAdmin(cfg, { advocates, terminals }) {
  const state = loadState();

  const persist = () => {
    state.at = iso();
    try {
      writeJsonAtomic(STATE_PATH, state);
    } catch (err) {
      // A pause that worked but could not be written down is still a pause. Losing
      // the record costs the screen its labels and resume its list; it must not
      // turn a successful stop into an error the caller retries.
      console.warn(`[admin] could not write ${STATE_PATH} — ${err.message}`);
    }
  };

  const inScope = (names, workspace) => names.includes(workspace);

  /* ------------------------------------------------------------- advocates */

  function pauseAdvocates(names, mode) {
    const paused = [];
    for (const a of advocates.snapshot()) {
      if (!inScope(names, a.workspace)) continue;
      if (a.paused) continue; // Already paused by hand: not ours, not ours to resume.
      advocates.control(a.workspace, 'pause');
      if (!state.owned.advocates.includes(a.workspace)) state.owned.advocates.push(a.workspace);
      paused.push(a.workspace);
    }

    // Draining is the default and touches nothing: the windows close themselves as
    // each bead finishes. Killing is the explicit second button.
    const killed = [];
    if (mode === 'kill') {
      for (const a of advocates.snapshot()) {
        if (!inScope(names, a.workspace)) continue;
        for (const w of a.workers) {
          if (!w.pid || w.ended) continue;
          try {
            process.kill(w.pid, 'SIGTERM');
            killed.push({ workspace: a.workspace, bead: w.id, pid: w.pid });
          } catch {
            // Gone between the snapshot and the signal. That is the outcome we
            // wanted anyway, so it is not an error.
          }
        }
      }
    }
    return { paused, killed };
  }

  function resumeAdvocates(names) {
    const resumed = [];
    for (const name of [...state.owned.advocates]) {
      if (!inScope(names, name)) continue;
      if (advocates.has(name)) {
        advocates.control(name, 'resume');
        resumed.push(name);
      }
      state.owned.advocates = state.owned.advocates.filter((n) => n !== name);
    }
    return { resumed };
  }

  /* ------------------------------------------------------------- terminals */

  function pauseTerminals(names) {
    const closed = [];
    for (const t of terminals.list()) {
      if (t.status !== 'live') continue;
      if (!inScope(names, t.workspace)) continue;
      // Recorded before the close, because after it there is nothing left to read:
      // the registry entry is reaped and the bead it was seeded on goes with it.
      const record = { workspace: t.workspace, bead: t.bead || null, cols: t.cols, rows: t.rows, closedAt: iso() };
      terminals.close(t.id);
      state.owned.terminals.push(record);
      closed.push(record);
    }
    return { closed };
  }

  /**
   * Reopen exactly the terminals this closed.
   *
   * **A reopened terminal is a new conversation.** `commandFor` in lib/terminal.js
   * runs a bare `claude` with no `--session-id`, so what comes back is a fresh
   * session in the same directory, seeded on the same bead — not the one you were
   * talking to. bc-4zz is the bead for making that resumable; until it lands, the
   * flag below is what the screen reads to say so out loud rather than letting you
   * find out by scrolling.
   */
  function resumeTerminals(names) {
    const opened = [];
    const failed = [];
    for (const record of [...state.owned.terminals]) {
      if (!inScope(names, record.workspace)) continue;
      try {
        terminals.open(record);
        opened.push(record);
      } catch (err) {
        // Almost always terminalMax: you opened terminals by hand while these were
        // shut. Keep the record — the ones that did not fit are still reopenable
        // once a slot frees, and dropping them would lose them silently.
        failed.push({ ...record, error: err.message });
        continue;
      }
      state.owned.terminals = state.owned.terminals.filter((r) => r !== record);
    }
    return { opened, failed };
  }

  /* ---------------------------------------------------------------- the API */

  /**
   * One press. Returns what it actually did, in the caller's words, so the screen
   * can report the real numbers rather than the ones it predicted.
   */
  function control({ action, what = 'all', scope = GLOBAL, mode = 'drain' } = {}) {
    const act = String(action || '');
    if (act !== 'pause' && act !== 'resume') {
      throw Object.assign(new Error(`unknown action: ${act || '(none given)'}`), { status: 400 });
    }
    const target = String(what || 'all');
    if (!['all', 'advocates', 'terminals'].includes(target)) {
      throw Object.assign(new Error(`unknown target: ${target}`), { status: 400 });
    }
    const m = String(mode || 'drain');
    if (!['drain', 'kill'].includes(m)) {
      throw Object.assign(new Error(`unknown mode: ${m}`), { status: 400 });
    }
    const names = reach(cfg, scope);
    if (!names) throw Object.assign(new Error(`unknown scope: ${scope}`), { status: 400 });

    const did = { action: act, what: target, scope: String(scope), mode: m, at: iso() };
    const touchAdvocates = target === 'all' || target === 'advocates';
    const touchTerminals = target === 'all' || target === 'terminals';

    if (act === 'pause') {
      if (touchAdvocates) Object.assign(did, pauseAdvocates(names, m));
      if (touchTerminals) Object.assign(did, pauseTerminals(names));
    } else {
      if (touchAdvocates) Object.assign(did, resumeAdvocates(names));
      if (touchTerminals) Object.assign(did, resumeTerminals(names));
    }

    console.log(
      `[admin] ${act} ${target} in ${scope === GLOBAL ? 'every space' : scope}` +
        (act === 'pause' && touchAdvocates ? ` (${m})` : '')
    );
    persist();
    return { did, status: status() };
  }

  /**
   * What the admin screen draws before you press anything.
   *
   * Every count here is what *would* be affected, per scope, so the buttons can say
   * it in their own labels. That is the house rule for a destructive control in this
   * app and the reason the numbers are computed per scope rather than once.
   */
  function status() {
    const live = terminals.list().filter((t) => t.status === 'live');
    const snap = advocates.snapshot();
    return {
      // Until bc-4zz lands, reopening starts a fresh conversation. The screen says
      // so; when it lands this becomes false and the sentence goes away.
      reopenIsFresh: true,
      at: state.at,
      scopes: scopes(cfg).map((s) => {
        const mine = snap.filter((a) => s.workspaces.includes(a.workspace));
        const myTerms = live.filter((t) => s.workspaces.includes(t.workspace));
        const closed = state.owned.terminals.filter((r) => s.workspaces.includes(r.workspace));
        return {
          id: s.id,
          label: s.label,
          workspaces: s.workspaces,
          advocates: {
            total: mine.length,
            pausedCount: mine.filter((a) => a.paused).length,
            // How many of those this page paused — which is exactly what a resume
            // here would give back, and the only honest thing to label the button
            // with. An advocate paused by hand is in `pausedCount` and not in this.
            ours: state.owned.advocates.filter((n) => s.workspaces.includes(n)).length,
            // Windows on the Mac's screen that a drain would leave running.
            workers: mine.reduce((n, a) => n + a.workers.filter((w) => !w.ended).length, 0),
          },
          terminals: {
            live: myTerms.length,
            closed: closed.length,
          },
        };
      }),
      closed: state.owned.terminals,
    };
  }

  return { control, status, scopes: () => scopes(cfg) };
}
