#!/usr/bin/env node
/**
 * Throwaway spike (bc-g1l): stand up the thing Claude Code calls an "IDE" and see
 * what the channel can actually carry.
 *
 * Claude Code's native WebSocket is not a way *in* to a session — it is the editor
 * integration, and the direction of the arrow is the whole question. The editor hosts
 * an MCP server over WS and advertises it by dropping a lock file in ~/.claude/ide/;
 * the CLI discovers the lock, connects out as an MCP *client*, and from then on calls
 * tools on the editor. This script is that editor: a WS server, a lock file, and a log
 * of every single frame in both directions.
 *
 * It exists to answer three things, and it answers them by observation rather than by
 * reading a minified bundle:
 *
 *   1. can something that is not an IDE be discovered and connected to at all;
 *   2. can a session that is *already running* attach after the fact, via /ide;
 *   3. can this channel deliver a prompt into that session, or only context.
 *
 * Question 3 is the one that decides the feature, so the outbox exists: write a line of
 * JSON to it and the probe sends it to the connected CLI verbatim. That makes "what
 * happens if the editor sends X" a thing you try in a second, not a thing you rebuild
 * the server for.
 *
 * usage: node scripts/ide-ws-probe.mjs [--dir <workspace>] [--name <ideName>]
 *   --log <file>      frame log (default <tmp>/ide-probe.log)
 *   --outbox <file>   JSON-per-line file; new lines are sent to the CLI (default <tmp>/ide-probe-outbox.jsonl)
 *   --port <n>        fixed port, otherwise ephemeral
 *
 * Nothing here is wired into the daemon and nothing imports it. The answer turned out to
 * be "context only" — so this file is the evidence, not a foundation. What it found, in
 * full, is in docs/ide-websocket-spike.md.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const TMP = process.env.TMPDIR || '/tmp';
const WORKSPACE = path.resolve(arg('dir', process.cwd()));
const IDE_NAME = arg('name', 'beadcause');
const LOG = arg('log', path.join(TMP, 'ide-probe.log'));
const OUTBOX = arg('outbox', path.join(TMP, 'ide-probe-outbox.jsonl'));
const FIXED_PORT = Number(arg('port', 0)) || 0;

const LOCK_DIR = path.join(os.homedir(), '.claude', 'ide');
const AUTH_TOKEN = crypto.randomUUID();

fs.mkdirSync(LOCK_DIR, { recursive: true });
fs.writeFileSync(LOG, '');
fs.writeFileSync(OUTBOX, '');

const log = (...parts) => {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
  fs.appendFileSync(LOG, line + '\n');
  process.stdout.write(line + '\n');
};

/**
 * The tools a real editor advertises, near enough.
 *
 * They are stubs on purpose: what matters is whether the CLI accepts the handshake and
 * what it does next, not whether opening a diff works. Every call is logged and answered
 * with something harmless, so a CLI that probes the editor on connect gets an answer
 * instead of a hang, and we still see exactly what it asked for.
 */
const TOOLS = [
  { name: 'getDiagnostics', description: 'Get language diagnostics', inputSchema: { type: 'object', properties: { uri: { type: 'string' } } } },
  { name: 'getCurrentSelection', description: 'Get the active editor selection', inputSchema: { type: 'object', properties: {} } },
  { name: 'getLatestSelection', description: 'Get the most recent selection', inputSchema: { type: 'object', properties: {} } },
  { name: 'getOpenEditors', description: 'List open editors', inputSchema: { type: 'object', properties: {} } },
  { name: 'getWorkspaceFolders', description: 'List workspace folders', inputSchema: { type: 'object', properties: {} } },
  { name: 'openFile', description: 'Open a file', inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } } },
  { name: 'openDiff', description: 'Show a diff', inputSchema: { type: 'object', properties: { old_file_path: { type: 'string' }, new_file_path: { type: 'string' }, new_file_contents: { type: 'string' }, tab_name: { type: 'string' } } } },
  { name: 'closeAllDiffTabs', description: 'Close all diff tabs', inputSchema: { type: 'object', properties: {} } },
  { name: 'close_tab', description: 'Close a tab', inputSchema: { type: 'object', properties: { tab_name: { type: 'string' } } } },
  { name: 'checkDocumentDirty', description: 'Is the document dirty', inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } } },
  { name: 'saveDocument', description: 'Save a document', inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } } },
  { name: 'executeCode', description: 'Run code in the editor', inputSchema: { type: 'object', properties: { code: { type: 'string' } } } },
];

