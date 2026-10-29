import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { describeCron, nextRun, parseCron } from '../src/schedule.js';
import { normalizeUsage } from '../src/account.js';
import { finalStatus, login, makeDirs, readEvents, request, startApp } from './helpers.js';

let dirs;
let ctx;
let cookie;

before(async () => {
  dirs = await makeDirs();
  ctx = await startApp(dirs);
  cookie = await login(ctx.port, ctx.password);
});
after(async () => {
  await ctx.app.close();
  await dirs.cleanup();
});

const api = (method, path, body) => request(ctx.port, method, path, { body, cookie });

function mcp(body, token, headers = {}, path = '/internal/mcp/tasks') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: ctx.port, method: 'POST', path,
      headers: { Host: `127.0.0.1:${ctx.port}`, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: t ? JSON.parse(t) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('cron parsing, next run and descriptions', () => {
  assert.throws(() => parseCron('* * *'), /5 段/);
  assert.throws(() => parseCron('60 * * * *'), /超出范围/);
  const from = new Date(2026, 9, 28, 15, 41, 30); // Wed 28 Oct 2026 15:41:30 local
  assert.equal(nextRun('0 9 * * *', from).getTime(), new Date(2026, 9, 29, 9, 0).getTime());
  assert.equal(nextRun('*/15 * * * *', from).getTime(), new Date(2026, 9, 28, 15, 45).getTime());
  assert.equal(nextRun('30 8 * * 1', from).getTime(), new Date(2026, 10, 2, 8, 30).getTime(), 'next Monday');
  assert.equal(nextRun('0 0 1 * *', from).getTime(), new Date(2026, 10, 1, 0, 0).getTime());
  // day-of-month OR day-of-week when both are restricted
  assert.equal(nextRun('0 12 30 * 5', from).getTime(), new Date(2026, 9, 30, 12, 0).getTime());
  assert.equal(nextRun('0 0 31 2 *', from), null, 'never fires');
  assert.equal(describeCron('0 9 * * *'), '每天 09:00');
  assert.equal(describeCron('30 18 * * 1-5'), '工作日 18:30');
  assert.equal(describeCron('0 8 * * 1,3'), '每周一、周三 08:00');
  assert.equal(describeCron('*/10 * * * *'), '每 10 分钟');
});

test('usage payload is reduced to limits with reset times', () => {
  const u = normalizeUsage({
    subscription_type: 'pro',
    rate_limits: { five_hour: { utilization: 9, resets_at: '2026-10-28T12:20:00+00:00' }, seven_day: { utilization: 11.6, resets_at: '2026-10-28T16:00:00+00:00' } },
  });
  assert.equal(u.available, true);
  assert.deepEqual(u.limits.map((l) => [l.kind, l.percent]), [['session', 9], ['weekly_all', 12]]);
  assert.equal(u.limits[0].resetsAt, '2026-10-28T12:20:00.000Z');
});

test('account, usage and commands come from the CLI and need a session', async () => {
  assert.equal((await request(ctx.port, 'GET', '/api/account')).status, 401);
  assert.equal((await request(ctx.port, 'GET', '/api/commands')).status, 401);
  assert.equal((await request(ctx.port, 'GET', '/api/tasks')).status, 401);
  const r = await api('GET', '/api/account');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.account.plan, 'Claude Pro');
  assert.equal(r.json.version, '9.9.9');
  assert.deepEqual(r.json.usage.limits.map((l) => [l.kind, l.percent]), [['session', 9], ['weekly_all', 11]]);
  assert.equal(r.json.commands, undefined, 'commands are served separately');
  const c = await api('GET', '/api/commands');
  assert.deepEqual(c.json.commands.map((x) => x.name), ['compact', 'usage']);
});

