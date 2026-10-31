import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StreamTranslator, approvalDetail, summarizeTool } from './stream.js';

const RECENT_KEEP_MS = 2 * 60 * 1000;
const STDERR_KEEP = 2000;
// After the last background task ends Claude Code normally starts a turn for its notification;
// if none starts within this time the reply is over.
const BACKGROUND_SETTLE_MS = 15 * 1000;

// Appended to Claude's system prompt on every web run. Facts about one particular host
// (machine, other sessions, SSH aliases, sudo) belong in `<configDir>/handoff.md`, which is
// appended after these lines when present.
const HANDOFF = [
  '你正在通过 MambaBot 网页界面为唯一的所有者工作，对方从手机或浏览器访问。',
  '网页端无法回答交互式提问。需要授权的工具调用会交给所有者在网页上允许或拒绝；被拒绝时说明影响并给出替代方案。',
  // Claude Code asks for these even under bypassPermissions; avoiding them keeps 完全放行 quiet.
  '写 Bash 命令时避开 Claude Code 在任何权限模式下（包括完全放行）都要人工确认的写法：不要把 cd 和写文件、重定向、rm 放进同一条命令（直接用绝对路径，或 git -C、make -C、--prefix 之类的参数）；rm 的目标写成不带通配符的绝对路径（要清空目录就 rm -rf 绝对路径后再 mkdir，或用 find 绝对路径 -delete）；不要用进程替换 <(...) 或 >(...)（改用临时文件、管道或 heredoc）；写入目标路径里不要用 $变量、~user、反引号或引号拼接。能拆成几条简单命令就拆开。',
];
const BROWSER_HANDOFF = [
  '浏览器：browseros-neo 工具连接的是这台服务器上的一个真实浏览器，所有者可以在网页右侧实时看到它。',
  '遇到登录、扫码、验证码、短信/邮件验证码或需要本人确认的步骤时，不要尝试绕过或自动化，也不要索要密码：调用 request_human_help（kind 选 login/captcha/approval/other，reason 用中文简述需要所有者做什么），然后反复调用 await_human_help 直到状态为 resolved，期间不要操作页面。',
  '所有者交还控制后，先用 snapshot 或 read 核实页面上确实已登录或已完成，再继续任务；没有核实之前不要声称登录成功。',
];
const TOOLS_HANDOFF = [
  '展示图片/文件：需要让所有者看到的截图、图表、生成的图片或文件，用 assistant-media 的 show_file 工具直接显示在回复里（图片内联显示，其他文件为下载卡片），不要只贴路径或用 Markdown 图片语法；网上的图片先下载到本机再展示。',
  '定时任务：所有者在网页“定时任务”里能看到和编辑的任务，用 assistant-tasks 工具查看、新建、修改、删除（cron 为 5 段表达式，按服务器本地时间）。不要用 CronCreate、系统 crontab 或 /loop 代替，它们在网页端不会持续存在或不可见。',
  '不要在回复中输出密码、令牌或私钥。默认使用简体中文回复。',
];

// Owner-selectable in 用量与设置. "manual" is the CLI's normal prompting mode; prompts are
// relayed to the page as approval cards in every mode that still prompts.
export const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'bypassPermissions'];
const MODE_NOTE = {
  manual: '当前权限模式：逐条确认。',
  acceptEdits: '当前权限模式：自动允许文件编辑，其他需要授权的操作仍由所有者在网页上确认。',
  auto: '当前权限模式：auto，由 Claude Code 自动判断，拿不准的操作仍由所有者在网页上确认。',
  bypassPermissions: '当前权限模式：完全放行，所有者选择了不逐条确认，工具调用（包括 sudo -n）会直接执行。正因为没有确认环节：删除数据、修改系统或服务配置、对外发送消息/发帖/付款这类不可逆操作，先在回复里说明并得到所有者明确同意再做。',
};

