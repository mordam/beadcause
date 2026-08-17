#!/usr/bin/env node
//
// Every store has a provenance, an access rule and a disposal rule — and the contentless
// push is a control rather than a feature. `lib/datastores.js`.
//
//   npm test
//   node test/datastores.mjs
//
// bc-eqn1.10. Annex A.7 asks the same five questions of every body of data — where it came
// from, what it is used for, whether it is adequate for that, who can reach it, and when it
// is disposed of — and the three registers this programme already produced each answer a
// different question. So the register under test is the fourth axis and its first job is to
// not become a fourth *format*: it cites the other three, and `coverageProblems` fails the
// repo when a citation is wrong, when an evidence class is not classified at all, or when
// the two registers disagree about how long one store lives.
//
// The checks are in four groups.
//
//  1. **The register is well-formed, and every rule in it can be shown to fail.** A rule
//     only ever run against a register that passes is a rule nobody has seen fail.
//  2. **The citations are real and the coverage is total** — against fabricated registers
//     as well as the real ones, so the coverage check is demonstrated rather than asserted.
//  3. **Personal data is located rather than denied.** The four places the bead names are
//     each present, and `none` is a claim that has to carry a reason.
//  4. **The contentless push, driven for real.** Every exported `push*` in `lib/notify.js`
//     is called against a minimal workspace with loaded fixtures and a stubbed `fetch`, and
//     the published body must carry none of the text. Then the same call against a `full`
//     workspace, which must carry it — a test that passes against a function that sends
//     nothing is a test of nothing. The list of pushers is checked against the module's own
//     exports, so a new notification cannot ship without being covered.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTENTLESS_PUSH,
  NOT_SUBJECT,
  PERSONAL_STATES,
  REGISTER,
  RETENTION_WORDS,
  UBIQUITOUS_PERSONAL,
  coverageProblems,
  entryProblems,
  personalDataLocations,
  registerProblems,
} from '../lib/datastores.js';
import { REGISTER as EVIDENCE, RETENTION_FLOOR_MONTHS } from '../lib/evidence.js';
import { REGISTER as SUPPLIERS } from '../lib/suppliers.js';
import { REGISTER as DOCUMENTS } from '../lib/documents.js';
import { ntfyDetailFor } from '../lib/spaces.js';
import * as notify from '../lib/notify.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

/** A well-formed store, to be broken one field at a time. */
const sound = () => ({
  id: 'a-store',
  title: 'A store',
  holds: 'Some body of data, described at the granularity somebody could disagree with.',
  where: ['somewhere on this Mac that a person could go and look at'],
  provenance: 'Written by something, out of something else, and it says which of the two here.',
  purpose: 'What it is for, said in a whole sentence rather than in a noun.',
  adequacy: 'Adequate for that, and here is the thing it is not adequate for, stated rather than implied.',
  personal: { state: 'none', what: 'Nothing about a person reaches it: every field in it is a sha or a timestamp.' },
  access: 'Anybody with the config directory, which on this install is one person and the daemon.',
  retention: 'permanent',
  disposal: 'None on a schedule, and here is the reason that is a decision rather than something nobody got round to.',
  evidence: null,
  suppliers: [],
  gap: null,
});

console.log('data-store register, and the contentless push as a control\n');

/* ------------------------------------------------------------------ the register */

await check('the register and its exemptions are well-formed', () => {
  const problems = registerProblems();
  assert.deepEqual(problems, [], `${problems.length} problem(s):\n${problems.join('\n')}`);
});

await check('a sound entry has nothing wrong with it', () => {
  assert.deepEqual(entryProblems(sound()), []);
});

