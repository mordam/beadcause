/* Reader tab: renders a file from the Mac that a question told you to read. */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const filePath = params.get('p') || '';
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

  main();
})();
