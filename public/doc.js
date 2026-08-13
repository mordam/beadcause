/* Reader tab: renders a file from the Mac that a question told you to read. */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const filePath = params.get('p') || '';
  // Which bead sent you here, when something did. Both are optional and the page works
  // exactly as it always did without them — they are what lets a publish say where it
  // ended up on the bead you opened the document from, rather than only in the
  // daemon's own state where nobody would ever look for it.
  const workspace = params.get('ws') || '';
  const bead = params.get('bead') || '';
  const token = localStorage.getItem('beadcause.token') || '';
  const out = document.getElementById('doc');
  const titleEl = document.getElementById('doc-title');

  const base = filePath.replace(/\/[^/]*$/, '');
  const name = filePath.split('/').pop() || 'document';
  const ext = (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
  titleEl.textContent = name;
  document.title = `${name} · Beadcause`;
  window.beadcause?.presence?.report({ view: 'doc', id: filePath, detail: name });

  // One rule for what closing a subordinate view means, and it lives in drawer.js —
  // see its header. Usually this is a tab opened via target=_blank and closing it
  // gives back the one underneath; from a pasted URL there is nothing underneath and
  // it is the inbox. In a drawer this button is hidden and drawer.js has the click.
  document.getElementById('doc-close').addEventListener('click', () => window.beadcause.closeView());

  const assetUrl = (p) => `/api/asset?p=${encodeURIComponent(p)}&t=${encodeURIComponent(token)}`;

  /** Resolve a link inside the document against the document's own directory. */
  function resolvePath(href) {
    if (/^([a-z]+:)?\/\//i.test(href) || href.startsWith('#') || href.startsWith('mailto:')) return null;
    if (href.startsWith('/')) return href;
    const parts = (base + '/' + href).split('/');
    const stack = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    return '/' + stack.join('/');
  }

  function fail(msg) {
    out.innerHTML = `<div class="empty"><strong>Can't open this file</strong>${msg}</div>`;
  }

  async function main() {
    if (!filePath) return fail('No path given.');
    if (!token) return fail('This device is not paired. Open the inbox first.');

    if (ext === 'pdf') {
      out.innerHTML = `<iframe class="pdf" src="${assetUrl(filePath)}" title="${name}"></iframe>`;
      return;
    }

    let res;
    try {
      res = await fetch(assetUrl(filePath), { headers: { 'x-beadcause-token': token } });
    } catch (err) {
      return fail(err.message);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return fail(body.error || `HTTP ${res.status}`);
    }
    const text = await res.text();

    if (ext === 'md' || ext === 'markdown') {
      const patched = text.replace(
        /!\[([^\]]*)\]\(\s*([^)\s]+)((?:\s+"[^"]*")?)\s*\)/g,
        (m, alt, href, title) => {
          const abs = resolvePath(href);
          return abs ? `![${alt}](${assetUrl(abs)}${title})` : m;
        }
      );
      out.innerHTML = window.DOMPurify.sanitize(window.marked.parse(patched, { gfm: true, breaks: false }), {
        ADD_ATTR: ['target', 'rel'],
      });
      // Sibling documents stay readable: point them back at this viewer.
      for (const a of out.querySelectorAll('a[href]')) {
        const abs = resolvePath(a.getAttribute('href'));
        if (abs) a.href = `/doc?p=${encodeURIComponent(abs)}`;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    } else {
      const pre = document.createElement('pre');
      pre.textContent = text;
      out.replaceChildren(pre);
    }
  }

  /* ----------------------------------------------------- publishing to Confluence */

  const bar = document.getElementById('doc-publish');
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /** "3h ago" — small enough not to be worth a shared module, exact enough to trust. */
  function ago(iso) {
    const then = Date.parse(iso || '');
    if (!Number.isFinite(then)) return '';
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  const api = (path, init = {}) =>
    fetch(path, { ...init, headers: { 'x-beadcause-token': token, ...(init.headers || {}) } });

  /**
   * The whole of publishing, drawn only when there is something to draw.
   *
   * Three states and they are deliberately not the same shape:
   *
   * - **No Confluence configured** — nothing at all. Not a disabled button, not an
   *   explanation: the best refusal is a button that was never there, and an install
   *   that never wanted this must not be told about it on every document it opens.
   * - **Configured and broken** — one muted line saying what is wrong. Something was
   *   meant to work, so silence would be the wrong answer here.
   * - **Configured and ready** — the target named in full (which space, which page
   *   title, and whether that page exists already, with a link to it) *above* a button
   *   that has to be pressed twice. The naming is not decoration: the second press
   *   sends the space and title back, and the daemon refuses if they have moved.
   */
  async function publishBar() {
    if (!filePath || !token) return;
    let plan;
    try {
      const res = await api(`/api/confluence?p=${encodeURIComponent(filePath)}&workspace=${encodeURIComponent(workspace)}`);
      if (!res.ok) return;
      plan = await res.json();
    } catch {
      // An older daemon has no such route, and a reader tab is not the place to say so.
      return;
    }
    if (!plan?.configured) return;
    if (!plan.publishable) {
      if (!plan.problem) return;
      bar.hidden = false;
      bar.innerHTML = `<div class="publish-note">Confluence is configured but off — ${esc(plan.problem)}</div>`;
      return;
    }
    draw(plan);
  }

  function draw(plan, note = '') {
    const where = plan.action === 'update' && plan.existing
      ? `replaces <a href="${esc(plan.existing.url)}" target="_blank" rel="noopener noreferrer">the page that is there</a>`
      : 'creates a new page';
    const last = plan.lastPublished?.at ? ` · last published ${esc(ago(plan.lastPublished.at))}` : '';
    bar.hidden = false;
    bar.innerHTML =
      `<div class="publish-target">Confluence · <strong>${esc(plan.spaceKey)}</strong> / <strong>${esc(plan.title)}</strong>` +
      `<span class="publish-what">${where}${last}</span></div>` +
      `<button id="publish-go" class="primary">Publish…</button>` +
      (note ? `<div class="publish-note">${note}</div>` : '');

    const go = document.getElementById('publish-go');
    let armed = false;
    go.addEventListener('click', async () => {
      if (!armed) {
        // Named once more, in the words of the act rather than of the plan, because
        // this is the press that cannot be taken back.
        armed = true;
        go.classList.add('armed');
        go.textContent = `${plan.action === 'update' ? 'Replace' : 'Create'} ${plan.spaceKey} / ${plan.title}`;
        return;
      }
      go.disabled = true;
      go.textContent = 'Publishing…';
      try {
        const res = await api('/api/confluence', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ p: filePath, workspace, bead, spaceKey: plan.spaceKey, title: plan.title }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          // Redrawn from a fresh plan rather than patched, because the commonest
          // failure here is a 409 saying the target has moved — and the one thing that
          // must not happen is the old target staying on screen under the error.
          return publishBar().then(() => {
            const err = document.createElement('div');
            err.className = 'publish-note publish-err';
            err.textContent = body.error || `HTTP ${res.status}`;
            bar.appendChild(err);
          });
        }
        bar.innerHTML =
          `<div class="publish-target">Published to <strong>${esc(body.spaceKey)}</strong> · ` +
          `<a href="${esc(body.url)}" target="_blank" rel="noopener noreferrer">${esc(body.title)}</a>` +
          `<span class="publish-what">${body.action === 'update' ? 'the page was replaced' : 'the page was created'}` +
          `${body.bead ? ` · said so on ${esc(body.bead)}` : ''}</span></div>`;
      } catch (err) {
        go.disabled = false;
        go.textContent = 'Publish…';
        armed = false;
        go.classList.remove('armed');
        const el = document.createElement('div');
        el.className = 'publish-note publish-err';
        el.textContent = err.message;
        bar.appendChild(el);
      }
    });
  }

  main().then(publishBar);
})();
