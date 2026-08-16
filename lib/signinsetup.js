import {
  CALLBACK_PATH,
  allowlist,
  clientSecretFile,
  clientSecretInFile,
  redirectUri,
  secretFileWarning,
  signinStatus,
  writeClientSecret,
} from './auth.js';

/**
 * The one `npm run configure` question that does not live in `npm run configure`.
 *
 * Every other question there is a line of prose and a field: a name, a list of
 * workspaces, y or n. This one is different in three ways at once, and each of them is a
 * reason it had to become something a test can call.
 *
 * - **It writes a second file.** The client secret must not go into `config.json` — that
 *   file is committed to the git repo lib/commonrepo.js keeps, after every write, so a
 *   secret put there is not "on disk in the clear", it is in a history a rotation cannot
 *   reach back into. That was bc-m6m, and setup is the most likely place to undo it by
 *   accident. So the test below asserts, in as many words, that what you type never
 *   appears in the config object and does appear in a 0600 file.
 * - **Its answer can be "not enough".** Sign-in needs a client id, a secret, a non-empty
 *   allowlist *and* an https callback, and three out of four is off — silently, with one
 *   line in the log at startup. That quiet failure is the entire reason bc-dcom exists:
 *   the hand-edit it replaces gets one of the three wrong and the only symptom is a
 *   login screen you cannot get past, in front of the inbox that would explain it. So
 *   this block ends by asking lib/auth.js what it *would* do with what was typed, and
 *   saying which piece is missing while the person who typed it is still sitting there.
 * - **It is the only question with a wrong answer that is expensive.** A misremembered
 *   redirect URI is a round trip to the Google Cloud console. So the URI is derived from
 *   the tailnet certificate and printed to be copied, rather than asked for.
 *
 * The prompts come in through `io` rather than being taken from a readline of its own,
 * which is what makes the whole block drivable from test/signinsetup.mjs with scripted
 * answers, and keeps a single `bail()`, a single SIGINT handler and one Ctrl+C story in
 * scripts/configure.js.
 *
 * Nothing is written to `config.json` here — the caller saves, once, at the end, so
 * Ctrl+C in the middle of this still leaves the configuration exactly as it was. The
 * secret file is the exception and cannot be otherwise: it is not part of the config.
 */

/** The callback Google would be told to use if nobody named one. Null before a certificate. */
const derivedRedirect = (cfg) =>
  redirectUri({ ...cfg, auth: { ...(cfg.auth || {}), google: { ...(cfg.auth?.google || {}), redirectUri: null } } });

/**
 * Addresses, from a comma-separated line. Anything without an `@` is dropped and named.
 *
 * Dropped rather than refused, in the house style of the workspace questions above it:
 * one fat-fingered entry in a list of four must not cost the other three, and a silently
 * ignored answer here would be an allowlist that is not the one on the screen.
 */
export function parseAllowed(raw) {
  const kept = [];
  const ignored = [];
  for (const piece of String(raw || '').split(',')) {
    const value = piece.trim().toLowerCase();
    if (!value) continue;
    if (!value.includes('@') || /\s/.test(value)) ignored.push(piece.trim());
    else if (!kept.includes(value)) kept.push(value);
  }
  return { allowed: kept, ignored };
}

/**
 * Ask about Google sign-in and fold the answers into `cfg`. Returns what to say about it.
 *
 * `io.ask(question, default)` and `io.yes(question, default)` are configure.js's own, so
 * Enter takes the default here exactly as it does everywhere else in that script, and
 * `io.secret(question)` is the same prompt with the echo turned off.
 */
