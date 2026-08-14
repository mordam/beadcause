#!/usr/bin/env node
//
// Is the agent chooser out of the way, without becoming a guess?
//
//   node scripts/agent-chooser-check.mjs [--baseline] [--out=dir]
//
// The chooser used to be drawn in full every time a bead opened: a label, a row of
// chips, a ＋, the selected agent's whole foundation paragraph and the "allow
// tools" checkbox — several centimetres of a control nearly every comment leaves
// alone, sitting between the thread you just read and the box you were about to
// type in. It now folds under a ⋯ at the top-right corner of that box.
//
// Folding it is the easy half. The half worth a check is what must NOT be hidden
// by the fold:
//
//   • which agent replies, readable with the panel shut — collapsing the roster to
//     a bare ⋯ would make every comment a guess;
//   • an armed tools override, which is spent the moment you press Answer, so a
//     shut panel must not leave the box looking ordinary;
//   • a half-written comment, which choosing a chip or arming tools must not eat —
//     the panel repaints, the card never does;
//   • the keyboard: aria-expanded/haspopup on the trigger, Escape to close, and the
//     caret staying in the textarea when it does.
//
// This drives the real public/app.js in a headless Chrome the size of a phone,
// against a roster built by lib/agents.js and a question parsed by lib/decision.js,
// so nothing here touches a bead. Same shape as proposal-check.mjs and the same
// rule: `--baseline` serves the committed app.js and style.css, so a failure can be
// told apart from a flake — baseline must fail the placement cases, the working
// copy must pass all of them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toQuestion } from '../lib/decision.js';
import { publicRoster } from '../lib/agents.js';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'agent-chooser-check-token';
const BASELINE = process.argv.includes('--baseline');
// Screenshots of the box shut and the panel open, for reviewing the look rather
// than the assertions. Off unless asked for, so a plain run stays a pass/fail.
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- fixtures */

// A real roster: the four built-ins, with the Critic given a tools override the way
// the config file is the only thing that can. `armed` is what /api/agent-arm flips.
const CFG = { defaultAgent: 'answerer', agents: [{ id: 'critic', tools: 'Bash(bd show:*), Read' }] };
const armed = new Set();
const rosterNow = () => publicRoster(CFG, { armed });
const AGENTS = rosterNow();
const DEFAULT_AGENT = AGENTS.find((a) => a.id === 'answerer');
const TOOLS_AGENT = AGENTS.find((a) => a.id === 'critic');
if (!DEFAULT_AGENT || !TOOLS_AGENT?.tools) {
  console.error('the roster fixture did not come back with a tools agent — lib/agents.js changed shape');
  process.exit(1);
}

// A thread on the bead, so "the thread runs straight into the box" is a distance
// this can actually measure rather than a claim about an empty card.
const COMMENTS = [
  { author: 'adam', text: 'Which of the two are we doing?', created_at: '2026-08-01T10:05:00Z' },
  { author: 'Critic', text: 'Neither, until the second one has a number on it.', created_at: '2026-08-01T10:06:00Z' },
];

const WS = 'demo';
const ISSUE = {
  id: 'ac-chooser',
  title: 'Gross or net on the seller statement?',
  issue_type: 'task',
  status: 'open',
  priority: 1,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  comment_count: COMMENTS.length,
  dependent_count: 0,
  description: [
    'The statement has said gross since the first invoice went out.',
    '',
    '```decision',
    'question: Gross or net?',
    'options:',
    '  - id: gross',
    '    label: Gross',
    '    response: "Gross."',
    '  - id: net',
    '    label: Net',
    '    response: "Net."',
    '```',
  ].join('\n'),
};

const QUESTIONS = [{ ...toQuestion(WS, ISSUE), comments: COMMENTS }];
const KEY = QUESTIONS[0].key;
if (!QUESTIONS[0].decision?.options?.length) {
  console.error('the fixture did not parse back into a decision — lib/decision.js changed shape');
  process.exit(1);
}

/* ------------------------------------------------------------------ server */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// Read through git rather than from a second checkout, so --baseline compares
// against HEAD of this very worktree. Both files, because half of what this checks
// — where the ⋯ sits, whether the panel is a popover — is in the stylesheet.
const committed = (f) => execFileSync('git', ['show', `HEAD:public/${f}`], { cwd: ROOT });

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });

