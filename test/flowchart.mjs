#!/usr/bin/env node
//
// Is the map still true of the tree it is a map of?
//
//   npm test
//   node test/flowchart.mjs
//
// lib/flowchart.js is a hand-written model of what beadcause does, and the one thing a
// hand-written model reliably does is go stale. Nothing here can check that a step is
// *described* correctly — that would take a second copy of the code, and the second copy
// is always the one that rots. What it can check is every claim the model makes that is
// mechanically true or false, and the list turns out to be most of what actually breaks:
//
//   - **A node names a module that is no longer in the tree.** The commonest drift by
//     far, and the one with no symptom: the page renders perfectly, and somebody follows
//     `lib/foo.js` into a directory that has not had it for six months.
//   - **An edge lands on nothing**, or a node has no edge at all. Mermaid draws both
//     without complaint — an orphan box reads as a deliberate aside rather than as a
//     wiring mistake.
//   - **An agent kind exists in lib/foundation.js and is nowhere on the map.** This is
//     the drift the whole file is written against. A sixth kind is added the way the
//     fifth was (lib/epicadvocate.js), and the map goes on describing five.
//   - **`public/flow.js` does not parse.** It is inlined verbatim into the standalone
//     page by scripts/flowchart.mjs, so a syntax error there is a blank doc as well as a
//     blank screen — and it has one hazard nothing else in `public/` has: the whole
//     stylesheet is a template literal, and a backtick typed into one of its comments
//     ends it. That failure reports as `Unexpected identifier` thirty lines further down,
//     in code that is fine. It cost a debugging session to find the first time.
//
// The browser half — does mermaid actually draw, do the taps land, does it follow the
// colour scheme — is scripts/flow-check.mjs, which needs a headless Chrome and so cannot
// be in `npm test`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGENTS, baseline } from '../lib/foundation.js';
import { ANY_AGENT, KINDS, agents, flowchart, mermaidFor, problems, sourcePaths } from '../lib/flowchart.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

console.log('the map of the system\n');

const map = flowchart();

/* ------------------------------------------------------- the model's own rules */

check('every node is whole, every edge lands, every agent kind is drawn', () => {
  const found = problems({ exists: (rel) => fs.existsSync(path.join(ROOT, rel)) });
  assert.deepEqual(found, [], `\n${found.map((p) => `- ${p}`).join('\n')}`);
});

check('every source path a node names is still in the tree', () => {
  const missing = sourcePaths().filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  assert.deepEqual(missing, [], `gone: ${missing.join(', ')}`);
  assert.ok(sourcePaths().length > 50, 'suspiciously few source paths — has the model been emptied?');
});

check('every flow has a pill-sized short name', () => {
  // Written per flow rather than derived — every rule for shortening a title gets one of
  // these wrong, and a nav bar that wraps to four rows is one nobody reads. `problems`
  // enforces the length; this is the case that says why the field exists at all.
  for (const f of map.flows) {
    assert.ok(f.short, `${f.id} has no short name`);
    assert.ok(f.short.length <= 18, `${f.id}: "${f.short}" is ${f.short.length} characters`);
  }
});

check('the flows cover the app’s spine', () => {
  // Named rather than counted. A count passes when somebody deletes the advocate flow
  // and adds two about the same screen, which is precisely the loss worth failing on:
  // these six are what somebody has to read to understand how work gets done here.
  for (const id of ['question', 'reply', 'chat', 'advocate', 'land', 'amendment']) {
    assert.ok(
      map.flows.some((f) => f.id === id),
      `the ${id} flow is gone — if it was renamed, rename it here too rather than dropping the assertion`
    );
  }
});

/* ------------------------------------------- the agents, read and never restated */

check('every agent kind in lib/foundation.js has a row, and no other', () => {
  assert.deepEqual(
    map.agents.map((a) => a.id).sort(),
    [...AGENTS].sort(),
    'the roster and the foundations disagree'
  );
});

