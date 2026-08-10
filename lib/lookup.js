/**
 * Reading something off the network, as the only shape an agent is allowed to ask for.
 *
 * The problem this exists for: an agent dispatched by beadcause runs `claude -p` with
 * an explicit `--allowedTools`, and until now that list had nothing on it that could
 * reach outside the checkout. A question that turned on one external fact — the
 * edition of a code table, what a spec actually says, whether an upstream API still
 * returns that field — stopped dead and came back as "I cannot look things up",
 * which is a true answer and a useless one.
 *
 * `WebFetch` and `WebSearch` cover most of it and are the preferable grant, because
 * they are read-only by construction. This module is for the rest: the content types
 * WebFetch mangles on its way to prose, where what is wanted is the bytes as served.
 *
 * **Why a wrapper and not `Bash(curl:*)`.** That was ruled on directly (bc-awr,
 * 2026-08-10) and the reasoning is worth keeping next to the code, because the
 * obvious implementation does not enforce the ruling:
 *
 * - `Bash(curl:*)` matches *every* curl invocation. `-X POST`, `-d`, `--upload-file`
 *   and `-o /somewhere/on/disk` all match it. Allowlisting the verb grants the whole
 *   binary; it does not grant "GET".
 * - curl reads `file://` happily, which turns a network grant into an unrestricted
 *   file read that goes around whatever limits `Read` has.
 * - `-X GET` alongside `-d` still sends a request body, so "GET only" cannot be
 *   implemented as a method flag. It has to be implemented as *nothing here ever
 *   constructs a body*, which is what this module does — there is no code path that
 *   sets one, so there is no flag that can reach one.
 *
 * So the agent's allowlist entry is `Bash(beadcause-get:*)`: it may name a URL and it
 * cannot name a method, a header, a body or an output file. This is the library half;
 * bin/beadcause-get is the command, and it is deliberately thin.
 *
 * **What it will not fetch, and why that is not paranoia.** Loopback and the private
 * ranges are refused. The daemon this runs beside serves an HTTP API on this machine,
 * and there are other local servers on a developer's laptop that answer a GET with
 * something they would not answer a stranger with — a headless Chrome's CDP endpoint
 * will *open a tab* for one. An unattended agent that can be talked into fetching a
 * URL should not be able to reach those by accident. This is a guard against accident
 * and obvious misuse rather than a hardened SSRF barrier: the name is resolved and
 * checked immediately before the request, so a name that changes what it resolves to
 * in between would slip through, and the honest fix for that is pinning the connection
 * to the vetted address, which node's fetch does not expose.
 *
 * Everything is bounded, because the caller is unattended and nobody is present to
 * notice a hang: a whole-operation timeout, a redirect depth, and a byte cap that
 * cancels the stream rather than buffering whatever the far end feels like sending.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { ownerName } from './owner.js';

/**
 * What the agents are told about the grant — one copy, quoted into every prompt.
 *
 * The allowlist entry is necessary and is not sufficient. An agent that never learns
 * it can look something up simply never does, and from outside that is
 * indistinguishable from it having decided not to — which is the exact failure this
 * whole change exists to fix, reproduced one layer up.
 *
 * The two rules after the commands are the ones with teeth, and neither is enforced
 * by the wrapper:
 *
 * - **A fetched value is not automatically a usable one.** The bead that motivated
 *   this (sp-b5r) refuses inference and summarisation for a good reason: a wrong
 *   ground snow load sizes a rib, and nothing on the page shows it. So the grant
 *   comes with an instruction to cite the source and the edition, and to keep asking
 *   when the source is not one that has been accepted.
 * - **A GET carries its query string to the other end.** The wrapper cannot narrow
 *   that, and no wrapper could; it is a prompt-and-audit concern. So the agents are
 *   told plainly what they may put in a URL, which is the public thing they are
 *   looking up and nothing else.
 */
