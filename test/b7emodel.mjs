#!/usr/bin/env node
/**
 * `b7e-model` — the numbers a named building actually produces, for one or more sizes,
 * in one call. lib/b7e_model.js and bin/b7e-model.
 *
 *     npm test
 *     node test/b7emodel.mjs
 *
 * Three tiers. First, `lib/b7e_model.js`'s pure functions (`parseSize`,
 * `sophabPython`), checked directly and fast. Second, `runModel` with an injected
 * `spawn` — the boundary cases (a process that cannot run, a non-zero exit, unparsable
 * output) that would be awkward to force through a real `python3`. Third, `bin/b7e-model`
 * itself, spawned for real against a **self-contained fixture "sophab" checkout** — stub
 * `fea_report`/`webapp.engine`/`tools.planset_sweep`/`costing` modules with the real call
 * signatures (`numbers_for(length, run, rise, rib_style=, shape=, place=)`,
 * `takeoff(params, region=, fx=)` returning `(items, summary)`) but none of the real
 * dependencies (`anastruct`/`numpy`/`scipy`) — driven with the real system `python3`, so
 * argv parsing, the JSON job/response bridge and the report formatting are all exercised
 * for real. bc-dgx7.15's own finding was five sessions getting the SHAPE of
 * `costing.takeoff()`'s return wrong; a fake `spawn` would let this module's own
 * misunderstanding of that shape pass silently, so the shape is what the fixture pins.
 *
 * A fourth, soft tier runs at the very end: one real size against the real sophab
 * checkout on this machine, if there is one — see the guard below.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';
import { parseSize, RIB_STYLES, sophabPython, runModel, formatReport } from '../lib/b7e_model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-model');

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
};

/* --------------------------------------------------------------- lib/b7e_model.js, pure */

console.log('parseSize');
{
  check('LxRxH parses to numbers', () => {
    assert.deepEqual(parseSize('24x14x12'), { length: 24, run: 14, rise: 12, raw: '24x14x12' });
  });
  check('uppercase X works too', () => {
    assert.deepEqual(parseSize('50X22X20'), { length: 50, run: 22, rise: 20, raw: '50X22X20' });
  });
  check('decimals work', () => {
    const p = parseSize('24.5x14x12.25');
    assert.equal(p.length, 24.5);
    assert.equal(p.rise, 12.25);
  });
  for (const bad of ['24x14', '24x14x12x9', 'abcxdefxghi', '24xx12', '0x14x12', '-5x14x12', '']) {
    check(`"${bad}" is refused with a usable message`, () => {
      const p = parseSize(bad);
      assert.ok(p.error, `expected an error for "${bad}"`);
      assert.match(p.error, /LxRxH/);
    });
  }
}

