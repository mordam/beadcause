/**
 * What a session actually cost, and whether it fitted the window it was routed into.
 *
 * bc-nc6o.8, and the fourth thing this epic records about a run. lib/complexity.js turns
 * a bead's tier into a `--model`, lib/ranmodel.js reads back which model the hour was
 * billed to, and both of those answer *which* — neither answers *how much*. So the tier
 * has been decided again and again with no feedback of any kind: the agent that rates a
 * bead `medium` is sending it to Sonnet's 200k window, and nothing in the tracker, the
 * archive or the cards has ever said whether the last bead rated that way fitted.
 *
 * It is not fitting. That is the observation this file exists for: Sonnet-routed workers
 * are hitting the wall, which means an unattended hour spent auto-compacting — the same
 * "botched session" outcome `FALLBACK_MODEL` picks the expensive model to avoid, arriving
 * through the tiers somebody *did* rate rather than through the ones nobody did.
 *
 * ## Peak occupancy cannot say it on its own, and that is the whole trap
 *
 * The obvious measure is how close the context got to the limit, and on its own it is
 * useless: **the harness compacts before the window is exceeded**, so a session that ran
 * out of room reads as ~90% full and one that had plenty to spare can read the same. The
 * number that never crosses its limit is not evidence about the limit.
 *
 * What is evidence is the compaction itself. Claude Code writes a `system` event with
 * `subtype: 'compact_boundary'` carrying `compactMetadata` — `trigger` (`auto` when the
 * harness ran out of room, `manual` when somebody typed `/compact`), `preTokens`,
 * `postTokens` and `cumulativeDroppedTokens`. An `auto` boundary is the definitive "this
 * session needed more window than it had", written by the thing that made the decision.
 * So the verdict here rests on the boundary, and occupancy is kept for the case the
 * boundary cannot cover: a session that *fitted*, and by how much. "Fitted at 41%" and
 * "fitted at 94%" are the same outcome and different advice.
 *
 * ## The window is not in the transcript, so it comes off what the launcher asked for
 *
 * `message.model` is `claude-opus-5` whether that session was opened on the 200k model or
 * on the 1M variant — the `[1m]` marker is part of the *selection* and is not written to
 * any turn. There is no field anywhere in the file naming the context limit. So the
 * window has to come from the model string beadcause itself passed to `--model`, which it
 * already stores in `meta.json`, and the rule is the same one the status line uses: a
 * string mentioning `1m` is the long window, anything else is 200k.
 *
 * A consequence worth stating rather than leaving to be discovered: `MODEL_BY_TIER` sends
 * `high` to plain `opus`, which is **also** a 200k window. Rating a bead `high` today buys
 * a better model and not one token more room. This file only measures; whether the tier
 * should pick the window too is bc-nc6o.9's question, and it is unanswerable without these
 * numbers, which is why they come first.
 *
 * ## Sidechains count toward the bill and not toward the window
 *
 * A subagent's turns are in the same transcript with `isSidechain: true`, and they are
 * real tokens on a real invoice — but they are spent in the subagent's own context, not in
 * the session's. Folding them into peak occupancy would make a session that fanned out to
 * six readers look like one that was about to overflow, which is precisely backwards:
 * fanning out is how a session *avoids* filling its window. So the totals include them and
 * the peak does not, and both halves say which they are.
 *
 * ## A label, and the same shape as `ran:` for the same reasons
 *
 * `ctx:fit` | `ctx:tight` | `ctx:over` on the bead, a set, written by the advocate beside
 * `ran:` and protected from the phone's ✎ by `isProtectedLabel` — see lib/ranmodel.js for
 * every one of those arguments, which are unchanged here. Three values because the tier
 * they inform has three, and `bd list --label ctx:over` is then the question this whole
 * file exists to make askable.
 *
 * **`ctx:fit` is written rather than left implicit.** The absence of `ctx:over` is
 * ambiguous in the direction that matters: nearly every bead in the tracker has never been
 * measured, and a rater reading "no overflow label" off one of those would be reading
 * reassurance out of a bead nothing has ever run on.
 */

