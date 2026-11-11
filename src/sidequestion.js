import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { claudeEnv } from './claude-accounts.js';

// Side questions (旁路提问, like `/btw` in the Claude Code terminal): asked while a reply runs
// (or any time), answered right away by a separate, read-only `claude -p` that never touches the
// main task. It resumes the chat as a throwaway fork of the last finished reply
// (`--fork-session --no-session-persistence`, so nothing is written to any session), gets the
// running turn's progress so far as text, and may only read files (`--tools Read,Grep,Glob`,
// `--permission-mode dontAsk`, no MCP servers). The answer is stored beside the messages
// (conv.btw), never in the main task's context; the page can paste it into the next message.

const TIMEOUT_MS = 3 * 60 * 1000;
const MAX_PROGRESS = 24000;
const MAX_ANSWER = 60000;
const MAX_PER_CHAT = 50;
const MAX_ACTIVE = 2;

const PROMPT = [
  '这是所有者在 MambaBot 网页上的旁路提问（/btw）。主任务在另一个进程里继续运行，你看不到它之后的步骤，也不能影响它。',
  '只回答这个问题，简洁直接，默认用简体中文。不要继续或重做主任务，不要修改任何文件，不要运行命令；需要时可以用 Read、Grep、Glob 查看文件。',
  '这次问答不会写进主任务的上下文。',
];

const TOOL_NAMES = {
  Bash: '运行命令', Read: '读取文件', Write: '写入文件', Edit: '编辑文件', MultiEdit: '编辑文件', Glob: '查找文件', Grep: '搜索内容',
  WebFetch: '获取网页', WebSearch: '网络搜索', Agent: '子任务', Task: '子任务', TodoWrite: '更新待办',
};
const STATES = { running: '进行中', done: '完成', error: '失败' };
const clock = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5);
};

/**
 * The running turn so far, as text for the side session: the owner's message, what Claude has
 * said, the steps it took (with the one in progress) and messages added meanwhile.
 */
export function progressText(userMessage, reply, now = new Date()) {
  const lines = [];
  const userText = (userMessage?.parts || []).map((p) => p.text || '').join('').trim();
  if (userText) lines.push(`所有者这一轮的消息：${userText}`);
  for (const p of reply?.parts || []) {
    if (p.type === 'text' && p.text?.trim()) lines.push(`Claude 说：${p.text.trim()}`);
    else if (p.type === 'tool') {
      const mins = p.state === 'running' && p.at ? Math.floor((now - new Date(p.at)) / 60000) : null;
      lines.push(`- ${TOOL_NAMES[p.name] || p.name}${p.summary ? `：${p.summary}` : ''}（${STATES[p.state] || p.state}${mins ? `，已 ${mins} 分钟` : ''}${p.at ? `，${clock(p.at)} 开始` : ''}）`);
      if (p.name === 'Bash' && p.output) lines.push(`  输出摘录：${p.output.slice(-600).replace(/\s+/g, ' ')}`);
    } else if (p.type === 'followup' && p.text) lines.push(`所有者中途补充：${p.text}`);
    else if (p.type === 'approval') lines.push(`- 授权请求：${p.summary || p.tool}（${p.state}）`);
  }
  for (const q of reply?.queued || []) if (q.text) lines.push(`所有者已排队、Claude 还没看到的补充：${q.text}`);
  let text = lines.join('\n');
  if (text.length > MAX_PROGRESS) text = `…（前面省略）\n${text.slice(-MAX_PROGRESS)}`;
  return text;
}

export class SideQuestions {
  constructor({ cfg, log = console, spawnImpl = spawn }) {
    Object.assign(this, { cfg, log, spawnImpl });
    this.claudeDir = () => undefined;
    this.active = new Map(); // btw id -> { child, entry }
    this.onUpdate = null;
  }

  get activeCount() {
    return this.active.size;
  }

  runningFor(convId) {
    return [...this.active.values()].some((a) => a.convId === convId);
  }