check('the agent rows are read out of the foundations rather than copied', () => {
  // The property that matters: change the foundation, and the map changes with it. Fed a
  // foundation that says something absurd, the row has to say the absurd thing — a row
  // that stayed sensible would be one carrying its own copy of the truth.
  const fake = { ...baseline('advocate'), writes: true, allowedTools: ['Bash(only-this)'], model: 'a-model-that-does-not-exist' };
  const row = agents({ advocate: fake }).find((a) => a.id === 'advocate');
  assert.equal(row.writes, true);
  assert.equal(row.model, 'a-model-that-does-not-exist');
  assert.deepEqual(row.allowedTools, ['Bash(only-this)']);
});

check('the two agents that may write are the two that should', () => {
  // Not a restatement of the foundations — a claim about *this* drawing. The whole
  // argument the advocate flow rests on is that the repo advocate may not invent work
  // while the P0 advocate may; a change that quietly made them the same would make the
  // page's central sentence false while every node in it still rendered.
  const writers = map.agents.filter((a) => a.writes).map((a) => a.id).sort();
  assert.deepEqual(writers, ['dispatch', 'epic-advocate', 'worker'], `writers are now: ${writers.join(', ')}`);
  assert.equal(map.agents.find((a) => a.id === 'advocate').writes, false, 'the repo advocate may not invent work');
  assert.equal(map.agents.find((a) => a.id === 'console').writes, false, 'the chat session is the review step');
});

check('an amendment shows up as the fields it moved, not as a flag', () => {
  const row = agents({ worker: { ...baseline('worker'), amended: ['timeoutMs'] } }).find((a) => a.id === 'worker');
  assert.deepEqual(row.amended, ['timeoutMs']);
  // And the baselines, which is what the standalone page renders, say nothing moved.
  assert.deepEqual(map.agents.find((a) => a.id === 'worker').amended, []);
});

check('an agent node names a foundation, or says it is any of them', () => {
  for (const flow of map.flows) {
    for (const n of flow.nodes.filter((x) => x.kind === 'agent')) {
      assert.ok(
        n.agent === ANY_AGENT || AGENTS.includes(n.agent),
        `${flow.id}/${n.id} is drawn as an agent and names ${n.agent}`
      );
    }
  }
});

/* ------------------------------------------------------------------- the drawing */

check('every flow renders as mermaid, with a shape and a class per node', () => {
  for (const flow of map.flows) {
    const src = mermaidFor(flow.id);
    assert.ok(src.startsWith('flowchart '), `${flow.id} does not open with a flowchart directive`);
    for (const n of flow.nodes) {
      assert.ok(src.includes(`class ${n.id} k-${n.kind};`), `${flow.id}/${n.id} has no kind class`);
    }
    for (const e of flow.edges) {
      assert.ok(src.includes(`${e.from} -->`), `${flow.id}: no edge drawn out of ${e.from}`);
    }
  }
});

check('no classDef — the colours have to stay the stylesheet’s', () => {
  // mermaid writes a classDef out as an inline `style`, which beats CSS, so a diagram
  // styled that way is frozen at one colour scheme. This is the only place that decision
  // is enforceable without a browser.
  for (const flow of map.flows) {
    assert.ok(!mermaidFor(flow.id).includes('classDef'), `${flow.id} has grown a classDef`);
  }
});

check('a label with a newline in it survives as a line break, not as a broken node', () => {
  // Every multi-line label in the model is written with a real newline, and mermaid's
  // parser ends a statement at one. `mermaidFor` turns them into `<br/>` — a regression
  // here is a diagram that fails to parse in the browser and nowhere else.
  const src = mermaidFor('question');
  assert.ok(!/\[\"[^"]*\n/.test(src), 'a raw newline reached a mermaid label');
  assert.ok(src.includes('<br/>'), 'no label survived as a two-line one — has the model lost its shape?');
});

