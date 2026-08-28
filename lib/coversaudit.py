#!/usr/bin/env python3
"""
`b7e-covers`'s own audit harness. `lib/covers.js`'s `auditCheck` spawns this — it is
never run by hand, and never named on any allowlist.

Runs one gate script under `sys.addaudithook`, recording every path it opens (the
`open` event, which `io.open`, the `open()` builtin, and `pathlib.Path.open`/
`read_text`/`read_bytes` all raise) or lists (`os.listdir`/`os.scandir`, which
`os.walk` and `glob.glob` both funnel through in CPython — so a script that globs a
directory shows up here exactly as if it had called `os.listdir` on it directly).
Recorded paths are normalised to absolute and then kept only if they fall under the
directory this process was started in (the repo root being audited), so interpreter
startup noise — stdlib source files, `__pycache__`, whatever else Python opens before
the target script's own first line runs — never pollutes the result.

Always writes a result to `out_path`, even when the target script raises an
uncaught exception or calls `sys.exit(1)` — coverage here means "what did it read
before it stopped", not "what did it read if it finished cleanly". This is the
`bc-dgx7.126` case verbatim: `scripts/check_saga_audit.py` fails a book with a new
chapter whose per-book count in an `INVENTORY` dict has not been bumped, and the read
that proves it covers that chapter (`os.listdir` over the book's directory, building
that dict) happens before the failure, not after.

Usage:
    python3 coversaudit.py <out_path> <target_script> [<target argv>...]

Must be run with cwd already set to the root being audited — every path is resolved
against `os.getcwd()`, exactly the way the target script itself would resolve one.
"""
import json
import os
import runpy
import sys


def main():
    out_path = sys.argv[1]
    target = sys.argv[2]
    target_argv = sys.argv[3:]
    root = os.getcwd()
    # `runpy.run_path` opens `target` itself to compile it — that is not the check
    # "reading" anything, it is the interpreter loading the check, so it is excluded
    # the same way stdlib/`__pycache__` noise is: a check does not "cover" its own path.
    target_abs = os.path.abspath(target)

    reads = set()
    dirs = set()

    def under_root(raw):
        if isinstance(raw, bytes):
            raw = raw.decode('utf-8', 'replace')
        if not isinstance(raw, str):
            return None
        try:
            ap = os.path.abspath(raw)
        except Exception:
            return None
        if ap == target_abs:
            return None
        if ap == root or ap.startswith(root + os.sep):
            return ap
        return None

    def hook(event, args):
        # The hook must never itself raise back into the traced program — a
        # malformed event (an int fd instead of a path, e.g.) is skipped, not fatal.
        try:
            if event == 'open':
                ap = under_root(args[0])
                if ap:
                    reads.add(ap)
            elif event in ('os.listdir', 'os.scandir'):
                p = args[0] if args else None
                ap = under_root(p if p is not None else '.')
                if ap:
                    dirs.add(ap)
        except Exception:
            pass

    sys.addaudithook(hook)

    sys.argv = [target] + target_argv
    exit_code = 0
    try:
        runpy.run_path(target, run_name='__main__')
    except SystemExit as e:
        code = e.code
        exit_code = code if isinstance(code, int) else (0 if code is None else 1)
    except BaseException:
        exit_code = 1
    finally:
        with open(out_path, 'w') as f:
            json.dump({'reads': sorted(reads), 'dirs': sorted(dirs), 'exitCode': exit_code}, f)


if __name__ == '__main__':
    main()