test('tasks: create, validate, preview, edit, run now, delete', async () => {
  assert.equal((await api('POST', '/api/tasks', { name: 'x', prompt: 'p', cron: '61 * * * *' })).status, 400);
  assert.equal((await api('POST', '/api/tasks', { name: '', prompt: 'p', cron: '0 9 * * *' })).status, 400);
  assert.equal((await api('POST', '/api/tasks', { name: 'x', prompt: 'p', cron: '0 9 * * *', model: 'nope' })).status, 400);
  const preview = await api('POST', '/api/tasks/preview', { cron: '0 9 * * 1-5' });
  assert.equal(preview.json.text, '工作日 09:00');
  assert.equal(preview.json.next.length, 3);

  const created = await api('POST', '/api/tasks', { name: '晨报', prompt: '你好', cron: '0 9 * * *', target: 'same' });
  assert.equal(created.status, 201, created.text);
  const task = created.json.task;
  assert.equal(task.createdBy, 'owner');
  assert.ok(Date.parse(task.nextRunAt) > Date.now());

  const edited = await api('PATCH', `/api/tasks/${task.id}`, { cron: '30 7 * * *', enabled: false });
  const t2 = edited.json.tasks.find((t) => t.id === task.id);
  assert.equal(t2.cron, '30 7 * * *');
  assert.equal(t2.enabled, false);
  assert.equal(t2.nextRunAt, null, 'disabled tasks are not scheduled');
  assert.equal(t2.scheduleText, '每天 07:30');

  const ran = await api('POST', `/api/tasks/${task.id}/run`, {});
  assert.equal(ran.status, 200, ran.text);
  const convId = ran.json.task.lastConversationId;
  const conv = (await api('GET', `/api/conversations/${convId}`)).json.conversation;
  assert.equal(conv.title, '定时：晨报');
  const user = conv.messages.find((m) => m.role === 'user');
  assert.equal(user.scheduledTask.id, task.id);
  const { events } = await readEvents(ctx.port, `/api/conversations/${convId}/events?run=${conv.run.id}&after=0`, cookie);
  assert.equal(finalStatus(events), 'done');

  // target "same": the next run continues the same conversation
  const again = await api('POST', `/api/tasks/${task.id}/run`, {});
  assert.equal(again.json.task.lastConversationId, convId);
  const conv2 = (await api('GET', `/api/conversations/${convId}`)).json.conversation;
  await readEvents(ctx.port, `/api/conversations/${convId}/events?run=${conv2.run.id}&after=0`, cookie);
  assert.equal((await api('GET', `/api/conversations/${convId}`)).json.conversation.messages.filter((m) => m.role === 'user').length, 2);

  assert.equal((await api('DELETE', `/api/tasks/${task.id}`)).status, 200);
  assert.equal((await api('DELETE', `/api/tasks/${task.id}`)).status, 400);
});

test('the scheduler fires due tasks on its tick', async () => {
  const { task } = (await api('POST', '/api/tasks', { name: '到点', prompt: '你好', cron: '*/5 * * * *' })).json;
  const live = ctx.app.scheduler.get(task.id);
  live.nextRunAt = new Date(Date.now() - 1000).toISOString();
  await ctx.app.scheduler.tick();
  assert.equal(live.lastStatus, 'started');
  assert.ok(live.lastConversationId);
  assert.ok(Date.parse(live.nextRunAt) > Date.now(), 'rescheduled');
  const conv = (await api('GET', `/api/conversations/${live.lastConversationId}`)).json.conversation;
  if (conv.run) await readEvents(ctx.port, `/api/conversations/${conv.id}/events?run=${conv.run.id}&after=0`, cookie);
  await api('DELETE', `/api/tasks/${task.id}`);
});

test('Claude can manage tasks through the per-run MCP endpoint only', async () => {
  assert.equal((await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  const entry = ctx.app.taskMcp.serverFor('run-test');
  const token = entry.headers.Authorization.slice(7);
  assert.equal((await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, token, { 'X-Real-IP': '1.2.3.4' })).status, 404, 'never via the proxy');

  const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, token);
  assert.equal(init.json.result.serverInfo.name, 'assistant-tasks');
  assert.equal((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, token)).status, 202);
  const list = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, token);
  assert.deepEqual(list.json.result.tools.map((t) => t.name), ['list_scheduled_tasks', 'create_scheduled_task', 'update_scheduled_task', 'delete_scheduled_task']);

  const call = (id, name, args) => mcp({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, token);
  const created = await call(3, 'create_scheduled_task', { name: '周报', prompt: '总结本周', cron: '0 18 * * 5' });
  const createdTask = JSON.parse(created.json.result.content[0].text).created;
  assert.equal(createdTask.schedule, '每周五 18:00');
  const bad = await call(4, 'update_scheduled_task', { id: createdTask.id, cron: 'nope' });
  assert.equal(bad.json.result.isError, true);
  await call(5, 'update_scheduled_task', { id: createdTask.id, prompt: '总结本周并列出下周计划' });
  const owner = (await api('GET', '/api/tasks')).json.tasks.find((t) => t.id === createdTask.id);
  assert.equal(owner.createdBy, 'claude');
  assert.equal(owner.prompt, '总结本周并列出下周计划');
  await call(6, 'delete_scheduled_task', { id: createdTask.id });
  assert.equal((await api('GET', '/api/tasks')).json.tasks.some((t) => t.id === createdTask.id), false);

  ctx.app.taskMcp.runEnded('run-test');
  assert.equal((await mcp({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, token)).status, 401, 'token dies with the run');
});