check('no label reaches mermaid with a backtick in it', () => {
  // A backtick opens mermaid's markdown-string mode even inside the quotes, and the parse
  // then fails for the whole *diagram* rather than the node — which leaves the source in
  // the box, exactly the way a missing mermaid does. Three flows died that way over
  // labels reading `bd ready` and the ```beads block.
  for (const flow of map.flows) {
    assert.ok(!mermaidFor(flow.id).includes('`'), `${flow.id} has a backtick in a label`);
  }
});

check('no node is called something mermaid already means', () => {
  // `end` closes a subgraph, so a step honestly called "the session ends" took the chat
  // flow's whole diagram down with it. `problems` is what refuses it; this is the case
  // that proved the refusal works.
  const found = problems({ exists: () => true });
  assert.deepEqual(found, [], found.join('\n'));
  const bad = flowchart().flows.some((f) => f.nodes.some((n) => n.id === 'end'));
  assert.equal(bad, false, 'a node is called `end` again');
});

check('an unknown flow is an error rather than an empty diagram', () => {
  assert.throws(() => mermaidFor('no-such-flow'), /unknown flow/);
});

/* ----------------------------------------------------------------- the two hosts */

check('public/flow.js parses', () => {
  // `node --check` and not an import: it is a browser script that touches `document` at
  // module scope, so importing it here would throw for a reason that is not a syntax
  // error. See this file's header for the backtick hazard this exists to catch.
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'public', 'flow.js')], { stdio: 'pipe' });
});

check('the standalone page renders, and carries the model and the renderer', () => {
  const out = path.join(ROOT, 'node_modules', '.cache', `flowchart-test-${process.pid}.html`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'flowchart.mjs'), '--out', out], { stdio: 'pipe' });
    const html = fs.readFileSync(out, 'utf8');
    assert.ok(html.includes('window.FLOWCHART = {'), 'the payload is not embedded');
    assert.ok(html.includes('The flowchart screen — one renderer, two hosts'), 'public/flow.js was not inlined');
    assert.ok(html.includes('<div id="flow">'), 'nothing for the renderer to draw into');
    // The payload has to survive being read back — a role prompt with a `</script>` in it
    // would end the tag it is sitting in, whatever the JSON says.
    const json = /window\.FLOWCHART = (\{[\s\S]*\});<\/script>/.exec(html);
    assert.ok(json, 'could not find the payload');
    const parsed = JSON.parse(json[1]);
    assert.equal(parsed.flows.length, map.flows.length);
    assert.ok(parsed.flows.every((f) => f.mermaid), 'a flow reached the page with no diagram source');
    assert.equal(parsed.effective, false, 'the committed page must draw the baselines, not this Mac’s amendments');
  } finally {
    fs.rmSync(out, { force: true });
  }
});

check('--check exits non-zero when the model names a file that is not there', () => {
  // The guard the whole file rests on, exercised rather than assumed: a `--check` that
  // could only ever pass would be worth nothing, and it is the one assertion here that
  // can prove the exit code is wired up.
  const missing = problems({ exists: (rel) => rel !== 'lib/server.js' && fs.existsSync(path.join(ROOT, rel)) });
  assert.ok(
    missing.some((m) => m.includes('lib/server.js')),
    'a file removed from the tree did not show up as a problem'
  );
});

/* ------------------------------------------------------------------ the counting */

check('the kinds are the axis the page is about, and both ends are populated', () => {
  assert.deepEqual(
    KINDS.map((k) => k.id),
    ['code', 'agent', 'human', 'device', 'external', 'store'],
    'the kinds have changed — the legend, the shapes and the CSS all key off this order'
  );
  assert.ok(map.counts.byKind.code > 20, 'almost nothing is code, which cannot be right');
  assert.ok(map.counts.byKind.agent >= 5, 'the agentic half has emptied out');
  assert.equal(
    map.counts.nodes,
    map.flows.reduce((n, f) => n + f.nodes.length, 0),
    'the total disagrees with the flows'
  );
});

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall good\x1b[0m');
process.exit(failures ? 1 : 0);
