import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readJson, writeJsonAtomic } from './fsutil.js';

// One real BrowserOS browser for the agent, started lazily on a private Xvfb display.
//
//  - The agent reaches BrowserOS's MCP server through this app (/internal/mcp/browseros,
//    per-run bearer token), so the browser can start on the first real tool call, the
//    conversation that is using it is known, and tool calls are held while the owner has
//    control.
//  - The owner sees and drives the same display through x11vnc on a Unix socket in a
//    private directory, bridged to an authenticated WebSocket. Keyboard/pointer input is
//    only forwarded while the owner has taken control.
//  - BrowserOS's own request_human_help / await_human_help tools are the hand-off
//    protocol; handing control back resolves that exact MCP session.
//
// BrowserOS binds its MCP proxy (9010/9011) on all interfaces with no option to change
// it, so starting is refused unless a firewall rule limits those ports to loopback.

const run = promisify(execFile);
const SERVER = 'http://127.0.0.1:9210';
const CDP = 'http://127.0.0.1:9110';
const PUBLIC_PORTS = [9010, 9011];
const FW_COMMENT = 'assistant-web-browseros';
const START_TIMEOUT_MS = 45000;
const IDLE_STOP_MS = 30 * 60 * 1000;
const VNC_LINGER_MS = 60 * 1000;
const HUMAN_TOOLS = new Set(['request_human_help', 'await_human_help']);

export const MODES = ['idle', 'agent', 'waiting', 'human'];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function httpOk(url, ms = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    await res.arrayBuffer();
    return res.ok;
  } catch {
    return false;
  }
}

