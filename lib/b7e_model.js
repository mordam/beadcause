/**
 * `b7e-model` — the numbers a named building actually produces, for one or more sizes,
 * in one call.
 *
 * bc-dgx7.15 is the session audit's finding: five sophab sessions (sp-oyg, sp-0hw,
 * sp-j8f, sp-clh, sp-weu) each needed "what does the model say for THIS size, versus
 * the as-built one" and each built the params from scratch, differently — a raw
 * `(length, run, rise)` tuple, `dataclasses.replace`, `engine.build_params` by hand —
 * and one of them (sp-j8f) burned three failed calls assuming `costing.takeoff()`
 * returns a list of dicts when it returns `(items, summary)`.
 *
 * `tools/planset_sweep.py::numbers_for()`, already in the sophab checkout, is the
 * load-bearing fact this replaces all five hand-rolled versions with: it calls
 * `engine.build_params` and the same `fea_report` functions production does ("a sweep
 * that re-derived the load path would be checking its own arithmetic"), so `util` and
 * `beam_util` here are never a re-derivation, they are `fea_report`'s own numbers.
 * Nothing here re-implements structural analysis; this module is the bridge that lets a
 * beadcause agent — in *any* checkout, not just a sophab one — ask that question with
 * no `.venv` of its own and no import of `SolariumParams`, `engine.build_params` or
 * `costing.takeoff`'s return shape.
 *
 * **Why this is a beadcause `lib/` file that shells out to sophab, not a file written
 * into the sophab checkout.** The bead's own "belongs at" line, filed while it still
 * lived in the sophab tracker, named `tools/b7e_model.py` there — but every wiring
 * requirement it also lists (`package.json`/`package-lock.json` bin entries,
 * `test/*.mjs`, a `DEFAULT_TOOL_LIST` entry, a README section) is beadcause-repo
 * machinery, and the comment on the bead from the 2026-08-22 move says outright that
 * "the work lands in the beadcause repo". Splitting the deliverable across two repos —
 * a sophab-side Python file needing its own PR, review and merge, on top of this one —
 * would owe a second delivery this bead's instructions never mention. So the whole
 * thing lives here: this module only *reads* sophab (`sys.path.insert` onto its
 * checkout, then `import`), and never writes into it. `bin/b7e-model` is the argv
 * parsing and the printing around it, the same split every other `b7e-*` command uses.
 *
 * The Python itself is a string spawned with `python3 -c`, the same shape
 * `lib/plate.js`'s `RENDER_SCRIPT` already uses for exactly this reason: one process,
 * one JSON job on stdin, one JSON array on the last line of stdout — no temp file, no
 * second script to keep in sync with this one on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * `"24x14x12"` → `{ length: 24, run: 14, rise: 12 }`. Case-insensitive on the `x`
 * (`24X14X12` works too, matching how these get typed). Returns `{ error }` instead of
 * throwing — `bin/b7e-model` collects every bad token before refusing, rather than
 * stopping at the first one, since a multi-size call is the whole point of this tool.
 */
export function parseSize(raw) {
  const s = String(raw ?? '').trim();
  const parts = s.split(/x/i).map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => !p)) {
    return { error: `${raw}: expected LxRxH in feet (e.g. 24x14x12)` };
  }
  const [length, run, rise] = parts.map(Number);
  if (![length, run, rise].every((n) => Number.isFinite(n) && n > 0)) {
    return { error: `${raw}: expected LxRxH in feet (e.g. 24x14x12)` };
  }
  return { length, run, rise, raw: s };
}

/** `solarium.params.RIB_STYLES` — the two names `--rib` accepts. */
export const RIB_STYLES = ['open', 'closed'];

/**
 * The sophab checkout's own interpreter if it has one (`.venv/bin/python3`, where the
 * FEA solver's `anastruct`/`numpy`/`scipy` are actually installed — see
 * `requirements.txt`), else plain `python3` off `PATH`. Resolved from the sophab root,
 * never from the caller's own cwd or `.venv` — which is what makes this work from a
 * beadcause worktree, which has no `.venv` at all and never will.
 */
