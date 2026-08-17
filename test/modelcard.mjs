#!/usr/bin/env node
/**
 * Both cards say which model a bead is routed to, and what it ran on.
 *
 *     npm test
 *     node test/modelcard.mjs
 *
 * bc-nc6o.4 and bc-nc6o.5 — the display half of the routing epic. The inbox card in
 * public/app.js draws a chip in its meta row; the bead sheet in public/graph.js draws a
 * row under the session link. They are one change rather than two because they draw the
 * *same fact*, and a chip saying `sonnet` beside a sheet saying `opus` would be worse
 * than either being absent: both are plausible, and nothing on either screen says which
 * one is lying. So there is one derivation (lib/modelcard.js), it happens on the daemon,
 * and this file pins the four things that could quietly come apart.
 *
 * 1. **The derivation itself.** Which is mostly about the answers that are *not* a tier:
 *    an unrated bead — most of the tracker — is routed to the expensive fallback and must
 *    say so rather than draw a blank, and a bead whose labels name two tiers is not a
 *    tier and must never be drawn as one.
 * 2. **The field reaches both readers.** `toQuestion` is deliberately narrow and drops
 *    `labels` on the floor, so the inbox has nothing to read client-side; `/api/bead`
 *    hands the sheet the identical object. Both are asserted, because a feature drawn on
 *    two cards fails by one of them silently losing its payload.
 * 3. **Each renderer, run for real**, over the five shapes that matter — untiered, rated,
 *    worked, diverged, contradictory. Not "the source mentions `m.model`": that passes
 *    just as happily when the value is drawn into a comment.
 * 4. **A phone has no hover.** Every fact the chip carries has to be in its text, because
 *    the one surface this app exists for cannot read a `title`. That is asserted against
 *    the *visible* string with the attributes stripped out.
 *
 * No browser, no network, no `bd`. public/app.js is one IIFE with nothing exported, so
 * the chip is sliced out and run in a `vm` the way test/jirarow.mjs does it; public/
 * graph.js is sliced the way test/graphsheet.mjs does.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-modelcard-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { modelCard } = await import(LIB('modelcard.js'));
const { toQuestion } = await import(LIB('decision.js'));

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 4).join('\n      ')}`);
  }
};

const APP = read('public/app.js');
const GRAPH = read('public/graph.js');
const CSS = read('public/style.css');
const SERVER = read('lib/server.js');

/** A `bd show --json` row, as thin as either card needs it. */
const bead = (labels) => ({ id: 'bc-x1', title: 'A bead', status: 'open', labels });

/* ------------------------------------------------------------- 1. the derivation */

console.log('\nthe one derivation both cards draw from');

check('an untiered bead is routed to the expensive fallback, and says which way it got there', () => {
  // The commonest row in the tracker by a distance: everything filed before bc-nc6o.1,
  // everything created by hand, everything out of JIRA.
  assert.deepEqual(modelCard(bead([])), {
    tier: '',
    model: 'opus',
    fallback: true,
    problem: null,
    ran: [],
    diverged: false,
  });
});

check('a rated bead is routed by its tier, and is not a fallback', () => {
  assert.deepEqual(modelCard(bead(['complexity:low'])), {
    tier: 'low',
    model: 'sonnet',
    fallback: false,
    problem: null,
    ran: [],
    diverged: false,
  });
  assert.equal(modelCard(bead(['complexity:medium'])).model, 'sonnet');
  assert.equal(modelCard(bead(['complexity:high'])).model, 'opus');
});

check('two tiers is a problem and never a tier — it must not be drawn as one', () => {
  const m = modelCard(bead(['complexity:low', 'complexity:high']));
  assert.equal(m.tier, '', 'a contradiction leaked out as a tier the cards would print');
  assert.ok(m.problem, 'and nothing was left to say why');
  assert.equal(m.model, 'opus', 'a bead nobody can route falls to the expensive one');
  assert.equal(m.fallback, true);
});

check('a label naming no tier at all is a problem too, not silence', () => {
  const m = modelCard(bead(['complexity:quite-hard']));
  assert.equal(m.tier, '');
  assert.match(m.problem, /names no tier/);
});

