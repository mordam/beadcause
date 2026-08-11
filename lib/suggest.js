/**
 * Suggested answers — the buttons a question gets when nobody wrote a block.
 *
 * A `decision` block (lib/decision.js) is the good case: the agent wrote the
 * options and wrote the exact sentence each one records, and the card draws a
 * button per choice. Most questions do not arrive that way. An ordinary session
 * files a `human` bead with the choices sitting in the prose —
 *
 *     The two ways to do this:
 *
 *     - **Restore at promotion** — move restoreTerminals() into /internal/activate.
 *       Freshest list, costs a directory read during the swap. (recommended)
 *     - **Restore at startup** — leave it where it is and rely on the reaper gating.
 *
 * — and the phone renders that as paragraphs with an empty box under them. The
 * choices are right there and answering still means typing them out with a thumb.
 *
 * So: read the prose, find the list that is the answer set, and offer it. What
 * comes out of here is deliberately NOT `decision.options`. It rides its own
 * field (`q.suggested`) because it has its own trust level: a real option's
 * `response` was written by the agent as the answer, and a suggestion is a line
 * this file lifted out of a paragraph. Both now fill the answer box rather than
 * sending themselves — the words that go on the thread under Adam's name are
 * always words he has actually read — but only the real option can carry the one
 * thing a sentence cannot say, which is whether answering commissions work
 * rather than settling the question. Hence two fields and two shapes on the card:
 * full-width buttons for what an agent wrote, chips for what was read off a
 * paragraph, and the strip above the chips saying which field they came out of.
 *
 * That trust level is also why every rule below fails towards silence. Two
 * plausible options and no buttons is a question you type the answer to, which
 * is exactly what happens today. Six buttons scraped off an unrelated bullet
 * list is a card that invites the wrong tap — worse than the thing it replaced.
 * When a shape is ambiguous this returns null.
 */

/* --------------------------------------------------------------- primitives */

/** How long a chip may be before it stops being scannable on a 360px phone. */
const LABEL_MAX = 72;
/** A pasted-in essay is not an answer. Longer items are cut at a sentence. */
const RESPONSE_MAX = 500;
/** Fewer than two is not a choice; more than six is a document, not a question. */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

const ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEAD_RE = /^\s*(#{1,6})\s+(.*)$/;
/** `- [ ] ship it` is a checklist. Checklists are work, not choices. */
const TASK_RE = /^\[[ xX]\]\s+/;

/**
 * "Option A — …", "Option 2:", "### Option B". The one shape explicit enough to
 * be trusted wherever it appears, list or not.
 */
const OPTION_RE =
  /^(?:\*\*|__)?\s*option\s+([A-Za-z0-9]{1,3})\s*(?:\*\*|__)?\s*(?:[—–:.)]|-\s)\s*(.+)$/i;

/**
 * The same thing written short: `**(a)** …`, `(b) …`, `c) …`.
 *
 * The commonest shape a question actually arrives in — bc-j0zl offered its three
 * ways to make room on the bottom bar exactly like this, and got no buttons at
 * all, because a bracketed letter is not the word "Option" and the bold it is
 * wrapped in makes every item's label read `(a)`.
 *
 * The closing bracket is required. A letter alone opens the door to every list
 * whose items happen to begin with a word — and `byLetterMarker` below asks for
 * more than the bracket anyway: the markers have to run a, b, c from the start,
 * which no accident does.
 */
const MARKER_RE =
  /^(?:\*\*|__)?\s*\(?([A-Za-z]|[1-9])\)\s*(?:\*\*|__)?\s*(?:[—–:.]|-\s)?\s*(.+)$/;

/** An item whose bold run is nothing but that marker — see byBoldList. */
const MARKER_ONLY_RE = /^(?:\*\*|__)\s*\(?[A-Za-z0-9]{1,2}\)?\s*(?:\*\*|__)/;

/** A line that introduces the list under it. */
const LEAD_RE =
  /^(?:\*\*|__)?\s*(?:the\s+)?(?:two|three|four|five|six)?\s*(options|choices|candidates|alternatives|possible answers|ways? (?:to|forward)|either)\b/i;

/**
 * Recommendation, and its opposite.
 *
 * `NOT_REC_RE` is not a nicety. "Rebuild from scratch — not recommended" is a
 * perfectly ordinary thing for an agent to write, and a star on that chip would
 * be this file telling Adam to do the thing the brief warned him off.
 */
const REC_RE =
  /\((?:strongly\s+)?recommended\)|\brecommended\b|\bmy recommendation\b|\b(?:i(?:'d| would)|we(?:'d| would)?) recommend\b/i;