export function sophabPython(sophabRoot) {
  const venv = path.join(sophabRoot, '.venv', 'bin', 'python3');
  return fs.existsSync(venv) ? venv : 'python3';
}

/**
 * The Python side of the bridge. Reads one JSON job off stdin:
 *
 *     { sophabRoot, sizes: [{length,run,rise}, ...], rib, shape, place, costing }
 *
 * and prints one JSON array, one entry per size, as the LAST line of stdout (matching
 * `lib/plate.js`'s convention, so a stray print from an imported sophab module — several
 * of them log at import time — cannot corrupt the parse).
 *
 * Per size: builds params once (`engine.build_params`, mirroring exactly what
 * `numbers_for` builds internally) to read the section's breadth/depth/modulus off it
 * cheaply (`fea_report.section`, no solving), then calls `numbers_for` itself for the
 * governing check — `util`/`beam_util`/`R_base_kN`/`thrust_kN`/`over_capacity`/
 * `beyond_ladder` are exactly its own fields, not re-derived. With `costing`, calls
 * `costing.takeoff(p)` on the same params object and keeps the top 5 line items by
 * extended cost, so the report shows what actually drove the total rather than every
 * line.
 *
 * A size whose analysis raises (an out-of-range geometry, same as `numbers_for`'s own
 * try/except) gets `error`/`error_type` instead of stopping the batch — the whole point
 * of a multi-size call is that one exploding geometry must not hide the others.
 */
export const PYTHON_SCRIPT = `
import json
import os
import sys

job = json.loads(sys.stdin.read())
sophab_root = job["sophabRoot"]
sys.path.insert(0, sophab_root)
os.chdir(sophab_root)

import fea_report
from webapp import engine
from tools import planset_sweep
import costing as costing_mod

rib = job.get("rib") or "open"
shape = float(job.get("shape") or 1.0)
place = job.get("place") or ""
want_costing = bool(job.get("costing"))

results = []
for sz in job["sizes"]:
    length, run, rise = sz["length"], sz["run"], sz["rise"]
    entry = {"length": length, "run": run, "rise": rise, "rib_style": rib, "shape": shape,
             "error": "", "error_type": ""}
    try:
        p = engine.build_params(length, run, rise, "b7e-model", shape=shape,
                                 rib_style=rib, place=place or None)
        sec = fea_report.section(p)
        row = planset_sweep.numbers_for(length, run, rise, rib_style=rib, shape=shape,
                                        place=place)
        if row.get("error"):
            entry["error"] = row["error"]
            entry["error_type"] = row["error_type"]
            results.append(entry)
            continue
        entry.update({
            # NOT row["breadth_in"] — planset_sweep.numbers_for() reads it via
            # getattr(arch, "breadth", 0.0), but ArchParams has no "breadth" attribute
            # (only "rib_breadth"), so that field is always 0.0 (a latent bug in sophab,
            # filed separately; not this bead's to fix). p.arch.rib_breadth is the real
            # value and is what this reports instead.
            "breadth_in": round(float(p.arch.rib_breadth), 3),
            "depth_in": round(float(p.arch.rib_depth), 3),
            "A_in2": row["A_in2"],
            "I_in4": row["I_in4"],
            "Sx_in3": round(float(sec["Sx"]), 1),
            "gov_combo": row["gov_combo"],
            "util": row["util"],
            "beam_util": row["beam_util"],
            "over_capacity": row["over_capacity"],
            "beam_over_capacity": row["beam_over_capacity"],
            "R_base_kN": row["R_base_kN"],
            "thrust_kN": row["thrust_kN"],
            "beyond_ladder": row["beyond_ladder"],
        })
        if want_costing:
            items, summary = costing_mod.takeoff(p)
            top = sorted(items, key=lambda it: it["ext"], reverse=True)[:5]
            entry["costing"] = {
                "currency": summary["currency"],
                "region": summary["region"],
                "subtotal": round(summary["subtotal"]),
                "project_total": round(summary["project_total"]),
                "top_items": [
                    {"cat": it["cat"], "item": it["item"], "qty": round(it["qty"], 2),
                     "unit": it["unit"], "unit_cost": round(it["unit_cost"], 2),
                     "ext": round(it["ext"])}
                    for it in top
                ],
            }
    except Exception as e:
        entry["error"] = str(e)[:300]
        entry["error_type"] = type(e).__name__
    results.append(entry)

print(json.dumps(results))
`;