await check('every field rule can be shown to fail', () => {
  const broken = [
    ['id', 'Not Kebab', /kebab-case/],
    ['title', '', /`title`/],
    ['holds', 'data', /`holds`/],
    ['where', [], /`where`/],
    ['provenance', 'somewhere', /`provenance`/],
    ['purpose', 'stuff', /`purpose`/],
    ['adequacy', 'yes', /`adequacy`/],
    ['access', 'me', /`access`/],
    ['disposal', 'never', /`disposal`/],
  ];
  for (const [field, value, re] of broken) {
    const problems = entryProblems({ ...sound(), [field]: value });
    assert.ok(
      problems.some((p) => re.test(p)),
      `breaking \`${field}\` was not reported — got: ${problems.join(' | ') || '(nothing)'}`
    );
  }
});

await check('a personal-data answer must be one of three, and `none` must carry its reason', () => {
  assert.ok(
    entryProblems({ ...sound(), personal: { state: 'probably not', what: sound().personal.what } }).some((p) =>
      /personal\.state/.test(p)
    ),
    'an invented state has to be refused — the vocabulary is the whole point of the field'
  );
  assert.ok(
    entryProblems({ ...sound(), personal: { state: 'none', what: '' } }).some((p) => /personal\.what/.test(p)),
    'a blank reads as "nobody asked", which is the finding this register exists to prevent'
  );
  assert.deepEqual(PERSONAL_STATES, ['present', 'possible', 'none']);
});

await check('a retention shorter than the evidence register\'s floor cannot be stated here either', () => {
  assert.ok(
    entryProblems({ ...sound(), retention: RETENTION_FLOOR_MONTHS - 1 }).some((p) => /`retention`/.test(p)),
    'this register does not get a second floor'
  );
  assert.deepEqual(entryProblems({ ...sound(), retention: RETENTION_FLOOR_MONTHS }), []);
  assert.ok(entryProblems({ ...sound(), retention: 'forever' }).some((p) => /`retention`/.test(p)));
  assert.deepEqual(RETENTION_WORDS, ['permanent', 'external']);
});

await check('`external` retention has to name whose rule it is', () => {
  assert.ok(
    entryProblems({ ...sound(), retention: 'external', suppliers: [] }).some((p) => /has to name who/.test(p)),
    '"somebody else decides" with nobody named is the same sentence as "we do not know"'
  );
  assert.deepEqual(entryProblems({ ...sound(), retention: 'external', suppliers: ['anthropic'] }), []);
});

await check('a gap has to name a bead and say what is not known', () => {
  assert.ok(entryProblems({ ...sound(), gap: { bead: 'nope', says: 'x'.repeat(60) } }).some((p) => /gap\.bead/.test(p)));
  assert.ok(entryProblems({ ...sound(), gap: { bead: 'bc-eqn1.17', says: 'short' } }).some((p) => /gap\.says/.test(p)));
  assert.deepEqual(entryProblems({ ...sound(), gap: { bead: 'bc-eqn1.17', says: 'x'.repeat(60) } }), []);
});

await check('two entries with the same id are reported', () => {
  const problems = registerProblems([sound(), sound()], []);
  assert.ok(problems.some((p) => /two entries with the same id/.test(p)));
});

/* ------------------------------------------------------- what it cites, and coverage */

await check('every citation into the evidence and supplier registers resolves', () => {
  const problems = coverageProblems();
  assert.deepEqual(problems, [], `${problems.length} problem(s):\n${problems.join('\n')}`);
});

await check('every evidence class is either classified here or excused, and nothing is both', () => {
  const claimed = new Set(REGISTER.map((e) => e.evidence).filter(Boolean));
  const excused = new Set(NOT_SUBJECT.map((x) => x.evidence));
  for (const cls of EVIDENCE) {
    assert.ok(
      claimed.has(cls.id) || excused.has(cls.id),
      `lib/evidence.js has \`${cls.id}\` and this register says nothing about what is in it`
    );
    assert.ok(!(claimed.has(cls.id) && excused.has(cls.id)), `\`${cls.id}\` is both classified and excused`);
  }
});