export async function askSignin(cfg, io) {
  // The number comes in with the heading rather than being written here: the other nine
  // are numbered in scripts/configure.js, and a tenth counting itself in another file is
  // a duplicate "10." the first time somebody inserts a question there.
  const {
    ask,
    yes,
    secret: askSecret,
    heading = 'Sign in with Google in the browser?',
    log = console.log,
    bold = (s) => s,
    dim = (s) => s,
  } = io;
  const google = { ...(cfg.auth?.google || {}) };
  const before = signinStatus(cfg);

  log(`\n${bold(heading)}`);
  log(
    dim(
      '   A second credential beside the pairing token, and beside is the whole point:\n' +
        '   the token keeps working untouched, because the things that use it — the Android\n' +
        '   app, an ntfy action button, a screenshot run — cannot sign in to anything. What\n' +
        '   this adds is a browser session tied to an address you name, which the token\n' +
        '   cannot be: it carries no identity and a photographed QR is a permanent grant.\n' +
        '   You need an OAuth client of type "Web application" from\n' +
        '   console.cloud.google.com/apis/credentials. Skip this and nothing changes.'
    )
  );
  log(dim(`   currently: ${before.text}`));

  // Default y once anything has been configured — including a half-configured one, which
  // is the state this question exists to get somebody out of. Enter-through then re-walks
  // the block with every current value as its default, which changes nothing.
  if (!(await yes('   set up Google sign-in? (y/n)', before.text === 'off' ? 'n' : 'y'))) {
    if (before.text !== 'off') log(dim('   (left exactly as it was)'));
    return { ...before, changed: false };
  }

  /* ------------------------------------------------------------ where it comes back */

  // Printed before it is asked for, because it has to match the Google client byte for
  // byte and the derived one is the answer in every ordinary install — retyping it is
  // only a chance to get it wrong.
  const auto = derivedRedirect(cfg);
  if (auto) {
    log(dim('\n   Register this as the redirect URI in that OAuth client, exactly:'));
    log(`   ${bold(auto)}`);
    log(dim('   It follows the certificate, so leave it as it is unless the client says otherwise.'));
  } else {
    log(
      dim(
        `\n   There is no tailnet certificate yet, so the callback cannot be worked out —\n` +
          `   and sign-in cannot switch on without one: Google refuses a plain-http redirect\n` +
          `   URI and the browser drops a Secure cookie over plain http. Either finish HTTPS\n` +
          `   and re-run this, or type the https URL ending ${CALLBACK_PATH} here.`
      )
    );
  }
  const uri = await ask('   redirect URI:', google.redirectUri || auto || '');
  // Stored only when it differs from the derived one: pinning the value we would have
  // derived anyway turns a URI that follows the certificate into one that is frozen at
  // the moment somebody ran setup.
  google.redirectUri = uri && uri !== auto ? uri : null;

  /* -------------------------------------------------------------------- client id */

  log(dim('\n   The client id from that OAuth client — it ends .apps.googleusercontent.com.'));
  log(dim('   Answer "none" to turn sign-in off and leave the token as the only credential.'));
  const id = await ask('   client id:', google.clientId || '');
  if (/^none$/i.test(id)) {
    // Both, and `enabled: false` is the load-bearing half. Clearing the id alone leaves a
    // secret file and an allowlist behind, which `googleProblem` reads as "wants sign-in"
    // — so every summary from then on would report a deliberate off as a misconfiguration
    // naming the id that was just deleted on purpose. The allowlist is kept: it is a list
    // somebody typed, and turning the feature off is not a reason to throw it away.
    google.clientId = null;
    google.enabled = false;
    cfg.auth = { ...(cfg.auth || {}), google };
    log(dim(`   sign-in is off. ${clientSecretFile(google)} is left alone — delete it yourself if you want it gone.`));
    return { on: false, text: 'off', changed: true };
  }
  google.clientId = id || null;

  /* ----------------------------------------------------------------------- secret */

  const file = clientSecretFile(google);
  const existing = clientSecretInFile(google);
  log(dim(`\n   The client secret. It is written to ${file}, mode 0600, and never into`));
  log(dim('   config.json — that file is committed to a git history a rotation cannot undo.'));
  if (existing) log(dim('   One is already there. Enter keeps it; anything you type replaces it.'));
  if (process.env.BEADCAUSE_GOOGLE_CLIENT_SECRET) {
    log(dim('   (BEADCAUSE_GOOGLE_CLIENT_SECRET is set in this shell, but the daemon runs'));
    log(dim('    under launchd and will not see it — put it in the file as well.)'));
  }
  // Held rather than written, and written below once the last question is answered.
  // scripts/configure.js promises that Ctrl+C anywhere in setup changes nothing, and a
  // secret on disk after a cancelled run would be the one exception to it — the one that
  // matters, since the file it lands in is the credential.
  const typed = await askSecret(`   client secret${existing ? ' (Enter keeps the current one)' : ''}:`);

  /* -------------------------------------------------------------------- allowlist */

  log(dim('\n   Which Google addresses may sign in? Comma-separated. Every other account is'));
  log(dim('   refused by name, and the refusal is logged. An empty list is sign-in off.'));
  const { allowed, ignored } = parseAllowed(await ask('   allowed:', allowlist(google).join(', ')));
  for (const bad of ignored) log(dim(`   (ignoring "${bad}" — that is not an email address)`));
  google.allowed = allowed;
  google.enabled = true;

  cfg.auth = { ...(cfg.auth || {}), google };

  // Now — nothing else here can be cancelled, and the verdict below has to be able to
  // read it back the way the daemon will.
  if (typed) {
    const written = writeClientSecret(typed, google);
    if (written.error) log(`   ${bold('could not save the secret')} — ${written.error}`);
    else log(dim(`   the secret is in ${written.file}`));
  }

  /* ------------------------------------------------------------------ the verdict */

  const stray = secretFileWarning(cfg);
  if (stray) log(`   ${bold('warning')} — ${stray}`);

  const after = signinStatus(cfg);
  if (after.on) log(dim(`   sign-in is ${after.text}.`));
  else if (after.text === 'off') log(`   ${bold('Sign-in is off')} — nothing was entered, so the token stays the only credential.`);
  else log(`   ${bold(`Sign-in is ${after.text}.`)} Re-run ${bold('npm run configure')} to finish it.`);

  return { ...after, changed: true };
}
