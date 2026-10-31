import { randomUUID } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDir, readJson, writeJsonAtomic } from './fsutil.js';

export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIVE_STATUSES = new Set(['running', 'stopping']);
const SAVE_DELAY_MS = 1000;

/** One JSON file per conversation, cached in memory (single user, small data). */
export class ConversationStore {
  constructor(dir) {
    this.dir = dir;
    this.items = new Map();
    this.timers = new Map();
    this.writes = new Map();
  }

  file(id) {
    return join(this.dir, `${id}.json`);
  }

  /** Loads everything; replies left running by a crash or restart are marked interrupted. */
  async load() {
    await ensurePrivateDir(this.dir);
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const conv = await readJson(join(this.dir, name));
      if (!conv || !ID_RE.test(conv.id || '')) continue;
      let changed = migrate(conv);
      for (const msg of conv.messages) {
        if (!LIVE_STATUSES.has(msg.status)) continue;
        msg.status = 'interrupted';
        msg.error = '服务在回复过程中重启，这条回复已中断。';
        for (const part of msg.parts) if (part.type === 'approval' && part.state === 'pending') part.state = 'expired';
        for (const entry of msg.queued || []) msg.parts.push({ type: 'followup', ...entry, undelivered: true });
        delete msg.queued;
        changed = true;
      }
      this.items.set(conv.id, conv);
      if (changed) await this.saveNow(conv);
    }
  }

  list() {
    return [...this.items.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id) {
    return this.items.get(id) || null;
  }

  async create(settings = {}) {
    const now = new Date().toISOString();
    const conv = {
      id: randomUUID(), version: 2, title: '', createdAt: now, updatedAt: now,
      settings: { model: settings.model || null, effort: settings.effort || null },
      leafId: null, tips: {}, messages: [],
    };
    this.items.set(conv.id, conv);
    await this.saveNow(conv);
    return conv;
  }

  touch(conv) {
    conv.updatedAt = new Date().toISOString();
  }

  /** Debounced save for streaming updates. */
  scheduleSave(conv) {
    if (this.timers.has(conv.id)) return;
    this.timers.set(conv.id, setTimeout(() => {
      this.timers.delete(conv.id);
      this.saveNow(conv).catch((err) => console.error('保存对话失败', conv.id, err.message));
    }, SAVE_DELAY_MS));
  }

  /** Serialised per conversation so writes never interleave. */
  saveNow(conv) {
    clearTimeout(this.timers.get(conv.id));
    this.timers.delete(conv.id);
    const prev = this.writes.get(conv.id) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => {
      if (this.items.get(conv.id) !== conv) return undefined;
      return writeJsonAtomic(this.file(conv.id), conv);
    });
    this.writes.set(conv.id, next);
    return next;
  }

  async delete(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.items.delete(id);
    await (this.writes.get(id) || Promise.resolve()).catch(() => {});
    this.writes.delete(id);
    await unlink(this.file(id)).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  }

  async flushAll() {
    await Promise.all([...this.items.values()].filter((c) => this.timers.has(c.id)).map((c) => this.saveNow(c)));
    await Promise.all([...this.writes.values()].map((p) => p.catch(() => {})));
  }
}

/**
 * Version 1 stored one flat thread and one Claude session per conversation. Version 2 is a
 * tree (parentId + leafId) where every assistant reply records the Claude session it lives
 * in, so edits and regenerations fork the CLI session at the right point. Old replies have
 * no message uuid; only the newest one can be continued (it is still its session's tip).
 */
export function migrate(conv) {
  if (conv.version === 2) return false;
  let prev = null;
  let lastAssistant = null;
  for (const msg of conv.messages) {
    msg.parentId = prev;
    prev = msg.id;
    if (msg.role === 'assistant') {
      msg.requested = { model: msg.model || 'default', effort: null };
      delete msg.model;
      lastAssistant = msg;
    }
  }
  conv.tips = {};
  if (lastAssistant && conv.claudeSessionId) {
    lastAssistant.sessionId = conv.claudeSessionId;
    lastAssistant.tipKey = `legacy:${lastAssistant.id}`;
    conv.tips[conv.claudeSessionId] = lastAssistant.tipKey;
  }
  delete conv.claudeSessionId;
  conv.leafId = prev;
  conv.settings = { model: null, effort: null };
  conv.version = 2;
  return true;
}

/** Messages from the root to `leafId`, in order. */
export function pathTo(conv, leafId) {
  const byId = new Map(conv.messages.map((m) => [m.id, m]));
  const path = [];
  for (let m = byId.get(leafId); m; m = byId.get(m.parentId)) path.unshift(m);
  return path;
}

/**
 * How to start Claude for a new turn whose user message hangs under `parentId` (an assistant
 * reply, or null for the first turn). Walks up to the nearest reply that has a Claude session.
 */
export function resumePlan(conv, parentId) {
  const byId = new Map(conv.messages.map((m) => [m.id, m]));
  let m = byId.get(parentId);
  while (m && !(m.role === 'assistant' && m.sessionId)) m = byId.get(m.parentId);
  if (!m) return { ok: true, resume: null };
  if (m.tipKey && conv.tips[m.sessionId] === m.tipKey) return { ok: true, resume: { sessionId: m.sessionId } };
  if (m.tailUuid) return { ok: true, resume: { sessionId: m.sessionId, at: m.tailUuid, fork: true } };
  return { ok: false, error: '这条较早的回复来自旧版本，无法从这里继续或分支' };
}