await check('a new evidence class fails this register until somebody classifies it', () => {
  const invented = [...EVIDENCE, { id: 'something-new', retention: 'permanent' }];
  const problems = coverageProblems(REGISTER, NOT_SUBJECT, invented, SUPPLIERS);
  assert.ok(
    problems.some((p) => /something-new/.test(p)),
    'the coverage baseline is the evidence register, so a class landing there has to be answered here'
  );
});

await check('a citation to a class or a supplier that does not exist is reported', () => {
  const bad = [{ ...sound(), id: 'bad-cite', evidence: 'no-such-class' }];
  assert.ok(coverageProblems(bad, NOT_SUBJECT, EVIDENCE, SUPPLIERS).some((p) => /a citation to nothing/.test(p)));

  const badSupplier = [{ ...sound(), id: 'bad-supplier', suppliers: ['no-such-supplier'] }];
  assert.ok(
    coverageProblems(badSupplier, NOT_SUBJECT, EVIDENCE, SUPPLIERS).some((p) => /not in lib\/suppliers\.js/.test(p))
  );
});

await check('the two registers disagreeing about a retention period fails the repo', () => {
  // The whole reason this file cites rather than restates. `agent-run-logs` is 24 months in
  // lib/evidence.js because bc-eqn1.7 argued for it there; a second number here would read
  // exactly as authoritative and there would be nothing to say which was current.
  const drifted = REGISTER.map((e) => (e.id === 'agent-run-logs' ? { ...e, retention: 'permanent' } : e));
  const problems = coverageProblems(drifted, NOT_SUBJECT, EVIDENCE, SUPPLIERS);
  assert.ok(
    problems.some((p) => /worse than either answer/.test(p)),
    'a retention drift between the two registers has to be a failure, not a discrepancy somebody notices'
  );
});

await check('an exemption for a class that is not there excuses nothing', () => {
  const problems = coverageProblems(REGISTER, [...NOT_SUBJECT, { evidence: 'gone', why: 'x'.repeat(60) }], EVIDENCE, SUPPLIERS);
  assert.ok(problems.some((p) => /not an evidence class/.test(p)));
});

await check('the register is itself a controlled document, rather than a fourth format beside three', () => {
  const doc = DOCUMENTS.find((d) => d.path === 'lib/datastores.js');
  assert.ok(doc, 'a register with no owner and no review date is the thing bc-eqn1.11 exists to stop');
  assert.ok(doc.owner && doc.approvedBy, 'it names a person accountable for it and a person who approved it');
});

await check('it is claimed by the evidence register it names refs out of', () => {
  // It quotes `refs/beadcause/…` in its data, so lib/evidence.js's coverage sweep sees it as
  // a module that persists state. The exemption is the same one that register takes for
  // itself: naming a path is not writing to one.
  const source = fs.readFileSync(path.join(ROOT, 'lib/evidence.js'), 'utf8');
  assert.ok(source.includes("file: 'lib/datastores.js'"), 'an unclaimed state-shaped module fails test/evidence.mjs');
});

await check('it stays a leaf — the exemption above is only safe while it is data', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib/datastores.js'), 'utf8');
  const imports = [...source.matchAll(/^import [^;]*? from '([^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(
    imports,
    ['./evidence.js', './suppliers.js'],
    'lib/datastores.js gained an import. It reads no state and writes none — if that is no longer true, the exemption in lib/evidence.js has to be argued again rather than inherited.'
  );
});

/* --------------------------------------------------- personal data, located not denied */

await check('the four places personal data actually is are each in the register', () => {
  const byId = new Map(REGISTER.map((e) => [e.id, e]));
  for (const id of ['bead-content', 'prompt-context', 'agent-memory', 'session-transcripts']) {
    assert.ok(byId.has(id), `${id} is a place personal data lands and it is not in the register`);
  }
  assert.equal(byId.get('bead-content').personal.state, 'present', 'a bead names a colleague, a ticket carries a customer');
  assert.equal(byId.get('prompt-context').personal.state, 'present', 'a screenshot carries whatever was on the screen');
  assert.equal(byId.get('agent-memory').personal.state, 'present', 'a memory about how a person likes work shaped is about that person');
});