const NOT_REC_RE = /\b(?:not|never|isn't|is not|un-?|less|least)\s*recommend/i;
/**
 * A standalone verdict line: "Recommendation: restore at promotion".
 *
 * The bare-space spelling — `RECOMMEND Gross — fee on the full charge` — is not a
 * generalisation for its own sake. It is the house style: the `handoff` skill
 * tells every session to close the option list in `--design` with exactly that,
 * so it is the single most common way a recommendation reaches this parser.
 */
const REC_LINE_RE =
  /^(?:\*\*|__)?\s*(?:my\s+|i\s+)?recommend(?:ation|ed|s)?(?:\*\*|__)?\s*(?:[:—–]|\s)\s*(.+)$/i;

/** Markdown down to the words. Chips carry text, not syntax. */
function plain(s) {
  return String(s ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(?<![A-Za-z0-9])[*_](?!\s)(.+?)(?<!\s)[*_](?![A-Za-z0-9])/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** Cut at a word, never mid-word, and say that it was cut. */
function clip(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:—–-]$/, '')}…`;
}

/** Cut a response at the last sentence that fits, so it never ends mid-thought. */
function clipSentence(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return stop > max * 0.5 ? cut.slice(0, stop + 1) : clip(s, max);
}

/* -------------------------------------------------------------- line → unit */

/**
 * Fenced blocks are removed before anything is read.
 *
 * A ```decision block that failed to parse, a shell transcript, a diff — all of
 * them are full of lines beginning with `-`, and none of them is a list of
 * answers. This runs on the *body*, which decision.js has already had its own
 * block cut out of, so what is left here is someone else's fence.
 */
function stripFences(md) {
  const kept = [];
  let fence = null;
  for (const line of String(md ?? '').split('\n')) {
    const m = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    kept.push(line);
  }
  return kept;
}

/**
 * Fold the lines into units: a list item, a heading or a paragraph, each with
 * its continuation lines joined back on.
 *
 * The joining is the part that has to be right. bd stores a description
 * hard-wrapped at about 78 columns, so the item above arrives as three physical
 * lines and a parser that reads lines sees one option and two fragments. Every
 * shape below matches against the *folded* text for that reason.
 *
 * `listId` increments whenever a run of items is broken by prose, so "the list
 * under this heading" is a thing that can be asked for.
 */
function unitize(lines) {
  const units = [];
  let list = 0;
  let inList = false;
  let blank = false;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      // A blank line inside a list is a loose list, not the end of one — that is
      // settled by what comes next, not here.
      blank = true;
      continue;
    }

    const item = line.match(ITEM_RE);
    const head = line.match(HEAD_RE);
    const last = units[units.length - 1];

    if (item) {
      const indent = item[1].length;
      // An indented item under an open item is that item's own sub-list, and its
      // words belong to the option above rather than standing as one.
      if (inList && last?.kind === 'item' && indent > last.indent + 1) {
        last.text += ` ${item[2].trim()}`;
        blank = false;
        continue;
      }
      if (!inList) list += 1;
      inList = true;
      blank = false;
      units.push({ kind: 'item', text: item[2].trim(), indent, list, line: raw });
      continue;
    }

    if (head) {
      inList = false;
      blank = false;
      units.push({ kind: 'head', text: head[2].trim(), indent: 0, list: 0, line: raw });
      continue;
    }

    // Prose. Indented under an open item it is a wrapped continuation of it;
    // flush left after a blank line it ends the list and starts a paragraph.
    const indent = line.length - line.trimStart().length;
    if (last && !blank && (last.kind === 'item' || last.kind === 'para')) {
      last.text += ` ${line.trim()}`;
      continue;
    }
    if (inList && indent > 0 && last?.kind === 'item') {
      last.text += ` ${line.trim()}`;
      blank = false;
      continue;
    }
    inList = false;
    blank = false;
    units.push({ kind: 'para', text: line.trim(), indent, list: 0, line: raw });
  }

  return units;
}

/* -------------------------------------------------------------- unit → option */

/** Split an item into the words on the chip and the words under it. */
function splitLabel(text) {
  const bold = text.match(/^(?:\*\*|__)\s*(.+?)\s*(?:\*\*|__)\s*(.*)$/s);
  if (bold && plain(bold[1])) {
    return [plain(bold[1]), plain(bold[2]).replace(/^[—–:]\s*/, '').replace(/^-\s+/, '')];
  }
  const t = plain(text);
  const dash = t.match(/^(.{2,120}?)\s+(?:[—–]|-)\s+(.+)$/);
  if (dash) return [dash[1], dash[2]];
  const colon = t.match(/^([^:]{2,120}):\s+(.+)$/);
  if (colon) return [colon[1], colon[2]];
  const sentence = t.match(/^(.{2,120}?[.!?])\s+(.+)$/);
  if (sentence) return [sentence[1].replace(/\.$/, ''), sentence[2]];
  return [t, ''];
}