/* --------------------------------------------------------------- the window */

/** Every model beadcause routes to today. 200k unless the selection says otherwise. */
export const DEFAULT_WINDOW = 200_000;

/** What `[1m]`, `sonnet[1m]`, `claude-opus-5[1m]` buy. */
export const LONG_WINDOW = 1_000_000;

/**
 * The context window a session opened on this model string had, or `null` for a session
 * whose selection nothing recorded.
 *
 * Takes the **selection** — the alias or id handed to `--model` — and not a model id read
 * off a turn, because the two are not interchangeable for this one question: the long
 * variant is `claude-opus-5[1m]` at selection time and `claude-opus-5` in every line of
 * the transcript it produces. Reading the window off a turn would silently answer 200k for
 * every 1M session there has ever been.
 *
 * `null` rather than a default for the unknown case, and that direction is deliberate: a
 * percentage is a claim about a limit, and inventing 200k for a window nobody recorded
 * would manufacture pressure out of a missing field — on an old archive entry, or on a
 * window somebody opened by hand. See `pressureOf`, which declines to grade those.
 */
export function contextWindow(model) {
  const selection = String(model ?? '').trim().toLowerCase();
  if (!selection) return null;
  // `1m` as its own token rather than as a substring, which is one character stricter than
  // the status line's `*1m*` glob and stricter on purpose: model ids carry dates, and a
  // release stamped `...-2025-1m-...` is not a thing today but a bare substring match is one
  // upstream naming decision away from silently grading every session against a million.
  return /(^|[^a-z0-9])1m([^a-z0-9]|$)/.test(selection) ? LONG_WINDOW : DEFAULT_WINDOW;
}

/* ------------------------------------------------------- reading a transcript */

/** A session that reached this share of its window is `tight` — it fitted, but only just. */
export const TIGHT_PCT = 75;

/** The verdicts, roomiest first. Three, because the tier they inform has three. */
export const PRESSURES = ['fit', 'tight', 'over'];

/** What `usageInTranscript` answers for a session that left no measurable turn. */
export const EMPTY_USAGE = Object.freeze({
  turns: 0,
  sidechainTurns: 0,
  input: 0,
  cacheRead: 0,
  cacheCreation: 0,
  output: 0,
  peakContext: 0,
  compactions: 0,
  autoCompactions: 0,
  droppedTokens: 0,
});

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/**
 * One transcript's worth of usage: `{ turns, input, cacheRead, cacheCreation, output,
 * peakContext, compactions, autoCompactions, droppedTokens, sidechainTurns }`.
 *
 * Takes the file's **text** rather than its path, for the reason `modelsInTranscript` does:
 * the part worth a test is testable without a fake home directory, and lib/sessionlog.js
 * already owns finding the files — a session that enters a worktree writes under two
 * project slugs and both halves are one conversation.
 *
 * Only `assistant` turns carry usage, and only `message.usage` is read. A transcript is
 * full of numbers that look like this one — a tool result quoting a bill, an agent
 * reasoning aloud about tokens, this very file's own source scrolling past a `cat` — and
 * every one of them would match a regex over the raw line.
 *
 * `peakContext` is the largest single-turn occupancy — `input + cache_read +
 * cache_creation`, which is what the harness itself compacts against — over the main
 * conversation only, and it is also raised to any `preTokens` a compaction reported. That
 * second half matters: the boundary's own number is measured by the thing that decided to
 * compact, at the moment it decided, and it is the one occupancy reading that is not an
 * inference from a turn.
 */