export const lookupBrief = (owner = ownerName()) => `**You can look things up outside this checkout.** Three shapes, smallest first:

    WebSearch                       find where the answer lives
    WebFetch                        read a page as prose — reach for this first
    beadcause-get <url>             the bytes as served: JSON, CSV, XML, a raw table

\`beadcause-get\` is GET over http/https and nothing else — there is no flag for a
method, a header, a request body or an output file, and private and loopback
addresses are refused. It prints the URL it actually landed on, after redirects.

**Cite what you read**: the URL and, when the page claims one, the edition, version or
date. An external fact with no source in the same sentence is a guess wearing a
fact's clothes, and whoever reads your comment cannot tell the difference.

**Finding a number is not the same as being allowed to use it.** If the question
names a source, use that one. If what you found is a *different* source — a mirror, a
summary, a later edition, someone's blog — say so plainly, give both, and let ${owner}
decide. Do not average, interpolate or infer a value that a table is supposed to
supply.

**Watch what you put in a URL.** A search query and a query string both travel to
whoever is on the other end. Look up the public fact; never send the contents of this
repo, a bead, a comment thread, a file path or anything resembling a credential.

You cannot log in, POST, or act as ${owner} anywhere. If the answer is behind a login,
that is the answer: say so rather than working around it.`;

/** The default read cap. Enough for a spec page; not enough to be a memory event. */
export const DEFAULT_MAX_BYTES = 2_000_000;
/** The ceiling `--max-bytes` cannot argue its way past. */
export const HARD_MAX_BYTES = 8_000_000;
/** The default whole-operation timeout, headers and body together. */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** The ceiling `--timeout` cannot argue its way past. */
export const HARD_MAX_TIMEOUT_MS = 60_000;
/** How many hops a redirect chain may take before it is treated as a loop. */
export const MAX_REDIRECTS = 5;

/**
 * A refusal, distinguishable from a network failure.
 *
 * The two read very differently to whoever is looking at the log afterwards: "the
 * wrapper would not do that" is a thing to argue with, and "the far end did not
 * answer" is a thing to retry.
 */
export class LookupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LookupError';
    this.code = code;
  }
}

/**
 * Hostnames that name this machine or something on the local wire by convention
 * rather than by address. Checked before DNS, because several of them never reach it.
 */
const LOCAL_NAMES = /^(localhost|127\.0\.0\.1|\[::1\]|.*\.local|.*\.localhost|.*\.internal|.*\.home\.arpa)$/i;

/** Is this literal address one an agent has no business reaching? */
export function isBlockedAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    if (p[0] === 0) return true; // "this network"
    if (p[0] === 127) return true; // loopback
    if (p[0] === 10) return true; // private
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // private
    if (p[0] === 192 && p[1] === 168) return true; // private
    if (p[0] === 169 && p[1] === 254) return true; // link-local, incl. cloud metadata
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // carrier NAT
    if (p[0] >= 224) return true; // multicast and reserved
    return false;
  }
  if (v === 6) {
    const ip6 = ip.toLowerCase();
    if (ip6 === '::' || ip6 === '::1') return true;
    // An IPv4-mapped address is an IPv4 address wearing a hat; check the address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip6);
    if (mapped) return isBlockedAddress(mapped[1]);
    if (/^fe[89ab]/.test(ip6)) return true; // link-local
    if (/^f[cd]/.test(ip6)) return true; // unique local
    if (/^ff/.test(ip6)) return true; // multicast
    return false;
  }
  return true; // not an address at all
}

/**
 * Parse and vet one URL, without touching the network.
 *
 * `allowLocal` exists for the test suite, which has to serve itself something on
 * loopback to have anything to fetch. There is deliberately **no flag on the command
 * that sets it** — an escape hatch an agent can type is not a guard.
 */