export class BrowserManager extends EventEmitter {
  constructor({ cfg, log = console }) {
    super();
    this.cfg = cfg;
    this.log = log;
    this.dir = join(cfg.dataDir, 'browser');
    this.xauth = join(this.dir, 'Xauthority');
    this.vncSock = join(this.dir, 'vnc.sock');
    this.pidFile = join(this.dir, 'pids.json');
    this.display = `:${cfg.browserDisplay}`;
    this.state = 'off'; // off | starting | ready | stopping | error
    this.error = null;
    this.mode = 'idle';
    this.help = null; // { convId, sid, reason, kind, details, resumeHint, since }
    this.controller = null; // convId the owner took control for
    this.activity = null; // { convId, tool, at }
    this.pids = {};
    this.vnc = null;
    this.viewers = 0;
    this.tokens = new Map(); // sha256(token) -> { convId, runId }
    this.sessions = new Map(); // our MCP session id -> { upstream, convId, initParams }
    this.cache = null; // { initialize, tools } from the last upstream session
    this.lastUse = Date.now();
    this.starting = null;
  }

  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    this.cache = await readJson(join(this.dir, 'mcp-cache.json'), null);
    const saved = await readJson(this.pidFile, {});
    // A browser left running by the previous server process is adopted, never restarted:
    // the owner may be in the middle of a login.
    if (saved.browser && this.alive(saved.browser) && await httpOk(`${SERVER}/api/v1/system`)) {
      this.pids = saved;
      this.setState('ready');
      this.log.info(`浏览器沿用已运行的实例 pid=${saved.browser}`);
    }
    this.idleTimer = setInterval(() => this.idleCheck(), 60000);
    this.idleTimer.unref();
  }

  alive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  snapshot() {
    return {
      state: this.state, error: this.error, mode: this.mode, help: this.help, controller: this.controller,
      activity: this.activity, viewers: this.viewers,
    };
  }

  setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit('change', this.snapshot());
  }

  setMode(mode) {
    this.mode = mode;
    this.emit('change', this.snapshot());
    if (mode !== 'human') this.emit('released');
  }

  /* ---------- firewall ---------- */

  async ensureFirewall() {
    if (this.cfg.browserSkipFirewall) return;
    for (const [bin, src] of [['iptables', '127.0.0.1/32'], ['ip6tables', '::1/128']]) {
      for (const port of PUBLIC_PORTS) {
        const rule = ['INPUT', '!', '-s', src, '-p', 'tcp', '-m', 'tcp', '--dport', String(port), '-m', 'comment', '--comment', FW_COMMENT, '-j', 'REJECT'];
        try {
          await run('sudo', ['-n', bin, '-C', ...rule]);
        } catch {
          try {
            await run('sudo', ['-n', bin, '-I', ...rule]);
            this.log.info(`已添加防火墙规则：${bin} 仅允许本机访问 ${port}`);
          } catch (err) {
            throw new Error(`无法限制浏览器端口 ${port} 只对本机开放（${bin}）：${err.message.split('\n')[0]}`);
          }
        }
      }
    }
  }

  /** Kills any process of ours that listens on TCP; the display must only be reachable via the socket. */
  async assertNoTcp(pid) {
    try {
      const { stdout } = await run('ss', ['-ltnpH']);
      if (stdout.split('\n').some((l) => l.includes(`pid=${pid},`))) {
        process.kill(pid, 'SIGKILL');
        throw new Error('远程桌面进程意外打开了 TCP 端口，已终止');
      }
    } catch (err) {
      if (err.message.includes('TCP')) throw err;
    }
  }

  /* ---------- lifecycle ---------- */

  start() {
    if (this.state === 'ready') return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => { this.starting = null; });
    return this.starting;
  }

  async doStart() {
    this.setState('starting');
    try {
      await this.ensureFirewall();
      if (await httpOk(`${SERVER}/api/v1/system`)) throw new Error('另一个 BrowserOS 实例正在运行（端口 9210 已被占用），请先关闭它');
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await this.startXvfb();
      await this.startBrowser();
      const deadline = Date.now() + START_TIMEOUT_MS;
      while (!(await httpOk(`${SERVER}/api/v1/system`))) {
        if (!this.alive(this.pids.browser)) throw new Error('浏览器进程启动后退出了');
        if (Date.now() > deadline) throw new Error('浏览器启动超时');
        await sleep(500);
      }
      await writeJsonAtomic(this.pidFile, this.pids);
      this.lastUse = Date.now();
      this.setState('ready');
      this.log.info(`浏览器已启动 pid=${this.pids.browser}`);
    } catch (err) {
      this.log.error('浏览器启动失败', err.message);
      await this.killAll();
      this.setState('error', err.message);
      throw err;
    }
  }

  async startXvfb() {
    const n = this.cfg.browserDisplay;
    if (this.pids.xvfb && this.alive(this.pids.xvfb)) return;
    if (existsSync(`/tmp/.X${n}-lock`) && !(await this.reclaimDisplay(n))) throw new Error(`显示器 ${this.display} 已被占用`);
    const cookie = randomBytes(16).toString('hex');
    await rm(this.xauth, { force: true });
    await run('xauth', ['-f', this.xauth, 'add', this.display, '.', cookie]);
    const child = spawn('Xvfb', [this.display, '-screen', '0', `${this.cfg.browserWidth}x${this.cfg.browserHeight}x24`, '-nolisten', 'tcp', '-auth', this.xauth], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
    this.pids.xvfb = child.pid;
    for (let i = 0; i < 40 && !existsSync(`/tmp/.X11-unix/X${n}`); i += 1) await sleep(100);
    if (!existsSync(`/tmp/.X11-unix/X${n}`)) throw new Error('虚拟显示器没有启动');
  }

  /**
   * A display lock left behind by this app (an Xvfb using our Xauthority file, e.g. after the
   * server lost its pid file) or by a process that no longer exists is reclaimed; a display
   * used by anything else is left alone. Returns true when the display is free.
   */
  async reclaimDisplay(n) {
    const lock = `/tmp/.X${n}-lock`;
    const pid = Number((await readFile(lock, 'utf8').catch(() => '')).trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    let argv;
    try {
      argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
    } catch {
      this.log.warn(`清理失效的显示器锁 ${this.display}（进程 ${pid} 已不存在）`);
      await rm(lock, { force: true });
      await rm(`/tmp/.X11-unix/X${n}`, { force: true });
      return true;
    }
    if (!/(^|\/)Xvfb$/.test(argv[0]) || !argv.includes(this.xauth)) return false;
    this.log.warn(`回收本服务遗留的虚拟显示器 ${this.display} pid=${pid}`);
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    for (let i = 0; i < 50 && existsSync(lock); i += 1) await sleep(100);
    return !existsSync(lock);
  }

  async startBrowser() {
    const env = {
      HOME: process.env.HOME, USER: process.env.USER, PATH: process.env.PATH, LANG: 'zh_CN.UTF-8',
      DISPLAY: this.display, XAUTHORITY: this.xauth,
    };
    const child = spawn(this.cfg.browserBin, [
      '--no-first-run', '--no-default-browser-check', '--lang=zh-CN', '--window-position=0,0',
      `--window-size=${this.cfg.browserWidth},${this.cfg.browserHeight}`, '--start-maximized',
      `--user-data-dir=${this.cfg.browserProfile}`, 'about:blank',
    ], { detached: true, stdio: 'ignore', env });
    child.unref();
    this.pids.browser = child.pid;
  }

  async stop(reason = '') {
    if (this.state === 'off') return;
    this.setState('stopping');
    this.log.info(`正在关闭浏览器${reason ? `（${reason}）` : ''}`);
    await this.cancelHelp();
    this.stopVnc(true);
    await this.killAll();
    // Runs keep their MCP session with us; it reconnects upstream on the next call.
    for (const local of this.sessions.values()) local.upstream = null;
    this.activity = null;
    this.controller = null;
    this.setMode('idle');
    this.setState('off');
  }

  async killAll() {
    const { browser, xvfb } = this.pids;
    if (browser && this.alive(browser)) {
      try { process.kill(-browser, 'SIGTERM'); } catch { try { process.kill(browser, 'SIGTERM'); } catch { /* gone */ } }
      for (let i = 0; i < 50 && this.alive(browser); i += 1) await sleep(100);
      try { process.kill(-browser, 'SIGKILL'); } catch { /* gone */ }
    }
    // BrowserOS's helper server is a grandchild in the same process group; make sure it is gone.
    try { await run('pkill', ['-u', String(process.getuid()), '-f', 'browseros-claw-server']); } catch { /* none */ }
    if (xvfb && this.alive(xvfb)) {
      try { process.kill(xvfb, 'SIGTERM'); } catch { /* gone */ }
    }
    this.pids = {};
    await rm(this.pidFile, { force: true });
  }

  idleCheck() {
    if (this.state === 'ready' && this.viewers === 0 && !this.help && this.mode !== 'human'
      && this.tokens.size === 0 && Date.now() - this.lastUse > IDLE_STOP_MS) {
      this.stop('闲置 30 分钟').catch(() => {});
    }
  }

  /* ---------- runs, hand-off ---------- */

  /** A run gets a private MCP config file pointing at this app with its own bearer token. */
  async mcpConfigFor(runId, convId, extraServers = {}) {
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(createHash('sha256').update(token).digest('hex'), { convId, runId });
    const file = join(this.dir, `mcp-${runId}.json`);
    await writeFile(file, JSON.stringify({
      mcpServers: {
        'browseros-neo': {
          type: 'http', url: `http://127.0.0.1:${this.cfg.port}/internal/mcp/browseros`, headers: { Authorization: `Bearer ${token}` },
        },
        ...extraServers,
      },
    }), { mode: 0o600 });
    return file;
  }

  async runEnded(runId, convId) {
    for (const [hash, t] of this.tokens) if (t.runId === runId) this.tokens.delete(hash);
    await rm(join(this.dir, `mcp-${runId}.json`), { force: true });
    if (this.help?.convId === convId && ![...this.tokens.values()].some((t) => t.convId === convId)) {
      await this.cancelHelp();
    }
    if (this.activity?.convId === convId) this.activity = null;
    if (this.mode === 'agent' && !this.tokens.size) this.setMode('idle');
    else this.emit('change', this.snapshot());
  }

  async cancelHelp() {
    const h = this.help;
    if (!h) return;
    this.help = null;
    try {
      await fetch(`${SERVER}/api/v1/sessions/${encodeURIComponent(h.sid)}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000) });
    } catch { /* browser gone */ }
    if (this.mode === 'waiting') this.setMode(this.tokens.size ? 'agent' : 'idle');
    else this.emit('change', this.snapshot());
  }

  /** The owner takes the keyboard and mouse; agent browser calls wait until they hand back. */
  takeover(convId = null) {
    if (this.state !== 'ready') throw new Error('浏览器没有运行');
    this.controller = convId || this.help?.convId || this.activity?.convId || null;
    this.setMode('human');
    if (this.help?.url) this.activateTab(this.help.url).catch(() => {});
  }

  async handback() {
    if (this.mode !== 'human' && this.mode !== 'waiting') throw new Error('当前不在人工操作状态');
    const h = this.help;
    let resolved = false;
    if (h) {
      try {
        const res = await fetch(`${SERVER}/api/v1/sessions/${encodeURIComponent(h.sid)}/help/resolve`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000),
        });
        resolved = Boolean((await res.json()).resolved);
      } catch (err) {
        this.log.warn('交还控制时通知浏览器失败', err.message);
      }
      this.help = null;
    }
    this.controller = null;
    this.setMode(this.tokens.size ? 'agent' : 'idle');
    return { resolved, convId: h?.convId || null };
  }

  waitForRelease() {
    if (this.mode !== 'human') return Promise.resolve();
    return new Promise((resolve) => this.once('released', resolve));
  }

  /* ---------- MCP proxy ---------- */

  authorize(header) {
    const m = /^Bearer\s+(\S+)$/.exec(header || '');
    if (!m) return null;
    return this.tokens.get(createHash('sha256').update(m[1]).digest('hex')) || null;
  }

  upstreamInit(local) {
    if (local.upstream) return Promise.resolve(local.upstream);
    if (!local.initializing) local.initializing = this.doUpstreamInit(local).finally(() => { local.initializing = null; });
    return local.initializing;
  }

  async doUpstreamInit(local) {
    const res = await fetch(`${SERVER}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: `init-${randomUUID()}`, method: 'initialize', params: local.initParams }),
    });
    const sid = res.headers.get('mcp-session-id');
    const text = await res.text();
    if (!res.ok || !sid) throw new Error(`浏览器 MCP 初始化失败（${res.status}）`);
    const init = parseRpc(text);
    await fetch(`${SERVER}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }).then((r) => r.arrayBuffer());
    local.upstream = sid;
    if (init?.result) {
      this.cache = { ...(this.cache || {}), initialize: init.result };
      writeJsonAtomic(join(this.dir, 'mcp-cache.json'), this.cache).catch(() => {});
    }
    return sid;
  }

  /** Streamable-HTTP MCP endpoint used by Claude runs. */
  async handleMcp(req, res, body) {
    const who = this.authorize(req.headers.authorization);
    if (!who) return jsonRes(res, 401, { error: 'unauthorized' });
    const localId = req.headers['mcp-session-id'];
    if (req.method === 'GET') return jsonRes(res, 405, { error: 'no server stream' });
    if (req.method === 'DELETE') {
      const local = this.sessions.get(localId);
      this.sessions.delete(localId);
      if (local?.upstream) fetch(`${SERVER}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': local.upstream } }).catch(() => {});
      res.writeHead(202);
      return res.end();
    }
    let msg;
    try { msg = JSON.parse(body.toString('utf8')); } catch { return jsonRes(res, 400, { error: 'bad json' }); }
    if (Array.isArray(msg)) return jsonRes(res, 400, { error: 'batch not supported' });

    if (msg.method === 'initialize') {
      const id = randomUUID();
      const local = { upstream: null, convId: who.convId, initParams: msg.params };
      this.sessions.set(id, local);
      // Answer from cache so a reply that never touches the browser never starts it.
      if (this.state !== 'ready' && this.cache?.initialize) {
        return jsonRes(res, 200, { jsonrpc: '2.0', id: msg.id, result: this.cache.initialize }, { 'mcp-session-id': id });
      }
      await this.start();
      await this.upstreamInit(local);
      return jsonRes(res, 200, { jsonrpc: '2.0', id: msg.id, result: this.cache.initialize }, { 'mcp-session-id': id });
    }
    const local = this.sessions.get(localId);
    if (!local || local.convId !== who.convId) return jsonRes(res, 404, { error: 'unknown session' });
    if (msg.id === undefined) {
      // Notifications before the upstream session exists have nothing to reach yet.
      if (local.upstream) return this.forward(res, local, msg);
      res.writeHead(202);
      return res.end();
    }
    if (msg.method === 'tools/list' && !local.upstream && this.cache?.tools) {
      return jsonRes(res, 200, { jsonrpc: '2.0', id: msg.id, result: this.cache.tools });
    }
    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      const page = msg.params?.arguments?.page;
      if (page !== undefined && page !== null) local.lastPage = page;
      if (!HUMAN_TOOLS.has(name) && this.mode === 'human') await this.waitForRelease();
      if (this.state !== 'ready') await this.start();
      this.lastUse = Date.now();
      await this.upstreamInit(local);
      if (name === 'request_human_help') {
        const a = msg.params.arguments || {};
        await this.showAgentTab(local).catch((err) => this.log.warn('切换到助理的标签页失败', err.message));
        this.help = {
          convId: local.convId, sid: local.upstream, reason: String(a.reason || '需要你在浏览器中操作'),
          kind: String(a.kind || 'other'), details: a.details ? String(a.details) : '', resumeHint: a.resumeHint ? String(a.resumeHint) : '',
          since: new Date().toISOString(), url: local.helpUrl || null,
        };
        this.activity = { convId: local.convId, tool: name, at: Date.now() };
        if (this.mode !== 'human') this.setMode('waiting');
        else this.emit('change', this.snapshot());
      } else if (!HUMAN_TOOLS.has(name)) {
        this.activity = { convId: local.convId, tool: name, at: Date.now() };
        if (this.mode === 'idle') this.setMode('agent');
        else this.emit('change', this.snapshot());
      }
      return this.forward(res, local, msg, name === 'await_human_help' ? (text) => this.afterAwait(text, local) : null);
    }
    await this.start();
    await this.upstreamInit(local);
    return this.forward(res, local, msg, msg.method === 'tools/list' ? (text) => this.cacheTools(text) : null);
  }

  /**
   * Brings the page the agent asked for help on to the front, so the owner sees it (agent tabs
   * open in the background). BrowserOS page ids are not CDP target ids: look the page's URL up
   * in the agent's own tab list, then activate the newest CDP page target with that URL.
   */
  async showAgentTab(local) {
    const res = await fetch(`${SERVER}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': local.upstream },
      body: JSON.stringify({ jsonrpc: '2.0', id: `tabs-${randomUUID()}`, method: 'tools/call', params: { name: 'tabs', arguments: { action: 'list' } } }),
      signal: AbortSignal.timeout(5000),
    });
    const text = (parseRpc(await res.text())?.result?.content || []).map((c) => c.text || '').join('\n');
    const url = pageUrl(text, local.lastPage);
    if (!url) return;
    local.helpUrl = url;
    await this.activateTab(url);
  }

  /**
   * CDP's Target.activateTarget is ignored for BrowserOS agent tabs, but the browser's own
   * extension can switch tabs: run chrome.tabs.update in its service worker. Picks the newest
   * tab with that URL and expands its group.
   */
  async activateTab(url) {
    const targets = await (await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    const expr = `(async (url) => {
      if (!chrome.tabs) return false;
      const tabs = (await chrome.tabs.query({})).filter((t) => t.url === url || (t.url || '').startsWith(url));
      if (!tabs.length) return false;
      const tab = tabs.sort((a, b) => b.id - a.id)[0];
      if (tab.groupId > -1 && chrome.tabGroups) await chrome.tabGroups.update(tab.groupId, { collapsed: false }).catch(() => {});
      await chrome.tabs.update(tab.id, { active: true });
      return true;
    })(${JSON.stringify(url)})`;
    for (const t of targets.filter((x) => x.type === 'service_worker' && x.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:'))) {
      if (await cdpEvaluate(t.webSocketDebuggerUrl, expr).catch(() => false)) return true;
    }
    return false;
  }

  cacheTools(text) {
    const r = parseRpc(text);
    if (!r?.result?.tools) return;
    this.cache = { ...(this.cache || {}), tools: r.result };
    writeJsonAtomic(join(this.dir, 'mcp-cache.json'), this.cache).catch(() => {});
  }

  afterAwait(text, local) {
    if (/handed control back|resolved/i.test(text) && this.help?.sid === local.upstream) {
      this.help = null;
      if (this.mode === 'waiting') this.setMode('agent');
      else this.emit('change', this.snapshot());
    }
  }

  async forward(res, local, msg, inspect = null) {
    let up;
    try {
      up = await fetch(`${SERVER}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': local.upstream, 'mcp-protocol-version': '2025-06-18' },
        body: JSON.stringify(msg),
      });
    } catch (err) {
      return jsonRes(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `浏览器不可用：${err.message}` } });
    }
    const type = up.headers.get('content-type') || 'application/json';
    if (!inspect) {
      res.writeHead(up.status, { 'content-type': type, 'cache-control': 'no-store' });
      if (!up.body) return res.end();
      for await (const chunk of up.body) res.write(chunk);
      return res.end();
    }
    const text = await up.text();
    try { inspect(text); } catch { /* best effort */ }
    res.writeHead(up.status, { 'content-type': type, 'cache-control': 'no-store' });
    return res.end(text);
  }

  /* ---------- live view (VNC over WebSocket) ---------- */

  // x11vnc: TCP disabled (-rfbport 0, -rfbportv6 -1) and any listener pinned to loopback
  // (-listen localhost). `-localhost` cannot be used: it rejects Unix-socket clients.

  async ensureVnc() {
    clearTimeout(this.vncStopTimer);
    if (this.vnc && this.alive(this.vnc.pid)) return;
    if (this.state !== 'ready') throw new Error('浏览器没有运行');
    await rm(this.vncSock, { force: true });
    const child = spawn('x11vnc', [
      '-display', this.display, '-auth', this.xauth, '-unixsock', this.vncSock,
      '-rfbport', '0', '-rfbportv6', '-1', '-listen', 'localhost', '-shared', '-forever', '-nopw', '-quiet',
      '-nowf', '-noxdamage', '-nolookup', '-wait', '30', '-defer', '30', '-cursor', 'arrow',
    ], { stdio: 'ignore' });
    this.vnc = child;
    child.on('exit', () => { if (this.vnc === child) this.vnc = null; });
    for (let i = 0; i < 50 && !existsSync(this.vncSock); i += 1) await sleep(100);
    if (!existsSync(this.vncSock)) throw new Error('远程画面服务没有启动');
    await this.assertNoTcp(child.pid);
  }

  stopVnc(now = false) {
    clearTimeout(this.vncStopTimer);
    const kill = () => { this.vnc?.kill('SIGTERM'); this.vnc = null; };
    if (now) kill();
    else this.vncStopTimer = setTimeout(() => { if (this.viewers === 0) kill(); }, VNC_LINGER_MS);
  }

  async connectViewer() {
    await this.ensureVnc();
    const sock = net.connect(this.vncSock);
    await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
    this.viewers += 1;
    this.emit('change', this.snapshot());
    sock.once('close', () => {
      this.viewers = Math.max(0, this.viewers - 1);
      this.emit('change', this.snapshot());
      if (this.viewers === 0) this.stopVnc();
    });
    return sock;
  }

  canInput() {
    return this.mode === 'human';
  }
}