test('task model and effort can be set and changed independently', async () => {
  const { task } = (await api('POST', '/api/tasks', { name: '强度', prompt: 'p', cron: '0 9 * * *' })).json;
  assert.equal(task.model, null);
  assert.equal(task.effort, null);
  const get = async () => (await api('GET', '/api/tasks')).json.tasks.find((t) => t.id === task.id);
  // effort alone, following the default model
  assert.equal((await api('PATCH', `/api/tasks/${task.id}`, { effort: 'high' })).status, 200);
  assert.equal((await get()).effort, 'high');
  assert.equal((await api('PATCH', `/api/tasks/${task.id}`, { effort: 'turbo' })).status, 400);
  // explicit model keeps a compatible effort
  await api('PATCH', `/api/tasks/${task.id}`, { model: 'haiku' });
  assert.deepEqual([(await get()).model, (await get()).effort], ['haiku', 'high']);
  assert.equal((await api('PATCH', `/api/tasks/${task.id}`, { effort: 'max' })).status, 400, 'haiku has no max');
  // a model without effort levels drops the stale level instead of failing
  await api('PATCH', `/api/tasks/${task.id}`, { model: 'claude-haiku-4-5-20251001' });
  assert.deepEqual([(await get()).model, (await get()).effort], ['claude-haiku-4-5-20251001', null]);
  await api('PATCH', `/api/tasks/${task.id}`, { model: null });
  assert.equal((await get()).model, null);
  await api('DELETE', `/api/tasks/${task.id}`);

  const token = ctx.app.taskMcp.serverFor('run-info').headers.Authorization.slice(7);
  const listed = await mcp({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'list_scheduled_tasks', arguments: {} } }, token);
  const info = JSON.parse(listed.json.result.content[0].text);
  assert.deepEqual(info.defaults, { model: 'default', effort: null });
  assert.ok(info.models.some((m) => m.value === 'haiku' && m.efforts.includes('high')));
  ctx.app.taskMcp.runEnded('run-info');
});

test('shares: read-only public snapshot, refresh keeps the link, revoke and delete end it', async () => {
  const conv = (await api('POST', '/api/conversations', {})).json.conversation;
  assert.equal((await api('POST', `/api/conversations/${conv.id}/share`, {})).status, 400, 'nothing to share yet');
  const sent = (await api('POST', `/api/conversations/${conv.id}/messages`, { text: '你好' })).json;
  await readEvents(ctx.port, `/api/conversations/${conv.id}/events?run=${sent.run.id}&after=0`, cookie);

  assert.equal((await request(ctx.port, 'POST', `/api/conversations/${conv.id}/share`, { body: {} })).status, 401);
  const created = (await api('POST', `/api/conversations/${conv.id}/share`, {})).json.share;
  assert.match(created.token, /^[A-Za-z0-9_-]{22,}$/);
  assert.equal(created.messageCount, 2);

  const pub = await request(ctx.port, 'GET', `/api/share/${created.token}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers['x-robots-tag'], 'noindex, nofollow');
  assert.deepEqual(pub.json.messages.map((m) => [m.role, m.text]), [['user', '你好'], ['assistant', '你好，世界']]);
  assert.ok(!/sessionId|claudeSessionId|tipKey|parentId/.test(pub.text), 'no internal fields');
  const page = await request(ctx.port, 'GET', `/s/${created.token}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /share\.js/);
  assert.equal((await request(ctx.port, 'GET', '/s/short')).status, 404);
  assert.equal((await request(ctx.port, 'GET', `/api/share/${'x'.repeat(30)}`)).status, 404);

  const sent2 = (await api('POST', `/api/conversations/${conv.id}/messages`, { text: 'echo 第二轮', parentId: sent.assistantMessage.id })).json;
  await readEvents(ctx.port, `/api/conversations/${conv.id}/events?run=${sent2.run.id}&after=0`, cookie);
  assert.equal((await request(ctx.port, 'GET', `/api/share/${created.token}`)).json.messages.length, 2, 'snapshot does not follow new messages');
  const refreshed = (await api('POST', `/api/conversations/${conv.id}/share`, {})).json.share;
  assert.equal(refreshed.token, created.token);
  assert.equal(refreshed.messageCount, 4);
  assert.equal((await api('GET', '/api/shares')).json.shares.length, 1);

  assert.equal((await api('DELETE', `/api/shares/${created.token}`)).status, 200);
  assert.equal((await request(ctx.port, 'GET', `/api/share/${created.token}`)).status, 404);
  const again = (await api('POST', `/api/conversations/${conv.id}/share`, {})).json.share;
  assert.notEqual(again.token, created.token, 'a revoked link is never revived');
  await api('DELETE', `/api/conversations/${conv.id}`);
  assert.equal((await request(ctx.port, 'GET', `/api/share/${again.token}`)).status, 404, 'deleting the chat ends its link');
});