check('what a finished session ran on comes off its ran: labels', () => {
  const m = modelCard(bead(['complexity:high', 'ran:opus']));
  assert.deepEqual(m.ran, ['opus']);
  assert.equal(m.diverged, false, 'it ran on exactly what it was routed to');
});

check('a run that went somewhere else is called out', () => {
  const m = modelCard(bead(['complexity:low', 'ran:opus']));
  assert.equal(m.model, 'sonnet');
  assert.deepEqual(m.ran, ['opus']);
  assert.equal(m.diverged, true);
});

check('a bead worked twice keeps both, and diverges only if neither was the routed one', () => {
  assert.equal(modelCard(bead(['complexity:low', 'ran:sonnet', 'ran:opus'])).diverged, false);
  assert.deepEqual(modelCard(bead(['complexity:low', 'ran:sonnet', 'ran:opus'])).ran, ['sonnet', 'opus']);
  assert.equal(modelCard(bead(['complexity:high', 'ran:sonnet', 'ran:haiku'])).diverged, true);
});

check('an unworked bead never diverges from anything', () => {
  // The half that would cry wolf. Nearly every bead in the tracker has been run by
  // nothing at all, and "ran on something else" drawn from a missing fact would be on
  // every card in the inbox.
  for (const labels of [[], ['complexity:low'], ['complexity:high']]) {
    assert.equal(modelCard(bead(labels)).diverged, false, labels.join(','));
  }
});

check('nothing throws on a row with no labels, or no row at all', () => {
  assert.equal(modelCard({ id: 'bc-x1' }).model, 'opus');
  assert.equal(modelCard(null).model, 'opus');
  assert.equal(modelCard(undefined).fallback, true);
});

/* ------------------------------------------------- 2. it reaches both card payloads */

console.log('\nthe field reaches both cards');

check('toQuestion carries it, because the inbox has no labels to read', () => {
  // The trap this pins: `toQuestion` emits derived fields and drops `labels`, so a chip
  // that tried to work the model out client-side would have nothing to work from.
  const q = toQuestion('beadcause', {
    id: 'bc-x1',
    title: 'A bead',
    status: 'open',
    labels: ['complexity:low', 'ran:opus'],
  });
  assert.ok(!('labels' in q), 'toQuestion started passing labels through — this check is now about the wrong thing');
  assert.deepEqual(q.model, modelCard(bead(['complexity:low', 'ran:opus'])));
});

check('/api/bead hands the sheet the same object, as a field rather than a route', () => {
  const handler = SERVER.slice(SERVER.indexOf("p === '/api/bead' &&"), SERVER.indexOf("p === '/api/bead-links'"));
  assert.match(handler, /modelCard\(issue\)/, '/api/bead no longer derives the model');
  assert.match(handler, /\bmodel,?\n/, 'it is derived and then not put on the response');
});

/* ------------------------------------------------------------ 3. the inbox chip */

/**
 * Lift one declaration out of public/app.js — copied from test/jirarow.mjs, which
 * explains the two shapes. The file is one IIFE with nothing exported.
 */
function lift(src, opener) {
  const at = src.indexOf(opener);
  assert.notEqual(at, -1, `public/app.js no longer declares \`${opener}\``);
  if (opener.startsWith('function')) {
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (!depth) return src.slice(at, i + 1);
      }
    }
    throw new Error(`unbalanced braces after ${opener}`);
  }
  let depth = 0;
  for (let i = at; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (c === ';' && depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`no statement end after ${opener}`);
}

const chipCtx = vm.createContext({ String, JSON });
vm.runInContext([lift(APP, 'const esc = ('), lift(APP, 'function modelChipHtml(q)')].join('\n'), chipCtx);
const chip = (labels) =>
  vm.runInContext('modelChipHtml(Q)', Object.assign(chipCtx, { Q: { model: modelCard(bead(labels)) } }));
/** What a phone can actually read: the text, with every attribute taken off it. */
const visible = (html) => html.replace(/<[^>]*>/g, '').trim();

console.log('\nthe inbox chip (bc-nc6o.4)');

check('every card says which model it is set to run on', () => {
  assert.match(visible(chip(['complexity:low'])), /sonnet/);
  assert.match(visible(chip(['complexity:high'])), /opus/);
});