export function vetUrl(raw, { allowLocal = false } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new LookupError('bad-url', `not a URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LookupError(
      'bad-scheme',
      `only http and https are allowed here, and this is ${url.protocol}${
        url.protocol === 'file:' ? ' — use Read for files on this machine' : ''
      }`,
    );
  }
  if (url.username || url.password) {
    // Credentials in a URL are an authenticated request in disguise, and this grant
    // is for reading what anyone could read.
    throw new LookupError('credentials', 'a URL with credentials in it is not allowed');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowLocal) {
    if (LOCAL_NAMES.test(url.hostname) || LOCAL_NAMES.test(host)) {
      throw new LookupError('local', `${url.hostname} names this machine; this fetches public URLs only`);
    }
    if (net.isIP(host) && isBlockedAddress(host)) {
      throw new LookupError('local', `${host} is a private or loopback address; this fetches public URLs only`);
    }
  }
  return url;
}

/** Resolve a hostname and refuse it if any address it answers with is off limits. */
async function assertPublicHost(url, allowLocal) {
  if (allowLocal) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return; // already vetted literally
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (err) {
    throw new LookupError('dns', `cannot resolve ${host}: ${err.message}`);
  }
  const blocked = addrs.filter((a) => isBlockedAddress(a.address));
  if (blocked.length) {
    throw new LookupError('local', `${host} resolves to ${blocked[0].address}, which is private or loopback`);
  }
}

/** Content types worth printing as text. Everything else is bytes nobody can read. */
const TEXTUAL = /^text\/|(\+|\/)(json|xml|yaml|csv|javascript|ecmascript|html|plain|markdown|graphql)\b/i;

function charsetOf(contentType) {
  const m = /charset=["']?([\w-]+)/i.exec(contentType || '');
  return (m ? m[1] : 'utf-8').toLowerCase();
}

/**
 * GET one URL and hand back what came off it.
 *
 * There is one method here and it is spelled in one place. No option adds a body, a
 * header the caller chose, or a file on disk.
 */
export async function get(raw, opts = {}) {
  const allowLocal = opts.allowLocal === true;
  const maxBytes = Math.max(1, Math.min(Number(opts.maxBytes) || DEFAULT_MAX_BYTES, HARD_MAX_BYTES));
  const timeoutMs = Math.max(1000, Math.min(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS, HARD_MAX_TIMEOUT_MS));
  const headersOnly = opts.headersOnly === true;

  // One controller for the whole operation, body included. A timeout that covers only
  // the headers is a timeout a slow trickle of bytes walks straight through.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new LookupError('timeout', `no answer within ${timeoutMs}ms`)), timeoutMs);

  try {
    let url = vetUrl(raw, { allowLocal });
    const chain = [];
    let res = null;

    for (let hop = 0; ; hop++) {
      await assertPublicHost(url, allowLocal);
      try {
        res = await fetch(url, {
          method: 'GET',
          redirect: 'manual',
          signal: ac.signal,
          headers: {
            // Named so a server operator reading a log can tell what this was, and
            // so the agent's own reach is identifiable. Nothing here is chosen by
            // the caller.
            'user-agent': 'beadcause-get/1 (+https://github.com/; unattended agent lookup)',
            accept: '*/*',
          },
        });
      } catch (err) {
        if (err instanceof LookupError) throw err;
        if (ac.signal.aborted) throw ac.signal.reason instanceof LookupError ? ac.signal.reason : new LookupError('timeout', 'timed out');
        throw new LookupError('network', `${url.origin}: ${err.message}`);
      }
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      if (hop >= MAX_REDIRECTS) {
        throw new LookupError('redirects', `more than ${MAX_REDIRECTS} redirects, starting at ${raw}`);
      }
      // Cancel the body of the hop rather than leaking the socket, then re-vet: a
      // redirect is the far end choosing the next URL, so it gets the same scrutiny
      // the first one did.
      await res.body?.cancel().catch(() => {});
      let next;
      try {
        next = new URL(location, url);
      } catch {
        throw new LookupError('bad-url', `redirected to something that is not a URL: ${location}`);
      }
      url = vetUrl(next, { allowLocal });
      chain.push(url.href);
    }

    const contentType = res.headers.get('content-type') || '';
    const out = {
      url: url.href,
      status: res.status,
      statusText: res.statusText,
      contentType,
      redirects: chain,
      bytes: 0,
      truncated: false,
      binary: false,
      body: '',
    };

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 0) out.declaredBytes = declared;

    if (headersOnly) {
      await res.body?.cancel().catch(() => {});
      return out;
    }
    if (contentType && !TEXTUAL.test(contentType)) {
      // Dumping a PDF's bytes into an agent's context helps nobody and costs the
      // whole read cap. Say what it was and stop.
      out.binary = true;
      await res.body?.cancel().catch(() => {});
      return out;
    }

    const chunks = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        let step;
        try {
          step = await reader.read();
        } catch (err) {
          if (ac.signal.aborted) throw ac.signal.reason instanceof LookupError ? ac.signal.reason : new LookupError('timeout', 'timed out');
          throw new LookupError('network', `while reading ${url.href}: ${err.message}`);
        }
        if (step.done) break;
        const room = maxBytes - total;
        if (step.value.length >= room) {
          chunks.push(step.value.subarray(0, room));
          total += room;
          out.truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(step.value);
        total += step.value.length;
      }
    }
    out.bytes = total;
    const buf = Buffer.concat(chunks, total);
    try {
      out.body = new TextDecoder(charsetOf(contentType), { fatal: false }).decode(buf);
    } catch {
      out.body = buf.toString('utf8');
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}