function defaultSpawn(job, pythonBin) {
  return spawnSync(pythonBin, ['-c', PYTHON_SCRIPT], {
    input: JSON.stringify(job),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Run the model for every size, returning `{ results }` (one entry per size, in order)
 * or throwing with a message meant to be printed as-is.
 *
 * `spawn(job, pythonBin)` is injectable — `test/b7emodel.mjs` points `sophabRoot` at a
 * self-contained fixture tree (stub `fea_report`/`webapp.engine`/`tools.planset_sweep`/
 * `costing` modules with the real call signatures but none of the real dependencies) and
 * runs the real interpreter against it, rather than faking the spawn away — the thing a
 * hand-rolled script got wrong five times was the SHAPE of what these functions return,
 * and a fake spawn would let this module's own misunderstanding of that shape pass.
 */
export function runModel({ sophabRoot, sizes, rib = 'open', shape = 1.0, place = '', costing = false }, { spawn = defaultSpawn } = {}) {
  const pythonBin = sophabPython(sophabRoot);
  const job = { sophabRoot, sizes, rib, shape, place, costing };
  const { status, stdout, stderr, error } = spawn(job, pythonBin);
  if (error) throw new Error(`b7e-model: ${pythonBin} is not runnable: ${error.message}`);
  if (status !== 0) throw new Error(`b7e-model: model run failed (${pythonBin}):\n${stderr || stdout}`);
  const lastLine = stdout.trim().split('\n').pop();
  let results;
  try {
    results = JSON.parse(lastLine);
  } catch {
    throw new Error(`b7e-model: could not parse the model's output:\n${stdout}${stderr ? `\n${stderr}` : ''}`);
  }
  return { results };
}

const fmt = (n, digits = 2) => (typeof n === 'number' ? n.toFixed(digits) : String(n));
const money = (n, currency) => `${currency ?? ''} ${Math.round(n).toLocaleString('en-US')}`.trim();

/** One multi-line block per size — the printed report `bin/b7e-model` prints by default. */
export function formatReport(results) {
  return results
    .map((r) => {
      const head = `${r.length}x${r.run}x${r.rise} (${r.rib_style}, shape ${fmt(r.shape ?? 1, 1)})`;
      if (r.error) return `${head}\n  ERROR (${r.error_type}): ${r.error}`;
      const lines = [
        head,
        `  section:        ${fmt(r.breadth_in)}" x ${fmt(r.depth_in)}"  (A ${fmt(r.A_in2)} in², I ${fmt(r.I_in4, 1)} in⁴, Sx ${fmt(r.Sx_in3, 1)} in³)`,
        `  governing:      ${r.gov_combo}  (util ${fmt(r.util, 3)}, beam_util ${fmt(r.beam_util, 3)})`,
        `  base:           R_base ${fmt(r.R_base_kN)} kN, thrust ${fmt(r.thrust_kN)} kN`,
        `  flags:          ${r.over_capacity ? 'OVER CAPACITY' : 'within capacity'}` +
          `${r.beam_over_capacity ? ', BEAM OVER CAPACITY' : ''}` +
          `${r.beyond_ladder ? ', beyond the calibrated ladder' : ''}`,
      ];
      if (r.costing) {
        const c = r.costing;
        lines.push(`  costing (${c.region}): ${money(c.project_total, c.currency)} total (${money(c.subtotal, c.currency)} subtotal)`);
        for (const it of c.top_items) {
          lines.push(
            `    ${it.cat.padEnd(11)} ${it.item}  ${it.qty} ${it.unit} @ ${money(it.unit_cost, c.currency)} = ${money(it.ext, c.currency)}`
          );
        }
      }
      return lines.join('\n');
    })
    .join('\n\n');
}
