import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { pathTo } from './store.js';

const compress = promisify(gzip);
const PAGE_BYTES = 64 * 1024;
const TEXT_PREVIEW = 16000;

export function messageView(message, { fullText = false } = {}) {
  let remaining = TEXT_PREVIEW;
  let truncated = false;
  const live = ['running', 'stopping'].includes(message.status);
  const parts = message.parts.map((part) => {
    if (part.type === 'tool') {
      const { detail, output, ...summary } = part;
      return { ...summary, deferredDetail: Boolean(detail || output) };
    }
    if (part.type === 'text' && message.role === 'assistant' && !live && !fullText) {
      const text = (part.text || '').slice(0, remaining);
      remaining -= text.length;
      truncated ||= text.length < (part.text || '').length;
      return { ...part, text };
    }
    return part;
  });
  return { ...message, parts, ...(truncated ? { deferredText: true } : {}) };
}

// Keep tree metadata for branch navigation, but send bodies only for the requested window.
export function conversationWindow(conv, params) {
  const leafId = params.get('leaf') || conv.leafId;
  if (leafId && !conv.messages.some((m) => m.id === leafId)) {
    throw Object.assign(new Error('Unknown branch'), { status: 400 });
  }
  const path = pathTo(conv, leafId);
  const before = params.get('before');
  const end = before ? path.findIndex((m) => m.id === before) : path.length;
  if (end < 0) throw Object.assign(new Error('Invalid history cursor'), { status: 400 });
  const limit = Math.min(30, Math.max(1, Number(params.get('limit')) || 30));
  const selected = new Map();
  let bytes = 0;
  // A single message may exceed the target; it is never silently dropped.
  for (let i = end - 1; i >= 0 && selected.size < limit; i--) {
    const view = messageView(path[i]);
    const size = Buffer.byteLength(JSON.stringify(view));
    if (selected.size && bytes + size > PAGE_BYTES) break;
    selected.set(view.id, view);
    bytes += size;
  }
  const messages = conv.messages.map((m) => selected.get(m.id) || {
    id: m.id, parentId: m.parentId, role: m.role, createdAt: m.createdAt,
    status: m.status, sessionId: m.sessionId, tailUuid: m.tailUuid, tipKey: m.tipKey,
    parts: [], deferred: true,
  });
  return { messages, leafId, tips: conv.tips || {}, window: {
    firstId: path[end - selected.size]?.id || null,
    hasMore: end > selected.size, count: selected.size, bodyBytes: bytes,
  } };
}

export async function sendConversationJson(req, res, body) {
  const start = performance.now();
  const raw = Buffer.from(JSON.stringify(body));
  const serialized = performance.now();
  const acceptsGzip = (req.headers['accept-encoding'] || '').split(',').some((entry) => {
    const [name, ...options] = entry.trim().split(';');
    const q = options.find((s) => s.trim().startsWith('q='));
    return name === 'gzip' && (!q || Number(q.trim().slice(2)) > 0);
  });
  const data = acceptsGzip && raw.length >= 1024 ? await compress(raw) : raw;
  if (res.destroyed) return;
  const compressed = performance.now();
  const headers = {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Length': data.length, Vary: 'Accept-Encoding',
    'Server-Timing': `serialize;dur=${(serialized - start).toFixed(2)}, compress;dur=${(compressed - serialized).toFixed(2)}`,
    ...(data !== raw ? { 'Content-Encoding': 'gzip' } : {}),
  };
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.writeHead(200);
  res.end(data);
}
