/**
 * Blank every comment in a JavaScript source, preserving length.
 *
 * Shared because three files now want it and the cost of not having it is a **wrong
 * answer** rather than noise: every file in this repo argues in prose that quotes the
 * identifiers around it, so a static read that does not blank comments finds its own
 * documentation and reports it as a call site. See the memory note
 * `grepping-this-repos-own-source-must-blank-comments` for the three times it has bitten
 * — most legibly public/editmode.js reporting two sites for a P0 card title, the second
 * of which was the paragraph explaining why class names make good grep keys.
 *
 * The original lives inside an IIFE in public/editmode.js and so cannot be imported; this
 * is the copy test/wizardnumbers.mjs made of it, lifted here rather than copied a third
 * time for test/wsshape.mjs. Keep the two in step by hand — there is no import that could
 * make a browser file and a test helper one file, and the browser one is the older.
 */

export function blankJs(src) {
  const out = src.split('');
  const stack = [];
  let mode = 'code';
  let prev = '';
  let i = 0;
  const wipe = (n) => {
    for (let k = 0; k < n; k++) if (out[i + k] !== '\n') out[i + k] = ' ';
  };
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') {
        mode = 'line';
        continue;
      }
      if (c === '/' && d === '*') {
        mode = 'block';
        continue;
      }
      if (c === '/' && /[(,=:[!&|?{};+\-*%~^<>]/.test(prev)) {
        mode = 'regex';
        i += 1;
        continue;
      }
      if (c === "'" || c === '"') {
        mode = c;
        i += 1;
        continue;
      }
      if (c === '`') {
        stack.push('tpl');
        mode = 'tpl';
        i += 1;
        continue;
      }
      // A `}` that closes a `${…}` hands the scanner back to the template around it.
      if (c === '}' && stack[stack.length - 1] === 'sub') {
        stack.pop();
        mode = 'tpl';
        i += 1;
        continue;
      }
      if (!/\s/.test(c)) prev = c;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        prev = '';
        i += 1;
        continue;
      }
      wipe(1);
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') {
        wipe(2);
        mode = 'code';
        i += 2;
        continue;
      }
      wipe(1);
      i += 1;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (mode === 'tpl') {
      if (c === '`') {
        stack.pop();
        mode = 'code';
        i += 1;
        continue;
      }
      if (c === '$' && d === '{') {
        stack.push('sub');
        mode = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === 'regex') {
      if (c === '/' || c === '\n') mode = 'code';
      i += 1;
      continue;
    }
    // A single- or double-quoted string, named by the quote that opened it.
    if (c === mode) {
      mode = 'code';
      prev = c;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * The complement of `blankJs`: keep every comment, blank everything else — code, strings,
 * template literals, regex bodies — to spaces, preserving length and line numbers exactly the
 * same way. Built for bc-fq5a.1's "question N" prose scan in test/wizardnumbers.mjs, whose
 * whole point is the opposite of every other static read in this repo: those blank comments
 * because a scan of *code* must not find its own documentation quoting that code; this one
 * wants only the comments, because the references it is checking (`// already handled in
 * question 3`) live nowhere else. Blanking comments here, as usual, would erase the very thing
 * being looked for — worth a function of its own, and this sentence, so nobody "fixes" the new
 * check by reaching for `blankJs` out of habit.
 *
 * Mirrors blankJs's state machine exactly, char for char, with `keep` in place of `wipe` and
 * the two swapped. Keep the two in step by hand, same as blankJs and its public/editmode.js
 * original.
 */
export function extractComments(src) {
  const out = src.split('').map((ch) => (ch === '\n' ? '\n' : ' '));
  const stack = [];
  let mode = 'code';
  let prev = '';
  let i = 0;
  const keep = (n) => {
    for (let k = 0; k < n; k++) out[i + k] = src[i + k];
  };
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') {
        mode = 'line';
        continue;
      }
      if (c === '/' && d === '*') {
        mode = 'block';
        continue;
      }
      if (c === '/' && /[(,=:[!&|?{};+\-*%~^<>]/.test(prev)) {
        mode = 'regex';
        i += 1;
        continue;
      }
      if (c === "'" || c === '"') {
        mode = c;
        i += 1;
        continue;
      }
      if (c === '`') {
        stack.push('tpl');
        mode = 'tpl';
        i += 1;
        continue;
      }
      if (c === '}' && stack[stack.length - 1] === 'sub') {
        stack.pop();
        mode = 'tpl';
        i += 1;
        continue;
      }
      if (!/\s/.test(c)) prev = c;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        prev = '';
        i += 1;
        continue;
      }
      keep(1);
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') {
        keep(2);
        mode = 'code';
        i += 2;
        continue;
      }
      keep(1);
      i += 1;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (mode === 'tpl') {
      if (c === '`') {
        stack.pop();
        mode = 'code';
        i += 1;
        continue;
      }
      if (c === '$' && d === '{') {
        stack.push('sub');
        mode = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === 'regex') {
      if (c === '/' || c === '\n') mode = 'code';
      i += 1;
      continue;
    }
    // A single- or double-quoted string, named by the quote that opened it.
    if (c === mode) {
      mode = 'code';
      prev = c;
    }
    i += 1;
  }
  return out.join('');
}
