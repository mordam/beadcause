/**
 * Is the tailnet address this Mac is configured to serve on actually *here*?
 *
 * ## The failure this exists for
 *
 * `cfg.host` is a Tailscale address — `100.96.105.106` — written into
 * `~/.config/beadcause/config.json` the first time the daemon saw one. Both bind loops
 * (`listen` in lib/server.js, `listen` in bin/router.js) bind loopback *and* that
 * address, and both treat a bind failure as fatal only when **every** address failed:
 *
 *     if (++failed === hosts.length && bound === 0) process.exit(PORT_TAKEN_EXIT)
 *
 * Which is right for the case it was written for — another instance owning the port —
 * and exactly wrong for a stopped Tailscale. Loopback binds, so `bound` is 1, so the
 * process carries on: one line of `EADDRNOTAVAIL` in a launchd log nobody reads, a
 * daemon that reports itself healthy, and a phone that cannot reach it at all. That is
 * how a morning was lost — `--status` said the build was active, `curl` on loopback
 * said 200, and the only symptom anywhere was the app not loading.
 *
 * ## Why a check is not enough on its own
 *
 * The obvious fix — shout at startup when Tailscale is down — cries wolf every boot.
 * launchd starts this daemon at login and Tailscale often has not finished connecting
 * by then, so the honest startup state is *not yet* rather than *broken*, and a daemon
 * that shouted and then served loopback forever would still need the restart by hand
 * that this bead is about.
 *
 * So the check keeps watching. `watchForAddress` polls `os.networkInterfaces()` — no
 * subprocess, so it is cheap enough to run on a timer forever — and the caller binds
 * the address the moment it appears. A daemon started before Tailscale therefore
 * arrives at the same place as one started after it, a few seconds later, with no
 * `launchctl kickstart` in between.
 *
 * ## Why the interface list and not `tailscale status`
 *
 * The question a bind loop has is not "is Tailscale healthy" but "can this address be
 * bound", and the kernel's own answer to that is the interface list. Shelling out is
 * kept for the one thing the interface list cannot say — *why* it is missing — and
 * happens once, on the failure path, never on a poll.
 *
 * A leaf, like lib/tls.js and for the same reason: bin/router.js holds port 4318 and
 * imports almost nothing, so nothing in here may be able to stop it coming up.
 */
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { tailscaleBin } from './config.js';

/** How often to look for an address that was not there when we tried to bind it. */
export const WATCH_EVERY_MS = 5000;

/** Every IPv4 address currently on an interface of this machine. */
export function localAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    // Node moved `family` from the string `'IPv4'` to the number `4` and back across
    // major versions; accepting both is cheaper than caring which one is running.
    for (const a of addrs || []) if (a.family === 'IPv4' || a.family === 4) out.push(a.address);
  }
  return out;
}

/** Can `host` be bound right now? Loopback and an unset host are trivially yes. */
export function addressIsHere(host) {
  if (!host || host === '127.0.0.1') return true;
  return localAddresses().includes(host);
}

/**
 * Ask `tailscale` what it thinks, for the sentence a person reads. Never called on the
 * polling path — only when a bind has already failed, where one subprocess is free.
 *
 * `tailscale ip -4` rather than `status --json`: it is the same question `tailscaleIp`
 * in lib/config.js asks in order to *write* `cfg.host` in the first place, so a
 * disagreement between the two is exactly the `moved` case below rather than an
 * artefact of having asked differently.
 */
function tailscaleSaysIp() {
  const bin = tailscaleBin();
  if (!bin) return { bin: null, ip: null };
  try {
    const out = execFileSync(bin, ['ip', '-4'], { encoding: 'utf8', timeout: 5000 }).trim();
    const ip = out.split('\n')[0].trim();
    return { bin, ip: /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null };
  } catch {
    // A non-zero exit is what a stopped Tailscale looks like from here: the CLI is
    // present, the daemon behind it is not running, or it is logged out.
    return { bin, ip: null };
  }
}