test('permission mode is an owner setting that reaches the CLI', async () => {
  const before = (await api('GET', '/api/models')).json.prefs;
  assert.equal(before.permissionMode, 'auto', 'default for a new install');
  assert.equal((await api('PUT', '/api/prefs', { permissionMode: 'yolo' })).status, 400);
  assert.equal((await request(ctx.port, 'PUT', '/api/prefs', { body: { permissionMode: 'bypassPermissions' } })).status, 401);
  const r = await api('PUT', '/api/prefs', { permissionMode: 'bypassPermissions' });
  assert.equal(r.json.prefs.permissionMode, 'bypassPermissions');
  assert.equal(r.json.prefs.model, before.model, 'a partial update keeps the model');
  const conv = (await api('POST', '/api/conversations', {})).json.conversation;
  const sent = (await api('POST', `/api/conversations/${conv.id}/messages`, { text: 'args' })).json;
  const { events } = await readEvents(ctx.port, `/api/conversations/${conv.id}/events?run=${sent.run.id}&after=0`, cookie);
  assert.match(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), /mode=bypassPermissions/);
  await api('PUT', '/api/prefs', { permissionMode: 'manual' });
  const sent2 = (await api('POST', `/api/conversations/${conv.id}/messages`, { text: 'args', parentId: sent.assistantMessage.id })).json;
  const r2 = await readEvents(ctx.port, `/api/conversations/${conv.id}/events?run=${sent2.run.id}&after=0`, cookie);
  assert.match(r2.events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), /mode=manual/);
  // the model picker's own update still works and keeps the mode
  const m = await api('PUT', '/api/prefs', { model: 'haiku', effort: 'low' });
  assert.deepEqual([m.json.prefs.model, m.json.prefs.effort, m.json.prefs.permissionMode], ['haiku', 'low', 'manual']);
  await api('DELETE', `/api/conversations/${conv.id}`);
});

test('concurrency limit is an owner setting; memory info needs a session', async () => {
  assert.equal((await request(ctx.port, 'GET', '/api/system')).status, 401);
  const sys = (await api('GET', '/api/system')).json;
  assert.ok(sys.memTotalMb > 0 && sys.memAvailableMb > 0);
  assert.equal(sys.maxRuns, 2);
  for (const bad of [0, 7, 'x', 1.5]) assert.equal((await api('PUT', '/api/prefs', { maxRuns: bad })).status, 400, String(bad));
  assert.equal((await api('PUT', '/api/prefs', { maxRuns: 1 })).json.prefs.maxRuns, 1);
  const a = (await api('POST', '/api/conversations', {})).json.conversation;
  const b = (await api('POST', '/api/conversations', {})).json.conversation;
  const slow = (await api('POST', `/api/conversations/${a.id}/messages`, { text: 'slow' })).json;
  const busy = await api('POST', `/api/conversations/${b.id}/messages`, { text: '你好' });
  assert.equal(busy.status, 429);
  assert.match(busy.json.error, /1 个/);
  await api('PUT', '/api/prefs', { maxRuns: 2 });
  const ok = await api('POST', `/api/conversations/${b.id}/messages`, { text: '你好' });
  assert.equal(ok.status, 201, 'raising the limit applies immediately');
  await readEvents(ctx.port, `/api/conversations/${b.id}/events?run=${ok.json.run.id}&after=0`, cookie);
  await api('POST', `/api/conversations/${a.id}/stop`, {});
  await readEvents(ctx.port, `/api/conversations/${a.id}/events?run=${slow.run.id}&after=0`, cookie);
  await api('DELETE', `/api/conversations/${a.id}`);
  await api('DELETE', `/api/conversations/${b.id}`);
});

