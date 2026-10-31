import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { pathTo } from './store.js';

// Read-only share links. A share is a snapshot of the conversation's current branch taken
// when the owner shares (or refreshes) it, so later messages never leak into an old link.
// Only message text goes in: no attachment files, tool inputs/outputs, approval details or
// session ids. Anyone with the unguessable token can read it; the owner can revoke it.

export const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
const MAX_SHARES = 200;
const LIVE = new Set(['running', 'stopping']);

const names = (attachments) => (attachments || []).map((a) => String(a.name || '附件'));

export function snapshot(conv) {
  const messages = [];
  const push = (role, texts, tools, attachments, createdAt) => {
    const text = texts.join('\n\n').trim();
    if (text || tools || attachments.length) messages.push({ role, text, tools, attachments, createdAt });
  };
  for (const m of pathTo(conv, conv.leafId)) {
    if (m.role === 'assistant' && LIVE.has(m.status)) continue;
    // A follow-up Claude received mid-reply splits the reply where it arrived.
    let texts = [];
    let tools = 0;
    for (const p of m.parts) {
      if (p.type === 'text') texts.push(p.text || '');
      else if (p.type === 'tool') tools += 1;
      else if (p.type === 'followup' && !p.undelivered) {
        push('assistant', texts, tools, [], m.createdAt);
        push('user', [p.text || ''], 0, names(p.attachments), p.createdAt);
        texts = [];
        tools = 0;
      }
    }
    push(m.role === 'user' ? 'user' : 'assistant', texts, tools, m.role === 'user' ? names(m.attachments) : [], m.createdAt);
  }
  return messages;
}

export class ShareStore {
  constructor(dataDir) {
    this.path = join(dataDir, 'shares.json');
    this.items = new Map();
  }

  async load() {
    const saved = await readJson(this.path, { shares: [] });
    for (const s of saved.shares || []) if (TOKEN_RE.test(s.token || '')) this.items.set(s.token, s);
  }

  save() {
    return writeJsonAtomic(this.path, { shares: [...this.items.values()] });
  }

  summary(s) {
    return { token: s.token, convId: s.convId, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, messageCount: s.messages.length };
  }

  list() {
    return [...this.items.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((s) => this.summary(s));
  }

  forConv(convId) {
    for (const s of this.items.values()) if (s.convId === convId) return s;
    return null;
  }

  get(token) {
    return TOKEN_RE.test(token || '') ? this.items.get(token) || null : null;
  }

  /** Creates the conversation's link, or refreshes its snapshot (same link). */
  async upsert(conv) {
    const messages = snapshot(conv);
    if (!messages.length) throw new Error('这个对话还没有可以分享的内容');
    const now = new Date().toISOString();
    let s = this.forConv(conv.id);
    if (!s) {
      if (this.items.size >= MAX_SHARES) throw new Error(`最多同时分享 ${MAX_SHARES} 个对话`);
      s = { token: randomBytes(18).toString('base64url'), convId: conv.id, createdAt: now };
      this.items.set(s.token, s);
    }
    Object.assign(s, { title: conv.title || '对话', updatedAt: now, messages });
    await this.save();
    return s;
  }

  async remove(token) {
    if (!this.items.delete(token)) return false;
    await this.save();
    return true;
  }

  async removeForConv(convId) {
    const s = this.forConv(convId);
    if (s) await this.remove(s.token);
  }
}