/** Strip the recommendation marker out of the words it was written into. */
const unmark = (s) =>
  s
    .replace(/[\s—–-]*\((?:strongly\s+)?recommended\)/gi, '')
    .replace(/[\s—–-]*\b(?:strongly\s+)?recommended\b\s*[.:]?\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,;:—–-]+$/, '')
    .trim();

function toOption(text, i) {
  const full = plain(text);
  if (!full) return null;
  const recommended = REC_RE.test(full) && !NOT_REC_RE.test(full);

  let [label, hint] = splitLabel(text);
  label = unmark(label);
  hint = unmark(hint);
  if (!label) return null;

  // The response is the whole item, rebuilt — the chip is a handle, but what goes
  // in the box has to stand on its own on a thread six weeks from now.
  const response = clipSentence(unmark([label, hint].filter(Boolean).join(' — ')) || label, RESPONSE_MAX);

  return {
    id: `${slug(label) || 'opt'}-${i + 1}`,
    label: clip(label, LABEL_MAX),
    hint: clip(hint, 140),
    response,
    recommended,
  };
}

/**
 * Turn a run of units into an answer set, or nothing.
 *
 * Every rejection here is a card that keeps the behaviour it has today, which is
 * why they are cheap to make and are made freely.
 */
function toOptions(units) {
  if (units.length < MIN_OPTIONS || units.length > MAX_OPTIONS) return null;
  if (units.some((u) => TASK_RE.test(u.text))) return null;

  const options = [];
  for (const [i, u] of units.entries()) {
    const opt = toOption(u.text, i);
    if (!opt) return null;
    options.push(opt);
  }

  // Two chips reading the same word is a parse that went wrong, not a choice.
  const labels = new Set(options.map((o) => o.label.toLowerCase()));
  if (labels.size !== options.length) return null;

  // One star, and the first one wins. Two recommendations is the brief
  // contradicting itself, and a card is the wrong place to discover that.
  let starred = false;
  for (const o of options) {
    if (o.recommended && starred) o.recommended = false;
    else if (o.recommended) starred = true;
  }
  return options;
}

/* ------------------------------------------------------------------ strategies */

/** "Option A — …", anywhere: list, heading or paragraph. */
function byOptionLabel(units) {
  const marked = units.filter((u) => OPTION_RE.test(u.text));
  if (marked.length < MIN_OPTIONS) return null;
  const stripped = marked.map((u) => ({ ...u, text: u.text.match(OPTION_RE)[2] }));
  return toOptions(stripped);
}

/**
 * A lettered set — `(a)`, `(b)`, `(c)` — as list items or as paragraphs.
 *
 * Explicit enough to act on, but only as a *run*: the markers have to be distinct
 * and consecutive from `a` or from `1`. A stray `b)` in a paragraph is then
 * nothing on its own, and neither is a set that starts at `(c)`, which is a
 * fragment of something quoted rather than a question being asked here.
 *
 * The letter stays on the chip and in the answer. It is the handle the question
 * itself used — "I recommend **(b)**" — so an answer that reads "Six tabs, and
 * accept the 9.5px labels" without it has dropped the one word Adam would have
 * typed, and dropped it out of the record as well as off the button.
 */
function byLetterMarker(units) {
  const marked = units.map((u) => [u, u.text.match(MARKER_RE)]).filter(([, m]) => m);
  if (marked.length < MIN_OPTIONS) return null;

  const raw = marked.map(([, m]) => m[1]);
  const seq = raw.map((c) => c.toLowerCase());
  const from = seq[0] === '1' ? '1' : 'a';
  if (seq[0] !== from) return null;
  const start = from.charCodeAt(0);
  if (seq.some((c, i) => c.charCodeAt(0) !== start + i)) return null;

  const options = toOptions(marked.map(([u, m]) => ({ ...u, text: m[2] })));
  if (!options) return null;
  return options.map((o, i) => ({
    ...o,
    marker: seq[i],
    label: clip(`(${raw[i]}) ${o.label}`, LABEL_MAX),
    response: `(${raw[i]}) ${o.response}`,
  }));
}

