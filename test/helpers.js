import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const quiet = { info() {}, warn() {}, error() {} };

export async function makeDirs() {
  const root = await mkdtemp(join(tmpdir(), 'aw-test-'));
  return { root, configDir: join(root, 'config'), dataDir: join(root, 'data'), claudeCwd: root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function startApp(dirs, overrides = {}) {
  const cfg = loadConfig({
    host: '127.0.0.1', port: 0, configDir: dirs.configDir, dataDir: dirs.dataDir, claudeCwd: dirs.claudeCwd,
    claudeBin: process.execPath, claudePrefixArgs: [FAKE], stopGraceMs: 300, browserEnabled: false, ...overrides,
  });
  const app = await createApp(cfg, quiet);
  const { port } = await app.listen();
  const password = (await readFile(app.secretPath, 'utf8')).trim();
  return { app, port, password, origin: `http://127.0.0.1:${port}` };
}

export function request(port, method, path, { body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    if (data !== null) h['Content-Type'] = 'application/json';
    if (method !== 'GET' && !('Origin' in headers)) h.Origin = `http://127.0.0.1:${port}`;
    if (cookie) h.Cookie = cookie;
    for (const [k, v] of Object.entries(h)) if (v === null) delete h[k];
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

export async function login(port, password) {
  const res = await request(port, 'POST', '/api/login', { body: { password } });
  if (res.status !== 200) throw new Error(`login failed ${res.status}`);
  return res.headers['set-cookie'][0].split(';')[0];
}

/** Reads SSE events until `end`/`gone`, or until onEvent returns 'close'. */
export function readEvents(port, path, cookie, onEvent = () => {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const events = [];
    let gone = false;
    const req = http.get({ host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}`, Cookie: cookie } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', async (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith('event: gone')) { gone = true; continue; }
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6));
          events.push(ev);
          if ((await onEvent(ev, events)) === 'close') { req.destroy(); resolve({ events, gone }); return; }
        }
      });
      res.on('end', () => resolve({ events, gone }));
    });
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
    setTimeout(() => { req.destroy(); reject(new Error('SSE timeout')); }, timeoutMs).unref();
  });
}

export const textOf = (events) => events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
export const finalStatus = (events) => events.filter((e) => e.type === 'status').pop()?.status;

export function rawPost(port, path, buf, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Content-Length': buf.length, ...headers };
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: h }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end(buf);
  });
}
