/**
 * Writing a state file without being able to lose it.
 *
 * Every durable file beadcause owns — config.json, state.json, status.json, one
 * JSON per console, the advocates' own state — was written with a bare
 * `fs.writeFileSync`. That call truncates the file to zero and then writes, so the
 * window between the two is a window in which the file on disk is empty. A crash,
 * a `kill -9`, a full disk or a laptop losing power inside that window does not
 * cost you the last turn; it costs you the whole file. The daemon then starts up,
 * finds `{}` or a `JSON.parse` failure, and every one of these readers is written
 * to treat unreadable as absent — `loadState` returns `{ notified: [] }`,
 * `readAll` returns `{}`, the advocate's state comes back empty. So the loss is
 * silent. That is the part that makes it worth an hour: nothing surfaces it, you
 * just find that every question is unread again and every cooldown has reset.
 *
 * The fix is the standard one and it is small. Write the new content to a
 * temporary file beside the real one, flush it to the platter, then `rename` it
 * over the target. POSIX `rename(2)` is atomic within a filesystem: any reader
 * either sees the whole old file or the whole new one, never a torn or empty one,
 * and there is no moment at which the name does not resolve. Same directory
 * matters — a rename across filesystems is a copy, which is exactly the
 * non-atomic thing we are avoiding.
 *
 * The `fsync` before the rename is the half people skip. Without it the rename can
 * reach disk before the data it points at, which turns a power cut into a
 * correctly-named empty file — a worse outcome than the torn write, because it
 * looks intact. We fsync the directory too, so the rename itself is durable.
 *
 * Scope, deliberately: this is for small state files rewritten whole, which is all
 * of them here. It is not for the transcript-sized appends in lib/sessionlog.js
 * (those ride a git ref, which has its own atomicity) and not for the temp prompt
 * files handed to `claude` (born, read once, deleted — a torn one is a failed
 * spawn, not lost state).
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * A tmp name no concurrent writer can collide with.
 *
 * Two beadcause processes writing the same state file is not hypothetical — the
 * daemon and a `bin/status.js` or `npm run configure` run share `config.json`.
 * If they shared a tmp name, one would rename the other's half-written file into
 * place, which is the corruption this module exists to prevent, reintroduced.
 * The pid separates processes and the counter separates writes within one.
 */
let seq = 0;
const tmpFor = (file) => path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${seq++}`);

/** fsync a directory so a rename inside it survives a power cut. Best-effort. */
function syncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Not every platform lets you open a directory for fsync, and failing to
    // harden a write is not a reason to fail the write. The rename has already
    // happened by the time we are called; the file is correct either way.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing useful to do */
      }
    }
  }
}

/**
 * Replace `file` with `data`, atomically.
 *
 * `mode` defaults to 0o600 because every caller here passes it: these files hold
 * an ntfy topic, a tailnet layout and whatever an agent said, and they live in
 * `~/.config`. The mode is set on the temp file *before* the rename, so there is
 * no instant at which the real name is world-readable.
 */
export function writeFileAtomic(file, data, { mode = 0o600 } = {}) {
  const tmp = tmpFor(file);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closing because of an error; this one adds nothing */
      }
    }
    // Leave nothing behind. An orphan `.config.json.tmp-4821-0` beside the real
    // file is confusing to find and, unlike the target, nothing ever cleans it up.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* it may never have been created */
    }
    throw err;
  }
  syncDir(path.dirname(file));
}

/**
 * The shape every caller in this repo actually wants: pretty JSON, trailing
 * newline, 0o600, atomically.
 *
 * The trailing newline is not decoration — these files get read with `cat` and
 * hand-edited, and it is what the six `writeFileSync` calls this replaces all
 * did. Keeping the bytes identical means switching to this changes durability and
 * nothing else, so a diff of a state file after the change shows no diff at all.
 */
export function writeJsonAtomic(file, value, { mode = 0o600 } = {}) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', { mode });
}
