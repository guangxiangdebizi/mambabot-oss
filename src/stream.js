// Translates Claude Code `--output-format stream-json` messages into the parts of one
// assistant message. Only user-facing content is kept: text, a one-line note per tool
// call, and its outcome. Thinking, raw tool output and protocol noise are dropped.

const clip = (s, n) => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

export function summarizeTool(name, input = {}) {
  switch (name) {
    case 'Bash': return clip(input.description || String(input.command || '').split('\n')[0], 140);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': return clip(input.file_path, 140);
    case 'NotebookEdit': return clip(input.notebook_path, 140);
    case 'Glob': case 'Grep': return clip(input.pattern, 140);
    case 'WebFetch': return clip(input.url, 140);
    case 'WebSearch': return clip(input.query, 140);
    case 'Agent': case 'Task': return clip(input.description, 140);
    default:
      if (name?.startsWith('mcp__browseros-neo__')) {
        return clip(input.reason || input.url || input.name || (input.kind && input.ref ? `${input.kind} ${input.ref}` : input.kind) || input.action || input.pattern || '', 140);
      }
      return '';
  }
}

const DETAIL_LIMIT = 4000;
const cut = (s) => (s.length > DETAIL_LIMIT ? `${s.slice(0, DETAIL_LIMIT)}\n…（已截断）` : s);

/** Full enough for an honest allow/deny decision. */
export function approvalDetail(name, input = {}) {
  switch (name) {
    case 'Bash': return cut(String(input.command ?? ''));
    case 'Write': return cut(`文件：${input.file_path}\n\n${input.content ?? ''}`);
    case 'Edit': return cut(`文件：${input.file_path}\n\n— 原内容 —\n${input.old_string ?? ''}\n\n— 新内容 —\n${input.new_string ?? ''}`);
    default: return cut(JSON.stringify(input, null, 2));
  }
}