await check('nothing claims to hold no personal data without saying why', () => {
  for (const e of REGISTER) {
    if (e.personal.state !== 'none') continue;
    assert.ok(
      e.personal.what.trim().length >= 40,
      `${e.id} claims none and does not argue for it — an unargued "none" is the sentence an auditor disproves`
    );
  }
});

await check('the identity that is in every store is stated once rather than fifteen times', () => {
  assert.match(UBIQUITOUS_PERSONAL, /email/i);
  const repeated = REGISTER.filter((e) => /git identity/i.test(e.personal.what));
  assert.equal(repeated.length, 0, 'repeating it per entry produces fifteen sentences that have to be kept agreeing');
});

await check('the disposal answers are citations where another bead already decided one', () => {
  const byId = new Map(REGISTER.map((e) => [e.id, e]));
  assert.equal(byId.get('agent-run-logs').retention, RETENTION_FLOOR_MONTHS, 'bc-eqn1.7 picked this and this register takes it');
  assert.match(byId.get('agent-run-logs').disposal, /bc-eqn1\.7/, 'and says where it came from rather than presenting it as its own');
  assert.match(byId.get('prompt-context').disposal, /bc-eqn1\.17/, 'the supplier terms are unread, and a period invented here would read like one somebody confirmed');
});

/* ------------------------------------------- the contentless push, driven for real */

const WS = 'shared-workspace-zzz';
const BEAD = 'zz-bead1';
const KEY = `${WS}/${BEAD}`;

/** Every distinct piece of content that must not reach a public relay. */
const S = {
  question: 'QUESTIONTEXT-zzz',
  title: 'BEADTITLE-zzz',
  optionLabel: 'OPTLABEL-zzz',
  optionResponse: 'OPTRESPONSE-zzz',
  priorAnswer: 'PRIORANSWER-zzz',
  comment: 'COMMENTTEXT-zzz',
  scope: 'AMENDSCOPE-zzz',
  landingTitle: 'LANDINGTITLE-zzz',
  owed: 'OWEDTEXT-zzz',
  deployError: 'DEPLOYERROR-zzz',
  repo: 'REPONAME-zzz',
  syncError: 'SYNCERROR-zzz',
  syncDir: 'SYNCDIR-zzz',
  certName: 'CERTNAME-zzz',
  certDetail: 'CERTDETAIL-zzz',
  verdict: 'VERDICTLINE-zzz',
  build: 'BUILDID-zzz',
};

const question = () => ({
  workspace: WS,
  id: BEAD,
  key: KEY,
  title: S.title,
  question: S.question,
  priority: 1,
  decision: { options: [{ label: S.optionLabel, response: S.optionResponse }] },
  answeredBefore: { at: new Date(Date.now() - 3600_000).toISOString(), response: S.priorAnswer },
  amendment: { agent: 'worker', scope: S.scope },
});
const comment = () => ({ author: 'worker', text: S.comment });

/**
 * Every pusher, loaded with fixtures — and what the *full* payload must carry.
 *
 * The keys are checked against `lib/notify.js`'s own exports below, so this table cannot
 * quietly fall behind the module — which is the difference between covering the pushers
 * that existed the day this was written and covering the control.
 *
 * `carries` is the half that stops the minimal check being vacuous, and it has to be per
 * case rather than "some fixture survived": `pushSyncedAgain` legitimately has nothing in
 * it but the workspace name, so a blanket rule would have to be loose enough to pass a
 * pusher that had silently stopped saying anything at all.
 */
