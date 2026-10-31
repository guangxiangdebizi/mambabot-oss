// Stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// Behaviour is chosen by the user prompt: slow | steps | background | tool | crash | args | echo | (default).
// A user message that arrives mid-turn is queued and taken in at the next step, as the CLI does.
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const has = (name) => args.includes(name);
// --fork-session gives the continued conversation a new id, as the real CLI does.
const sessionId = (has('--fork-session') ? null : flag('--resume')) || randomUUID();
export const MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'Fastest', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Old' },
];
const RESOLVED = Object.fromEntries(MODELS.map((m) => [m.value, m.resolvedModel]));
const runtimeModel = process.env.FAKE_WRONG_MODEL || RESOLVED[flag('--model') || 'default'] || flag('--model');
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const pending = new Map();
let interrupted = false;
let slowTimer = null;
const queue = [];
let busy = false;
let wake = null;
let backgroundRunning = false;
let stdinEnded = false;

const textOf = (content) => (typeof content === 'string' ? content
  : content.map((b) => (b.type === 'text' ? b.text : `[${b.type}:${b.source?.media_type}]`)).join(' '));

/** --replay-user-messages: each user message is echoed (with its uuid) when it is taken in. */
function replay(m) {
  if (has('--replay-user-messages')) out({ type: 'user', isReplay: true, uuid: m.uuid, message: m.message, session_id: sessionId });
}

function take(m) {
  if (busy) {
    queue.push(m);
    wake?.();
    return;
  }
  busy = true;
  // The real CLI echoes a slash command only after running it.
  const command = textOf(m.message.content).startsWith('/');
  if (!command && !m.notification) replay(m);
  onUser(m.message.content).then((keepBusy) => {
    if (command) replay(m);
    return keepBusy;
  }).then((keepBusy) => {
    if (keepBusy) return;
    busy = false;
    const next = queue.shift();
    if (next) take(next);
  });
}

function result(text, extra = {}) {
  out({
    type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, permission_denials: [],
    total_cost_usd: 0.0125, duration_ms: 1200,
    modelUsage: { [runtimeModel]: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40, costUSD: 0.0125, contextWindow: 1000000 } },
    ...extra,
  });
}

function streamText(id, chunks) {
  out({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
  for (const t of chunks) out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } });
  out({ type: 'assistant', uuid: randomUUID(), message: { id, model: runtimeModel, content: [{ type: 'text', text: chunks.join('') }] } });
}

function askPermission(toolName, input) {
  const requestId = randomUUID();
  out({ type: 'control_request', request_id: requestId, request: {
    subtype: 'can_use_tool', tool_name: toolName, input, description: 'echo hi', tool_use_id: 'toolu_1',
    decision_reason: 'Process substitution requires manual approval', decision_reason_type: 'safetyCheck',
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'localSettings' }],
  } });
  return new Promise((resolve) => pending.set(requestId, resolve));
}