/**
 * What is true about `host`, and — when it is not bindable — which of the reasons:
 *
 *   - `loopback` — nothing to check; no tailnet address is configured.
 *   - `here`     — the address is on an interface and can be bound.
 *   - `no-cli`   — no `tailscale` binary in any of the known places. Not an outage:
 *                  this is a machine that never had Tailscale, and a loopback-only
 *                  install on it is working as intended.
 *   - `stopped`  — the CLI is there and has no address to give. Tailscale is down, or
 *                  logged out. This is the one that cost the morning.
 *   - `starting` — Tailscale names this very address but the interface is not up yet.
 *                  The ordinary state a few seconds after login, and the reason the
 *                  startup line must not read as a failure.
 *   - `moved`    — Tailscale is up and this Mac's address is a *different* one, so the
 *                  config is stale. Kept apart from `stopped` because the cure is
 *                  different: nothing to start, something to rewrite.
 */
export function tailnetState(host) {
  if (!host || host === '127.0.0.1') return { ok: true, reason: 'loopback', host: null, ip: null };
  if (addressIsHere(host)) return { ok: true, reason: 'here', host, ip: host };
  const { bin, ip } = tailscaleSaysIp();
  if (!bin) return { ok: false, reason: 'no-cli', host, ip: null };
  if (!ip) return { ok: false, reason: 'stopped', host, ip: null };
  if (ip === host) return { ok: false, reason: 'starting', host, ip };
  return { ok: false, reason: 'moved', host, ip };
}

/**
 * The state as a line for the startup block and `--status`, in the shape the rest of
 * that block uses. It says the *consequence* — whether the phone can reach this daemon
 * — because that is the fact the log was missing, and the cure where there is one.
 */
export function describeTailnet(state) {
  switch (state.reason) {
    case 'loopback':
      return 'loopback only — no tailnet address configured, so nothing off this Mac can reach it';
    case 'here':
      return `${state.host} — on this Mac, so the phone can reach it`;
    case 'no-cli':
      return `${state.host} is configured but there is no \`tailscale\` on this Mac — loopback only, and the phone cannot reach it`;
    case 'stopped':
      return (
        `${state.host} is NOT on this Mac — Tailscale is stopped, and the phone cannot reach this daemon. ` +
        'Start it (`tailscale up`); the address is bound the moment it appears, with no restart'
      );
    case 'starting':
      return `${state.host} is not up yet — Tailscale knows the address but the interface is still coming up; binding it as soon as it appears`;
    case 'moved':
      return (
        `${state.host} is NOT on this Mac — Tailscale gives it ${state.ip} now, so the configured address is stale ` +
        'and the phone cannot reach this daemon. Fix `host` in the config (`npm run configure`) and restart'
      );
    default:
      return `${state.host} — unknown state`;
  }
}

/**
 * The same line, for a caller that has no use for the state object. Kept apart from
 * `describeTailnet` so a caller that wants both — the startup block, which chooses
 * `console.log` or `console.warn` on `ok` — asks `tailscale` once rather than twice.
 */
export function tailnetLine(host) {
  return describeTailnet(tailnetState(host));
}

/**
 * Call `onHere` once, as soon as `host` is bindable. Returns a stop function.
 *
 * The timer is `unref`d: a daemon whose only remaining work is waiting for Tailscale
 * has nothing to stay alive *for*, and a suite that forgets to stop one must not hang
 * on it. It fires for an address that is already there too, so a caller can use this
 * without first asking `addressIsHere` itself — but never synchronously, because every
 * caller here is still inside its own bind loop at the moment it calls this.
 */
export function watchForAddress(host, onHere, { intervalMs = WATCH_EVERY_MS } = {}) {
  let stopped = false;
  const check = () => {
    if (stopped || !addressIsHere(host)) return;
    stop();
    onHere();
  };
  const timer = setInterval(check, intervalMs);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  timer.unref?.();
  if (addressIsHere(host)) setImmediate(check);
  return stop;
}