export function usageInTranscript(text) {
  const out = { ...EMPTY_USAGE };
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // A half-written last line is the normal state of a file being appended to.
      continue;
    }

    if (event?.type === 'system' && event?.subtype === 'compact_boundary') {
      const meta = event.compactMetadata || {};
      out.compactions += 1;
      // `auto` is the harness saying it ran out of room. Anything else — `manual`, or a
      // trigger a later release invents — is not that claim, so it is counted as a
      // compaction and not as an overflow. It still raises the peak below, which is the
      // honest part of it: the occupancy was real however the compaction was started.
      if (String(meta.trigger ?? '').trim().toLowerCase() === 'auto') out.autoCompactions += 1;
      out.peakContext = Math.max(out.peakContext, num(meta.preTokens));
      // Cumulative, so the largest is the total rather than the sum being it.
      out.droppedTokens = Math.max(out.droppedTokens, num(meta.cumulativeDroppedTokens));
      continue;
    }

    if (event?.type !== 'assistant') continue;
    const usage = event?.message?.usage;
    if (!usage || typeof usage !== 'object') continue;

    const input = num(usage.input_tokens);
    const cacheRead = num(usage.cache_read_input_tokens);
    const cacheCreation = num(usage.cache_creation_input_tokens);

    // Billed either way — a subagent's tokens are on the same invoice.
    out.input += input;
    out.cacheRead += cacheRead;
    out.cacheCreation += cacheCreation;
    out.output += num(usage.output_tokens);

    if (event.isSidechain === true) {
      out.sidechainTurns += 1;
      continue;
    }
    out.turns += 1;
    // Spent in *this* window, so this is the only kind of turn the peak may come from.
    out.peakContext = Math.max(out.peakContext, input + cacheRead + cacheCreation);
  }
  return out;
}

/**
 * Two readings of the same session, folded into one.
 *
 * For the session that entered a worktree and therefore has two transcript files. Sums
 * what sums and takes the larger of what does not — a peak is a maximum over the whole
 * conversation, and `droppedTokens` is cumulative in the file it came from.
 */
export function mergeUsage(a, b) {
  const x = a || EMPTY_USAGE;
  const y = b || EMPTY_USAGE;
  return {
    turns: x.turns + y.turns,
    sidechainTurns: x.sidechainTurns + y.sidechainTurns,
    input: x.input + y.input,
    cacheRead: x.cacheRead + y.cacheRead,
    cacheCreation: x.cacheCreation + y.cacheCreation,
    output: x.output + y.output,
    peakContext: Math.max(x.peakContext, y.peakContext),
    compactions: x.compactions + y.compactions,
    autoCompactions: x.autoCompactions + y.autoCompactions,
    droppedTokens: Math.max(x.droppedTokens, y.droppedTokens),
  };
}

/** Was anything measurable at all? A window closed before its first turn answers no. */
export const measured = (usage) =>
  Boolean(usage && (usage.turns || usage.sidechainTurns || usage.compactions));

/**
 * The verdict: `'over'`, `'tight'`, `'fit'`, or `''` for a run this cannot grade.
 *
 * `over` is the auto-compaction and nothing else — the harness's own statement that the
 * session needed more room than it had.
 *
 * `tight` and `fit` are a comparison against a window, so both require one. A session
 * whose window is unknown gets `''` even with hundreds of measured turns, and that is the
 * point of the empty string: `fit` means "measured, and comfortable", which is a claim
 * nobody can make about an occupancy with no limit beside it. The one thing that survives
 * a missing window is `over`, because a compaction is a fact about the run rather than a
 * ratio.
 */
export function pressureOf(usage, limit) {
  if (!measured(usage)) return '';
  if (usage.autoCompactions > 0) return 'over';
  const window = Number(limit);
  if (!Number.isFinite(window) || window <= 0) return '';
  return (usage.peakContext / window) * 100 >= TIGHT_PCT ? 'tight' : 'fit';
}

/**
 * Everything `meta.json` records about the cost of one run, or `null` for a run that left
 * nothing measurable.
 *
 * `null` rather than a zeroed record, so the archive distinguishes "this session spent
 * nothing" from "this entry predates bc-nc6o.8" — a field of zeros would read as the
 * former and there are hundreds of the latter.
 *
 * `model` is the **selection** the window is derived from, and it is taken as an argument
 * rather than read back out of the usage because the transcript cannot answer it — see
 * `contextWindow`.
 */