const CASES = {
  pushQuestion: {
    call: (cfg) => notify.pushQuestion(cfg, question()),
    carries: [S.question, S.priorAnswer, S.optionLabel, S.optionResponse],
  },
  pushFoundationRequest: {
    call: (cfg) => notify.pushFoundationRequest(cfg, question()),
    carries: [S.scope, S.optionLabel, S.optionResponse],
  },
  pushFoundationReply: { call: (cfg) => notify.pushFoundationReply(cfg, question(), comment()), carries: [S.comment] },
  pushReply: { call: (cfg) => notify.pushReply(cfg, question(), comment()), carries: [S.comment] },
  pushLanded: {
    call: (cfg) =>
      notify.pushLanded(cfg, { workspace: WS, bead: BEAD, number: 12, title: S.landingTitle, sha: 'abcdef1234', owed: S.owed }),
    carries: [S.landingTitle, S.owed],
  },
  pushDeploy: {
    call: (cfg) =>
      notify.pushDeploy(cfg, { workspace: WS, repo: S.repo, bead: BEAD, status: 'failed', to: 'abcdef1234', error: S.deployError, id: 'dep-1' }),
    carries: [S.repo, S.deployError],
  },
  pushCertificate: {
    call: (cfg) => notify.pushCertificate(cfg, { state: 'expiring', daysLeft: 2, name: S.certName, detail: S.certDetail }),
    carries: [S.certName, S.certDetail],
  },
  pushNoBackend: {
    call: (cfg) => notify.pushNoBackend(cfg, { verdict: { summary: S.verdict, lines: [S.verdict] }, disk: S.build }),
    carries: [S.verdict, S.build],
  },
  pushSyncTrouble: {
    call: (cfg) => notify.pushSyncTrouble(cfg, [{ workspace: WS, error: S.syncError, dir: S.syncDir, conflict: true }]),
    carries: [S.syncError, S.syncDir, WS],
  },
  pushSyncedAgain: { call: (cfg) => notify.pushSyncedAgain(cfg, [{ workspace: WS }]), carries: [WS] },
  pushServingAgain: { call: (cfg) => notify.pushServingAgain(cfg, { seconds: 30, build: S.build }), carries: [S.build] },
};

/** Everything that must never appear in a minimal payload, in any field. */
const NEVER = Object.values(S);

const cfgFor = (detail) => ({
  baseUrl: 'http://beadcause.example.ts.net:9000',
  token: 'token-zzz',
  ntfy: {
    enabled: true,
    topic: 'topic-zzz',
    server: 'http://ntfy.invalid',
    actionButtons: true,
    detail,
    minimalWorkspaces: detail === 'minimal' ? [WS] : [],
  },
});

/** Run one pusher with `fetch` stubbed, and hand back what it would have published. */
async function published(fn, cfg) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '' };
  };
  try {
    await fn(cfg);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(sent.length, 1, 'expected exactly one publish');
  return sent[0];
}

await check('the table covers every pusher lib/notify.js exports', () => {
  const exported = Object.keys(notify)
    .filter((k) => k.startsWith('push') && typeof notify[k] === 'function')
    .sort();
  assert.deepEqual(
    Object.keys(CASES).sort(),
    exported,
    'a new notification landed and this control does not cover it. Add it to CASES with its fixtures loaded — the whole point of reading the exports is that the list cannot fall behind the module.'
  );
});

await check('a minimal push carries none of the content — every pusher, driven for real', async () => {
  const cfg = cfgFor('minimal');
  for (const [name, { call }] of Object.entries(CASES)) {
    const body = await published(call, cfg);
    const { click, ...rest } = body;
    const text = JSON.stringify(rest);
    for (const secret of NEVER) {
      assert.ok(
        !text.includes(secret),
        `${name} put ${secret} on a public relay for a minimal workspace. That is the control, not a formatting choice.`
      );
    }
    assert.ok(!body.actions, `${name} sent action buttons to a minimal workspace — an option label leaks as much as the question`);
    // `Beadcause · asked again` is the one permitted suffix and it is deliberate: that you
    // have seen a question before leaks nothing, and it is the marker that stops the same
    // answer being given twice from a lock screen. Anything else in a title is content.
    assert.match(
      body.title,
      /^Beadcause( · asked again)?$/,
      `${name} titled a minimal push with something other than the bare marker`
    );
    assert.ok(String(body.message || '').length < 120, `${name} sent a long message to a minimal workspace`);
  }
});