test('history list pages with a stable cursor and searches on the server', async () => {
  const made = [];
  for (let i = 0; i < 5; i += 1) {
    const c = (await api('POST', '/api/conversations', {})).json.conversation;
    await api('PATCH', `/api/conversations/${c.id}`, { title: `分页测试 ${i}` });
    made.push(c.id);
  }
  const all = (await api('GET', '/api/conversations')).json;
  assert.equal(all.nextCursor, undefined, 'no limit: everything, as before');
  const seen = [];
  let cursor = null;
  do {
    const page = (await api('GET', `/api/conversations?limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`)).json;
    assert.ok(page.conversations.length <= 2);
    seen.push(...page.conversations.map((c) => c.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(seen).size, seen.length, 'no duplicates across pages');
  assert.deepEqual(seen, all.conversations.map((c) => c.id), 'pages concatenate to the full, ordered list');
  const found = (await api('GET', `/api/conversations?limit=40&q=${encodeURIComponent('分页测试 3')}`)).json.conversations;
  assert.deepEqual(found.map((c) => c.title), ['分页测试 3']);
  for (const id of made) await api('DELETE', `/api/conversations/${id}`);
});

test('Claude can show the owner a file in its reply through the media MCP endpoint', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = join(dirs.root, 'pics');
  await mkdir(dir, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await writeFile(join(dir, 'chart.png'), png);
  await writeFile(join(dir, 'report.csv'), 'a,b\n1,2\n');

  const conv = (await api('POST', '/api/conversations', {})).json.conversation;
  const sent = (await api('POST', `/api/conversations/${conv.id}/messages`, { text: 'slow' })).json;
  const token = ctx.app.mediaMcp.serverFor(sent.run.id).headers.Authorization.slice(7);
  const media = (body, t = token, headers = {}) => mcp(body, t, headers, '/internal/mcp/media');
  assert.equal((await media({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'nope')).status, 401);
  assert.equal((await media({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, token, { 'X-Forwarded-For': '1.2.3.4' })).status, 404, 'never via the proxy');
  const list = await media({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.json.result.tools.map((t) => t.name), ['show_file']);

  const show = (id, args) => media({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'show_file', arguments: args } });
  const ok = await show(3, { path: join(dir, 'chart.png'), caption: '本周走势' });
  assert.equal(ok.json.result.isError, undefined, ok.text);
  assert.equal((await show(4, { path: 'pics/report.csv' })).json.result.isError, undefined, 'relative to the Claude working dir');
  assert.match((await show(5, { path: join(dir, 'missing.png') })).json.result.content[0].text, /不存在/);
  assert.match((await show(6, { path: dir })).json.result.content[0].text, /不能展示目录/);
  assert.match((await show(7, { path: join(dirs.configDir, 'auth.json') })).json.result.content[0].text, /凭据/);

  const live = (await api('GET', `/api/conversations/${conv.id}`)).json.conversation.messages.at(-1);
  const files = live.parts.filter((p) => p.type === 'file');
  assert.equal(files.length, 2);
  assert.deepEqual([files[0].attachment.name, files[0].attachment.image, files[0].caption], ['chart.png', true, '本周走势']);
  assert.deepEqual([files[1].attachment.type, files[1].attachment.image], ['text/csv', false]);
  const img = await api('GET', `/api/uploads/${files[0].attachment.id}`);
  assert.equal(img.headers['content-type'], 'image/png');
  const csv = await api('GET', `/api/uploads/${files[1].attachment.id}`);
  assert.equal(csv.headers['content-type'], 'application/octet-stream', 'non-images only download');

  await api('POST', `/api/conversations/${conv.id}/stop`, {});
  await readEvents(ctx.port, `/api/conversations/${conv.id}/events?run=${sent.run.id}&after=0`, cookie);
  assert.equal((await media({ jsonrpc: '2.0', id: 8, method: 'tools/list' })).status, 401, 'token dies with the run');
});

test('search finds message text across chats and returns an excerpt', async () => {
  const conv = (await api('POST', '/api/conversations', {})).json.conversation;
  const sent = (await api('POST', `/api/conversations/${conv.id}/messages`, { text: 'echo 青花瓷茶杯的库存' })).json;
  await readEvents(ctx.port, `/api/conversations/${conv.id}/events?run=${sent.run.id}&after=0`, cookie);
  await api('PATCH', `/api/conversations/${conv.id}`, { title: '库存问题' });
  const byTitle = (await api('GET', `/api/conversations?limit=40&q=${encodeURIComponent('库存问题')}`)).json.conversations;
  assert.equal(byTitle[0].id, conv.id);
  assert.equal(byTitle[0].snippet, undefined);
  const byText = (await api('GET', `/api/conversations?limit=40&q=${encodeURIComponent('青花瓷')}`)).json.conversations;
  assert.deepEqual(byText.map((c) => c.id), [conv.id]);
  assert.match(byText[0].snippet, /青花瓷茶杯/);
});
