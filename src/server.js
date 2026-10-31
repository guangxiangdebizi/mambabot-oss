import http from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import {
  LoginLimiter, SessionStore, checkHost, checkOrigin, ensureCredentials, readAuthRecord, verifyPassword,
} from './auth.js';
import { ConversationStore, ID_RE, pathTo, resumePlan } from './store.js';
import { PERMISSION_MODES, RunManager } from './runner.js';
import { ModelCatalog } from './models.js';
import { MAX_ATTACHMENTS, UploadStore } from './uploads.js';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { BrowserManager, RfbFilter } from './browser.js';
import { acceptUpgrade, bridge, rejectUpgrade } from './ws.js';
import { AccountService } from './account.js';
import { ContextProbe, sessionCost } from './context.js';
import { MEDIA_SERVER, MediaMcp } from './media.js';
import { TASK_SERVER, TaskMcp, TaskScheduler, describeCron, nextRun, parseCron } from './schedule.js';
import { ShareStore, TOKEN_RE } from './shares.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const COOKIE = 'aw_session';
const MAX_BODY = 64 * 1024;
const MAX_RUNS_CAP = 6;

/** Host memory from /proc/meminfo (MemAvailable counts reclaimable cache). */
async function memory() {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const kb = (k) => Number((text.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0);
    return { memTotalMb: Math.round(kb('MemTotal') / 1024), memAvailableMb: Math.round(kb('MemAvailable') / 1024) };
  } catch {
    return { memTotalMb: null, memAvailableMb: null };
  }
}
const MAX_MESSAGE = 20000;
// Sent to the CLI as-is: it runs its own /compact (optionally with summary instructions).
const COMPACT_RE = /^\/compact(?:\s|$)/;
const NOVNC_DIR = '/usr/share/novnc/';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

async function readBody(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, '请求格式必须是 JSON');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, '请求内容过大');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON 格式错误');
  }
}

const summary = (conv, runs) => ({
  id: conv.id, title: conv.title, updatedAt: conv.updatedAt, running: runs.isRunning(conv.id),
  settings: conv.settings || { model: null, effort: null },
});

/** About 60 characters of message text around the first match of `q` (lowercase), or null. */
function messageExcerpt(conv, q) {
  for (const m of conv.messages) {
    for (const p of m.parts || []) {
      if ((p.type !== 'text' && p.type !== 'followup') || !p.text) continue;
      const text = p.text.replace(/\s+/g, ' ');
      const i = text.toLowerCase().indexOf(q);
      if (i < 0) continue;
      const start = Math.max(0, i - 20);
      return `${start ? '…' : ''}${text.slice(start, i + q.length + 40)}${i + q.length + 40 < text.length ? '…' : ''}`;
    }
  }
  return null;
}

