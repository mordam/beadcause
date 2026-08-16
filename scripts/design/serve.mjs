// Look at the bundle in a real browser: node scripts/design/serve.mjs [port]
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = 'design-bundle';
const PORT = Number(process.argv[2]) || 4577;

const walk = (dir, base = '') => readdirSync(dir).flatMap((e) => {
  const p = join(dir, e);
  return statSync(p).isDirectory() ? walk(p, `${base}${e}/`) : [`${base}${e}`];
});

createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/' || path === '/index.html') {
    const links = walk(ROOT).sort().map(f => `<li><a href="/${f}">${f}</a></li>`).join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<meta name="color-scheme" content="dark light"><style>body{font:15px/1.7 system-ui;padding:24px}</style><h1>design-bundle</h1><ul>${links}</ul>`);
  }
  try {
    const body = readFileSync(join(ROOT, path.replace(/^\/+/, '')));
    const type = extname(path) === '.json' ? 'application/json' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not in the bundle');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`design-bundle on http://127.0.0.1:${PORT}/`));