/** One Claude Code process per running reply, driven over the stream-json control channel. */
export class RunManager {
  constructor({ cfg, store, log = console, spawnImpl = spawn, catalog = null }) {
    Object.assign(this, { cfg, store, log, spawnImpl, catalog });
    this.onRunEnd = null;
    this.handoffExtra = '';
    this.active = new Map();
    this.recent = new Map();
    this.shuttingDown = false;
  }

  get activeCount() {
    return this.active.size;
  }

  isRunning(convId) {
    return this.active.has(convId);
  }

  publicState(convId) {
    const run = this.active.get(convId);
    return run ? { id: run.id, seq: run.seq, messageId: run.msg.id } : null;
  }

  /**
   * @param content string or Claude content blocks for the user turn
   * @param opts.model / opts.effort  validated selection, passed to the CLI as-is
   * @param opts.resume  { sessionId, at?, fork? } from resumePlan()
   */
  start(conv, message, content, {
    model = '', effort = '', resume = null, runId = randomUUID(), extraArgs = [], permissionMode = 'manual',
  } = {}) {
    const mode = PERMISSION_MODES.includes(permissionMode) ? permissionMode : 'manual';
    if (this.shuttingDown) throw new Error('服务正在重启');
    const run = {
      id: runId, conv, msg: message, seq: 0, events: [], listeners: new Set(),
      approvals: new Map(), stopRequested: false, finished: false, stderr: '', killTimers: [],
      // uuids of the user messages written to this process; their replays are not transcript tails.
      sent: new Set(), inputClosed: false,
      // Between turns (after a result) and the background tasks Claude left running: while any
      // run, Claude Code wakes the reply up again when they finish, so input stays open.
      idle: false, background: 0, settleTimer: null,
    };
    run.translator = new StreamTranslator(message, (ev) => this.emit(run, ev));
    this.active.set(conv.id, run);
    this.recent.delete(conv.id);

    const args = [
      ...this.cfg.claudePrefixArgs,
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages',
      // Echoes each user message when Claude Code takes it in: the delivery signal for follow-ups.
      '--replay-user-messages',
      // Normal approval behaviour: anything that would prompt in a terminal is sent to the owner.
      '--permission-mode', mode, '--permission-prompt-tool', 'stdio',
      // Session-scoped cron dies with this one-reply process; scheduled work uses assistant-tasks.
      '--disallowedTools', 'AskUserQuestion,CronCreate,CronDelete,CronList,ScheduleWakeup',
      '--append-system-prompt', this.handoff(mode),
    ];
    if (resume?.sessionId) {
      args.push('--resume', resume.sessionId);
      if (resume.at) args.push('--resume-session-at', resume.at);
      if (resume.fork) args.push('--fork-session');
    }
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    args.push(...extraArgs);

    const child = this.spawnImpl(this.cfg.claudeBin, args, {
      cwd: this.cfg.claudeCwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    run.child = child;
    child.stdin.on('error', () => {});
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) this.onLine(run, line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { run.stderr = (run.stderr + chunk).slice(-STDERR_KEEP); });
    child.on('error', (err) => {
      run.spawnError = err;
      this.finish(run, null, null);
    });
    child.on('close', (code, signal) => this.finish(run, code, signal));

    this.send(run, { type: 'control_request', request_id: `init_${run.id}`, request: { subtype: 'initialize', hooks: null } });
    this.sendUser(run, randomUUID(), content);
    this.log.info(`回复开始 conv=${conv.id} run=${run.id} pid=${child.pid ?? '-'}`);
    return run;
  }

  handoff(mode) {
    return [
      ...HANDOFF, `工作目录：${this.cfg.claudeCwd}。`,
      ...(this.cfg.browserEnabled ? BROWSER_HANDOFF : []), ...TOOLS_HANDOFF,
      ...(this.handoffExtra ? [this.handoffExtra] : []), MODE_NOTE[mode],
    ].join('\n');
  }

  /** A reply must never silently come from a different model than the one selected. */
  checkModel(run) {
    const { msg } = run;
    const want = msg.requested?.model && this.catalog?.find(msg.requested.model)?.resolvedModel;
    if (want && msg.modelUsed && msg.modelUsed !== want) {
      run.translator.pushPart({ type: 'notice', text: `注意：运行时实际使用的是 ${msg.modelUsed}，不是所选的 ${want}。` });
    }
  }

  /** A file Claude chose to show (assistant-media show_file), added to that run's reply. */
  addFile(runId, file) {
    const run = [...this.active.values()].find((r) => r.id === runId);
    if (!run || run.finished || run.stopRequested) return false;
    run.translator.pushPart({ type: 'file', ...file });
    return true;
  }

  /**
   * A message typed while the reply is running. As in the Claude Code terminal, the CLI adds it
   * to the turn after the current step (or starts one more turn if the reply already ended).
   * False once the process can no longer take input.
   */
  followup(convId, entry, content) {
    const run = this.active.get(convId);
    if (!run || run.finished || run.stopRequested || run.terminated || run.inputClosed) return false;
    run.msg.queued = [...(run.msg.queued || []), entry];
    this.emit(run, { type: 'meta', queued: run.msg.queued });
    this.sendUser(run, entry.id, content);
    return true;
  }

  sendUser(run, uuid, content) {
    run.sent.add(uuid);
    this.send(run, { type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null, session_id: 'default' });
  }

  /** Claude Code took a queued follow-up in: it moves into the reply where Claude saw it. */
  delivered(run, uuid) {
    const queued = run.msg.queued || [];
    const entry = queued.find((q) => q.id === uuid);
    if (!entry) return;
    run.msg.queued = queued.filter((q) => q !== entry);
    run.translator.pushPart({ type: 'followup', ...entry });
    this.emit(run, { type: 'meta', queued: run.msg.queued });
  }

  send(run, obj) {
    if (run.finished || !run.child?.stdin?.writable) return;
    run.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  emit(run, ev) {
    ev.seq = ++run.seq;
    run.events.push(ev);
    for (const listener of run.listeners) listener(ev);
    if (ev.type !== 'end') this.store.scheduleSave(run.conv);
  }

  setStatus(run, status, error) {
    run.msg.status = status;
    if (error) run.msg.error = error;
    this.emit(run, { type: 'status', status, ...(error ? { error } : {}) });
  }

  onLine(run, line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.type === 'control_request') return this.onControlRequest(run, m);
    if (m.type === 'control_cancel_request') return this.resolveApproval(run, this.approvalByRequest(run, m.request_id), 'expired', false);
    if (m.type === 'control_response') {
      if (m.response?.request_id === `init_${run.id}`) this.catalog?.update(m.response.response?.models);
      return undefined;
    }
    if (m.type === 'user' && m.isReplay && run.sent.has(m.uuid)) return this.delivered(run, m.uuid);
    run.translator.handle(m);
    if (m.type === 'system' && m.subtype === 'init') {
      run.idle = false;
      this.noteWaiting(run);
    } else if (m.type === 'system' && m.subtype === 'background_tasks_changed') {
      run.background = Array.isArray(m.tasks) ? m.tasks.length : 0;
      this.noteWaiting(run);
      if (!run.background && run.idle) {
        clearTimeout(run.settleTimer);
        run.settleTimer = setTimeout(() => this.closeInputIfDone(run), BACKGROUND_SETTLE_MS);
      }
    } else if (m.type === 'result') {
      run.idle = true;
      this.noteWaiting(run);
      this.closeInputIfDone(run);
    }
    return undefined;
  }

  /**
   * Stream-json input keeps the process alive for more turns; one reply per process, which ends
   * after a result once no follow-up waits for its turn and no background task can wake it up.
   */
  closeInputIfDone(run) {
    if (!run.idle || run.inputClosed || run.msg.queued?.length || run.background) return;
    run.inputClosed = true;
    run.child.stdin.end();
  }

  /** Tells the page the reply is waiting on background tasks (and still takes messages). */
  noteWaiting(run) {
    const background = run.idle ? run.background : 0;
    if ((run.msg.background || 0) === background) return;
    if (background) run.msg.background = background;
    else delete run.msg.background;
    this.emit(run, { type: 'meta', background });
  }

  onControlRequest(run, m) {
    const req = m.request || {};
    if (req.subtype !== 'can_use_tool') {
      this.send(run, { type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: '网页端不支持这个请求' } });
      return;
    }
    if (run.stopRequested) {
      this.send(run, this.permissionResponse(m.request_id, req.input, 'deny', '所有者已停止这个任务。'));
      return;
    }
    const approvalId = randomUUID();
    // Claude Code's own "don't ask again" suggestions, applied only to this process (one reply).
    const suggestions = (Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [])
      .filter((x) => x && x.type === 'addRules' && x.behavior === 'allow')
      .map((x) => ({ ...x, destination: 'session' }));
    const index = run.translator.pushPart({
      type: 'approval', id: approvalId, tool: req.tool_name,
      summary: req.description || summarizeTool(req.tool_name, req.input),
      detail: approvalDetail(req.tool_name, req.input), state: 'pending', canAllowForRun: suggestions.length > 0,
      ...(decisionReason(req) ? { reason: decisionReason(req), safetyCheck: req.decision_reason_type === 'safetyCheck' } : {}),
    });
    const timer = setTimeout(() => this.resolveApproval(run, approvalId, 'expired'), this.cfg.approvalTimeoutMs);
    run.approvals.set(approvalId, { requestId: m.request_id, index, input: req.input, timer, suggestions });
  }