export function sessionTokens(usage, model) {
  if (!measured(usage)) return null;
  const limit = contextWindow(model);
  const peakPct = limit ? Math.round((usage.peakContext / limit) * 1000) / 10 : null;
  return {
    turns: usage.turns,
    // Named apart from `turns` rather than folded into it: these are on the bill and not
    // in the window, and a reader three months from now must not have to know that.
    sidechainTurns: usage.sidechainTurns,
    input: usage.input,
    cacheRead: usage.cacheRead,
    cacheCreation: usage.cacheCreation,
    output: usage.output,
    peakContext: usage.peakContext,
    limit,
    peakPct,
    compactions: usage.compactions,
    autoCompactions: usage.autoCompactions,
    droppedTokens: usage.droppedTokens,
    pressure: pressureOf(usage, limit),
  };
}

/* ---------------------------------------------------------------- the label */

/** The label prefix. One spelling in one place, as `RAN_PREFIX` is. */
export const CTX_PREFIX = 'ctx:';

/** `ctx:over`. `''` for anything that is not one of `PRESSURES` — never a bare `ctx:`. */
export const ctxLabel = (pressure) => {
  const p = String(pressure ?? '').trim().toLowerCase();
  return PRESSURES.includes(p) ? `${CTX_PREFIX}${p}` : '';
};

/** Is this one of ours? Used by the ✎ to leave it alone — see `isProtectedLabel`. */
export const isCtxLabel = (value) => String(value ?? '').trim().toLowerCase().startsWith(CTX_PREFIX);

/** The `ctx:` labels off a bead, as written. */
export const ctxLabelsOf = (bead) =>
  (bead?.labels || []).map((l) => String(l).trim()).filter((l) => isCtxLabel(l));

/**
 * Every verdict this bead has been worked under, deduplicated: `['tight', 'over']`.
 *
 * `[]` for a bead nothing has finished a session on, which is nearly all of them — and
 * that is a different fact from `['fit']`, which is why `fit` is written.
 *
 * Not ordered by time, for the reason `modelsRan` is not: a label set has no order, and a
 * caller that needs "how did the last run go" wants the session archive, where the runs
 * are a chain of commits and the question has a real answer.
 */
export function pressuresSeen(bead) {
  const out = [];
  for (const raw of ctxLabelsOf(bead)) {
    const token = raw.slice(CTX_PREFIX.length).trim().toLowerCase();
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * The label this bead is missing for this run: `{ addLabels }`.
 *
 * Never removes, exactly as `ranUpdate` never does. A bead that fitted in March and
 * overflowed in June carries both, and that pair is the most informative thing the tracker
 * can say about it — the work grew, and the tier did not. Collapsing it to the latest
 * verdict would throw away the only comparison available.
 *
 * A run with no verdict — no window recorded, nothing measurable — writes nothing at all
 * rather than a placeholder, so a missing label always means "nobody knows" and never
 * "somebody looked and shrugged".
 */
export function ctxUpdate(bead, pressure) {
  const want = ctxLabel(pressure);
  if (!want) return { addLabels: [] };
  const current = new Set(ctxLabelsOf(bead).map((l) => l.toLowerCase()));
  return { addLabels: current.has(want) ? [] : [want] };
}

/**
 * The one line a log or a card can say about a run: `'194k of 200k · 97% · auto-compacted
 * once'`. `''` for a run there is nothing to say about.
 *
 * Here rather than in the caller because there are already three of them — the advocate's
 * console line, the archive's own reader, and the audit corpus — and a number formatted
 * three ways is three chances for two of them to disagree about the same session.
 */
export function tokenLine(tokens) {
  if (!tokens) return '';
  const k = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : `${Math.round(n / 1000)}k`);
  const parts = [tokens.limit ? `${k(tokens.peakContext)} of ${k(tokens.limit)}` : `${k(tokens.peakContext)} peak`];
  if (tokens.peakPct !== null && tokens.peakPct !== undefined) parts.push(`${tokens.peakPct}%`);
  if (tokens.autoCompactions === 1) parts.push('auto-compacted once');
  else if (tokens.autoCompactions > 1) parts.push(`auto-compacted ${tokens.autoCompactions}×`);
  else if (tokens.compactions) parts.push(`compacted by hand ${tokens.compactions === 1 ? 'once' : `${tokens.compactions}×`}`);
  return parts.join(' · ');
}