check('an untiered bead shows the Opus fallback rather than a blank', () => {
  // The acceptance criterion, and the interesting half: an unrated bead is not
  // unrouted, and an empty meta row would hide exactly the beads worth tiering.
  const html = chip([]);
  assert.ok(html.trim(), 'nothing at all was drawn for an untiered bead');
  assert.match(visible(html), /opus/);
  assert.match(visible(html), /unrated/, 'and it is silent about why it is on the expensive one');
});

check('the tier is drawn beside the model, not only in the title', () => {
  assert.match(visible(chip(['complexity:low'])), /low/);
  assert.match(visible(chip(['complexity:high'])), /high/);
});

check('a bead that has been worked shows what it ran with', () => {
  assert.match(visible(chip(['complexity:high', 'ran:opus'])), /opus/);
  assert.match(chip(['complexity:high', 'ran:opus']), /class="pill model ran"/);
});

check('a run that went elsewhere is legible without a hover', () => {
  const html = chip(['complexity:low', 'ran:opus']);
  // Both models, in order, in the text itself — this is the one case where the chip
  // showing a single name would be showing the wrong one.
  assert.match(visible(html), /sonnet.*→.*opus/s);
  assert.match(html, /class="pill model diverged"/);
});

check('contradictory labels are flagged and never drawn as a tier', () => {
  const html = chip(['complexity:low', 'complexity:high']);
  assert.match(visible(html), /⚠/);
  assert.match(html, /class="pill model bad"/);
  // The whole sentence goes in the title, where a desktop can have it; what must not
  // happen is one of the two tiers appearing as if it were the answer.
  assert.ok(!/·\s*(low|high)\b/.test(visible(html)), `a tier was drawn: ${visible(html)}`);
});

check('a title somebody put a quote in cannot write markup into the chip', () => {
  const html = vm.runInContext(
    'modelChipHtml(Q)',
    Object.assign(chipCtx, {
      Q: { model: { model: '"><img src=x>', tier: '', fallback: true, problem: null, ran: [], diverged: false } },
    })
  );
  assert.ok(!html.includes('<img'), html);
  assert.match(html, /&quot;&gt;&lt;img/);
});

check('a question with no model field draws nothing rather than throwing', () => {
  // Every renderer in this app has to survive a payload from a daemon that predates it —
  // the phone caches its own script, and a card is drawn before anything checks versions.
  assert.equal(vm.runInContext('modelChipHtml(Q)', Object.assign(chipCtx, { Q: {} })), '');
  assert.equal(vm.runInContext('modelChipHtml(Q)', Object.assign(chipCtx, { Q: { model: {} } })), '');
});

check('the chip is drawn in the card meta row, beside the workspace and the id', () => {
  assert.match(APP, /\$\{modelChipHtml\(q\)\}/, 'the chip is defined and never called');
  // From `cardHtml` itself: four renderers in this file open a `.card-head`, and the
  // question that matters is whether *this* one draws the chip. The slice used to end at
  // the literal `<p class="q">` that followed it; bc-rfnr.9.8 made the title a real
  // `<button class="q">` instead (written inline, not behind a shared helper — see the
  // note on `shutCardAct` in public/app.js for why), so that opening tag is the marker
  // now — still the next line after the chip, and still unique to this call site.
  const at = APP.indexOf('function cardHtml(q)');
  const head = APP.slice(APP.indexOf('<div class="card-head">', at), APP.indexOf('<button type="button" class="q"', at));
  assert.match(head, /modelChipHtml\(q\)/, 'the chip is called from somewhere other than the card head');
});

/* -------------------------------------------------------------- 4. the sheet row */

const START = 'const beadUrl = (id) =>';
const END = "return parts.join('');";
const from = GRAPH.indexOf(START);
const to = GRAPH.indexOf(END, from);
if (from < 0 || to < 0) {
  console.log('  \x1b[31m✗\x1b[0m public/graph.js no longer has a beadUrl…sheetHtml region to slice');
  process.exit(1);
}
const region = GRAPH.slice(from, GRAPH.indexOf('\n  }', to) + 4);
const sheetCtx = vm.createContext({
  esc: (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    ),
  statusColor: (s) => `colour(${s || 'open'})`,
  md: (t) => `<p>${t}</p>`,
  FROM_BD: { fromBd: true },
  workspace: 'beadcause',
});
const { sheetHtml, modelRowHtml } = vm.runInContext(`${region}\n;({ sheetHtml, modelRowHtml })`, sheetCtx);
const row = (labels) => modelRowHtml({ id: 'bc-x1', title: 'A bead', model: modelCard(bead(labels)) });

