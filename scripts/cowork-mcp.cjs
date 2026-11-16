#!/usr/bin/env node
/**
 * cowork-mcp — call the OMC MCP server ("t") from a shell.
 *
 * Why: claude.ai / Cowork cloud sessions start with
 * CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS=1, so the plugin's stdio MCP server is
 * never attached and its tools (state_*, notepad_*, lsp_*, ast_grep_*, wiki_*,
 * python_repl, ...) do not exist as native tools. This script reaches the same
 * server over a local socket instead.
 *
 * A small daemon keeps ONE server process alive per working directory, so
 * in-memory state (python_repl namespaces, warm LSP servers) survives between
 * calls. It exits by itself after 30 idle minutes.
 *
 *   node cowork-mcp.cjs list                 # tool names + one-line summaries
 *   node cowork-mcp.cjs schema <tool>        # JSON input schema of one tool
 *   node cowork-mcp.cjs call <tool> [json]   # json args, or "-" to read stdin
 *   node cowork-mcp.cjs status | stop
 */
'use strict';
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'bridge', 'mcp-server.cjs');
const IDLE_MS = Number(process.env.OMC_COWORK_MCP_IDLE_MS) || 30 * 60 * 1000;
const CALL_TIMEOUT_MS = Number(process.env.OMC_COWORK_MCP_TIMEOUT_MS) || 10 * 60 * 1000;

function socketPath(cwd) {
  const key = crypto.createHash('sha256').update(ROOT + '\0' + cwd).digest('hex').slice(0, 12);
  const dir = path.join(os.tmpdir(), `omc-cowork-mcp-${process.getuid ? process.getuid() : 'u'}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${key}.sock`);
}

// ---------------------------------------------------------------- daemon ---
function runDaemon(sock) {
  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let nextId = 1;
  const pending = new Map();
  let idle;
  const quit = (code) => {
    try { fs.unlinkSync(sock); } catch {}
    try { srv.kill(); } catch {}
    process.exit(code);
  };
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => quit(0), IDLE_MS); };
  const rpc = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  readline.createInterface({ input: srv.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  });
  srv.on('exit', () => quit(1));
  srv.stdin.on('error', () => quit(1));
  process.on('SIGTERM', () => quit(0));
  process.on('SIGINT', () => quit(0));

  (async () => {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'omc-cowork-mcp', version: '1' },
    });
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    try { fs.unlinkSync(sock); } catch {}
    net.createServer({ allowHalfOpen: true }, (conn) => {
      let buf = '';
      conn.on('error', () => {}); // client went away (e.g. piped into `head`)
      conn.on('data', (d) => { buf += d; });
      conn.on('end', async () => {
        touch();
        let reply;
        try {
          const req = JSON.parse(buf);
          if (req.method === 'stop') { conn.end('{"ok":true}'); return quit(0); }
          if (req.method === 'status') reply = { ok: true, pid: process.pid, serverPid: srv.pid, cwd: process.cwd() };
          else reply = await rpc(req.method, req.params);
        } catch (e) {
          reply = { error: { message: String(e && e.message || e) } };
        }
        conn.end(JSON.stringify(reply));
        touch();
      });
    }).listen(sock, touch);
  })();
}

// ---------------------------------------------------------------- client ---
function request(sock, payload) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sock);
    let buf = '';
    const timer = setTimeout(() => { conn.destroy(); reject(new Error('timeout waiting for OMC MCP server')); }, CALL_TIMEOUT_MS);
    conn.on('error', (e) => { clearTimeout(timer); reject(e); });
    conn.on('data', (d) => { buf += d; });
    conn.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(buf)); } catch { reject(new Error('bad reply from daemon: ' + buf.slice(0, 200))); }
    });
    conn.end(JSON.stringify(payload));
  });
}

async function ensureDaemon(sock) {
  try { await request(sock, { method: 'status' }); return; } catch {}
  if (!fs.existsSync(SERVER)) throw new Error(`OMC MCP server not found at ${SERVER}`);
  try { fs.unlinkSync(sock); } catch {}
  spawn(process.execPath, [__filename, '--daemon', sock], {
    detached: true, stdio: 'ignore', env: process.env, cwd: process.cwd(),
  }).unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    try { await request(sock, { method: 'status' }); return; } catch {}
  }
  throw new Error('OMC MCP daemon did not start within 15s');
}

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.on('data', (d) => { s += d; }).on('end', () => resolve(s));
  });
}

const USAGE = `usage: cowork-mcp.cjs list | schema <tool> | call <tool> [json|-] | status | stop`;

async function main() {
  const [cmd, tool, rawArgs] = process.argv.slice(2);
  if (cmd === '--daemon') return runDaemon(tool);
  const sock = socketPath(process.cwd());

  if (cmd === 'stop' || cmd === 'status') {
    try { console.log(JSON.stringify(await request(sock, { method: cmd }))); }
    catch { console.log('{"ok":false,"running":false}'); }
    return;
  }
  if (!['list', 'schema', 'call'].includes(cmd) || (cmd !== 'list' && !tool)) {
    console.error(USAGE);
    process.exit(2);
  }
  await ensureDaemon(sock);

  if (cmd === 'list' || cmd === 'schema') {
    const res = await request(sock, { method: 'tools/list', params: {} });
    if (res.error) throw new Error(res.error.message);
    const tools = res.result.tools;
    if (cmd === 'list') {
      for (const t of tools) console.log(`${t.name}\t${String(t.description || '').split('\n')[0].slice(0, 110)}`);
      return;
    }
    const found = tools.find((t) => t.name === tool);
    if (!found) throw new Error(`unknown tool "${tool}" (run: list)`);
    console.log(JSON.stringify(found.inputSchema, null, 2));
    return;
  }

  let text = rawArgs === '-' ? await readStdin() : rawArgs;
  let args;
  try { args = text && text.trim() ? JSON.parse(text) : {}; }
  catch (e) { throw new Error(`arguments are not valid JSON: ${e.message}`); }
  const res = await request(sock, { method: 'tools/call', params: { name: tool, arguments: args } });
  if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
  const out = (res.result.content || []).map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
  console.log(out);
  if (res.result.isError) process.exitCode = 1;
}

main().catch((e) => { console.error(`cowork-mcp: ${e.message}`); process.exit(1); });
