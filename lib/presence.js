/**
 * What each device is looking at, right now.
 *
 * Everything else in beadcause is a report on the *tracker* — what is ready, who is
 * working, what an advocate wants to file. This is the one thing the daemon knows
 * about the *reader*: which view the phone has open and which card is up in it. The
 * monitor's mirror tab is the only consumer, and without this it has nothing to
 * follow — no endpoint here ever said where anyone was.
 *
 * **In memory, never on disk.** A phone's whereabouts is worth exactly as long as
 * the daemon that serves it: a restart means every client re-reports on its next
 * heartbeat, and a record that outlived the process would only ever be a lie about
 * where someone is. It is also why nothing here needs pruning on a timer — `list()`
 * drops what has gone stale as it reads.
 *
 * A report is a claim by a client, so every field is bounded here rather than
 * trusted: an unknown view collapses to `other`, and every string is cut to a length
 * that fits a line of the mirror.
 */

/** How long a device stays listed after its last word. */
const TTL_MS = 15 * 60 * 1000;

/** Long enough for a bead title; short enough that no field can be a payload. */
const MAX_LEN = 300;

/** The views a client can be in. Anything else is still shown, as `other`. */
export const VIEWS = new Set(['inbox', 'card', 'graph', 'console', 'sessions', 'prs', 'config', 'terminal', 'doc', 'other']);

const devices = new Map();

const str = (v) => (v == null ? '' : String(v).slice(0, MAX_LEN));

/** The part of a report that decides whether the mirror has to redraw. */
function identity(r) {
  return [r.view, r.workspace, r.id, r.key, r.scope, r.space, r.detail, r.hidden ? 'h' : ''].join(' ');
}

/**
 * Record where a device is.
 *
 * Returns `{ record, changed }` — `changed` is false for a heartbeat that says the
 * same thing as last time, and the server uses it to decide whether to wake every
 * parked long-poll. A phone beating every half minute must not cost the tailnet a
 * broadcast per beat.
 */
export function report(deviceId, payload = {}, now = new Date()) {
  const device = str(deviceId).replace(/[^\w.-]/g, '');
  if (!device) return null;
  const view = VIEWS.has(payload.view) ? payload.view : payload.view ? 'other' : null;
  const record = {
    device,
    label: str(payload.label) || device.slice(0, 6),
    view,
    workspace: str(payload.workspace),
    id: str(payload.id),
    key: str(payload.key),
    scope: str(payload.scope),
    space: str(payload.space),
    detail: str(payload.detail),
    // A backgrounded tab stops beating, so without this the mirror could not tell
    // "put the phone down two minutes ago" from "still reading".
    hidden: Boolean(payload.hidden),
    at: now.toISOString(),
  };
  const prev = devices.get(device);
  // `since` is when this device arrived *at this view* — the age worth showing, and
  // it has to survive the heartbeats that keep the record alive.
  record.since = prev && identity(prev) === identity(record) ? prev.since : record.at;
  devices.set(device, record);
  return { record, changed: !prev || identity(prev) !== identity(record) };
}

/** Every device seen inside the TTL, most recently heard from first. */
export function list(now = Date.now()) {
  for (const [id, r] of devices) {
    if (now - new Date(r.at).getTime() > TTL_MS) devices.delete(id);
  }
  return [...devices.values()].sort((a, b) => b.at.localeCompare(a.at));
}

/** A device saying it has gone — a tab closing, or a page told to stop reporting. */
export function forget(deviceId) {
  return devices.delete(str(deviceId));
}

/** Tests, and nothing else: the store is process-lifetime state by design. */
export function reset() {
  devices.clear();
}