function makeTitle(text) {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

export async function createApp(cfg = loadConfig(), log = console) {
  const secretPath = await ensureCredentials(cfg.configDir, log);
  const sessions = new SessionStore(join(cfg.dataDir, 'sessions.json'), cfg.sessionTtlMs);
  await sessions.load();
  const store = new ConversationStore(join(cfg.dataDir, 'conversations'));
  await store.load();
  const catalog = new ModelCatalog({ cfg, log });
  await catalog.load();
  const uploads = new UploadStore(cfg);
  await uploads.load();
  const prefsPath = join(cfg.dataDir, 'prefs.json');
  let prefs = { model: 'default', effort: null, permissionMode: 'auto', maxRuns: cfg.maxRuns, ...(await readJson(prefsPath, {})) };
  const maxRuns = () => prefs.maxRuns || cfg.maxRuns;
  const runs = new RunManager({ cfg, store, log, catalog });
  runs.handoffExtra = (await readFile(join(cfg.configDir, 'handoff.md'), 'utf8').catch(() => '')).trim();
  const browser = cfg.browserEnabled ? new BrowserManager({ cfg, log }) : null;
  await browser?.init();
  const account = new AccountService({ cfg, log, catalog });
  const contextProbe = new ContextProbe({ cfg });
  const scheduler = new TaskScheduler({ cfg, log });
  // A task without a model follows the owner's default, so effort is checked against that.
  scheduler.validateModel = (model, effort) => catalog.validate(model || prefs.model || 'default', effort);
  await scheduler.load();
  const taskMcp = new TaskMcp({
    scheduler,
    info: () => ({
      defaults: { model: prefs.model || 'default', effort: prefs.effort || null },
      models: catalog.models.map((m) => ({ value: m.value, name: m.displayName, efforts: m.efforts })),
    }),
  });
  const mediaMcp = new MediaMcp({ cfg, uploads, show: async (runId, file) => runs.addFile(runId, file) });
  const shares = new ShareStore(cfg.dataDir);
  await shares.load();
  const runMcpDir = join(cfg.dataDir, 'run-mcp');
  await mkdir(runMcpDir, { recursive: true, mode: 0o700 });
  runs.onRunEnd = async (run) => {
    taskMcp.runEnded(run.id);
    mediaMcp.runEnded(run.id);
    await rm(join(runMcpDir, `mcp-${run.id}.json`), { force: true });
    await browser?.runEnded(run.id, run.conv.id);
  };
  const app = {};
  const limiter = new LoginLimiter();

  const clientKey = (req) => {
    const remote = req.socket.remoteAddress || '';
    if (cfg.trustProxy && /^(127\.|::1$|::ffff:127\.)/.test(remote)) {
      const fwd = req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',').pop();
      if (fwd && fwd.trim()) return fwd.trim();
    }
    return remote;
  };

  const cookieFlags = `Path=/; HttpOnly; SameSite=Strict${cfg.cookieSecure ? '; Secure' : ''}`;

  let loginsInFlight = 0;

  async function login(req, res) {
    const key = clientKey(req);
    const gate = limiter.check(key);
    if (!gate.allowed) {
      return sendJson(res, 429, { error: '尝试次数过多，请稍后再试', retryAfterSec: gate.retryAfterSec }, { 'Retry-After': String(gate.retryAfterSec) });
    }
    // The limiter only learns of a failure after scrypt finishes, so cap concurrent KDF work
    // (32 MB each) before any is started.
    if (loginsInFlight >= cfg.maxLoginInFlight) {
      return sendJson(res, 429, { error: '登录请求过于频繁，请稍后再试', retryAfterSec: 1 }, { 'Retry-After': '1' });
    }
    loginsInFlight += 1;
    let ok;
    try {
      const body = await readBody(req);
      ok = await verifyPassword(String(body.password || ''), await readAuthRecord(cfg.configDir));
      if (!ok) {
        limiter.fail(key);
        await new Promise((r) => setTimeout(r, 300));
      }
    } finally {
      loginsInFlight -= 1;
    }
    if (!ok) return sendJson(res, 401, { error: '登录密钥不正确' });
    limiter.succeed(key);
    const token = await sessions.create();
    const maxAge = Math.floor(cfg.sessionTtlMs / 1000);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${token}; Max-Age=${maxAge}; ${cookieFlags}` });
  }

  function streamEvents(req, res, conv, url) {
    const runId = url.searchParams.get('run') || '';
    let after = Number(url.searchParams.get('after') ?? 0);
    const lastId = Number(req.headers['last-event-id']);
    if (Number.isFinite(lastId) && lastId > after) after = lastId;
    if (!Number.isFinite(after)) after = 0;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let sawEnd = false;
    const write = (ev) => {
      if (res.writableEnded) return;
      res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
      if (ev.type === 'end') {
        sawEnd = true;
        res.end();
      }
    };
    const sub = runs.subscribe(conv.id, runId, after, write);
    if (!sub || (!sub.live && !sawEnd)) {
      if (!res.writableEnded) res.end('event: gone\ndata: {}\n\n');
      return;
    }
    if (res.writableEnded) return;
    res.write(': ok\n\n');
    const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
    res.on('close', () => {
      clearInterval(ping);
      sub.unsubscribe();
    });
  }

  /** Model/effort for one reply: explicit request, else the chat's, else the owner's default. */
  function selection(body, conv) {
    const model = typeof body.model === 'string' && body.model ? body.model : (conv.settings?.model || prefs.model || 'default');
    let effort = typeof body.effort === 'string' && body.effort ? body.effort : (conv.settings?.effort || prefs.effort || '');
    let m;
    try {
      m = catalog.validate(model, null);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    if (effort && !m.efforts.includes(effort)) {
      if (typeof body.effort === 'string' && body.effort) throw new HttpError(400, `${m.displayName} 不支持这个推理强度`);
      effort = '';
    }
    return { model, effort };
  }

  async function startTurn(conv, { parentId, userMessage, content, sel, resume }) {
    const now = new Date().toISOString();
    const assistantMessage = {
      id: crypto.randomUUID(), role: 'assistant', parentId: userMessage.id, createdAt: now, status: 'running',
      requested: sel, parts: [],
    };
    conv.messages.push(assistantMessage);
    conv.leafId = assistantMessage.id;
    conv.settings = { model: sel.model, effort: sel.effort || null };
    store.touch(conv);
    const runId = crypto.randomUUID();
    const servers = { [TASK_SERVER]: taskMcp.serverFor(runId), [MEDIA_SERVER]: mediaMcp.serverFor(runId) };
    let mcpFile;
    if (browser) {
      mcpFile = await browser.mcpConfigFor(runId, conv.id, servers);
    } else {
      mcpFile = join(runMcpDir, `mcp-${runId}.json`);
      await writeFile(mcpFile, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
    }
    // Listing tasks and showing the owner a file are read-only for the owner, so pre-approved.
    const extraArgs = ['--mcp-config', mcpFile, '--allowedTools', `mcp__${TASK_SERVER}__list_scheduled_tasks,mcp__${MEDIA_SERVER}__show_file`];
    const run = runs.start(conv, assistantMessage, content, {
      model: sel.model, effort: sel.effort, resume, runId, extraArgs, permissionMode: prefs.permissionMode,
    });
    return { assistantMessage, run };
  }

  function preflight(conv) {
    if (runs.isRunning(conv.id)) throw new HttpError(409, '这个对话正在回复中');
    if (runs.activeCount >= maxRuns()) throw new HttpError(429, `同时进行的回复已达上限（${maxRuns()} 个，可在设置里调整），请稍后再试`);
  }

  function parentFor(conv, parentId) {
    if (parentId === null || parentId === undefined || parentId === '') return null;
    const p = conv.messages.find((m) => m.id === parentId);
    if (!p || p.role !== 'assistant') throw new HttpError(400, '无效的上级消息');
    if (p.status === 'running' || p.status === 'stopping') throw new HttpError(409, '上一条回复还没有结束');
    return p.id;
  }

  /** Text and uploaded files of a message the owner sends. */
  async function readInput(body) {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const ids = Array.isArray(body.attachments) ? body.attachments.filter((x) => typeof x === 'string') : [];
    if (!text && !ids.length) throw new HttpError(400, '消息不能为空');
    if (text.length > MAX_MESSAGE) throw new HttpError(400, `消息过长（最多 ${MAX_MESSAGE} 字）`);
    if (ids.length > MAX_ATTACHMENTS) throw new HttpError(400, `一次最多 ${MAX_ATTACHMENTS} 个附件`);
    const files = ids.map((id) => uploads.get(id));
    if (files.some((f) => !f)) throw new HttpError(400, '附件不存在，请重新上传');
    for (const f of files) if (!(await uploads.exists(f))) throw new HttpError(400, `附件 ${f.name} 已丢失，请重新上传`);
    return { text, files };
  }

  async function postMessage(req, res, conv) {
    const body = await readBody(req);
    const { text, files } = await readInput(body);
    preflight(conv);
    const parentId = parentFor(conv, body.parentId);
    const plan = resumePlan(conv, parentId);
    if (!plan.ok) throw new HttpError(409, plan.error);
    const sel = selection(body, conv);
    if (COMPACT_RE.test(text)) {
      if (!plan.resume) throw new HttpError(400, '这个对话还没有可压缩的上下文');
      if (files.length) throw new HttpError(400, '压缩上下文时不能附带文件');
    }

    const userMessage = {
      id: crypto.randomUUID(), role: 'user', parentId, createdAt: new Date().toISOString(), status: 'done',
      parts: [{ type: 'text', text }], attachments: files.map((f) => uploads.publicView(f)),
    };
    conv.messages.push(userMessage);
    if (!conv.title) conv.title = makeTitle(text || files[0].name);
    const content = await uploads.buildContent(text, files);
    const { assistantMessage, run } = await startTurn(conv, { parentId, userMessage, content, sel, resume: plan.resume });
    await store.saveNow(conv);
    return sendJson(res, 201, { userMessage, assistantMessage, leafId: conv.leafId, run: { id: run.id, seq: run.seq, messageId: assistantMessage.id } });
  }

  /** A message sent while a reply runs, added to that reply's turn as in the Claude Code terminal. */
  async function postFollowup(req, res, conv) {
    const NOT_RUNNING = '这条回复已经结束，请直接发送';
    if (!runs.isRunning(conv.id)) throw new HttpError(409, NOT_RUNNING);
    const { text, files } = await readInput(await readBody(req));
    if (COMPACT_RE.test(text)) throw new HttpError(400, '压缩上下文要等当前回复结束');
    const entry = {
      id: crypto.randomUUID(), text, attachments: files.map((f) => uploads.publicView(f)), createdAt: new Date().toISOString(),
    };
    const content = await uploads.buildContent(text, files);
    if (!runs.followup(conv.id, entry, content)) throw new HttpError(409, NOT_RUNNING);
    await store.saveNow(conv);
    return sendJson(res, 201, { followup: entry });
  }

  /** A new reply to an existing user message, as a sibling of the earlier replies. */
  async function regenerate(req, res, conv) {
    const body = await readBody(req);
    const userMessage = conv.messages.find((m) => m.id === body.userMessageId && m.role === 'user');
    if (!userMessage) throw new HttpError(400, '找不到要重新生成的消息');
    preflight(conv);
    const plan = resumePlan(conv, userMessage.parentId);
    if (!plan.ok) throw new HttpError(409, plan.error);
    const sel = selection(body, conv);
    const files = (userMessage.attachments || []).map((a) => uploads.get(a.id)).filter(Boolean);
    for (const f of files) if (!(await uploads.exists(f))) throw new HttpError(400, `附件 ${f.name} 已丢失，无法重新生成`);
    const text = userMessage.parts.map((x) => x.text || '').join('');
    const content = await uploads.buildContent(text, files);
    const { assistantMessage, run } = await startTurn(conv, { parentId: userMessage.parentId, userMessage, content, sel, resume: plan.resume });
    await store.saveNow(conv);
    return sendJson(res, 201, { assistantMessage, leafId: conv.leafId, run: { id: run.id, seq: run.seq, messageId: assistantMessage.id } });
  }

  /** /status: context window of the current branch (live from the CLI) and recorded spend. */
  async function conversationStatus(res, conv) {
    const path = pathTo(conv, conv.leafId);
    const total = (msgs) => {
      const t = { costUsd: 0, replies: 0, unrecorded: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      for (const m of msgs) {
        if (m.role !== 'assistant' || m.status === 'running' || m.status === 'stopping') continue;
        t.replies += 1;
        if (!m.usage || m.usage.costUsd === null) { t.unrecorded += 1; continue; }
        t.costUsd += m.usage.costUsd;
        for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) t[k] += m.usage[k] || 0;
      }
      t.costUsd = Math.round(t.costUsd * 1e6) / 1e6;
      return t;
    };
    const compacts = path.flatMap((m) => (m.role === 'assistant' ? m.parts.filter((p) => p.type === 'compact' && p.state === 'done').map((p) => ({ ...p, at: m.finishedAt })) : []));
    const leaf = path[path.length - 1];
    let sel;
    try {
      sel = selection({}, conv);
    } catch {
      sel = { model: conv.settings?.model || prefs.model || 'default', effort: '' };
    }
    const info = catalog.find(sel.model);
    let context = null;
    let contextError = null;
    const plan = resumePlan(conv, leaf?.id ?? null);
    if (!plan.ok) {
      contextError = plan.error;
    } else {
      try {
        context = await contextProbe.get({ resume: plan.resume, model: sel.model });
      } catch (err) {
        contextError = err.message;
      }
    }
    // Each Claude session (forks start their own) keeps its own running total, so the chat's
    // total over all branches is the sum over its sessions, including replies made before the
    // web page recorded per-reply cost.
    const sessionIds = [...new Set(conv.messages.filter((m) => m.role === 'assistant' && m.sessionId).map((m) => m.sessionId))];
    const costs = await Promise.all(sessionIds.map((id) => sessionCost(cfg, id)));
    const cli = sessionIds.length ? {
      costUsd: Math.round(costs.reduce((a, c) => a + (c?.costUsd || 0), 0) * 1e6) / 1e6,
      sessions: sessionIds.length, missing: costs.filter((c) => !c).length,
    } : null;
    return sendJson(res, 200, {
      model: { value: sel.model, effort: sel.effort || null, displayName: info?.displayName || sel.model, resolvedModel: info?.resolvedModel || null },
      running: runs.isRunning(conv.id),
      hasSession: Boolean(plan.ok && plan.resume),
      context, contextError,
      spend: { branch: total(path), all: total(conv.messages), cli },
      compactions: compacts.length,
      lastCompact: compacts.length ? compacts[compacts.length - 1] : null,
      fetchedAt: new Date().toISOString(),
    });
  }

  async function patchConversation(req, res, conv) {
    const body = await readBody(req);
    if (typeof body.title === 'string') {
      const title = body.title.replace(/\s+/g, ' ').trim();
      if (!title || title.length > 80) throw new HttpError(400, '标题需要 1–80 个字');
      conv.title = title;
    }
    if (body.settings && typeof body.settings === 'object') {
      const model = String(body.settings.model || '');
      const effort = body.settings.effort ? String(body.settings.effort) : null;
      let m;
      try { m = catalog.validate(model, effort); } catch (err) { throw new HttpError(400, err.message); }
      conv.settings = { model: m.value, effort };
    }
    if (typeof body.leafId === 'string') {
      if (runs.isRunning(conv.id)) throw new HttpError(409, '回复进行中，暂时不能切换分支');
      if (!conv.messages.some((m) => m.id === body.leafId)) throw new HttpError(400, '分支不存在');
      conv.leafId = body.leafId;
    }
    store.touch(conv);
    await store.saveNow(conv);
    return sendJson(res, 200, { conversation: summary(conv, runs), leafId: conv.leafId });
  }

  async function browserApi(req, res, path, method) {
    if (!browser) throw new HttpError(404, '浏览器功能未启用');
    if (path === '/api/browser' && method === 'GET') return sendJson(res, 200, { browser: browser.snapshot() });
    if (path === '/api/browser/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      const send = (snap) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(snap)}\n\n`); };
      send(browser.snapshot());
      browser.on('change', send);
      const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20000);
      res.on('close', () => { clearInterval(ping); browser.off('change', send); });
      return undefined;
    }
    if (method !== 'POST') throw new HttpError(405, '不支持的请求方法');
    const body = await readBody(req);
    try {
      if (path === '/api/browser/start') await browser.start();
      else if (path === '/api/browser/stop') await browser.stop('所有者关闭');
      else if (path === '/api/browser/takeover') browser.takeover(ID_RE.test(String(body.convId || '')) ? body.convId : null);
      else if (path === '/api/browser/handback') {
        const r = await browser.handback();
        return sendJson(res, 200, { browser: browser.snapshot(), ...r });
      } else throw new HttpError(404, '接口不存在');
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(409, err.message);
    }
    return sendJson(res, 200, { browser: browser.snapshot() });
  }

  // Cron runs in this process's local time; report it as an IANA name the browser can use.
  const serverZone = (() => {
    for (const tz of [Intl.DateTimeFormat().resolvedOptions().timeZone, process.env.TZ]) {
      try { if (tz) { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } } catch { /* not IANA */ }
    }
    return null;
  })();
  /**
   * Sidebar history. With `limit`, one page newest-first plus a cursor (updatedAt|id) for the
   * next; `q` searches titles on the server so unloaded pages are searchable too.
   */
  function listConversations(res, url) {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    let list = store.list().slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    // Titles first; otherwise the text of any message (all branches), with a short excerpt.
    const snippets = new Map();
    if (q) {
      list = list.filter((c) => {
        if ((c.title || '新对话').toLowerCase().includes(q)) return true;
        const hit = messageExcerpt(c, q);
        if (hit) snippets.set(c.id, hit);
        return Boolean(hit);
      });
    }
    const view = (c) => (snippets.has(c.id) ? { ...summary(c, runs), snippet: snippets.get(c.id) } : summary(c, runs));
    if (!url.searchParams.has('limit')) return sendJson(res, 200, { conversations: list.map(view) });
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 40));
    const before = url.searchParams.get('before');
    if (before) {
      const [u, id] = before.split('|');
      list = list.filter((c) => c.updatedAt < u || (c.updatedAt === u && c.id < id));
    }
    const page = list.slice(0, limit);
    const last = page[page.length - 1];
    return sendJson(res, 200, {
      conversations: page.map(view),
      nextCursor: list.length > limit && last ? `${last.updatedAt}|${last.id}` : null,
    });
  }

  const tasksPayload = () => ({
    tasks: scheduler.list(), timezone: serverZone, utcOffsetMinutes: -new Date().getTimezoneOffset(), now: new Date().toISOString(),
  });

  async function tasksApi(req, res, path, method) {
    const wrap = async (fn) => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(err.retry ? 429 : 400, err.message);
      }
    };
    if (path === '/api/tasks') {
      if (method === 'GET') return sendJson(res, 200, tasksPayload());
      if (method === 'POST') {
        const body = await readBody(req);
        return wrap(async () => sendJson(res, 201, { task: await scheduler.create(body, 'owner'), ...tasksPayload() }));
      }
    }
    if (path === '/api/tasks/preview' && method === 'POST') {
      const cron = String((await readBody(req)).cron || '').trim();
      return wrap(async () => {
        parseCron(cron);
        const next = [];
        for (let t = new Date(), i = 0; i < 3; i += 1) {
          t = nextRun(cron, t);
          if (!t) break;
          next.push(t.toISOString());
        }
        return sendJson(res, 200, { text: describeCron(cron), next });
      });
    }
    const tm = path.match(/^\/api\/tasks\/([^/]+)(?:\/(run))?$/);
    if (!tm || !ID_RE.test(tm[1])) throw new HttpError(404, '接口不存在');
    if (!tm[2] && method === 'PATCH') {
      const body = await readBody(req);
      return wrap(async () => { await scheduler.update(tm[1], body, 'owner'); return sendJson(res, 200, tasksPayload()); });
    }
    if (!tm[2] && method === 'DELETE') return wrap(async () => { await scheduler.remove(tm[1]); return sendJson(res, 200, tasksPayload()); });
    if (tm[2] === 'run' && method === 'POST') {
      return wrap(async () => sendJson(res, 200, { task: await scheduler.runNow(tm[1]), ...tasksPayload() }));
    }
    throw new HttpError(405, '不支持的请求方法');
  }

  /**
   * The app's own MCP servers for Claude runs (tasks, media): loopback only, per-run bearer
   * token, never through nginx.
   */
  async function internalRpc(req, res, mcp) {
    const remote = req.socket.remoteAddress || '';
    if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote) || req.headers['x-real-ip'] || req.headers['x-forwarded-for']) {
      throw new HttpError(404, '未找到');
    }
    if (!mcp.authorized(req)) throw new HttpError(401, 'unauthorized');
    if (req.method === 'GET') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end();
    }
    if (req.method === 'DELETE') {
      res.writeHead(200);
      return res.end();
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 256 * 1024) throw new HttpError(413, 'too large');
      chunks.push(chunk);
    }
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid json'); }
    const runId = mcp.runFor?.(req) ?? null;
    const out = [];
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      const [, body] = await mcp.handle(msg || {}, runId);
      if (body) out.push(body);
    }
    if (!out.length) {
      res.writeHead(202);
      return res.end();
    }
    return sendJson(res, 200, Array.isArray(parsed) ? out : out[0]);
  }

  /** Claude runs reach BrowserOS through here; only from this host, never through nginx. */
  async function internalMcp(req, res) {
    const remote = req.socket.remoteAddress || '';
    if (!browser || !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote) || req.headers['x-real-ip'] || req.headers['x-forwarded-for']) {
      throw new HttpError(404, '未找到');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new HttpError(413, 'too large');
      chunks.push(chunk);
    }
    try {
      return await browser.handleMcp(req, res, Buffer.concat(chunks));
    } catch (err) {
      log.warn('浏览器 MCP 请求失败', err.message);
      if (res.headersSent) return res.end();
      return sendJson(res, 502, { error: err.message });
    }
  }

  async function upload(req, res) {
    let name = '';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { /* keep empty */ }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > 20 * 1024 * 1024) throw new HttpError(413, '文件超过 20 MB 上限');
    const result = await uploads.save(req, { name, type: req.headers['content-type'] });
    if (result.error) throw new HttpError(400, result.error);
    return sendJson(res, 201, { attachment: uploads.publicView(result.item) });
  }

  async function serveUpload(res, id) {
    const u = uploads.get(id);
    if (!u) throw new HttpError(404, '附件不存在');
    let data;
    try { data = await readFile(u.path); } catch { throw new HttpError(404, '附件已丢失'); }
    const inlineOk = /^image\/(png|jpeg|gif|webp)$/.test(u.type);
    res.writeHead(200, {
      'Content-Type': inlineOk ? u.type : 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'private, max-age=86400',
      'Content-Disposition': `${inlineOk ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(u.name)}`,
    });
    return res.end(data);
  }

  async function api(req, res, url) {
    const { pathname: path } = url;
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD' && !checkOrigin(req.headers)) throw new HttpError(403, '请求来源无效');
    if (path === '/api/login' && method === 'POST') return login(req, res);
    // Public, read-only snapshot behind an unguessable token.
    const pub = path.match(/^\/api\/share\/([^/]+)$/);
    if (pub && method === 'GET') {
      const s = shares.get(pub[1]);
      if (!s) throw new HttpError(404, '分享链接不存在或已失效');
      return sendJson(res, 200, { title: s.title, updatedAt: s.updatedAt, messages: s.messages }, { 'X-Robots-Tag': 'noindex, nofollow' });
    }

    const token = readCookie(req, COOKIE);
    const authed = sessions.validate(token);
    if (path === '/api/session' && method === 'GET') return sendJson(res, 200, { authenticated: authed });
    if (!authed) throw new HttpError(401, '未登录');

    if (path === '/api/logout' && method === 'POST') {
      await sessions.destroy(token);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Max-Age=0; ${cookieFlags}` });
    }
    if (path === '/api/conversations') {
      if (method === 'GET') return listConversations(res, url);
      if (method === 'POST') {
        const body = await readBody(req);
        let settings = {};
        if (body.model) {
          try { catalog.validate(String(body.model), body.effort ? String(body.effort) : null); } catch (err) { throw new HttpError(400, err.message); }
          settings = { model: String(body.model), effort: body.effort ? String(body.effort) : null };
        }
        return sendJson(res, 201, { conversation: summary(await store.create(settings), runs) });
      }
    }
    if (path === '/api/models' && method === 'GET') return sendJson(res, 200, { ...catalog.publicList(), prefs });
    if (path === '/api/models/refresh' && method === 'POST') {
      try { await catalog.refresh(); } catch (err) { throw new HttpError(502, `刷新模型列表失败：${err.message}`); }
      return sendJson(res, 200, { ...catalog.publicList(), prefs });
    }
    if (path === '/api/prefs' && method === 'PUT') {
      // Partial update: the model picker sends model/effort, settings sends permissionMode.
      const body = await readBody(req);
      const next = { ...prefs };
      if (body.model !== undefined) {
        next.model = String(body.model || '');
        next.effort = body.effort ? String(body.effort) : null;
        try { catalog.validate(next.model, next.effort); } catch (err) { throw new HttpError(400, err.message); }
      }
      if (body.maxRuns !== undefined) {
        const n = Number(body.maxRuns);
        if (!Number.isInteger(n) || n < 1 || n > MAX_RUNS_CAP) throw new HttpError(400, `并发数需要在 1–${MAX_RUNS_CAP} 之间`);
        next.maxRuns = n;
        log.info(`并发上限改为 ${n}`);
      }
      if (body.permissionMode !== undefined) {
        if (!PERMISSION_MODES.includes(body.permissionMode)) throw new HttpError(400, '不支持的权限模式');
        next.permissionMode = body.permissionMode;
        log.info(`权限模式改为 ${next.permissionMode}`);
      }
      prefs = next;
      await writeJsonAtomic(prefsPath, prefs);
      return sendJson(res, 200, { prefs });
    }
    if (path === '/api/account' && method === 'GET') {
      try {
        const { account: acct, version, usage, fetchedAt } = await account.get({ force: url.searchParams.get('refresh') === '1' });
        return sendJson(res, 200, { account: acct, version, usage, fetchedAt });
      } catch (err) {
        throw new HttpError(502, `读取账号信息失败：${err.message}`);
      }
    }
    if (path === '/api/commands' && method === 'GET') {
      if (!account.data) {
        try { await account.get(); } catch (err) { throw new HttpError(502, `读取指令列表失败：${err.message}`); }
      }
      return sendJson(res, 200, { commands: account.commands() });
    }
    if (path === '/api/system' && method === 'GET') {
      return sendJson(res, 200, { ...(await memory()), activeRuns: runs.activeCount, maxRuns: maxRuns(), maxRunsCap: MAX_RUNS_CAP });
    }
    if (path.startsWith('/api/tasks')) return tasksApi(req, res, path, method);
    if (path.startsWith('/api/browser')) return browserApi(req, res, path, method);
    if (path === '/api/uploads' && method === 'POST') return upload(req, res);
    const um = path.match(/^\/api\/uploads\/([^/]+)$/);
    if (um && method === 'GET' && ID_RE.test(um[1])) return serveUpload(res, um[1]);

    if (path === '/api/shares' && method === 'GET') return sendJson(res, 200, { shares: shares.list() });
    const sm = path.match(/^\/api\/shares\/([^/]+)$/);
    if (sm && method === 'DELETE') {
      if (!(await shares.remove(sm[1]))) throw new HttpError(404, '分享链接不存在');
      return sendJson(res, 200, { shares: shares.list() });
    }

    const m = path.match(/^\/api\/conversations\/([^/]+)(?:\/(messages|followups|regenerate|stop|events|approvals|share|status)(?:\/([^/]+))?)?$/);
    if (!m || !ID_RE.test(m[1])) throw new HttpError(404, '接口不存在');
    const conv = store.get(m[1]);
    if (!conv) throw new HttpError(404, '对话不存在');
    const [, , action, sub] = m;

    if (!action && method === 'GET') {
      return sendJson(res, 200, {
        conversation: { ...summary(conv, runs), messages: conv.messages, leafId: conv.leafId, run: runs.publicState(conv.id) },
      });
    }
    if (!action && method === 'PATCH') return patchConversation(req, res, conv);
    if (action === 'regenerate' && method === 'POST') return regenerate(req, res, conv);
    if (action === 'status' && method === 'GET') return conversationStatus(res, conv);
    if (!action && method === 'DELETE') {
      if (runs.isRunning(conv.id)) throw new HttpError(409, '请先停止正在进行的回复');
      await shares.removeForConv(conv.id);
      await store.delete(conv.id);
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'share') {
      const view = (s) => (s ? shares.summary(s) : null);
      if (method === 'GET') return sendJson(res, 200, { share: view(shares.forConv(conv.id)) });
      if (method === 'POST') {
        try {
          return sendJson(res, 200, { share: view(await shares.upsert(conv)) });
        } catch (err) {
          throw new HttpError(400, err.message);
        }
      }
      if (method === 'DELETE') {
        await shares.removeForConv(conv.id);
        return sendJson(res, 200, { share: null });
      }
    }
    if (action === 'messages' && method === 'POST') return postMessage(req, res, conv);
    if (action === 'followups' && method === 'POST') return postFollowup(req, res, conv);
    if (action === 'events' && method === 'GET') return streamEvents(req, res, conv, url);
    if (action === 'stop' && method === 'POST') {
      if (!runs.stop(conv.id)) throw new HttpError(409, '没有正在进行的回复');
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'approvals' && sub && method === 'POST') {
      const body = await readBody(req);
      if (!['allow', 'allow_run', 'deny'].includes(body.decision)) throw new HttpError(400, '无效的决定');
      if (!runs.decide(conv.id, sub, body.decision)) throw new HttpError(409, '这个授权请求已失效');
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(405, '不支持的请求方法');
  }

  async function serveStatic(req, res, path) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '不支持的请求方法' });
    let rel;
    try {
      rel = path === '/' ? 'index.html' : normalize(decodeURIComponent(path)).replace(/^[/\\]+/, '');
    } catch {
      return sendJson(res, 404, { error: '未找到' });
    }
    const file = join(PUBLIC_DIR, rel);
    const type = MIME[extname(file)];
    if (!file.startsWith(PUBLIC_DIR) || !type || rel.includes('..')) return sendJson(res, 404, { error: '未找到' });
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': data.length });
      return res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      return sendJson(res, 404, { error: '未找到' });
    }
  }

  /** noVNC's ES modules, read-only from the system package (core/ and vendor/ only). */
  async function serveNovnc(req, res, path) {
    const rel = normalize(decodeURIComponent(path.slice('/vendor/novnc/'.length))).replace(/^[/\\]+/, '');
    if (rel.includes('..') || !/^(core|vendor)\/[\w/.-]+\.js$/.test(rel)) return sendJson(res, 404, { error: '未找到' });
    try {
      const data = await readFile(join(NOVNC_DIR, rel));
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'public, max-age=86400', 'Content-Length': data.length });
      return res.end(data);
    } catch {
      return sendJson(res, 404, { error: '未找到' });
    }
  }

  // Live view: authenticated, same-origin WebSocket to the browser display.
  function onUpgrade(req, socket) {
    socket.on('error', () => {});
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { return rejectUpgrade(socket, 400, 'Bad Request'); }
    if (url.pathname !== '/api/browser/vnc' || !browser) return rejectUpgrade(socket, 404, 'Not Found');
    if (!checkHost(req.headers.host, cfg.allowedHosts)) return rejectUpgrade(socket, 421, 'Misdirected Request');
    if (!checkOrigin(req.headers)) return rejectUpgrade(socket, 403, 'Forbidden');
    if (!sessions.validate(readCookie(req, COOKIE))) return rejectUpgrade(socket, 401, 'Unauthorized');
    browser.connectViewer().then((vnc) => {
      if (socket.destroyed) { vnc.destroy(); return; }
      if (!acceptUpgrade(req, socket, { protocols: ['binary'] })) { vnc.destroy(); return; }
      socket.setNoDelay(true);
      const filter = new RfbFilter(() => browser.canInput());
      bridge(socket, vnc, { filterIn: (chunk) => filter.push(chunk) });
    }).catch((err) => {
      log.warn('打开浏览器画面失败', err.message);
      rejectUpgrade(socket, 503, 'Service Unavailable');
    });
    return undefined;
  }

  const server = http.createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    let url = null;
    const handle = async () => {
      try {
        url = new URL(req.url, 'http://local');
      } catch {
        throw new HttpError(400, '请求地址无效');
      }
      if (!checkHost(req.headers.host, cfg.allowedHosts)) throw new HttpError(421, '不允许的主机名');
      // Explicit wss: source for the live view (older Safari does not match ws to 'self').
      const host = String(req.headers.host).toLowerCase();
      if (/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) res.setHeader('Content-Security-Policy', SECURITY_HEADERS['Content-Security-Policy'].replace("connect-src 'self'", `connect-src 'self' wss://${host} ws://${host}`));
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
      if (url.pathname === '/internal/mcp/browseros') return internalMcp(req, res);
      if (url.pathname === '/internal/mcp/tasks') return internalRpc(req, res, taskMcp);
      if (url.pathname === '/internal/mcp/media') return internalRpc(req, res, mediaMcp);
      if (url.pathname.startsWith('/api/')) return api(req, res, url);
      if (url.pathname.startsWith('/vendor/novnc/')) return serveNovnc(req, res, url.pathname);
      const share = url.pathname.match(/^\/s\/([^/]+)$/);
      if (share) {
        if (!TOKEN_RE.test(share[1])) throw new HttpError(404, '未找到');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        return serveStatic(req, res, '/share.html');
      }
      return serveStatic(req, res, url.pathname);
    };
    handle().catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log.error('请求处理失败', req.method, url?.pathname, err);
      if (res.headersSent) return res.end();
      return sendJson(res, status, { error: status === 500 ? '服务器内部错误' : err.message, ...(err.extra || {}) });
    });
  });
  server.requestTimeout = 60000;
  server.on('upgrade', onUpgrade);

  /** One scheduled run: a new chat each time, or the task's own chat when target is "same". */
  scheduler.fire = async (task) => {
    const busy = (message) => Object.assign(new Error(message), { retry: true });
    if (runs.activeCount >= maxRuns()) throw busy('同时进行的回复已达上限');
    let conv = task.target === 'same' && task.conversationId ? store.get(task.conversationId) : null;
    if (conv && runs.isRunning(conv.id)) throw busy('目标对话正在回复中');
    let plan = null;
    if (conv) {
      const leaf = conv.messages.find((m) => m.id === conv.leafId);
      plan = leaf?.role === 'assistant' ? resumePlan(conv, leaf.id) : null;
      if (!plan?.ok) { conv = null; plan = null; }
    }
    if (!conv) conv = await store.create({});
    const parentId = plan ? conv.leafId : null;
    const sel = selection({ model: task.model || '', effort: task.effort || '' }, conv);
    const userMessage = {
      id: crypto.randomUUID(), role: 'user', parentId, createdAt: new Date().toISOString(), status: 'done',
      parts: [{ type: 'text', text: task.prompt }], attachments: [], scheduledTask: { id: task.id, name: task.name },
    };
    conv.messages.push(userMessage);
    if (!conv.title) conv.title = makeTitle(`定时：${task.name}`);
    await startTurn(conv, { parentId, userMessage, content: task.prompt, sel, resume: plan ? plan.resume : null });
    await store.saveNow(conv);
    return { conversationId: conv.id };
  };
  scheduler.start();

  return Object.assign(app, {
    server,
    secretPath,
    account,
    scheduler,
    taskMcp,
    mediaMcp,
    catalog,
    uploads,
    browser,
    runs,
    store,
    listen() {
      return new Promise((resolve) => server.listen(cfg.port, cfg.host, () => resolve(server.address())));
    },
    async close() {
      scheduler.stop();
      server.close();
      await runs.shutdown();
      server.closeAllConnections();
      await store.flushAll();
      clearInterval(browser?.idleTimer);
    },
  });
}

async function main() {
  const cfg = loadConfig();
  const log = {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
  };
  const app = await createApp(cfg, log);
  const addr = await app.listen();
  log.info(`assistant-web 已启动 http://${addr.address}:${addr.port}`);
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    log.info(`收到 ${signal}，正在停止…`);
    setTimeout(() => { log.error('停止超时，强制退出'); process.exit(1); }, 10000).unref();
    await app.close().catch((err) => log.error('停止时出错', err));
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error('启动失败', err);
    process.exit(1);
  });
}
