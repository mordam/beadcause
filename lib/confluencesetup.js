import {
  apiToken,
  apiTokenFile,
  confluenceStatus,
  problem,
  readProblem,
  readableSpaces,
  tokenFileWarning,
  writeApiToken,
} from './confluence.js';

/**
 * The second `npm run configure` question that does not live in `npm run configure`.
 *
 * Confluence was the last integration on this Mac that could only be turned on by
 * hand-editing `config.json` under a running daemon — the exact shape bc-ikj6 fixed for
 * Slack, and the reason this block exists (bc-ynzs). It is beside lib/signinsetup.js
 * rather than inline for the same three reasons that one is, and one more:
 *
 * - **It writes a second file.** The API token must not go into `config.json` — that file
 *   is committed to the git repo lib/commonrepo.js keeps, after every write, so a token
 *   put there is not "on disk in the clear", it is in a history a rotation cannot reach
 *   back into. Setup is the most natural place in the codebase to undo that by accident,
 *   so the suite below asserts in as many words that what you type never appears in the
 *   config object and does appear in a file at 0600.
 * - **Its answer can be "not enough".** Publishing needs a site, an email, a token *and*
 *   a space; reading needs the first three and a list of its own. Short of that, the
 *   symptom is a button that never appears and one line in a log at startup — so this
 *   block ends by asking lib/confluence.js what it *would* do with what was typed, and
 *   saying which half is off while the person who typed it is still sitting there.
 * - **Its questions are drivable only through `io`.** `ask`/`yes`/`secret` come from the
 *   caller, which is what lets test/confluencesetup.mjs script the answers, and keeps one
 *   `bail()`, one SIGINT handler and one Ctrl+C story in scripts/configure.js.
 * - **One of its answers must never acquire a default.** `readSpaces` is empty on every
 *   install until somebody names a space, and it deliberately does not inherit
 *   `confluence.space`: the token that publishes can read the whole site, so inheriting
 *   would decide *every agent this Mac dispatches may read the company wiki* on the day
 *   publishing was switched on for an unrelated reason (bc-xecw). A wizard is where that
 *   property is easiest to lose — the obliging thing for a prompt to do is offer the
 *   space you just typed — so the default offered here is the list already in the config
 *   and nothing else, and the suite asserts that an install which publishes into `ENG` is
 *   offered `none`.
 *
 * Nothing is written to `config.json` here: the caller saves once, at the end, so Ctrl+C
 * in the middle of this leaves the configuration exactly as it was. The token file is the
 * exception and cannot be otherwise — it is not part of the config — so it is written
 * after the last question rather than at the prompt that asks for it.
 */

/**
 * Space keys, from a comma-separated line: uppercased, de-duplicated, and anything that
 * cannot be a key dropped and named.
 *
 * Dropped rather than refused, in the house style of `parseAllowed` beside it: one
 * fat-fingered entry in a list of four must not cost the other three. Uppercased because
 * `readableSpaces` compares in upper case anyway — storing what was typed would mean a
 * config saying `eng` and a README saying `ENG` are the same list drawn two ways.
 *
 * `none` is honoured only as the *whole* answer, which is the one case that has to be
 * unambiguous: it is how a list is emptied, and treating it as a sentinel inside a list
 * would make a space genuinely called `NONE` unnameable to buy nothing.
 */
export function parseSpaceKeys(raw) {
  const text = String(raw || '').trim();
  if (!text || /^none$/i.test(text)) return { keys: [], ignored: [] };
  const keys = [];
  const ignored = [];
  for (const piece of text.split(',')) {
    const value = piece.trim();
    if (!value) continue;
    const key = value.toUpperCase();
    // Whitespace, a slash or a colon means a URL or a page title was pasted instead of a
    // key — the likeliest wrong answer here, and the one worth naming rather than storing.
    if (!/^[A-Z0-9._~-]+$/.test(key)) ignored.push(value);
    else if (!keys.includes(key)) keys.push(key);
  }
  return { keys, ignored };
}

/**
 * Ask about Confluence and fold the answers into `cfg`. Returns what to say about it.
 *
 * `io.ask(question, default)` and `io.yes(question, default)` are scripts/configure.js's
 * own, so Enter takes the default here exactly as it does everywhere else in that script,
 * and `io.secret(question)` is the same prompt with the echo turned off.
 */
