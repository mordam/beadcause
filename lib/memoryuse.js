/**
 * Whether any of the memory is ever opened — the half the three stores could not see.
 *
 * lib/memory.js records what was *written*: a commit per `remember`, per `note`, per
 * `post`, on refs you can count with `git log`. Nothing recorded that an agent ever
 * read one back, and that absence is not cosmetic — the prediction the whole
 * persistence epic is written against is that an agent keeps a **write-only diary**,
 * and a store with 244 entries and no read record cannot answer it either way. Tier 3
 * (lib/agentrepo.js) has answered it from the first day, because its wrapper logs
 * every command with a `read`/`write` kind; tier 3 is also the tier with almost no
 * data. The tiers with the data had no instrument. This is that instrument.
 *
 * **One line per read, appended, and never a git write.** The obvious place for a read
 * record is the store it is about, and it is the wrong place twice over: a commit per
 * read would double the entry counts the epic is measured by — the same `git log` that
 * says "244 things learned" would start saying 500 — and every session start reads,
 * so it would put a compare-and-swap on the hot path of opening a window. An append to
 * a JSONL is neither.
 *
 * **It lives beside tier 3's log, under `~/.config/beadcause/agents/`, and that is
 * load-bearing rather than tidy.** `agents/` is ignored by the common repo's
 * `.gitignore` (lib/commonrepo.js) precisely because what is under it is *beadcause's
 * measurement of the experiment* rather than anything an agent owns — which is exactly
 * what this file is. Putting it one directory up would commit a growing log into the
 * history that exists to explain the state files.
 *
 * **What is counted, and the one thing that deliberately is not.** A read here means an
 * agent ran the command: `beadcause-memory recall`, `notes`, `read`, `debriefs`. It does
 * **not** mean a brief mentioned a note. lib/session.js already puts the notes it thinks
 * are relevant into the prompt of every session it opens, and counting that as a read
 * would make the number unfalsifiable — every session would "read" everything, and the
 * write-only-diary prediction would be answered `no` by the instrument rather than by
 * the agents. The honest signal is the one an agent had to choose to send.
 *
 * **Why there is no `readFirst` here, unlike tier 3.** Tier 3 groups by a run id its
 * wrapper is handed at spawn, so it can say "was told what was in there, and went and
 * looked before writing". Tiers 1 and 2 are reached by a CLI that is a fresh process
 * per call, and the honest per-run grouping does not exist for the agents that have no
 * bead. What replaces it is a better answer to the same question anyway: a key that has
 * been written and never opened is a diary entry nobody read, and `keys` here against
 * the store's own key list is exactly that number.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

/** Beside the tier 3 repos and their usage log, under the same ignored directory. */
export const READ_LOG = path.join(CONFIG_DIR, 'agents', 'memory-reads.jsonl');

/** Which store a read was against. `notes` is tier 1, `memory` tier 2, and so on. */
export const TIERS = ['notes', 'memory', 'bus', 'debrief'];

/**
 * Append one read.
 *
 * Never throws, for the same reason `record` in lib/agentrepo.js never throws: the
 * measurement must not be able to break the thing it measures, and a `recall` that
 * failed because its instrumentation could not write would be the silliest possible
 * outcome for an epic about whether agents can remember anything.
 *
 * `by` is who read, `subject` is whose store — the two differ exactly when somebody
 * passed `--of`, and collapsing them would lose the one case where the distinction is
 * the whole point.
 */
export function recordRead({ by, tier, subject = null, key = null, hit = null, repo = null, bead = null } = {}) {
  try {
    if (!by || !TIERS.includes(tier)) return;
    fs.mkdirSync(path.dirname(READ_LOG), { recursive: true, mode: 0o700 });
    const line = {
      at: new Date().toISOString(),
      by: String(by),
      tier,
      subject: subject ? String(subject) : null,
      key: key ? String(key) : null,
      hit: hit === null ? null : Boolean(hit),
      repo: repo ? String(repo) : null,
      bead: bead || process.env.BEADCAUSE_BEAD || null,
    };
    fs.appendFileSync(READ_LOG, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    /* see above */
  }
}

/** The log, oldest first, unparseable lines dropped. */
export function entries({ limit = 5000 } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(READ_LOG, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n').filter(Boolean).slice(-limit)) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn append; one line is not worth failing a report over */
    }
  }
  return out;
}

const blank = () => ({ reads: 0, listings: 0, keys: [], lastAt: null, beads: 0 });

/**
 * What one agent has actually opened, per store — and what others opened of *its*.
 *
 * `reads` is every invocation; `listings` is the subset that named no key, which is
 * what the brief tells agents to run and is therefore most of them. Both are reported
 * because they answer different questions: a store that is listed daily and never
 * queried by key is being *glanced at*, and saying so is more honest than folding the
 * two into one number that reads as engagement.
 *
 * `repo` narrows tier 1 only. A note is about one codebase, so "has the worker ever
 * read its notes" has a different answer in every checkout, and pooling them would put
 * sophab's reads on beadcause's screen. Nothing else is repo-scoped, because nothing
 * else is about a repo.
 */
export function readsFor(agents, { repo = null, limit = 5000 } = {}) {
  const out = {};
  for (const a of agents) {
    out[a] = { byThem: 0 };
    for (const t of TIERS) out[a][t] = blank();
  }
  const beads = new Map();
  for (const e of entries({ limit })) {
    if (!TIERS.includes(e.tier)) continue;
    if (e.tier === 'notes' && repo && e.repo && e.repo !== repo) continue;
    const mine = out[e.by];
    if (mine) {
      const s = mine[e.tier];
      s.reads += 1;
      if (e.key) {
        if (!s.keys.includes(e.key)) s.keys.push(e.key);
      } else s.listings += 1;
      if (!s.lastAt || String(e.at) > s.lastAt) s.lastAt = e.at || null;
      if (e.bead) {
        const seen = beads.get(`${e.by}/${e.tier}`) || new Set();
        seen.add(e.bead);
        beads.set(`${e.by}/${e.tier}`, seen);
        s.beads = seen.size;
      }
    }
    // Somebody reading another agent's store with `--of`. Counted against the agent
    // whose store it was, because "has anything I wrote ever been useful to anyone"
    // is the question that half of the roster exists to answer.
    if (e.subject && e.subject !== e.by && out[e.subject]) out[e.subject].byThem += 1;
  }
  return out;
}