/** Resolves true while the turn keeps running in the background (slow). */
async function onUser(content) {
  const text = textOf(content);
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: runtimeModel });
  if (text.includes('crash')) process.exit(3);
  if (text.startsWith('/compact')) {
    out({ type: 'system', subtype: 'status', status: 'compacting', session_id: sessionId, uuid: randomUUID() });
    out({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: sessionId, uuid: randomUUID() });
    out({ type: 'system', subtype: 'compact_boundary', session_id: sessionId, uuid: randomUUID(), compact_metadata: { trigger: 'manual', pre_tokens: 21627, post_tokens: 6081, duration_ms: 900 } });
    out({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }, session_id: sessionId, uuid: 'replay-uuid', isReplay: true });
    result('', { local_command: 'compact', total_cost_usd: 0.05 });
    return;
  }
  if (text.includes('slow')) {
    out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_slow' } } });
    let n = 0;
    slowTimer = setInterval(() => {
      if (interrupted) return;
      n += 1;
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `第${n}行\n` } } });
    }, 40);
    return true;
  }
  if (text === '__task_notification') {
    streamText('msg_b2', ['woke']);
    result('woke');
    backgroundRunning = false;
    if (stdinEnded) setImmediate(() => process.exit(0));
    return;
  }
  if (text.includes('background')) {
    // Ends the turn with a background task running; its completion starts one more turn, and
    // the process keeps running for it even after stdin ends, as the CLI does.
    backgroundRunning = true;
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash' }], session_id: sessionId });
    streamText('msg_b1', ['waiting']);
    result('waiting');
    setTimeout(() => {
      out({ type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: sessionId });
      take({ notification: true, message: { content: '__task_notification' } });
    }, Number(process.env.FAKE_BACKGROUND_MS || 1500));
    return;
  }
  if (text.includes('steps')) {
    // One tool step that lasts until a follow-up is queued (or 3 s), then the queue is taken in.
    out({ type: 'assistant', uuid: randomUUID(), message: { id: 'msg_s1', model: runtimeModel, content: [{ type: 'tool_use', id: 'toolu_s', name: 'Bash', input: { command: 'sleep 1' } }] } });
    await new Promise((resolve) => {
      wake = resolve;
      if (queue.length) resolve();
      setTimeout(resolve, 3000);
    });
    wake = null;
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_s', content: 'ok' }] } });
    const added = queue.splice(0).map((q) => { replay(q); return textOf(q.message.content); });
    streamText('msg_s2', [`done${added.map((t) => ` +${t}`).join('')}`]);
    result('done');
    return false;
  }
  if (text.includes('tool')) {
    out({ type: 'assistant', message: { id: 'msg_t1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } }] } });
    const decision = await askPermission('Bash', { command: 'echo hi' });
    const allowed = decision.behavior === 'allow';
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: !allowed, content: allowed ? 'hi' : decision.message } ] } });
    const rules = decision.updatedPermissions?.map((u) => `${u.destination}:${u.rules[0].toolName}`).join(',');
    const word = allowed ? `allowed${rules ? `+${rules}` : ''}` : 'denied';
    streamText('msg_t2', [word]);
    result(word);
    return;
  }
  if (text.includes('args')) {
    const s = `resume=${flag('--resume') || ''} at=${flag('--resume-session-at') || ''} fork=${has('--fork-session')} model=${flag('--model') || ''} effort=${flag('--effort') || ''} mode=${flag('--permission-mode')} prompt=${flag('--permission-prompt-tool')}`;
    streamText('msg_a', [s]);
    result(s);
    return;
  }
  if (text.includes('echo')) {
    streamText('msg_e', [`echo:${text}`]);
    result('echo');
    return;
  }
  streamText('msg_1', ['你好，', '世界']);
  result('你好，世界');
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.type === 'control_request' && m.request.subtype === 'initialize') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {
        models: MODELS,
        account: { email: 'owner@example.test', organization: 'Test Org', subscriptionType: 'Claude Pro', apiProvider: 'firstParty' },
        claude_code_version: '9.9.9',
        commands: [
          { name: 'compact', description: 'Free up context', argumentHint: '<instructions>' },
          { name: 'usage', description: 'Show plan usage', argumentHint: '' },
          { name: '__internal', description: 'hidden', argumentHint: '' },
        ],
      } } });
    } else if (m.type === 'control_request' && m.request.subtype === 'get_usage') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {
        subscription_type: 'pro', rate_limits_available: true,
        rate_limits: {
          extra_usage: { is_enabled: false },
          limits: [
            { kind: 'session', group: 'session', percent: 9, severity: 'normal', resets_at: '2026-10-28T12:20:00.487730+00:00' },
            { kind: 'weekly_all', group: 'weekly', percent: 11, severity: 'normal', resets_at: '2026-10-28T16:00:00+00:00' },
          ],
        },
      } } });
    } else if (m.type === 'control_request' && m.request.subtype === 'get_context_usage') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {
        categories: [
          { id: 'system_prompt', name: 'System prompt', tokens: 3201, kind: 'used' },
          { id: 'system_tools_deferred', name: 'System tools (deferred)', tokens: 15070, kind: 'deferred' },
          { id: 'messages', name: 'Messages', tokens: flag('--resume') ? 168703 : 0, kind: 'used' },
          { id: 'free_space', name: 'Free space', tokens: 784796, kind: 'free' },
        ],
        totalTokens: flag('--resume') ? 182204 : 13500, maxTokens: 1000000, percentage: flag('--resume') ? 18 : 1, model: runtimeModel,
        args: { resume: flag('--resume'), at: flag('--resume-session-at'), fork: has('--fork-session'), persist: !has('--no-session-persistence') },
      } } });
    } else if (m.type === 'control_request' && m.request.subtype === 'interrupt') {
      interrupted = true;
      clearInterval(slowTimer);
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: sessionId, permission_denials: [] });
    } else if (m.type === 'control_response') {
      pending.get(m.response.request_id)?.(m.response.response);
      pending.delete(m.response.request_id);
    } else if (m.type === 'user') {
      take(m);
    }
  }
});
process.stdin.on('end', () => {
  stdinEnded = true;
  if ((!slowTimer || interrupted) && !backgroundRunning) process.exit(0);
});
process.on('SIGTERM', () => process.exit(143));