  approvalByRequest(run, requestId) {
    for (const [id, a] of run.approvals) if (a.requestId === requestId) return id;
    return null;
  }

  permissionResponse(requestId, input, decision, message, updatedPermissions = null) {
    const response = decision === 'allow'
      ? { behavior: 'allow', updatedInput: input, ...(updatedPermissions?.length ? { updatedPermissions } : {}) }
      : { behavior: 'deny', message };
    return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
  }

  resolveApproval(run, approvalId, decision, reply = true) {
    const a = approvalId && run.approvals.get(approvalId);
    if (!a) return false;
    run.approvals.delete(approvalId);
    clearTimeout(a.timer);
    const part = run.msg.parts[a.index];
    part.state = { allow: 'allowed', allow_run: 'allowed_run', deny: 'denied' }[decision] || 'expired';
    run.translator.updatePart(a.index);
    if (reply) {
      const message = decision === 'deny' ? '所有者在网页上拒绝了这个操作。' : '授权请求已失效，操作未执行。';
      const allow = decision === 'allow' || decision === 'allow_run';
      this.send(run, this.permissionResponse(a.requestId, a.input, allow ? 'allow' : 'deny', message, decision === 'allow_run' ? a.suggestions : null));
    }
    return true;
  }

  decide(convId, approvalId, decision) {
    const run = this.active.get(convId);
    if (!run || run.stopRequested) return false;
    return this.resolveApproval(run, approvalId, ['allow', 'allow_run'].includes(decision) ? decision : 'deny');
  }