/** One Runtime.evaluate over a short-lived CDP WebSocket (loopback only). */
function cdpEvaluate(wsUrl, expression, ms = 4000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP timeout')); }, ms);
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP error')); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      resolve(m.result?.result?.value === true);
    };
  });
}

function jsonRes(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

/** URL of page `id` in BrowserOS's tab list text ("[3] https://… (title)"), else the agent's newest tab. */
export function pageUrl(listText, id) {
  const lines = String(listText).split('\n');
  const parse = (l) => /^\[(\d+)\]\s+(\S+)/.exec(l.trim());
  if (id !== undefined && id !== null) {
    for (const l of lines) {
      const m = parse(l);
      if (m && m[1] === String(id)) return m[2];
    }
  }
  let section = '';
  const own = [];
  for (const l of lines) {
    if (/^\S.*:$/.test(l.trim())) section = l.trim();
    const m = parse(l);
    if (m && /^Your tabs/i.test(section)) own.push(m);
  }
  return own.length ? own[own.length - 1][2] : null;
}

/** Last JSON-RPC message in a JSON or SSE response body. */
export function parseRpc(text) {
  const t = String(text || '').trim();
  if (t.startsWith('{')) { try { return JSON.parse(t); } catch { return null; } }
  const datas = t.split('\n').filter((l) => l.startsWith('data: {'));
  for (let i = datas.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(datas[i].slice(6)); } catch { /* keep looking */ }
  }
  return null;
}