console.log('\nthe bead details sheet (bc-nc6o.5)');

check('the sheet says the tier and the model it selects', () => {
  const html = row(['complexity:high']);
  assert.match(visible(html), /opus/);
  assert.match(visible(html), /complexity:high/);
});

check('an untiered bead says which way the silence was resolved', () => {
  const html = row([]);
  assert.match(visible(html), /opus/);
  assert.match(visible(html), /no tier/i);
  assert.match(html, /model-why is-none/);
});

check('what the session ran on is a separate fact from what it was routed to', () => {
  // The whole reason the row has room the chip does not: a plan and a bill are two
  // sentences, and one number for both is the failure lib/ranmodel.js exists against.
  const html = row(['complexity:high', 'ran:opus']);
  assert.match(visible(html), /ran on opus/);
  assert.match(visible(html), /complexity:high/, 'the routed half was replaced rather than joined');
});

check('a bead that ran on something other than the selected model says so', () => {
  const html = row(['complexity:low', 'ran:opus']);
  assert.match(visible(html), /sonnet/, 'what it was routed to went missing');
  assert.match(visible(html), /ran on opus/);
  assert.match(html, /model-ran is-diverged/);
});

check('a bead nothing ran on says nothing about what ran', () => {
  assert.ok(!/ran on/.test(visible(row(['complexity:low']))));
});

check('contradictory labels are spelled out here, where there is room for the sentence', () => {
  const html = row(['complexity:low', 'complexity:high']);
  assert.match(visible(html), /will not guess/);
  assert.match(html, /model-why is-bad/);
});

check('a row whose bead carries no derived field is absent rather than broken', () => {
  assert.equal(modelRowHtml({ id: 'bc-x1' }), '');
  assert.equal(modelRowHtml(null), '');
});

check('the row is on the sheet for an open bead and a closed one alike', () => {
  for (const status of ['open', 'closed', 'in_progress']) {
    const html = sheetHtml({ id: 'bc-x1', title: 'A bead', status, model: modelCard(bead(['complexity:high'])) });
    assert.match(html, /id="sheet-model"/, `no model row on a ${status} bead`);
  }
});

check('it sits under the session row and above the description', () => {
  const html = sheetHtml({
    id: 'bc-x1',
    title: 'A bead',
    status: 'closed',
    description: 'Some prose.',
    model: modelCard(bead(['complexity:high'])),
  });
  const session = html.indexOf('id="sheet-session"');
  const model = html.indexOf('id="sheet-model"');
  const desc = html.indexOf('class="md"');
  assert.ok(session >= 0 && model > session, 'the model row is not under the session row');
  assert.ok(desc > model, 'the model row landed below the description');
});

/* ------------------------------------------------------------------- 5. the styles */

console.log('\nboth are styled, in one stylesheet');

check('every class either renderer draws has a rule behind it', () => {
  const drawn = [
    'pill model',
    'model-row',
    'model-kind',
    'model-picked',
    'model-why',
    'model-ran',
    '.model-why.is-none',
    '.model-why.is-bad',
    '.model-ran.is-diverged',
    '.pill.model.ran',
    '.pill.model.diverged',
    '.pill.model.bad',
  ];
  for (const name of drawn) {
    const sel = name.startsWith('.') ? name : `.${name.trim().split(/\s+/).join('.')}`;
    assert.ok(CSS.includes(sel), `public/style.css has no rule for ${sel}`);
  }
});

check('the chip does not shout the model names', () => {
  // `.pill` uppercases, and `sonnet`/`opus` are the CLI's own words — `SONNET` is a
  // spelling this app invented and nothing else anybody reads uses.
  const rules = CSS.slice(CSS.indexOf('.pill.model {'), CSS.indexOf('.pill.model.ran'));
  assert.match(rules, /text-transform:\s*none/);
});

console.log(`\n${failures ? `${failures} of ${ran} failed` : `all ${ran} checks passed`}`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