/** A list sitting under a line that says a list is coming. */
function byLeadIn(units) {
  for (const [i, u] of units.entries()) {
    if (u.kind === 'item' || !LEAD_RE.test(u.text)) continue;
    const rest = units.slice(i + 1);
    const first = rest.findIndex((v) => v.kind === 'item');
    if (first < 0) continue;
    // The list has to be the *next* thing. Prose between the lead-in and the list
    // means the paragraph changed the subject on the way past — "The options:" and
    // then two paragraphs and then a list of what shipped last week is a list of
    // what shipped last week.
    if (first !== 0) continue;
    const list = rest[first].list;
    const items = [];
    for (const v of rest.slice(first)) {
      if (v.list !== list || v.kind !== 'item') break;
      items.push(v);
    }
    const options = toOptions(items);
    if (options) return options;
  }
  return null;
}

/**
 * A list whose every item leads with bold — the shape agents reach for without
 * being asked, and the only unlabelled one confident enough to act on.
 *
 * Ambiguity is resolved by the question mark: when a body holds several such
 * lists, the answer set is the one after the last thing that was asked. If
 * nothing was asked and there is more than one list, this gives up.
 */
function byBoldList(units) {
  const lists = new Map();
  for (const u of units) {
    if (u.kind !== 'item') continue;
    if (!lists.has(u.list)) lists.set(u.list, []);
    lists.get(u.list).push(u);
  }

  const bold = [...lists.values()].filter(
    (items) =>
      items.length >= MIN_OPTIONS &&
      items.every((u) => /^(?:\*\*|__)\s*\S/.test(u.text)) &&
      // A list whose every bold run is only a marker — `**(b)**`, `**a**` — is a
      // lettered set, and belongs to byLetterMarker above. If that refused it, the
      // answer is silence rather than three chips reading "(b)", "(c)", "(d)": the
      // bold run is what goes on the chip here, and a bracketed letter with the
      // words left behind in the hint is a row of buttons nobody can read.
      !items.every((u) => MARKER_ONLY_RE.test(u.text))
  );
  if (!bold.length) return null;
  if (bold.length === 1) return toOptions(bold[0]);

  const asked = units.reduce((at, u, i) => (/\?\s*$/.test(plain(u.text)) ? i : at), -1);
  if (asked < 0) return null;
  const after = bold.filter((items) => units.indexOf(items[0]) > asked);
  return after.length === 1 ? toOptions(after[0]) : null;
}

/**
 * A verdict written beside the list rather than inside it: "Recommendation:
 * restore at promotion".
 *
 * It wins over a `(recommended)` marker inside an item, because it is the later
 * thought: an agent writes the options, then works out which one it would pick.
 * A line naming nothing in the list changes nothing — "Recommendation: none of
 * these, ask the vendor" is a real thing to write, and it is not a vote.
 */
function applyRecommendationLine(units, options) {
  const line = units.map((u) => plain(u.text).match(REC_LINE_RE)).find(Boolean);
  if (!line) return options;

  // It has to *name* the option, not merely mention its words somewhere. The rule
  // is the start of the sentence, and the reason is "Recommendation: neither, ask
  // the vendor first" — which contains the word "first" and recommends nothing.
  const said = line[1]
    .toLowerCase()
    .replace(/^(?:go with|going with|pick|choose|take|use|do)\s+/, '')
    .replace(/^(?:option|the)\s+/, '')
    .trim();

  // A lettered set is named by its letter, and the rule below cannot see that: the
  // words after "(b)" belong to the sentence, not to the option. The bracket is what
  // makes this safe to read — "Recommendation: a fresh start" also begins with the
  // letter a, and recommends nothing of the sort.
  const named = said.match(/^\(?([a-z1-9])\)/);
  const byMarker = named && options.find((o) => o.marker === named[1]);
  if (byMarker) {
    for (const o of options) o.recommended = o === byMarker;
    return options;
  }

  const first = said.split(/[.;]/)[0].trim();
  if (first.length < 3) return options;
  const hit = options.find((o) => {
    const l = o.label.toLowerCase();
    return first.startsWith(l) || l.startsWith(first);
  });
  if (!hit) return options;
  for (const o of options) o.recommended = o === hit;
  return options;
}

/* ---------------------------------------------------------------------- api */

/**
 * Read one markdown field. Returns `null` when nothing here is confidently a
 * set of answers — which is the ordinary outcome and not a failure.
 */
export function suggestOptions(markdown) {
  const units = unitize(stripFences(markdown));
  if (!units.length) return null;
  for (const strategy of [byOptionLabel, byLetterMarker, byLeadIn, byBoldList]) {
    const options = strategy(units);
    if (options) return applyRecommendationLine(units, options);
  }
  return null;
}

/**
 * The whole bead: description, then design, then notes — the same order and the
 * same first-wins rule the decision block gets, so a question does not answer to
 * one field and take its buttons from another.
 */
export function suggestFromSections(sections) {
  for (const s of sections || []) {
    const options = suggestOptions(s.markdown);
    if (options) return { from: s.field, options };
  }
  return null;
}