  /**
   * Starts one side question; resolves when it is registered. `entry` is updated in place
   * (answer text as it streams, then status) and `onUpdate(convId, entry, done)` is called.
   */
  ask(conv, { question, anchorId, resume, cwd, model, effort, progress }) {
    if (this.runningFor(conv.id)) throw Object.assign(new Error('上一个旁路提问还没有回答完'), { status: 409 });
    if (this.active.size >= MAX_ACTIVE) throw Object.assign(new Error('同时进行的旁路提问太多，请稍后再试'), { status: 429 });
    const entry = {
      id: randomUUID(), question, answer: '', status: 'running', anchorId, createdAt: new Date().toISOString(),
      model: model || null, live: Boolean(progress),
    };
    conv.btw = [...(conv.btw || []), entry].slice(-MAX_PER_CHAT);
    const system = [...PROMPT, ...(progress ? ['', '主任务当前这一轮还在进行，已经完成的进度如下：', progress] : [])].join('\n');
    const args = [
      ...this.cfg.claudePrefixArgs,
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--no-session-persistence', '--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob', '--strict-mcp-config',
      '--append-system-prompt', system,
    ];
    if (resume?.sessionId) {
      args.push('--resume', resume.sessionId, '--fork-session');
      if (resume.at) args.push('--resume-session-at', resume.at);
    }
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    let child;
    try {
      child = this.spawnImpl(this.cfg.claudeBin, args, { cwd, env: claudeEnv(this.claudeDir()), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.end(conv, entry, 'error', `无法启动 Claude：${err.message}`);
      return entry;
    }
    const slot = { child, entry, convId: conv.id };
    this.active.set(entry.id, slot);
    let buf = '';
    let streamed = '';
    let stderr = '';
    let lastPush = 0;
    const timer = setTimeout(() => {
      this.end(conv, entry, 'error', '旁路提问超时（3 分钟）');
      child.kill('SIGTERM');
    }, TIMEOUT_MS);
    slot.timer = timer;
    child.stdin.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') {
          streamed += m.event.delta.text || '';
          entry.answer = streamed.slice(0, MAX_ANSWER);
          if (Date.now() - lastPush > 300) { lastPush = Date.now(); this.onUpdate?.(conv, entry, false); }
        } else if (m.type === 'stream_event' && m.event?.type === 'message_start' && streamed && !streamed.endsWith('\n')) {
          // A new assistant message after a tool call: keep the answers apart.
          streamed += '\n\n';
        } else if (m.type === 'control_request') {
          // dontAsk mode should never ask; refuse anything that does.
          child.stdin.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'deny', message: '旁路提问只能读取文件。' } } })}\n`);
        } else if (m.type === 'result') {
          if (typeof m.total_cost_usd === 'number') entry.costUsd = m.total_cost_usd;
          if (m.is_error || m.subtype !== 'success') this.end(conv, entry, 'error', String(m.result || `Claude 返回错误（${m.subtype}）`).slice(0, 300));
          else {
            if (typeof m.result === 'string' && m.result.trim() && !streamed.trim()) entry.answer = m.result.slice(0, MAX_ANSWER);
            this.end(conv, entry, 'done');
          }
          child.stdin.end();
        }
      }
    });
    child.on('error', (err) => this.end(conv, entry, 'error', `无法启动 Claude：${err.message}`));
    child.on('close', (code, signal) => {
      if (entry.status === 'running') {
        this.log.warn(`旁路提问失败 conv=${conv.id} code=${code} signal=${signal}: ${stderr.trim().slice(-300)}`);
        this.end(conv, entry, 'error', `Claude 进程意外退出（${signal || `代码 ${code}`}）`);
      }
      clearTimeout(timer);
      this.active.delete(entry.id);
    });
    child.stdin.write(`${JSON.stringify({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: question }, parent_tool_use_id: null, session_id: 'default' })}\n`);
    this.log.info(`旁路提问开始 conv=${conv.id} btw=${entry.id} pid=${child.pid ?? '-'}`);
    return entry;
  }

  end(conv, entry, status, error) {
    if (entry.status !== 'running') return;
    entry.status = status;
    if (error) entry.error = error;
    entry.finishedAt = new Date().toISOString();
    const slot = this.active.get(entry.id);
    if (slot) clearTimeout(slot.timer);
    this.onUpdate?.(conv, entry, true);
  }

  /** Stops a side question (deleted, or its chat deleted). */
  cancel(id) {
    const slot = this.active.get(id);
    if (!slot) return false;
    slot.entry.status = 'error';
    slot.entry.error = '已取消';
    slot.child.kill('SIGTERM');
    clearTimeout(slot.timer);
    this.active.delete(id);
    return true;
  }

  shutdown() {
    for (const id of [...this.active.keys()]) this.cancel(id);
  }
}
