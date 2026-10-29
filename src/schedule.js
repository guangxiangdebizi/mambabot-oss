import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil.js';

// Scheduled tasks owned by this app. Claude Code's own CronCreate lives only as long as one
// CLI process, and every web reply is its own short-lived process, so tasks are kept here:
// stored on disk, fired by this server, visible and editable in the page, and editable by
// Claude through the `assistant-tasks` MCP tools (each change is a normal approval card).

/* ---------------- cron ---------------- */

const FIELDS = [
  { name: '分钟', min: 0, max: 59 },
  { name: '小时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '星期', min: 0, max: 7 },
];

function parseField(src, { name, min, max }) {
  const set = new Set();
  for (const part of src.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`${name}字段格式不正确：${part}`);
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a;
      hi = b ?? (m[2] ? max : a);
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`${name}字段超出范围：${part}`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

/** Standard 5-field cron in server local time. Day-of-month and day-of-week OR when both set. */
export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('时间表达式需要 5 段：分 时 日 月 星期');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.has(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

function dayMatches(c, d) {
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

/** First matching minute strictly after `from`, or null if none within ~4 years. */
export function nextRun(expr, from = new Date()) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 4 * 366 * 24 * 3600 * 1000;
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!dayMatches(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d;
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** Short Chinese description for the common shapes; falls back to the expression. */
export function describeCron(expr) {
  const p = String(expr).trim().split(/\s+/);
  if (p.length !== 5) return expr;
  const [mi, h, dom, mon, dow] = p;
  const simple = (s) => /^\d+$/.test(s);
  const every = mi.match(/^\*\/(\d+)$/);
  if (every && h === '*' && dom === '*' && mon === '*' && dow === '*') return `每 ${every[1]} 分钟`;
  const everyH = h.match(/^\*\/(\d+)$/);
  if (simple(mi) && everyH && dom === '*' && mon === '*' && dow === '*') return `每 ${everyH[1]} 小时（第 ${mi} 分）`;
  if (simple(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `每小时第 ${mi} 分`;
  if (simple(mi) && simple(h) && mon === '*') {
    const t = `${pad(h)}:${pad(mi)}`;
    if (dom === '*' && dow === '*') return `每天 ${t}`;
    if (dom === '*' && dow === '1-5') return `工作日 ${t}`;
    if (dom === '*' && /^[0-7](,[0-7])*$/.test(dow)) return `每${[...new Set(dow.split(',').map((x) => WEEK[Number(x) % 7]))].join('、')} ${t}`;
    if (simple(dom) && dow === '*') return `每月 ${dom} 日 ${t}`;
  }
  return `cron: ${expr}`;
}

/* ---------------- store + scheduler ---------------- */

const MAX_TASKS = 50;
const TICK_MS = 20 * 1000;
const LATE_GIVE_UP_MS = 30 * 60 * 1000;
const clipStr = (v, n) => String(v ?? '').trim().slice(0, n);

export class TaskScheduler {
  /**
   * @param fire async (task) => { conversationId }  starts one run; throws a user-facing message if it cannot
   */
  constructor({ cfg, log = console, now = () => new Date() }) {
    Object.assign(this, { cfg, log, now });
    this.path = join(cfg.dataDir, 'tasks.json');
    this.tasks = [];
    this.fire = null;
    this.validateModel = null;
    this.timer = null;
    this.firing = new Set();
    this.onChange = null;
  }

  async load() {
    const saved = await readJson(this.path, { tasks: [] });
    this.tasks = Array.isArray(saved.tasks) ? saved.tasks : [];
    // Runs missed while the server was down are skipped, not replayed in a burst.
    for (const t of this.tasks) t.nextRunAt = t.enabled ? nextRun(t.cron, this.now())?.toISOString() ?? null : null;
    await this.save();
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((err) => this.log.warn('定时任务检查失败', err.message)), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  save() {
    this.onChange?.();
    return writeJsonAtomic(this.path, { tasks: this.tasks });
  }

  list() {
    return this.tasks.map((t) => ({ ...t, scheduleText: describeCron(t.cron) }));
  }

  get(id) {
    return this.tasks.find((t) => t.id === id) || null;
  }

  /** Validates and normalises user or Claude input; throws a user-facing message. */
  clean(input, existing = null) {
    const out = {};
    if (!existing || input.name !== undefined) {
      out.name = clipStr(input.name, 60);
      if (!out.name) throw new Error('任务名称不能为空');
    }
    if (!existing || input.prompt !== undefined) {
      out.prompt = clipStr(input.prompt, 8000);
      if (!out.prompt) throw new Error('要执行的指令不能为空');
    }
    if (!existing || input.cron !== undefined) {
      out.cron = String(input.cron ?? '').trim().replace(/\s+/g, ' ');
      parseCron(out.cron);
      if (!nextRun(out.cron, this.now())) throw new Error('这个时间表达式永远不会触发');
    }
    if (input.enabled !== undefined) out.enabled = Boolean(input.enabled);
    // Model and effort can change independently; null means "the owner's default".
    if (input.model !== undefined) out.model = input.model ? String(input.model) : null;
    if (input.effort !== undefined) out.effort = input.effort ? String(input.effort) : null;
    if (out.model !== undefined || out.effort !== undefined) {
      const model = out.model !== undefined ? out.model : existing?.model ?? null;
      const effort = out.effort !== undefined ? out.effort : existing?.effort ?? null;
      try {
        this.validateModel?.(model, effort);
      } catch (err) {
        // A new model that lacks the old effort level: drop the stale level instead of failing.
        if (input.effort !== undefined || !effort) throw err;
        out.effort = null;
        this.validateModel?.(model, null);
      }
    }
    if (input.target !== undefined) {
      out.target = input.target === 'same' ? 'same' : 'new';
    }
    return out;
  }

  async create(input, createdBy = 'owner') {
    if (this.tasks.length >= MAX_TASKS) throw new Error(`最多 ${MAX_TASKS} 个定时任务`);
    const fields = this.clean(input);
    const now = this.now().toISOString();
    const task = {
      id: randomUUID(), name: fields.name, prompt: fields.prompt, cron: fields.cron,
      enabled: fields.enabled ?? true, model: fields.model ?? null, effort: fields.effort ?? null,
      target: fields.target ?? 'new', conversationId: null, createdBy, createdAt: now, updatedAt: now,
      lastRunAt: null, lastStatus: null, lastError: null, lastConversationId: null, nextRunAt: null,
    };
    task.nextRunAt = task.enabled ? nextRun(task.cron, this.now()).toISOString() : null;
    this.tasks.push(task);
    await this.save();
    return task;
  }

  async update(id, input, by = 'owner') {
    const task = this.get(id);
    if (!task) throw new Error('定时任务不存在');
    Object.assign(task, this.clean(input, task), { updatedAt: this.now().toISOString(), updatedBy: by });
    task.nextRunAt = task.enabled ? nextRun(task.cron, this.now()).toISOString() : null;
    await this.save();
    return task;
  }

  async remove(id) {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    if (this.tasks.length === before) throw new Error('定时任务不存在');
    await this.save();
  }

  async runNow(id) {
    const task = this.get(id);
    if (!task) throw new Error('定时任务不存在');
    return this.execute(task, { manual: true });
  }

  async execute(task, { manual = false } = {}) {
    if (this.firing.has(task.id)) throw new Error('这个任务正在启动');
    this.firing.add(task.id);
    try {
      const { conversationId } = await this.fire(task);
      Object.assign(task, { lastRunAt: this.now().toISOString(), lastStatus: 'started', lastError: null, lastConversationId: conversationId });
      if (task.target === 'same') task.conversationId = conversationId;
      if (!manual) task.nextRunAt = nextRun(task.cron, this.now())?.toISOString() ?? null;
      await this.save();
      return task;
    } finally {
      this.firing.delete(task.id);
    }
  }

  /** Fires due tasks; a busy server delays a run, and gives up after 30 minutes. */
  async tick() {
    const now = this.now().getTime();
    for (const task of this.tasks) {
      if (!task.enabled || !task.nextRunAt || Date.parse(task.nextRunAt) > now || this.firing.has(task.id)) continue;
      try {
        await this.execute(task);
        this.log.info(`定时任务已触发 task=${task.id}`);
      } catch (err) {
        if (now - Date.parse(task.nextRunAt) < LATE_GIVE_UP_MS && err.retry) continue;
        Object.assign(task, { lastRunAt: new Date(now).toISOString(), lastStatus: 'failed', lastError: err.message });
        task.nextRunAt = nextRun(task.cron, this.now())?.toISOString() ?? null;
        await this.save();
        this.log.warn(`定时任务失败 task=${task.id}: ${err.message}`);
      }
    }
  }
}

/* ---------------- MCP tools for Claude ---------------- */

export const TASK_SERVER = 'assistant-tasks';

const TOOLS = [
  {
    name: 'list_scheduled_tasks',
    description: '列出所有者在 assistant-web 里的全部定时任务（id、名称、cron、指令、模型、推理强度、启用状态、下次/上次运行时间），以及当前默认模型/推理强度和可选模型及其支持的推理强度。model/effort 为 null 表示跟随默认。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_scheduled_task',
    description: '新建一个定时任务。到点时服务器会用 prompt 作为一条新消息启动一次 Claude 回复。cron 是标准 5 段表达式（分 时 日 月 星期），按服务器本地时间（北京时间）计算。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '简短名称' },
        prompt: { type: 'string', description: '到点时发送给 Claude 的完整指令' },
        cron: { type: 'string', description: '例如 "0 9 * * *" 表示每天 9:00' },
        enabled: { type: 'boolean' },
        model: { type: ['string', 'null'], description: '可选：模型值（见 list_scheduled_tasks 返回的 models），null=跟随默认' },
        effort: { type: ['string', 'null'], description: '可选：推理强度，必须是该模型支持的级别，null=跟随默认' },
        target: { type: 'string', enum: ['new', 'same'], description: 'new=每次新建对话，same=始终写入同一个对话' },
      },
      required: ['name', 'prompt', 'cron'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_scheduled_task',
    description: '修改已有定时任务的任意字段（只传要改的字段）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' }, cron: { type: 'string' },
        enabled: { type: 'boolean' },
        model: { type: ['string', 'null'], description: 'null=跟随默认' },
        effort: { type: ['string', 'null'], description: 'null=跟随默认；可以单独修改' },
        target: { type: 'string', enum: ['new', 'same'] },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_scheduled_task',
    description: '删除一个定时任务。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
];

const view = (t) => ({
  id: t.id, name: t.name, cron: t.cron, schedule: describeCron(t.cron), prompt: t.prompt, enabled: t.enabled,
  model: t.model, effort: t.effort, target: t.target, nextRunAt: t.nextRunAt, lastRunAt: t.lastRunAt,
  lastStatus: t.lastStatus, lastError: t.lastError,
});

/** Minimal MCP (streamable HTTP, JSON responses) server exposing the task tools to one run. */
export class TaskMcp {
  /** @param info () => ({ defaults, models }) shown to Claude alongside the task list */
  constructor({ scheduler, info = () => ({}) }) {
    this.scheduler = scheduler;
    this.info = info;
    this.tokens = new Map();
  }

  serverFor(runId) {
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(createHash('sha256').update(token).digest('hex'), runId);
    return { type: 'http', url: `http://127.0.0.1:${this.scheduler.cfg.port}/internal/mcp/tasks`, headers: { Authorization: `Bearer ${token}` } };
  }

  runEnded(runId) {
    for (const [hash, id] of this.tokens) if (id === runId) this.tokens.delete(hash);
  }

  authorized(req) {
    const m = String(req.headers.authorization || '').match(/^Bearer (\S+)$/);
    return Boolean(m && this.tokens.has(createHash('sha256').update(m[1]).digest('hex')));
  }

  async call(name, args = {}) {
    const s = this.scheduler;
    switch (name) {
      case 'list_scheduled_tasks': return { tasks: s.list().map(view), ...this.info() };
      case 'create_scheduled_task': return { created: view(await s.create(args, 'claude')) };
      case 'update_scheduled_task': {
        const { id, ...rest } = args;
        return { updated: view(await s.update(String(id || ''), rest, 'claude')) };
      }
      case 'delete_scheduled_task': await s.remove(String(args.id || '')); return { deleted: args.id };
      default: throw new Error(`未知工具 ${name}`);
    }
  }

  /** Returns [status, body|null] for one JSON-RPC message. */
  async handle(msg) {
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    if (msg.id === undefined || msg.id === null) return [202, null];
    switch (msg.method) {
      case 'initialize':
        return [200, reply({
          protocolVersion: msg.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: TASK_SERVER, version: '1.0.0' },
          instructions: '所有者在 assistant-web 网页里的定时任务。用这些工具查看和修改，不要用 CronCreate 或系统 crontab。',
        })];
      case 'ping': return [200, reply({})];
      case 'tools/list': return [200, reply({ tools: TOOLS })];
      case 'tools/call':
        try {
          const out = await this.call(msg.params?.name, msg.params?.arguments || {});
          return [200, reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] })];
        } catch (err) {
          return [200, reply({ content: [{ type: 'text', text: err.message }], isError: true })];
        }
      default: return [200, fail(-32601, `不支持的方法 ${msg.method}`)];
    }
  }
}