/** Shorter input view for the collapsible activity list. */
export function toolDetail(name, input = {}) {
  const full = approvalDetail(name, input);
  return full.length > 1500 ? `${full.slice(0, 1500)}\n…（已截断）` : full;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Cost and tokens of one CLI process (one reply), from its `result`. The CLI prices usage at
 * API list rates; on a subscription login this is an estimate, not a charge.
 */
export function runUsage(result) {
  const t = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let contextWindow = null;
  for (const u of Object.values(result?.modelUsage || {})) {
    t.inputTokens += num(u.inputTokens) || 0;
    t.outputTokens += num(u.outputTokens) || 0;
    t.cacheReadTokens += num(u.cacheReadInputTokens) || 0;
    t.cacheWriteTokens += num(u.cacheCreationInputTokens) || 0;
    contextWindow = Math.max(contextWindow ?? 0, num(u.contextWindow) ?? 0) || null;
  }
  return { costUsd: num(result?.total_cost_usd), ...t, contextWindow, durationMs: num(result?.duration_ms) };
}

export class StreamTranslator {
  /**
   * @param {object} message assistant message whose `parts` array is mutated in place
   * @param {(event: object) => void} emit receives `part` / `text` events
   */
  constructor(message, emit) {
    this.msg = message;
    this.emit = emit;
    this.apiMessageId = null;
    this.streamed = new Set();
    this.toolIndex = new Map();
    this.sessionId = null;
    this.result = null;
    this.tailUuid = null;
    this.model = null;
    this.compactIndex = null;
  }

  /** The model the runtime reports, which may differ from the one requested. */
  noteModel(model) {
    if (!model || model === this.model || model === '<synthetic>') return;
    this.model = model;
    this.msg.modelUsed = model;
    this.emit({ type: 'meta', modelUsed: model });
  }

  pushPart(part) {
    const index = this.msg.parts.push(part) - 1;
    this.emit({ type: 'part', index, part: structuredClone(part) });
    return index;
  }

  updatePart(index) {
    this.emit({ type: 'part', index, part: structuredClone(this.msg.parts[index]) });
  }

  /** Text from another API message (a later turn of the same reply) starts a new paragraph. */
  appendText(text, messageId = null) {
    if (!text) return;
    let index = this.msg.parts.length - 1;
    const sameMessage = !messageId || !this.textMessageId || messageId === this.textMessageId;
    if (this.msg.parts[index]?.type !== 'text' || !sameMessage) index = this.pushPart({ type: 'text', text: '' });
    if (messageId) this.textMessageId = messageId;
    this.msg.parts[index].text += text;
    this.emit({ type: 'text', index, delta: text });
  }

  handle(m) {
    // Subagent internals are not part of the main reply.
    if (m.parent_tool_use_id) return;
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          if (m.session_id) this.sessionId = m.session_id;
          this.noteModel(m.model);
        } else if (m.subtype === 'status' || m.subtype === 'compact_boundary') {
          this.onCompact(m);
        }
        break;
      case 'stream_event': this.onStreamEvent(m.event || {}); break;
      case 'assistant':
        if (m.uuid) this.tailUuid = m.uuid;
        this.noteModel(m.message?.model);
        this.onAssistant(m.message || {});
        break;
      case 'user':
        // After /compact the CLI replays its "Compacted" output; that entry is the session's new
        // tail, so a later branch can fork from the compacted state.
        if (this.compactIndex !== null && m.isReplay && m.uuid) this.tailUuid = m.uuid;
        this.onUser(m.message || {});
        break;
      case 'result':
        this.result = m;
        if (m.session_id) this.sessionId = m.session_id;
        // Local commands (e.g. /compact) report their outcome only here.
        if (m.local_command && m.result && !this.msg.parts.some((x) => x.type === 'text')) this.appendText(String(m.result));
        this.msg.usage = runUsage(m);
        this.emit({ type: 'meta', usage: this.msg.usage });
        if (this.compactIndex !== null && this.msg.parts[this.compactIndex].state === 'running') {
          this.msg.parts[this.compactIndex].state = m.is_error ? 'failed' : 'done';
          this.updatePart(this.compactIndex);
        }
        break;
      default: break;
    }
  }

  /** Manual (/compact) or automatic compaction: one `compact` part per reply. */
  onCompact(m) {
    if (m.subtype === 'status' && m.status === 'compacting') {
      if (this.compactIndex === null) this.compactIndex = this.pushPart({ type: 'compact', state: 'running' });
      return;
    }
    if (this.compactIndex === null) {
      if (m.subtype !== 'compact_boundary' && !m.compact_result) return;
      this.compactIndex = this.pushPart({ type: 'compact', state: 'running' });
    }
    const part = this.msg.parts[this.compactIndex];
    if (m.subtype === 'compact_boundary') {
      const meta = m.compact_metadata || {};
      Object.assign(part, {
        state: 'done', trigger: meta.trigger === 'auto' ? 'auto' : 'manual',
        preTokens: num(meta.pre_tokens), postTokens: num(meta.post_tokens), durationMs: num(meta.duration_ms),
      });
      if (m.uuid) this.tailUuid = m.uuid;
    } else if (m.compact_result && m.compact_result !== 'success') {
      part.state = 'failed';
    } else {
      return;
    }
    this.updatePart(this.compactIndex);
  }

  onStreamEvent(e) {
    if (e.type === 'message_start') this.apiMessageId = e.message?.id || null;
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
      if (this.apiMessageId) this.streamed.add(this.apiMessageId);
      this.appendText(e.delta.text, this.apiMessageId);
    }
  }

  onAssistant(message) {
    for (const block of message.content || []) {
      if (block.type === 'text' && !this.streamed.has(message.id)) {
        this.appendText(block.text, message.id);
      } else if (block.type === 'tool_use' && !this.toolIndex.has(block.id)) {
        const index = this.pushPart({
          type: 'tool', id: block.id, name: block.name, summary: summarizeTool(block.name, block.input), state: 'running',
          detail: toolDetail(block.name, block.input),
        });
        this.toolIndex.set(block.id, index);
      }
    }
  }

  onUser(message) {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      const index = this.toolIndex.get(block.tool_use_id);
      if (index === undefined) continue;
      this.msg.parts[index].state = block.is_error ? 'error' : 'done';
      this.updatePart(index);
    }
  }
}
