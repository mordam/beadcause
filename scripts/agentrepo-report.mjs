#!/usr/bin/env node
/**
 * The tier 3 experiment, read out.
 *
 *   npm run agentrepo
 *
 * There is a whole file of measurement in lib/agentrepo.js and, until bc-goo.12, nothing
 * at all that *read* it: `summary()` had no caller anywhere in the daemon, so the only
 * way to see the experiment was to open a node REPL and know the function's name. That is
 * how it went four days recording one run in one arm without anybody noticing — the
 * failure the bead names is that **a starved experiment and a running one look
 * identical**, and it is a failure of reporting as much as of wiring.
 *
 * So this is the one command that answers "is it actually running", and `report` is
 * written so that the answer cannot be a zero pretending to be a measurement: an arm with
 * no runs says so in words, and an agent that owns a repo and has never run at all is
 * listed even though nothing in the log mentions it. That last part is why `expect` is
 * passed in from lib/foundation.js rather than derived from the log — the agent that had
 * never run once was invisible in its own data.
 *
 * Read-only, and deliberately not reachable by an agent: `bin/beadcause-agentrepo` is what
 * the *subject* of the experiment is given, and an agent that could read this could see
 * which arm it is in.
 */
import { summary, report } from '../lib/agentrepo.js';
import { AGENTS, baseline } from '../lib/foundation.js';

const expect = AGENTS.filter((a) => baseline(a).ownsRepo);
process.stdout.write(report(summary(), { expect }));