await check('the same calls against a full workspace do carry it — otherwise this proves nothing', async () => {
  const cfg = cfgFor('full');
  for (const [name, { call, carries }] of Object.entries(CASES)) {
    const text = JSON.stringify(await published(call, cfg));
    for (const wanted of carries) {
      assert.ok(
        text.includes(wanted),
        `${name} did not carry ${wanted} even in full mode — the fixture is not reaching the payload, so the minimal check above proves nothing for it`
      );
    }
  }
});

await check('the workspace and the bead survive in the deep link only, which is the stated limit', async () => {
  // A minimal push conceals what is being asked, not that something is being asked in a
  // named repo: the click target has to name both or the tap lands nowhere. That is written
  // into CONTENTLESS_PUSH.LINK_ONLY, and this is what stops it drifting into a title.
  const cfg = cfgFor('minimal');
  for (const [name, { call }] of Object.entries(CASES)) {
    const { click, ...rest } = await published(call, cfg);
    const text = JSON.stringify(rest);
    assert.ok(!text.includes(WS), `${name} named the workspace outside the deep link`);
    assert.ok(!text.includes(BEAD), `${name} named the bead outside the deep link`);
  }
  assert.deepEqual(CONTENTLESS_PUSH.LINK_ONLY, ['the workspace name', 'the bead id']);
  assert.ok(CONTENTLESS_PUSH.limits.some((l) => /tailnet hostname/.test(l)), 'the click target is in every push, minimal or not');
});

await check('all three ways of configuring it reach the same decision', () => {
  // The per-repo veto, the space-level setting, and the global default — the first exists so
  // one shared tracker does not need a space of its own, the second so adding a workspace to
  // a space picks the policy up without anybody remembering to list it.
  const base = { ntfy: { enabled: true, topic: 't' } };
  assert.equal(ntfyDetailFor({ ...base, ntfy: { ...base.ntfy, minimalWorkspaces: [WS] } }, WS), 'minimal');
  assert.equal(
    ntfyDetailFor({ ...base, spaces: [{ name: 's', workspaces: [WS], ntfyDetail: 'minimal' }] }, WS),
    'minimal',
    'a space set to minimal covers a workspace nobody remembered to list'
  );
  assert.equal(ntfyDetailFor({ ...base, ntfy: { ...base.ntfy, detail: 'minimal' } }, WS), 'minimal');
  assert.equal(ntfyDetailFor(base, WS), 'full', 'and the default is full, because most installs are one person');

  for (const key of CONTENTLESS_PUSH.configuredBy) assert.ok(key.length > 3);
  assert.equal(CONTENTLESS_PUSH.decidedBy.module, 'lib/spaces.js');
  assert.equal(CONTENTLESS_PUSH.decidedBy.fn, 'ntfyDetailFor');
});

await check('the control names modules that exist and functions they really export', async () => {
  for (const rel of [CONTENTLESS_PUSH.decidedBy.module, CONTENTLESS_PUSH.enforcedIn, CONTENTLESS_PUSH.reportedBy]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is named by the control and is not in the repo`);
  }
  const spaces = await import('../lib/spaces.js');
  assert.equal(typeof spaces[CONTENTLESS_PUSH.decidedBy.fn], 'function');
  const team = fs.readFileSync(path.join(ROOT, CONTENTLESS_PUSH.reportedBy), 'utf8');
  assert.ok(team.includes('minimalWorkspaces'), 'lib/team.js is named as what reports the setting when a workspace is shared');
});

await check('the store the control protects says so, and points at it', () => {
  const bead = REGISTER.find((e) => e.id === 'bead-content');
  assert.match(bead.access, /CONTENTLESS_PUSH/, 'the entry whose data the control is about is where a reader will look for it');
  assert.ok(personalDataLocations().some((l) => l.id === 'bead-content'));
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
