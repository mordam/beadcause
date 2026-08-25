/*
  ＋ Add a bead-space — the dialog behind the last row of the picker.

  ## Why it is here and not on the admin screen

  Retiring a tracker lives on /admin, because that page is about what this Mac is doing
  rather than about beads, and a repo you have finished with is a machine fact. Adding one
  is not the same act. It is the thing you do at the *start* of a project, from wherever
  you happen to be, and the place you go to change which repo you are looking at is the
  picker — so the way to add a repo to look at is the last row of it. The two halves are
  deliberately in different places for that reason and not by accident.

  ## The three words

  A **group** is "Personal" or "Climative" — a name, a list, and quiet hours. A
  **bead-space** is one tracker: one .beads, one Dolt database, one id prefix. A
  **bead-repo** is a checkout attached to a bead-space, which is how forty Climative
  services file into one `cl-` graph. The config file still says `space` and `workspace`
  for the first two (bc-35qub); every sentence a person reads says these.

  ## Two rounds, because the directory answers better than the person does

  Round one is what you know: a path on the Mac, or a URL to clone. Round two exists only
  when there is no `.beads` in what you pointed at, and it asks the one question that
  cannot be looked up — a graph of its own, or beads filed into one that already exists.
  Most adds never see it.

  Round two always sends the **path**, never the URL again: the clone has happened by
  then, and re-sending the URL would make the server decide whether the directory it finds
  is the one it just made or somebody else's checkout of the same name.

  ## What it does not do

  It does not put the new bead-space in a group. Nothing on a phone does — moving a repo
  between groups changes which questions may reach you, which is why `POST /api/space`
  refuses `name` and `workspaces` — so a new tracker arrives under **Other**, on the
  picker, where the group it should join is a config decision you make once and rarely.

  It does not tidy up after a cancel. If a clone has happened, the directory stays and the
  message says where it is: something was fetched onto a disk, and deleting a tree because
  a dialog was dismissed is not a thing this app does.
*/
(() => {
  'use strict';

  const token = (() => {
    try {
      return new URLSearchParams(location.search).get('t') || localStorage.getItem('beadcause.token') || '';
    } catch {
      return '';
    }
  })();

  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const api = (body) =>
    fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-beadcause-token': token },
      body: JSON.stringify(body),
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `the Mac answered ${res.status}`);
      return data;
    });

  let dlg = null;
  let body = null;
  /* Where a clone would land, and where a tracker would be made — both are config on the
     Mac, so the fields cannot be prefilled until /api/workspaces has answered once. */
  let roots = { cloneRoot: '', trackerRoot: '' };

  function ensureDialog() {
    if (dlg) return;
    dlg = document.createElement('dialog');
    dlg.className = 'accountpick addspace';
    dlg.innerHTML = `<div class="accountpick-body" id="addspace-body"></div>`;
    document.body.append(dlg);
    body = dlg.querySelector('#addspace-body');
  }

  /** The last segment of a path or URL — what the bead-space would be called. */
  const nameOf = (value) => {
    const s = String(value || '').trim().replace(/\/+$/, '');
    if (!s) return '';
    return (s.split(/[/:]/).pop() || '').replace(/\.git$/i, '');
  };

  const setError = (text) => {
    const p = body.querySelector('#addspace-error');
    if (!p) return;
    p.textContent = text || '';
    p.hidden = !text;
  };

  const busy = (on, label) => {
    const b = body.querySelector('#addspace-go');
    if (!b) return;
    b.disabled = on;
    b.textContent = on ? label : b.dataset.label;
  };

  /* ------------------------------------------------------------------- round one */

  function paintSource() {
    body.innerHTML = `
      <h2 class="accountpick-title">Add a bead-space</h2>
      <p class="accountpick-lede">A bead-space is one tracker — one <code>.beads</code>, one id
        prefix. Point at a directory on the Mac, or at a repo to clone onto it.</p>
      <div class="addspace-kinds" role="radiogroup" aria-label="Where it comes from">
        <label class="addspace-kind"><input type="radio" name="addspace-kind" value="path" checked> A path on the Mac</label>
        <label class="addspace-kind"><input type="radio" name="addspace-kind" value="git"> A git URL</label>
      </div>
      <label class="accountform-field">
        <span id="addspace-vlabel">Path</span>
        <input type="text" id="addspace-value" autocapitalize="off" autocorrect="off" spellcheck="false"
               placeholder="~/neadamthal.projects/safeleaf">
      </label>
      <label class="accountform-field" id="addspace-clonefield" hidden>
        <span>Clone to</span>
        <input type="text" id="addspace-clone" autocapitalize="off" autocorrect="off" spellcheck="false">
      </label>
      <p class="addspace-note" id="addspace-note">The path is resolved on the Mac running beadcause,
        not on this device.</p>
      <div class="accountpick-actions">
        <button type="button" class="accountpick-add" id="addspace-go" data-label="Add">Add</button>
        <button type="button" class="accountpick-close" id="addspace-cancel">Cancel</button>
      </div>
      <p class="accountform-error" id="addspace-error" hidden></p>`;

    const value = body.querySelector('#addspace-value');
    const clone = body.querySelector('#addspace-clone');
    const cloneField = body.querySelector('#addspace-clonefield');
    const vlabel = body.querySelector('#addspace-vlabel');
    const note = body.querySelector('#addspace-note');
    const kind = () => body.querySelector('input[name="addspace-kind"]:checked').value;

    /* The clone directory follows the URL until somebody edits it, and then it stops —
       an edited field that a keystroke in another field overwrites is the field you
       cannot use. */
    let cloneTouched = false;
    clone.addEventListener('input', () => {
      cloneTouched = true;
    });
    const refill = () => {
      if (kind() !== 'git' || cloneTouched) return;
      const n = nameOf(value.value);
      clone.value = n && roots.cloneRoot ? `${roots.cloneRoot}/${n}` : '';
    };
    value.addEventListener('input', refill);

    for (const r of body.querySelectorAll('input[name="addspace-kind"]')) {
      r.addEventListener('change', () => {
        const git = kind() === 'git';
        cloneField.hidden = !git;
        vlabel.textContent = git ? 'URL' : 'Path';
        value.placeholder = git ? 'https://github.com/you/safeleaf' : '~/neadamthal.projects/safeleaf';
        note.textContent = git
          ? 'The clone happens on the Mac, with whatever git credentials it has.'
          : 'The path is resolved on the Mac running beadcause, not on this device.';
        refill();
        value.focus();
      });
    }

    body.querySelector('#addspace-cancel').addEventListener('click', () => dlg.close());
    body.querySelector('#addspace-go').addEventListener('click', async () => {
      setError('');
      const source = kind();
      if (!value.value.trim()) return setError(source === 'git' ? 'No URL yet.' : 'No path yet.');
      busy(true, source === 'git' ? 'Cloning…' : 'Looking…');
      try {
        const data = await api({
          action: 'add',
          source,
          value: value.value.trim(),
          ...(source === 'git' && clone.value.trim() ? { cloneTo: clone.value.trim() } : {}),
        });
        if (data.needs === 'tracker') return paintTracker(data);
        done(data);
      } catch (err) {
        setError(err.message);
      } finally {
        busy(false);
      }
    });
    value.focus();
  }

  /* ------------------------------------------------------------------- round two */

  /**
   * No `.beads` in it. Two answers, and one of them is withheld when the clone carries
   * beads history that has never been bootstrapped: making a second tracker there is the
   * one move that cannot be undone afterwards, because `bd bootstrap` will not clone over
   * a database that exists and the two histories then conflict on every sync.
   */
  function paintTracker(found) {
    const spaces = found.beadSpaces || [];
    const canInit = !found.carriesData;
    body.innerHTML = `
      <h2 class="accountpick-title">${esc(found.name)} has no tracker</h2>
      <p class="accountpick-lede">${
        found.cloned ? `Cloned to <code>${esc(found.dir)}</code>, and there is no ` : 'There is no '
      }<code>.beads</code> in it. Beads about this repo have to live somewhere.</p>
      ${
        found.carriesData
          ? `<p class="addspace-warn">It does carry beads history on <code>refs/dolt/data</code> — a
             tracker somebody else already made. Run <code>npm run onboard</code> on the Mac to
             bootstrap it; making a new one here could never be merged with it.</p>`
          : ''
      }
      <div class="addspace-kinds" role="radiogroup" aria-label="Where its beads live">
        ${
          canInit
            ? `<label class="addspace-kind"><input type="radio" name="addspace-tracker" value="new" checked>
                 A bead-space of its own</label>`
            : ''
        }
        <label class="addspace-kind"><input type="radio" name="addspace-tracker" value="attach" ${canInit ? '' : 'checked'}>
          File its beads in one I already have</label>
      </div>
      ${
        canInit
          ? `<label class="accountform-field" id="addspace-prefixfield">
              <span>Id prefix</span>
              <input type="text" id="addspace-prefix" maxlength="4" autocapitalize="off" autocorrect="off"
                     spellcheck="false" value="${esc(found.prefix || '')}">
            </label>
            <p class="addspace-note">Two to four letters — every bead in it is <code>${esc(
              found.prefix || 'xx'
            )}-1</code>, <code>${esc(found.prefix || 'xx')}-2</code>, and so on.</p>`
          : ''
      }
      <label class="accountform-field" id="addspace-hostfield" ${canInit ? 'hidden' : ''}>
        <span>Bead-space</span>
        <select id="addspace-host">${spaces.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}</select>
      </label>
      <p class="addspace-note" id="addspace-hostnote" ${canInit ? 'hidden' : ''}>It becomes a bead-repo of that
        bead-space. A bead says which repo it is about by the <code>serviceToken</code> the checkout
        declares, so it needs one before anything can name it.</p>
      <div class="accountpick-actions">
        <button type="button" class="accountpick-add" id="addspace-go" data-label="Add">Add</button>
        <button type="button" class="accountpick-close" id="addspace-cancel">Cancel</button>
      </div>
      <p class="accountform-error" id="addspace-error" hidden></p>`;

    const mode = () => body.querySelector('input[name="addspace-tracker"]:checked')?.value || 'attach';
    const sync = () => {
      const attaching = mode() === 'attach';
      const prefix = body.querySelector('#addspace-prefixfield');
      if (prefix) prefix.hidden = attaching;
      body.querySelector('#addspace-hostfield').hidden = !attaching;
      body.querySelector('#addspace-hostnote').hidden = !attaching;
    };
    for (const r of body.querySelectorAll('input[name="addspace-tracker"]')) r.addEventListener('change', sync);
    sync();

    body.querySelector('#addspace-cancel').addEventListener('click', () => dlg.close());
    body.querySelector('#addspace-go').addEventListener('click', async () => {
      setError('');
      const attaching = mode() === 'attach';
      if (attaching && !spaces.length) return setError('There is no other bead-space on this Mac to file them in.');
      busy(true, attaching ? 'Attaching…' : 'Making it…');
      try {
        // A path, always — the clone has already happened. See the header.
        const data = await api({
          action: 'add',
          source: 'path',
          value: found.dir,
          tracker: attaching
            ? { mode: 'attach', workspace: body.querySelector('#addspace-host').value }
            : { mode: 'new', prefix: body.querySelector('#addspace-prefix').value.trim().toLowerCase() },
        });
        done(data);
      } catch (err) {
        setError(err.message);
      } finally {
        busy(false);
      }
    });
  }

  /* --------------------------------------------------------------------- and after */

  /**
   * It landed. Repaint the picker from the server rather than from what we think we did:
   * the reply says what changed, and the bar is drawn from `/api/spaces`, which is the
   * one place that knows what the daemon is actually serving now.
   */
  function done(data) {
    const added = data.added || data.attached || {};
    const lines = [
      data.added
        ? `<strong>${esc(added.name)}</strong> is a bead-space now, under <em>Other</em> in the picker.`
        : `<strong>${esc(added.name)}</strong> is a bead-repo of <strong>${esc(added.workspace)}</strong> now.`,
      data.warning ? `<span class="addspace-warn">${esc(data.warning)}</span>` : '',
      data.unseen ? `<span class="addspace-warn">${esc(data.unseen)}</span>` : '',
      (data.changed || []).length
        ? `<span class="addspace-changed">${(data.changed || []).map((c) => esc(c)).join('<br>')}</span>`
        : '',
    ].filter(Boolean);
    body.innerHTML = `
      <h2 class="accountpick-title">Added</h2>
      <p class="accountpick-lede">${lines.join('</p><p class="accountpick-lede">')}</p>
      <div class="accountpick-actions">
        <button type="button" class="accountpick-close" id="addspace-done">Close</button>
      </div>`;
    body.querySelector('#addspace-done').addEventListener('click', () => dlg.close());
    window.beadcause?.space?.reload?.();
  }

  async function open() {
    ensureDialog();
    paintSource();
    if (!dlg.open) dlg.showModal();
    // After the paint, never before it: the dialog opens on the tap and the roots arrive a
    // moment later, which is the right way round on a phone. The URL field is empty at
    // this point anyway, so there is nothing to prefill until somebody types.
    try {
      const res = await fetch('/api/workspaces', { headers: { 'x-beadcause-token': token } });
      if (!res.ok) return;
      const data = await res.json();
      roots = { cloneRoot: data.cloneRoot || '', trackerRoot: data.trackerRoot || '' };
      if (data.observing) setError('This instance is only watching — it cannot add anything.');
    } catch {
      /* The Add press says so itself if the Mac cannot be reached. */
    }
  }

  window.beadcause = window.beadcause || {};
  window.beadcause.addSpace = { open };
})();