  stop(convId) {
    const run = this.active.get(convId);
    if (!run || run.stopRequested) return Boolean(run);
    run.stopRequested = true;
    for (const id of [...run.approvals.keys()]) this.resolveApproval(run, id, 'deny');
    this.setStatus(run, 'stopping');
    this.terminate(run);
    return true;
  }

  /** Interrupt politely, then escalate; bounded so a stuck process cannot hold a run. */
  terminate(run) {
    run.terminated = true;
    this.send(run, { type: 'control_request', request_id: `stop_${run.id}`, request: { subtype: 'interrupt' } });
    run.child?.stdin?.end();
    const grace = this.cfg.stopGraceMs;
    run.killTimers.push(setTimeout(() => run.child?.kill('SIGTERM'), grace));
    run.killTimers.push(setTimeout(() => run.child?.kill('SIGKILL'), grace * 2));
  }

  finish(run, code, signal) {
    if (run.finished) return;
    const { msg, conv, translator } = run;
    for (const id of [...run.approvals.keys()]) this.resolveApproval(run, id, 'expired', false);
    run.finished = true;
    clearTimeout(run.settleTimer);
    delete msg.background;
    // Kept in the reply so the text is not lost, marked as never seen by Claude.
    if (msg.queued?.length) {
      for (const entry of msg.queued) translator.pushPart({ type: 'followup', ...entry, undelivered: true });
      delete msg.queued;
      this.emit(run, { type: 'meta', queued: [] });
    }
    run.killTimers.forEach(clearTimeout);
    if (translator.sessionId) {
      msg.sessionId = translator.sessionId;
      // Only a cleanly finished reply is a safe point to fork the session from later.
      if (translator.tailUuid && translator.result && !translator.result.is_error && !run.stopRequested && !run.terminated) {
        msg.tailUuid = translator.tailUuid;
      }
      msg.tipKey = translator.tailUuid || `run:${run.id}`;
      conv.tips = conv.tips || {};
      conv.tips[translator.sessionId] = msg.tipKey;
    }
    this.checkModel(run);

    const result = translator.result;
    let status = 'done';
    let error;
    if (run.stopRequested) {
      status = 'stopped';
    } else if (run.terminated) {
      status = 'interrupted';
      error = '服务在回复过程中重启，这条回复已中断。';
    } else if (run.spawnError) {
      status = 'error';
      error = '无法启动 Claude，请检查服务配置。';
    } else if (!result) {
      status = 'error';
      error = `Claude 进程意外退出（${signal || `代码 ${code}`}）。`;
    } else if (result.is_error || result.subtype !== 'success') {
      status = 'error';
      error = clipError(result.result) || `Claude 返回错误（${result.subtype}）。`;
    }
    const denials = result?.permission_denials || [];
    if (denials.length && status !== 'stopped') {
      const names = [...new Set(denials.map((d) => d.tool_name))].join('、');
      translator.pushPart({ type: 'notice', text: `以下操作未获授权，没有执行：${names}` });
    }
    if (status !== 'done' && status !== 'stopped' && run.stderr) {
      this.log.warn(`回复失败 conv=${conv.id} run=${run.id} code=${code} signal=${signal}: ${run.stderr.trim().slice(-500)}`);
    }
    msg.finishedAt = new Date().toISOString();
    this.store.touch(conv);
    this.setStatus(run, status, error);
    this.active.delete(conv.id);
    this.recent.set(conv.id, run);
    setTimeout(() => { if (this.recent.get(conv.id) === run) this.recent.delete(conv.id); }, RECENT_KEEP_MS).unref();
    this.log.info(`回复结束 conv=${conv.id} run=${run.id} status=${status}`);
    // `end` is only sent once the final state is on disk.
    Promise.resolve(this.onRunEnd?.(run)).catch(() => {});
    const done = () => {
      this.emit(run, { type: 'end' });
      run.listeners.clear();
      run.onFinished?.();
    };
    this.store.saveNow(conv).then(done, (err) => {
      this.log.error('保存对话失败', conv.id, err.message);
      done();
    });
  }

  /**
   * Replays events after `after`, then streams live ones. Returns null when the run is unknown
   * (the client should reload the conversation instead).
   */
  subscribe(convId, runId, after, listener) {
    const run = this.active.get(convId) || this.recent.get(convId);
    if (!run || run.id !== runId) return null;
    for (const ev of run.events) if (ev.seq > after) listener(ev);
    if (run.finished) return { live: false, unsubscribe() {} };
    run.listeners.add(listener);
    return { live: true, unsubscribe: () => run.listeners.delete(listener) };
  }

  async shutdown() {
    this.shuttingDown = true;
    await Promise.all([...this.active.values()].map((run) => new Promise((resolve) => {
      run.onFinished = resolve;
      this.terminate(run);
    })));
  }
}

/** Why Claude Code asks (e.g. a safety check that applies even under bypassPermissions). */
function decisionReason(req) {
  const r = req.decision_reason;
  const text = typeof r === 'string' ? r : (r && (r.reason || r.message)) || '';
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 300);
}

function clipError(text) {
  if (!text) return '';
  const s = String(text).trim();
  return s.length > 300 ? `${s.slice(0, 299)}…` : s;
}