export async function askConfluence(cfg, io) {
  // The number comes in with the heading rather than being written here, for the reason
  // lib/signinsetup.js gives: the rest are numbered in scripts/configure.js, and a
  // question counting itself in another file is a duplicate the first time one is inserted.
  const {
    ask,
    yes,
    secret: askSecret,
    heading = 'Publish and read Confluence pages?',
    log = console.log,
    bold = (s) => s,
    dim = (s) => s,
  } = io;
  const before = confluenceStatus(cfg);
  const conf = { ...(cfg.confluence || {}) };

  log(`\n${bold(heading)}`);
  log(
    dim(
      '   Two switches, not one. Outward: a document the reader tab can open — a UX\n' +
        '   review, a foundation, the summary a worker left behind — gets published to a\n' +
        '   Confluence page, and re-published to the same page later. Inward: an agent can\n' +
        '   read a page you have named a space for, and nothing else on that site. Both\n' +
        '   need an Atlassian API token from id.atlassian.com/manage-profile/security/\n' +
        '   api-tokens. Skip this and nothing changes — no button is drawn, no file opened.'
    )
  );
  log(dim(`   currently: ${before.text}`));

  // Default y once anything is configured — including a half-configured install, which is
  // the state this question exists to get somebody out of. Enter-through then re-walks the
  // block with every current value as its default, which changes nothing.
  if (!(await yes('   set up Confluence? (y/n)', before.text === 'off' ? 'n' : 'y'))) {
    if (before.text !== 'off') log(dim('   (left exactly as it was)'));
    return { ...before, changed: false };
  }

  /* -------------------------------------------------------------------------- site */

  log(dim('\n   The Atlassian site, e.g. https://yourteam.atlassian.net — the /wiki is not'));
  log(dim('   needed. Answer "none" to turn Confluence off and leave nothing configured.'));
  const site = await ask('   site:', conf.site || 'none');
  if (!site || /^none$/i.test(site)) {
    // All four together, and that is the load-bearing part. Clearing the site alone leaves
    // `space` and `readSpaces` behind, which `problem` and `readProblem` both read as
    // "wants Confluence" — so every summary from then on would report a deliberate off as
    // a misconfiguration naming the site that was just deleted on purpose.
    const dropped = readableSpaces(cfg);
    cfg.confluence = { ...conf, site: null, email: null, space: null, readSpaces: [] };
    log(dim('   Confluence is off — nothing publishes and no agent reads a page.'));
    if (dropped.length) log(dim(`   (the readable spaces went with it: ${dropped.join(', ')})`));
    log(dim(`   ${apiTokenFile(cfg)} is left alone — delete it yourself if you want it gone.`));
    return { on: false, reading: false, text: 'off', changed: true };
  }
  conf.site = site.trim();

  /* ------------------------------------------------------------------------- email */

  log(dim('\n   The Atlassian account the token belongs to. It is half of the credential:'));
  log(dim('   email and token together are HTTP basic auth against the Cloud REST API.'));
  conf.email = (await ask('   account email:', conf.email || '')).trim() || null;

  /* ------------------------------------------------------------------------- space */

  log(dim('\n   The space documents are published into by default, as a key (ENG), not a'));
  log(dim('   name. A beadcause space may override it with confluenceSpace, or refuse to'));
  log(dim('   publish at all with false — that stays a config-file answer. "none" leaves'));
  log(dim('   the default unset, and then only the spaces naming their own publish.'));
  const space = await ask('   space to publish into:', conf.space || 'none');
  conf.space = /^none$/i.test(space) ? null : space.trim() || null;

  /* ------------------------------------------------------------------------- token */

  const file = apiTokenFile({ ...cfg, confluence: conf });
  // The file, not the environment: "one is already there" has to mean a token that will
  // still be there for the daemon under launchd, and `BEADCAUSE_CONFLUENCE_TOKEN` in this
  // shell is exactly the case where it will not be. That is its own line, below.
  const existing = apiToken({ ...cfg, confluence: conf }, { envVar: null });
  log(dim(`\n   The API token. It is written to ${file}, mode 0600, and never into`));
  log(dim('   config.json — that file is committed to a git history a rotation cannot undo.'));
  if (existing) log(dim('   One is already there. Enter keeps it; anything you type replaces it.'));
  if (process.env.BEADCAUSE_CONFLUENCE_TOKEN) {
    log(dim('   (BEADCAUSE_CONFLUENCE_TOKEN is set in this shell, but the daemon runs'));
    log(dim('    under launchd and will not see it — put it in the file as well.)'));
  }
  // Held rather than written, and written below once the last question is answered:
  // scripts/configure.js promises that Ctrl+C anywhere in setup changes nothing, and a
  // token on disk after a cancelled run would be the one exception that matters.
  const typed = await askSecret(`   API token${existing ? ' (Enter keeps the current one)' : ''}:`);

  /* -------------------------------------------------------------------- readSpaces */

  log(dim('\n   Which spaces may an agent READ? This is the other switch and it starts off:'));
  log(dim('   the token above can read the whole site, so naming a space here is naming'));
  log(dim('   what every unattended agent this Mac dispatches may read — and it is never'));
  log(dim('   derived from the space you publish into. Comma-separated keys, or "none".'));
  const { keys, ignored } = parseSpaceKeys(
    await ask('   readable spaces:', readableSpaces({ confluence: conf }).join(', ') || 'none')
  );
  for (const bad of ignored) log(dim(`   (ignoring "${bad}" — that is not a space key; paste the key, e.g. ENG)`));
  conf.readSpaces = keys;

  cfg.confluence = conf;

  // Now — nothing else here can be cancelled, and the verdict below has to read the token
  // back the way the daemon will.
  if (typed) {
    try {
      log(dim(`   the token is in ${writeApiToken(cfg, typed)}`));
    } catch (err) {
      log(`   ${bold('could not save the token')} — ${err.message}`);
    }
  }

  /* --------------------------------------------------------------------- the verdict */

  const stray = tokenFileWarning(cfg);
  if (stray) log(`   ${bold('warning')} — ${stray}`);

  const after = confluenceStatus(cfg);
  const why = problem(cfg);
  const readWhy = readProblem(cfg);
  // Said as two sentences, because they are two switches: "Confluence is on" over an
  // install that reads nothing is the exact sentence this block must not print.
  if (after.on) log(dim(`   Publishing is on — into ${conf.space || 'the spaces that name their own'}.`));
  else log(`   ${bold('Publishing is off')}${why ? ` — ${why}` : '.'}`);
  if (after.reading) log(dim(`   Reading is on for ${keys.join(', ')} and nothing else on that site.`));
  else if (readWhy) log(`   ${bold('Reading is off')} — ${readWhy}`);
  else log(dim('   Reading is off, which is the default — no agent reads a page until a space is named here.'));
  // Only over a stated problem. An install that publishes and deliberately reads nothing
  // is finished, and telling it to re-run setup would be nagging it about the safe answer.
  if (why || readWhy) log(dim(`   Re-run ${bold('npm run configure')} to finish it.`));

  return { ...after, changed: true };
}