const text = (s) => ({ content: [{ type: 'text', text: s }] });

/** Stub results, keyed by tool name. Unknown tools get an empty text result rather than an error. */
function callTool(name, params) {
  switch (name) {
    case 'getWorkspaceFolders':
      return text(JSON.stringify({ folders: [{ name: path.basename(WORKSPACE), uri: `file://${WORKSPACE}`, path: WORKSPACE }], rootPath: WORKSPACE }));
    case 'getOpenEditors':
      return text(JSON.stringify({ tabs: [] }));
    case 'getCurrentSelection':
    case 'getLatestSelection':
      return text(JSON.stringify({ success: false, message: 'no selection' }));
    case 'getDiagnostics':
      return text(JSON.stringify([]));
    case 'checkDocumentDirty':
      return text(JSON.stringify({ success: false, message: 'not open' }));
    default:
      return text(JSON.stringify({ ok: true, tool: name, params }));
  }
}

const wss = new WebSocketServer({ host: '127.0.0.1', port: FIXED_PORT });

wss.on('listening', () => {
  const { port } = wss.address();
  const lockPath = path.join(LOCK_DIR, `${port}.lock`);

  /**
   * The advertisement. Keyed by port, not by pid — the CLI reads the filename as the
   * port to dial, which is why a stale lock from a dead editor is worse than none.
   *
   * `authToken` is the interesting field: it is what the CLI is expected to hand back
   * on the upgrade, and whether it *insists* on doing so is one of the things the
   * header log below settles.
   */
  const lock = {
    pid: process.pid,
    workspaceFolders: [WORKSPACE],
    ideName: IDE_NAME,
    transport: 'ws',
    runningInWindows: false,
    authToken: AUTH_TOKEN,
  };
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));

  log('listening', { port, lockPath, authToken: AUTH_TOKEN, workspace: WORKSPACE });
  log('env-for-autoconnect', `CLAUDE_CODE_SSE_PORT=${port} ENABLE_IDE_INTEGRATION=true`);

  const cleanup = () => {
    try { fs.unlinkSync(lockPath); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
});

/** Every socket that has completed the upgrade. The outbox broadcasts to all of them. */
const clients = new Set();

wss.on('headers', (headers, req) => {
  log('upgrade-headers', req.headers);
});

wss.on('connection', (ws, req) => {
  clients.add(ws);
  log('connection', { url: req.url, remote: req.socket.remoteAddress, headers: req.headers });

  ws.on('message', (data) => {
    const raw = data.toString();
    log('<-- from CLI', raw);
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (Array.isArray(msg)) return;
    if (msg.method === undefined) return; // a response to something we sent

    const reply = (result) => {
      if (msg.id === undefined) return;
      const out = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      log('--> to CLI', out);
      ws.send(out);
    };

    switch (msg.method) {
      case 'initialize':
        reply({
          protocolVersion: msg.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: true }, resources: {}, prompts: {}, logging: {} },
          serverInfo: { name: IDE_NAME, version: '0.1.0' },
        });
        break;
      case 'tools/list':
        reply({ tools: TOOLS });
        break;
      case 'resources/list':
        reply({ resources: [] });
        break;
      case 'prompts/list':
        reply({ prompts: [] });
        break;
      case 'tools/call':
        reply(callTool(msg.params?.name, msg.params?.arguments));
        break;
      default:
        if (msg.id !== undefined) reply({});
        break;
    }
  });

  ws.on('close', (code, reason) => {
    clients.delete(ws);
    log('close', { code, reason: reason.toString() });
  });
  ws.on('error', (err) => log('socket error', err.message));
});

/**
 * The outbox: one JSON object per line, sent to every connected CLI as-is.
 *
 * Polled rather than watched because fs.watch on macOS coalesces appends and misses
 * them; 200ms is instant enough for a person trying one frame at a time.
 */
let sent = 0;
setInterval(() => {
  let lines;
  try { lines = fs.readFileSync(OUTBOX, 'utf8').split('\n').filter((l) => l.trim()); } catch { return; }
  while (sent < lines.length) {
    const line = lines[sent++];
    if (!clients.size) { log('outbox (no client, dropped)', line); continue; }
    log('--> outbox', line);
    for (const ws of clients) ws.send(line);
  }
}, 200);