/* ---------- RFB client-message filter ---------- */

/**
 * Splits the client->server RFB stream into messages and drops keyboard, pointer, clipboard
 * and resize messages unless input is allowed. Unknown message types end the session.
 * The first 14 bytes (version, security type, ClientInit with no-auth) pass through.
 */
export class RfbFilter {
  constructor(allowInput) {
    this.allowInput = allowInput;
    this.handshake = 14;
    this.buf = Buffer.alloc(0);
  }

  /** @returns {{ out: Buffer[], error?: string }} */
  push(chunk) {
    const out = [];
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.handshake > 0) {
      const n = Math.min(this.handshake, this.buf.length);
      out.push(this.buf.subarray(0, n));
      this.buf = this.buf.subarray(n);
      this.handshake -= n;
    }
    while (this.buf.length) {
      const len = messageLength(this.buf);
      if (len === -1) return { out, error: 'unknown RFB message' };
      if (len === 0 || this.buf.length < len) break;
      const msg = this.buf.subarray(0, len);
      this.buf = this.buf.subarray(len);
      if (!isInput(msg[0]) || this.allowInput()) out.push(msg);
    }
    if (this.buf.length > 1 << 20) return { out, error: 'message too large' };
    return { out };
  }
}

const isInput = (type) => type === 4 || type === 5 || type === 6 || type === 251 || type === 255;

/** Byte length of the client message at the start of buf, 0 if more bytes are needed, -1 if unknown. */
function messageLength(b) {
  const need = (n) => (b.length >= n ? null : 0);
  switch (b[0]) {
    case 0: return 20; // SetPixelFormat
    case 2: return need(4) ?? 4 + 4 * b.readUInt16BE(2); // SetEncodings
    case 3: return 10; // FramebufferUpdateRequest
    case 4: return 8; // KeyEvent
    case 5: return 6; // PointerEvent
    case 6: return need(8) ?? 8 + b.readUInt32BE(4); // ClientCutText
    case 150: return 10; // EnableContinuousUpdates
    case 248: return need(9) ?? 9 + b[8]; // ClientFence
    case 251: return need(8) ?? 8 + 16 * b[6]; // SetDesktopSize
    case 255: return need(2) ?? (b[1] === 0 ? 12 : -1); // QEMU extended key event
    default: return -1;
  }
}