// The one arming gate this cares about: the first arm of an agent must carry an
// acknowledgement, which is what puts the disclaimer dialog on screen. Same shape
// as lib/server.js, small enough to state here.
let acknowledged = false;

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (p === '/api/questions') {
      return json({ questions: QUESTIONS, workspaces: [WS], spaces: [], scope: 'human' });
    }
    if (p === '/api/question') {
      const q = QUESTIONS.find((x) => x.id === url.searchParams.get('id'));
      return q ? json(q) : json({ error: 'not found' });
    }
    if (p === '/api/agents') return json({ agents: rosterNow(), default: CFG.defaultAgent });
    if (p === '/api/agent-arm') {
      const body = await readBody(req);
      const agent = rosterNow().find((a) => a.id === body.id);
      if (!agent) return json({ error: 'no such agent' }, 404);
      if (body.disarm) {
        armed.delete(agent.id);
        return json({ ok: true, armed: false, agents: rosterNow() });
      }
      if (!acknowledged && !body.acknowledge) {
        return json(
          {
            needsAcknowledgement: true,
            disclaimer: {
              agent: agent.name,
              title: `Give ${agent.name} extended tools?`,
              tools: agent.tools,
              points: ['For one reply only.', 'It runs unattended, as you, on this Mac.'],
            },
          },
          428
        );
      }
      acknowledged = true;
      armed.add(agent.id);
      return json({ ok: true, armed: true, agents: rosterNow() });
    }
    // Everything else the app pokes at on boot — work, consoles, sessions.
    if (p.startsWith('/api/')) return json({});

    if (BASELINE && (p === '/app.js' || p === '/style.css')) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] });
      return res.end(committed(p.slice(1)));
    }
    const file = path.join(PUBLIC, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const evalJs = async (s, expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails)
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 160)}`);
  return r.result.value;
};

const shoot = async (s, name) => {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
};

/* ------------------------------------------------------------------- probe */

// Everything is read off the DOM as it actually is — by geometry, by visibility and
// by what a screen reader would be handed — so nothing here can agree with a bug in
// the rendering it is checking.
const BOX = `(() => {
  const ta = document.querySelector('.freeform textarea[data-role="answer"]');
  const dots = document.querySelector('.agent-dots');
  const bar = document.querySelector('.reply-bar');
  // The composer as a whole, and the brief above it. On a phone these are two
  // consecutive rows of the card, and the brief is its own scroller — so the thread
  // inside it has no fixed position to measure against, and the brief's own bottom
  // edge is what stands in for "where the reading stops". The last .comment used to
  // be read here; see the placement checks below for why it no longer can be. (No
  // backticks in this comment: it lives inside a template literal.)
  const freeform = document.querySelector('.freeform');
  const brief = document.querySelector('.card.open > .brief');
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height) }; };
  const shown = (e) => !!e && !!e.offsetParent;
  return {
    ta: r(ta), dots: r(dots), bar: r(bar), freeform: r(freeform), brief: r(brief),
    // A chooser is "in the way" if any of it is on screen with the panel shut.
    loudChips: [...document.querySelectorAll('.agent-chip')].filter(shown).length,
    loudDesc: [...document.querySelectorAll('.agent-desc')].filter(shown).length,
    loudAllow: [...document.querySelectorAll('.allow-tools')].filter(shown).length,
    who: document.querySelector('.reply-who') ? document.querySelector('.reply-who').textContent.replace(/\\s+/g, ' ').trim() : null,
    whoShown: shown(document.querySelector('.reply-who')),
    armedMark: shown(document.querySelector('.reply-armed')) || !!(dots && dots.classList.contains('armed')),
    expanded: dots ? dots.getAttribute('aria-expanded') : null,
    haspopup: dots ? dots.getAttribute('aria-haspopup') : null,
    label: dots ? dots.getAttribute('aria-label') : null,
    panelShown: shown(document.querySelector('.agent-panel')),
    draft: ta ? ta.value : null,
    focus: document.activeElement ? (document.activeElement.dataset.role || document.activeElement.className || document.activeElement.tagName) : null,
  };
})()`;

const PANEL = `(() => {
  const panel = document.querySelector('.agent-panel');
  if (!panel || !panel.offsetParent) return null;
  const b = panel.getBoundingClientRect();
  return {
    chips: panel.querySelectorAll('.agent-chip').length,
    add: !!panel.querySelector('.agent-add'),
    desc: (panel.querySelector('.agent-desc') || {}).textContent || '',
    allow: !!panel.querySelector('.allow-tools input[data-act="allow-tools"]'),
    form: !!panel.querySelector('[data-role="agent-name"]'),
    formOpen: !!panel.querySelector('.agent-form') && !panel.querySelector('.agent-form').hidden,
    right: Math.round(b.right), left: Math.round(b.left), width: Math.round(b.width),
  };
})()`;

const key = (s, k) =>
  s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: 27 }).then(() =>
    s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: 27 })
  );

/* -------------------------------------------------------------------- run */

// Not a failure of the run: the checks already recorded stand, the rest could not
// be driven at all. Only --baseline ever gets here.
class SkipRest extends Error {}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-chooser-');

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: VP.width,
    height: VP.height,
    deviceScaleFactor: VP.dpr,
    mobile: true,
    screenWidth: VP.width,
    screenHeight: VP.height,
  });
  await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  console.log(
    `\n${BASELINE ? 'BASELINE (HEAD:public/app.js + style.css)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`
  );

  // A throw inside a render leaves the previous DOM standing, which reads exactly
  // like "nothing happened" — so keep the first one and say it out loud.
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__err = null;
      addEventListener('error', (e) => (window.__err ||= \`\${e.message} @ \${e.filename}:\${e.lineno}\`));
      addEventListener('unhandledrejection', (e) => (window.__err ||= \`unhandled: \${(e.reason && e.reason.stack) || e.reason}\`));`,
  });

  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `!!document.querySelector('.card[data-key]')`)) break;
  }
  if (!(await evalJs(s, `!!document.querySelector('.card[data-key]')`))) throw new Error('the list never rendered');

  await evalJs(s, `document.querySelector('.card[data-key=${JSON.stringify(KEY)}][data-act="toggle"]').click()`);
  await sleep(600);
  if (!(await evalJs(s, `!!document.querySelector('.freeform textarea[data-role="answer"]')`)))
    throw new Error(`the answer box never rendered — page error: ${await evalJs(s, `window.__err`)}`);
  // Scroll the box into view before anything is measured: a control above the fold
  // has no honest geometry, and the panel opens relative to what is on screen.
  await evalJs(s, `document.querySelector('.freeform').scrollIntoView({ block: 'center' })`);
  await sleep(300);
  await shoot(s, 'shut');

  /* 1. the thread runs into the box, with no chooser in between */
  const shut = await evalJs(s, BOX);
  // What the chooser costs the brief: everything the composer puts above the place
  // you type. The reply strip, and the padding over it. Nothing else may live here.
  //
  // This used to be measured from the bottom of the last comment, and that was right
  // for exactly 74 minutes: the fold (124b55f) and the pinned composer (23a0fa3)
  // landed the same afternoon from different branches. Before the pin, the brief and
  // the box were consecutive blocks in one scroller and the last comment really did
  // sit a strip above the box. After it, the brief is its own scroller with the
  // composer pinned under it — so that distance became "where the brief happens to be
  // scrolled to", which the fixture's own content decides. It read 134px against a
  // 110px bar with nothing wrong, and stayed red on main for two days.
  const strip = shut.freeform && shut.ta ? shut.ta.top - shut.freeform.top : null;
  const seam = shut.brief && shut.freeform ? shut.freeform.top - shut.brief.bottom : null;
  check(
    'no agent block between the thread and the answer box',
    shut.loudChips === 0 && shut.loudDesc === 0 && shut.loudAllow === 0,
    `${shut.loudChips} chip(s), ${shut.loudDesc} foundation(s), ${shut.loudAllow} tools box(es) on screen`
  );
  check(
    'the chooser costs the box a strip, not a block',
    strip != null && strip <= 110,
    strip == null ? 'no box' : `${strip}px above the textarea`
  );
  check(
    // The other half, and the one the old measurement was really reaching for: the
    // brief runs right up to the composer, so nothing has been slipped in between.
    // Scroll-position-proof, because it is two card rows meeting, not two pieces of
    // content — and it still fails if a block is inserted there.
    'and the thread runs right up to it, with nothing in between',
    seam != null && seam <= 2,
    seam == null ? 'no brief or no box' : `${seam}px between the brief and the composer`
  );

  /* 2. the ⋯ is the box's own top-right corner */
  check(
    'a ⋯ sits at the top-right of the textarea',
    !!shut.dots &&
      !!shut.ta &&
      Math.abs(shut.dots.right - shut.ta.right) <= 8 &&
      shut.dots.bottom <= shut.ta.top + 2 &&
      shut.dots.top >= shut.ta.top - 64,
    shut.dots ? `⋯ right ${shut.dots.right} vs box right ${shut.ta?.right}, ⋯ bottom ${shut.dots.bottom} vs box top ${shut.ta?.top}` : 'no ⋯ at all'
  );

  /* 3. which agent replies is readable with the panel shut */
  check(
    'who replies is on screen without opening anything',
    shut.whoShown && !!shut.who && shut.who.includes(DEFAULT_AGENT.name) && shut.who.includes(DEFAULT_AGENT.emoji),
    shut.who ? `"${shut.who}"` : 'nothing says who replies'
  );
  check(
    'and it names the button that dispatches, not both of them',
    !!shut.who && /comment/i.test(shut.who) && !/answer & close/i.test(shut.who),
    shut.who ? `"${shut.who}"` : 'nothing says who replies'
  );

  /* 4. the trigger is a labelled, keyboard-reachable popup button */
  check(
    'the ⋯ is labelled and announced as a popup',
    shut.haspopup === 'true' && shut.expanded === 'false' && !!shut.label && shut.label.includes(DEFAULT_AGENT.name),
    `haspopup=${shut.haspopup} expanded=${shut.expanded} label="${shut.label || ''}"`
  );

  /* 5. everything the old block drew is in the panel */
  // Nothing below this line can be driven on a build with no ⋯ on it, and a crash
  // there would be read as this check being broken rather than as the change being
  // absent — which is exactly the confusion --baseline exists to remove.
  if (!shut.dots) {
    check('everything after this needs a ⋯ to open', false, 'there is none on this build');
    throw new SkipRest();
  }
  await evalJs(s, `document.querySelector('.agent-dots').click()`);
  await sleep(250);
  await shoot(s, 'open');
  const panel = await evalJs(s, PANEL);
  const opened = await evalJs(s, BOX);
  check(
    'the ⋯ opens a panel with the whole roster in it',
    !!panel && panel.chips === AGENTS.length && panel.add && panel.form,
    panel ? `${panel.chips} chip(s) of ${AGENTS.length}, ＋ ${panel.add}, create form ${panel.form}` : 'no panel opened'
  );
  check(
    "the selected agent's foundation is in the panel",
    !!panel && panel.desc.trim().length > 20 && DEFAULT_AGENT.description.startsWith(panel.desc.trim().slice(0, 24)),
    panel ? `"${panel.desc.trim().slice(0, 48)}…"` : 'no panel opened'
  );
  check(
    'opening it flips aria-expanded',
    opened.expanded === 'true',
    `expanded=${opened.expanded}`
  );
  check(
    'the panel stays inside the phone',
    !!panel && panel.left >= 0 && panel.right <= VP.width,
    panel ? `${panel.left}…${panel.right} of ${VP.width}px` : 'no panel opened'
  );

  /* 6. ＋ opens the create form, in place */
  await evalJs(s, `document.querySelector('.agent-panel .agent-add').click()`);
  await sleep(200);
  const withForm = await evalJs(s, PANEL);
  check(
    '＋ opens the create form inside the panel',
    !!withForm && withForm.formOpen,
    withForm ? `form open ${withForm.formOpen}` : 'the panel closed'
  );
  await evalJs(s, `document.querySelector('.agent-panel [data-act="agent-cancel"]').click()`);
  await sleep(150);

  /* 7. choosing an agent does not eat a half-written comment */
  const DRAFT = 'Half a comment, typed before I went looking for the Critic.';
  await evalJs(
    s,
    `(() => {
      const ta = document.querySelector('.freeform textarea[data-role="answer"]');
      ta.focus();
      ta.value = ${JSON.stringify(DRAFT)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`
  );
  await sleep(150);
  await evalJs(s, `document.querySelector('.agent-panel .agent-chip[data-agent="${TOOLS_AGENT.id}"]').click()`);
  await sleep(250);
  const picked = await evalJs(s, BOX);
  check(
    'choosing an agent keeps a half-typed comment',
    picked.draft === DRAFT,
    picked.draft === DRAFT ? 'the draft survived' : `the box now says "${String(picked.draft).slice(0, 40)}"`
  );
  check(
    'and the strip says who replies now',
    !!picked.who && picked.who.includes(TOOLS_AGENT.name),
    picked.who ? `"${picked.who}"` : 'nothing says who replies'
  );

  /* 8. an armed override is visible with the panel shut */
  await evalJs(s, `document.querySelector('.agent-panel input[data-act="allow-tools"]').click()`);
  await sleep(400);
  const dialog = await evalJs(s, `!!document.querySelector('.dialog-wrap [data-yes]')`);
  check('arming tools still asks first', dialog, dialog ? 'the disclaimer came up' : 'no disclaimer');
  if (dialog) {
    await evalJs(s, `document.querySelector('.dialog-wrap [data-yes]').click()`);
    await sleep(500);
  }
  const armedOpen = await evalJs(s, BOX);
  check(
    'arming does not shut the panel out from under the checkbox',
    armedOpen.panelShown,
    armedOpen.panelShown ? 'still open' : 'the panel closed'
  );
  check(
    'arming keeps the half-typed comment too',
    armedOpen.draft === DRAFT,
    armedOpen.draft === DRAFT ? 'the draft survived' : `the box now says "${String(armedOpen.draft).slice(0, 40)}"`
  );
  // Shut it the way a thumb would: a tap somewhere that is not the panel.
  await evalJs(s, `document.querySelector('.card-foot .q').click()`);
  await sleep(250);
  await shoot(s, 'armed');
  const armedShut = await evalJs(s, BOX);
  check('a tap outside closes the panel', !armedShut.panelShown, armedShut.panelShown ? 'still open' : 'closed');
  check(
    'an armed override is visible with the panel shut',
    armedShut.armedMark && /tools/i.test(armedShut.who || ''),
    `marker ${armedShut.armedMark}, strip "${armedShut.who || ''}"`
  );
  check(
    'and the label says so too',
    !!armedShut.label && /tools/i.test(armedShut.label),
    `label "${armedShut.label || ''}"`
  );

  /* 9. Escape closes it, and the caret stays in the box */
  await evalJs(s, `document.querySelector('.agent-dots').click()`);
  await sleep(200);
  await evalJs(s, `document.querySelector('.freeform textarea[data-role="answer"]').focus()`);
  await key(s, 'Escape');
  await sleep(250);
  const escaped = await evalJs(s, BOX);
  check(
    'Escape closes the panel',
    !escaped.panelShown && escaped.expanded === 'false',
    `shown ${escaped.panelShown}, expanded=${escaped.expanded}`
  );
  check(
    'and the caret does not jump out of the box',
    escaped.focus === 'answer',
    `focus is on "${escaped.focus}"`
  );
} catch (err) {
  if (!(err instanceof SkipRest)) throw err;
} finally {
  close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${OUT ? ` · shots in ${OUT}` : ''}\n`);
if (BASELINE) {
  // Inverted on purpose: HEAD has no ⋯ at all, so a baseline run that passes means
  // this check is asserting nothing.
  if (!failed.length) {
    console.error('BASELINE passed everything — this check is not measuring the change.');
    process.exit(1);
  }
  console.log(`baseline fails ${failed.length} case(s), as it must.`);
  process.exit(0);
}
process.exit(failed.length ? 1 : 0);