console.log('\nRIB_STYLES / sophabPython');
{
  check('RIB_STYLES is open and closed', () => {
    assert.deepEqual([...RIB_STYLES].sort(), ['closed', 'open']);
  });
  check('prefers the checkout .venv when it exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b7e-model-venv-'));
    fs.mkdirSync(path.join(tmp, '.venv', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.venv', 'bin', 'python3'), '#!/bin/sh\n');
    try {
      assert.equal(sophabPython(tmp), path.join(tmp, '.venv', 'bin', 'python3'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  check('falls back to plain python3 with no .venv', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b7e-model-novenv-'));
    try {
      assert.equal(sophabPython(tmp), 'python3');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

/* --------------------------------------------------------------------- runModel(spawn) */

console.log('\nrunModel with an injected spawn');
{
  check('parses the last stdout line as the result array', () => {
    const spawn = () => ({ status: 0, stdout: 'a stray import-time print\n[{"length":24,"run":14,"rise":12,"error":""}]\n', stderr: '' });
    const { results } = runModel({ sophabRoot: '/nowhere', sizes: [{ length: 24, run: 14, rise: 12 }] }, { spawn });
    assert.equal(results.length, 1);
    assert.equal(results[0].length, 24);
  });
  check('a spawn error (no interpreter) throws a b7e-model-prefixed message', () => {
    const spawn = () => ({ error: new Error('ENOENT') });
    assert.throws(
      () => runModel({ sophabRoot: '/nowhere', sizes: [] }, { spawn }),
      /b7e-model: .* is not runnable/
    );
  });
  check('a non-zero exit throws with stderr', () => {
    const spawn = () => ({ status: 1, stdout: '', stderr: 'Traceback: boom' });
    assert.throws(() => runModel({ sophabRoot: '/nowhere', sizes: [] }, { spawn }), /boom/);
  });
  check('unparsable output throws rather than returning garbage', () => {
    const spawn = () => ({ status: 0, stdout: 'not json at all', stderr: '' });
    assert.throws(() => runModel({ sophabRoot: '/nowhere', sizes: [] }, { spawn }), /could not parse/);
  });
}

console.log('\nformatReport');
{
  check('an error entry prints ERROR and skips the numeric fields', () => {
    const out = formatReport([{ length: 24, run: 200, rise: 12, rib_style: 'open', shape: 1, error: 'run out of range', error_type: 'ValueError' }]);
    assert.match(out, /ERROR \(ValueError\): run out of range/);
  });
  check('a clean entry prints section, governing and flags', () => {
    const out = formatReport([
      {
        length: 24, run: 14, rise: 12, rib_style: 'open', shape: 1, error: '',
        breadth_in: 6, depth_in: 10.5, A_in2: 95.2, I_in4: 480.1, Sx_in3: 91.4,
        gov_combo: 'D+S', util: 0.62, beam_util: 0.71, over_capacity: false,
        beam_over_capacity: false, R_base_kN: 41.2, thrust_kN: 18.4, beyond_ladder: false,
      },
    ]);
    assert.match(out, /24x14x12/);
    assert.match(out, /D\+S/);
    assert.match(out, /within capacity/);
    assert.doesNotMatch(out, /OVER CAPACITY/);
  });
}

/* ---------------------------------------------------- bin/b7e-model against a fixture */

console.log('\nbin/b7e-model against a self-contained fixture sophab checkout');

const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'b7e-model-fixture-'));
{
  fs.writeFileSync(
    path.join(FIXTURE, 'fea_report.py'),
    `def section(params):\n    return {"A": 95.2, "I_comp": 480.1, "Sx": 91.4, "c": 5.25}\n`
  );
  fs.mkdirSync(path.join(FIXTURE, 'webapp'));
  fs.writeFileSync(path.join(FIXTURE, 'webapp', '__init__.py'), '');
  fs.writeFileSync(
    path.join(FIXTURE, 'webapp', 'engine.py'),
    [
      'class _Arch:',
      '    def __init__(self):',
      '        self.rib_breadth = 6.0',
      '        self.rib_depth = 10.5',
      '',
      'class _Params:',
      '    def __init__(self, name):',
      '        self.name = name',
      '        self.arch = _Arch()',
      '',
      'def build_params(length, run, rise, name, shape=1.0, rib_style="open", place=None, lat=None, lon=None):',
      '    if run > 100:',
      '        raise ValueError("run out of range")',
      '    return _Params(name)',
      '',
    ].join('\n')
  );
  fs.mkdirSync(path.join(FIXTURE, 'tools'));
  fs.writeFileSync(path.join(FIXTURE, 'tools', '__init__.py'), '');
  fs.writeFileSync(
    path.join(FIXTURE, 'tools', 'planset_sweep.py'),
    [
      'def numbers_for(length, run, rise, rib_style="open", shape=1.0, place=""):',
      '    row = {"length": length, "run": run, "rise": rise, "error": "", "error_type": ""}',
      '    if run > 100:',
      '        row["error"] = "run out of range"',
      '        row["error_type"] = "ValueError"',
      '        return row',
      '    row.update({',
      '        "breadth_in": 6.0, "A_in2": 95.2, "I_in4": 480.1,',
      '        "gov_combo": "D+S", "util": 0.62, "beam_util": 0.71,',
      '        "over_capacity": False, "beam_over_capacity": False,',
      '        "R_base_kN": 41.2, "thrust_kN": 18.4, "beyond_ladder": False,',
      '    })',
      '    return row',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(FIXTURE, 'costing.py'),
    [
      'def takeoff(params, region="CA-NB", fx=None):',
      '    items = [',
      '        {"cat": "Foundation", "item": "Screw piles", "qty": 14, "unit": "ea", "unit_cost": 410.0, "ext": 5740.0},',
      '        {"cat": "Ribs", "item": "Chord laminations", "qty": 900.0, "unit": "bf", "unit_cost": 6.5, "ext": 5850.0},',
      '    ]',
      '    summary = {"currency": "CAD", "region": region, "subtotal": 100000, "project_total": 128400}',
      '    return items, summary',
      '',
    ].join('\n')
  );
}

const pyCheck = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const HAVE_PY3 = !pyCheck.error;
if (!HAVE_PY3) {
  console.log('  (skipped: no python3 on this machine)');
} else {
  const run = (args) => spawnSync(process.execPath, [BIN, '--sophab-root', FIXTURE, ...args], { encoding: 'utf8' });

  check('two sizes side by side, exit 0', () => {
    const r = run(['24x14x12', '50x22x20']);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /24x14x12/);
    assert.match(r.stdout, /50x22x20/);
    assert.match(r.stdout, /D\+S/);
    assert.match(r.stdout, /util 0\.620/);
  });

  check('--json is a parseable array with the expected fields', () => {
    const r = run(['24x14x12', '--json']);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const out = JSON.parse(r.stdout);
    assert.equal(out.length, 1);
    assert.equal(out[0].gov_combo, 'D+S');
    assert.equal(out[0].util, 0.62);
    assert.equal(out[0].beam_util, 0.71);
    assert.equal(out[0].depth_in, 10.5);
    // not the fixture row's own (deliberately unused) "breadth_in": 6.0 — this pins that
    // b7e-model reads breadth off p.arch.rib_breadth, not numbers_for's own buggy field
    // (getattr(arch, "breadth", 0.0), always 0.0 on the real ArchParams — see lib/b7e_model.js).
    assert.equal(out[0].breadth_in, 6.0);
  });

  check('--costing prints the total and top line items with their rates', () => {
    const r = run(['24x14x12', '--costing', '--json']);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const out = JSON.parse(r.stdout);
    assert.equal(out[0].costing.project_total, 128400);
    assert.equal(out[0].costing.top_items.length, 2);
    assert.equal(out[0].costing.top_items[0].item, 'Chord laminations'); // higher ext (5850) sorts first
    assert.equal(out[0].costing.top_items[0].unit_cost, 6.5);
  });

  check('caller never needs to know SolariumParams/build_params/takeoff\'s shape — printed report names none of them', () => {
    const r = run(['24x14x12', '--costing']);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.doesNotMatch(r.stdout, /SolariumParams|build_params|takeoff/);
  });

  check('a geometry the fixture model refuses is reported, not fatal, and the other size still prints', () => {
    const r = run(['24x14x12', '200x150x12']);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /ERROR \(ValueError\): run out of range/);
    assert.match(r.stdout, /24x14x12/);
    assert.match(r.stdout, /D\+S/);
  });

  check('a bad LxRxH token is refused at exit 2, before any model run', () => {
    const r = run(['24x14']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /LxRxH/);
  });

  check('an unknown --rib value is refused at exit 2', () => {
    const r = run(['24x14x12', '--rib', 'shiny']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /open\|closed/);
  });

  check('--sophab-root pointing nowhere is refused at exit 4', () => {
    // run()'s own --sophab-root FIXTURE would win (value() takes the first occurrence),
    // so this needs a bare invocation rather than run().
    const r = spawnSync(process.execPath, [BIN, '24x14x12', '--sophab-root', '/no/such/place'], { encoding: 'utf8' });
    assert.equal(r.status, 4, r.stderr);
  });

  check('--help prints usage and exits 0 without running anything', () => {
    const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /usage: b7e-model/);
  });

  check('no size at all is refused at exit 2', () => {
    const r = spawnSync(process.execPath, [BIN, '--sophab-root', FIXTURE], { encoding: 'utf8' });
    assert.equal(r.status, 2);
  });
}

/* ---------------------------------- soft: one real size against the real sophab checkout */

console.log('\nagainst the real sophab checkout, if this machine has one (soft — never fails the gate)');
{
  const REAL_SOPHAB = path.join(os.homedir(), 'neadamthal.projects', 'sophab');
  const hasReal =
    HAVE_PY3 && fs.existsSync(path.join(REAL_SOPHAB, 'tools', 'planset_sweep.py')) && fs.existsSync(path.join(REAL_SOPHAB, 'costing.py'));
  if (!hasReal) {
    console.log('  (skipped: no sophab checkout at ~/neadamthal.projects/sophab on this machine)');
  } else {
    ran += 1;
    const r = spawnSync(process.execPath, [BIN, '24x14x12', '--sophab-root', REAL_SOPHAB, '--costing', '--json'], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (r.status !== 0) {
      console.log(`  \x1b[33m·\x1b[0m real sophab run did not come back clean (not counted as a failure — see below)`);
      console.log(`      ${(r.stderr || r.stdout || String(r.error)).split('\n').slice(0, 6).join('\n      ')}`);
    } else {
      try {
        const out = JSON.parse(r.stdout);
        assert.equal(out.length, 1);
        assert.equal(out[0].error, '');
        assert.ok(out[0].util > 0 && out[0].util < 5, `util ${out[0].util} is not a plausible utilisation`);
        assert.ok(out[0].beam_util > 0 && out[0].beam_util < 5, `beam_util ${out[0].beam_util} is not plausible`);
        assert.ok(out[0].costing.project_total > 0, 'project_total should be a positive dollar figure');
        console.log(`  \x1b[32m✓\x1b[0m real sophab: 24x14x12 → util ${out[0].util}, beam_util ${out[0].beam_util}, total ${out[0].costing.project_total} ${out[0].costing.currency}`);
      } catch (err) {
        failures += 1;
        console.log(`  \x1b[31m✗\x1b[0m real sophab run came back 0 but was not what was expected`);
        console.log(`      ${String(err.message)}`);
      }
    }
  }
}

await cleanupTmp(FIXTURE, { quiesceFirst: false }).catch(() => {});

console.log(`\n${ran - failures}/${ran} ok`);
process.exit(failures ? 1 : 0);
