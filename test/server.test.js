import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ContextProbe } from '../src/context.js';
import { finalStatus, login, makeDirs, rawPost, readEvents, request, startApp, textOf } from './helpers.js';

let dirs;
let ctx;
let cookie;
const UUID = '00000000-0000-4000-8000-000000000000';

before(async () => {
  dirs = await makeDirs();
  ctx = await startApp(dirs);
  cookie = await login(ctx.port, ctx.password);
});
after(async () => {
  await ctx.app.close();
  await dirs.cleanup();
});

async function newConversation() {
  const res = await request(ctx.port, 'POST', '/api/conversations', { body: {}, cookie });
  assert.equal(res.status, 201);
  return res.json.conversation.id;
}

async function send(convId, text, extra = {}) {
  const res = await request(ctx.port, 'POST', `/api/conversations/${convId}/messages`, { body: { text, ...extra }, cookie });
  assert.equal(res.status, 201, res.text);
  return res.json;
}

const eventsPath = (convId, run, after = run.seq) => `/api/conversations/${convId}/events?run=${run.id}&after=${after}`;

test('health and static assets are public, everything else needs a session', async () => {
  assert.equal((await request(ctx.port, 'GET', '/healthz')).status, 200);
  assert.equal((await request(ctx.port, 'GET', '/')).status, 200);
  for (const [method, path] of [
    ['GET', '/api/conversations'], ['POST', '/api/conversations'], ['GET', `/api/conversations/${UUID}`],
    ['GET', `/api/conversations/${UUID}/events?run=x&after=0`], ['POST', `/api/conversations/${UUID}/messages`],
    ['POST', `/api/conversations/${UUID}/stop`], ['POST', `/api/conversations/${UUID}/approvals/${UUID}`],
  ]) {
    const res = await request(ctx.port, method, path, { body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  const forged = await request(ctx.port, 'GET', '/api/conversations', { cookie: 'aw_session=forged' });
  assert.equal(forged.status, 401);
  assert.equal((await request(ctx.port, 'GET', '/api/session')).json.authenticated, false);
});

test('rejects foreign hosts, cross-origin mutations and path traversal', async () => {
  assert.equal((await request(ctx.port, 'GET', '/healthz', { headers: { Host: 'evil.example' } })).status, 421);
  assert.equal((await request(ctx.port, 'POST', '/api/login', { body: { password: ctx.password }, headers: { Origin: null } })).status, 403);
  assert.equal((await request(ctx.port, 'POST', '/api/conversations', { body: {}, cookie, headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await request(ctx.port, 'POST', '/api/conversations', { body: {}, cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request(ctx.port, 'GET', '/..%2f..%2fsrc%2fserver.js')).status, 404);
});

test('a malformed request target gets 400 and the server keeps running', async () => {
  const raw = await new Promise((resolve, reject) => {
    const sock = net.connect(ctx.port, '127.0.0.1', () => sock.write('GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
    let data = '';
    sock.on('data', (c) => { data += c; });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
  assert.match(raw, /^HTTP\/1\.1 400/);
  assert.equal((await request(ctx.port, 'GET', '/healthz')).status, 200);
});

test('login issues an HttpOnly SameSite cookie; secret stays out of the hash file', async () => {
  const bad = await request(ctx.port, 'POST', '/api/login', { body: { password: 'wrong' } });
  assert.equal(bad.status, 401);
  const good = await request(ctx.port, 'POST', '/api/login', { body: { password: ctx.password } });
  assert.equal(good.status, 200);
  const setCookie = good.headers['set-cookie'][0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.equal((await stat(ctx.app.secretPath)).mode & 0o777, 0o600);
  const authFile = await readFile(join(dirs.configDir, 'auth.json'), 'utf8');
  assert.ok(!authFile.includes(ctx.password));
  assert.equal((await stat(join(dirs.configDir, 'auth.json'))).mode & 0o777, 0o600);
});

test('message streams through Claude and is persisted; next turn resumes the session', async () => {
  const id = await newConversation();
  const { run } = await send(id, '你好');
  const { events } = await readEvents(ctx.port, eventsPath(id, run), cookie);
  assert.equal(textOf(events), '你好，世界');
  assert.equal(finalStatus(events), 'done');
  assert.equal(events.at(-1).type, 'end');

  const conv = (await request(ctx.port, 'GET', `/api/conversations/${id}`, { cookie })).json.conversation;
  assert.equal(conv.title, '你好');
  assert.equal(conv.run, null);
  assert.deepEqual(conv.messages[1].parts, [{ type: 'text', text: '你好，世界' }]);
  const onDisk = JSON.parse(await readFile(join(dirs.dataDir, 'conversations', `${id}.json`), 'utf8'));
  const first = onDisk.messages[1];
  assert.equal(first.status, 'done');
  assert.ok(first.sessionId && first.tailUuid);
  assert.equal(first.modelUsed, 'claude-opus-5-5');
  assert.equal(onDisk.leafId, first.id);

  const second = await send(id, 'args', { model: 'haiku', effort: 'low', parentId: first.id });
  const r2 = await readEvents(ctx.port, eventsPath(id, second.run), cookie);
  assert.equal(textOf(r2.events), `resume=${first.sessionId} at= fork=false model=haiku effort=low mode=auto prompt=stdio`);
  assert.ok(r2.events.some((e) => e.type === 'meta' && e.modelUsed === 'claude-haiku-5-5'));
  const conv2 = (await request(ctx.port, 'GET', `/api/conversations/${id}`, { cookie })).json.conversation;
  assert.deepEqual(conv2.settings, { model: 'haiku', effort: 'low' });
  assert.equal(conv2.messages.at(-1).modelUsed, 'claude-haiku-5-5');
});

test('edits and regenerations fork the Claude session and keep old branches', async () => {
  const id = await newConversation();
  const a = await send(id, '你好');
  await readEvents(ctx.port, eventsPath(id, a.run), cookie);
  const b = await send(id, 'echo B', { parentId: a.assistantMessage.id });
  await readEvents(ctx.port, eventsPath(id, b.run), cookie);
  let conv = (await request(ctx.port, 'GET', `/api/conversations/${id}`, { cookie })).json.conversation;
  const a1 = conv.messages.find((m) => m.id === a.assistantMessage.id);

  // Edit the second user message: a sibling under a1, resumed at a1 and forked.
  const edit = await send(id, 'args', { parentId: a1.id });
  const r = await readEvents(ctx.port, eventsPath(id, edit.run), cookie);
  assert.equal(textOf(r.events), `resume=${a1.sessionId} at=${a1.tailUuid} fork=true model=default effort= mode=auto prompt=stdio`);
  conv = (await request(ctx.port, 'GET', `/api/conversations/${id}`, { cookie })).json.conversation;
  const siblings = conv.messages.filter((m) => m.parentId === a1.id);
  assert.equal(siblings.length, 2);
  assert.equal(conv.leafId, edit.assistantMessage.id);
  assert.notEqual(conv.messages.at(-1).sessionId, a1.sessionId);

  // Regenerate the first reply: no earlier context, so it starts a fresh session.
  const regen = await request(ctx.port, 'POST', `/api/conversations/${id}/regenerate`, { body: { userMessageId: a.userMessage.id }, cookie });
  assert.equal(regen.status, 201, regen.text);
  await readEvents(ctx.port, eventsPath(id, regen.json.run), cookie);
  conv = (await request(ctx.port, 'GET', `/api/conversations/${id}`, { cookie })).json.conversation;
  assert.equal(conv.messages.filter((m) => m.parentId === a.userMessage.id).length, 2);

  // Switch back to the original branch; continuing it resumes the original session.
  const sw = await request(ctx.port, 'PATCH', `/api/conversations/${id}`, { body: { leafId: b.assistantMessage.id }, cookie });
  assert.equal(sw.status, 200);
  const cont = await send(id, 'args', { parentId: b.assistantMessage.id });
  const rc = await readEvents(ctx.port, eventsPath(id, cont.run), cookie);
  assert.match(textOf(rc.events), new RegExp(`^resume=${a1.sessionId} at= fork=false`));
});

test('legacy flat conversations migrate to a tree and can continue', async () => {
  const legacyId = '11111111-2222-4333-8444-555555555555';
  const now = new Date().toISOString();
  const legacy = {
    id: legacyId, title: 'old', createdAt: now, updatedAt: now, claudeSessionId: 'sess-old', messages: [
      { id: 'u1', role: 'user', createdAt: now, status: 'done', parts: [{ type: 'text', text: 'q' }] },
      { id: 'a1', role: 'assistant', createdAt: now, status: 'done', model: '', parts: [{ type: 'text', text: 'r' }] },
    ],
  };
  const { writeFile, mkdir } = await import('node:fs/promises');
  const d2 = await makeDirs();
  await mkdir(join(d2.dataDir, 'conversations'), { recursive: true });
  await writeFile(join(d2.dataDir, 'conversations', `${legacyId}.json`), JSON.stringify(legacy));
  const c2 = await startApp(d2);
  try {
    const ck = await login(c2.port, c2.password);
    const conv = (await request(c2.port, 'GET', `/api/conversations/${legacyId}`, { cookie: ck })).json.conversation;
    assert.equal(conv.leafId, 'a1');
    assert.equal(conv.messages[1].parentId, 'u1');
    const res = await request(c2.port, 'POST', `/api/conversations/${legacyId}/messages`, { body: { text: 'args', parentId: 'a1' }, cookie: ck });
    assert.equal(res.status, 201, res.text);
    const r = await readEvents(c2.port, `/api/conversations/${legacyId}/events?run=${res.json.run.id}&after=0`, ck);
    assert.match(textOf(r.events), /^resume=sess-old at= fork=false/);
    // The first turn cannot be edited in place (no message uuid), but regenerating it starts fresh.
    const edit = await request(c2.port, 'POST', `/api/conversations/${legacyId}/messages`, { body: { text: 'x', parentId: 'a1' }, cookie: ck });
    assert.equal(edit.status, 409);
  } finally {
    await c2.app.close();
    await d2.cleanup();
  }
});

test('models come from the CLI; selections are validated and persisted', async () => {
  const list = (await request(ctx.port, 'GET', '/api/models', { cookie })).json;
  assert.deepEqual(list.models.map((m) => m.value), ['default', 'haiku', 'claude-haiku-4-5-20251001']);
  assert.deepEqual(list.models[1].efforts, ['low', 'medium', 'high']);
  assert.equal((await request(ctx.port, 'PUT', '/api/prefs', { body: { model: 'haiku', effort: 'max' }, cookie })).status, 400);
  assert.equal((await request(ctx.port, 'PUT', '/api/prefs', { body: { model: 'gpt-5' }, cookie })).status, 400);
  assert.equal((await request(ctx.port, 'PUT', '/api/prefs', { body: { model: 'haiku', effort: 'medium' }, cookie })).status, 200);
  assert.deepEqual((await request(ctx.port, 'GET', '/api/models', { cookie })).json.prefs, { model: 'haiku', effort: 'medium', permissionMode: 'auto', maxRuns: 2 });
  const id = await newConversation();
  const { run } = await send(id, 'args');
  const r = await readEvents(ctx.port, eventsPath(id, run), cookie);
  assert.match(textOf(r.events), /model=haiku effort=medium/);
  await request(ctx.port, 'PUT', '/api/prefs', { body: { model: 'default', effort: null }, cookie });
});

test('a reply from a different model than selected is flagged', async () => {
  const d2 = await makeDirs();
  process.env.FAKE_WRONG_MODEL = 'claude-sonnet-5-5';
  const c2 = await startApp(d2);
  try {
    const ck = await login(c2.port, c2.password);
    const conv = (await request(c2.port, 'POST', '/api/conversations', { body: {}, cookie: ck })).json.conversation;
    const res = await request(c2.port, 'POST', `/api/conversations/${conv.id}/messages`, { body: { text: 'hi', model: 'haiku' }, cookie: ck });
    const r = await readEvents(c2.port, `/api/conversations/${conv.id}/events?run=${res.json.run.id}&after=0`, ck);
    assert.ok(r.events.some((e) => e.type === 'part' && e.part.type === 'notice' && /claude-sonnet-5-5/.test(e.part.text)));
  } finally {
    delete process.env.FAKE_WRONG_MODEL;
    await c2.app.close();
    await d2.cleanup();
  }
});

test('uploads are stored, served only with a session, and sent with the message', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const up = await rawPost(ctx.port, '/api/uploads', png, { 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('图.png'), Cookie: cookie });
  assert.equal(up.status, 201, up.text);
  const att = up.json.attachment;
  assert.equal(att.image, true);
  assert.equal((await request(ctx.port, 'GET', `/api/uploads/${att.id}`)).status, 401);
  assert.equal((await request(ctx.port, 'GET', `/api/uploads/${att.id}`, { cookie })).status, 200);
  const doc = await rawPost(ctx.port, '/api/uploads', Buffer.from('a,b\n1,2\n'), { 'Content-Type': 'text/csv', 'X-File-Name': '../../etc/x.csv', Cookie: cookie });
  assert.equal(doc.json.attachment.name, 'x.csv');
  const cross = await rawPost(ctx.port, '/api/uploads', png, { 'Content-Type': 'image/png', Cookie: cookie, Origin: 'http://evil.example' });
  assert.equal(cross.status, 403);
  const id = await newConversation();
  const { run, userMessage } = await send(id, 'echo look', { attachments: [att.id, doc.json.attachment.id] });
  const r = await readEvents(ctx.port, eventsPath(id, run), cookie);
  assert.match(textOf(r.events), /\[image:image\/png\]/);
  assert.match(textOf(r.events), /x\.csv/);
  assert.equal(userMessage.attachments.length, 2);
  const missing = await request(ctx.port, 'POST', `/api/conversations/${id}/messages`, {
    body: { text: 'echo', attachments: ['00000000-0000-4000-8000-00000000dead'] }, cookie,
  });
  assert.equal(missing.status, 400);
});

test('rename and settings updates', async () => {
  const id = await newConversation();
  assert.equal((await request(ctx.port, 'PATCH', `/api/conversations/${id}`, { body: { title: '  新 标题 ' }, cookie })).json.conversation.title, '新 标题');
  assert.equal((await request(ctx.port, 'PATCH', `/api/conversations/${id}`, { body: { title: '' }, cookie })).status, 400);
  assert.equal((await request(ctx.port, 'PATCH', `/api/conversations/${id}`, { body: { settings: { model: 'haiku', effort: 'xhigh' } }, cookie })).status, 400);
  assert.equal((await request(ctx.port, 'PATCH', `/api/conversations/${id}`, { body: { settings: { model: 'haiku', effort: 'high' } }, cookie })).status, 200);
});

test('tool approvals are surfaced and honoured (allow and deny)', async () => {
  for (const [decision, expected, toolState] of [['allow', 'allowed', 'done'], ['allow_run', 'allowed+session:Bash', 'done'], ['deny', 'denied', 'error']]) {
    const id = await newConversation();
    const { run } = await send(id, 'tool');
    const { events } = await readEvents(ctx.port, eventsPath(id, run), cookie, async (ev) => {
      if (ev.type === 'part' && ev.part.type === 'approval' && ev.part.state === 'pending') {
        assert.equal(ev.part.tool, 'Bash');
        assert.equal(ev.part.detail, 'echo hi');
        assert.equal(ev.part.reason, 'Process substitution requires manual approval');
        assert.equal(ev.part.safetyCheck, true);
        const res = await request(ctx.port, 'POST', `/api/conversations/${id}/approvals/${ev.part.id}`, { body: { decision }, cookie });
        assert.equal(res.status, 200);
        const again = await request(ctx.port, 'POST', `/api/conversations/${id}/approvals/${ev.part.id}`, { body: { decision }, cookie });
        assert.equal(again.status, 409);
      }
    });
    assert.equal(textOf(events), expected);
    const conv = (await request(ctx.port, 'GET', `/api/conversations/${id}`, { cookie })).json.conversation;
    const parts = conv.messages[1].parts;
    assert.equal(parts.find((p) => p.type === 'tool').state, toolState);
    assert.equal(parts.find((p) => p.type === 'approval').state, { allow: 'allowed', allow_run: 'allowed_run', deny: 'denied' }[decision]);
  }
});

test('stop ends a running reply and keeps the partial text', async () => {
  const id = await newConversation();
  const { run } = await send(id, 'slow');
  const busy = await request(ctx.port, 'POST', `/api/conversations/${id}/messages`, { body: { text: 'again' }, cookie });
  assert.equal(busy.status, 409);
  const { events } = await readEvents(ctx.port, eventsPath(id, run), cookie, async (ev, all) => {
    if (ev.type === 'text' && all.filter((e) => e.type === 'text').length === 3) {
      assert.equal((await request(ctx.port, 'POST', `/api/conversations/${id}/stop`, { body: {}, cookie })).status, 200);
    }
  });
  assert.ok(events.some((e) => e.type === 'status' && e.status === 'stopping'));
  assert.equal(finalStatus(events), 'stopped');
  const conv = (await request(ctx.port, 'GET', `/api/conversations/${id}`, { cookie })).json.conversation;
  assert.equal(conv.messages[1].status, 'stopped');
  assert.match(conv.messages[1].parts[0].text, /第1行/);
  assert.equal((await request(ctx.port, 'POST', `/api/conversations/${id}/stop`, { body: {}, cookie })).status, 409);
});

test('reconnecting replays only events after the last seen one', async () => {
  const id = await newConversation();
  const { run } = await send(id, 'slow');
  const first = await readEvents(ctx.port, eventsPath(id, run), cookie, (ev, all) => (all.length >= 4 ? 'close' : undefined));
  const lastSeq = first.events.at(-1).seq;
  const snapshot = (await request(ctx.port, 'GET', `/api/conversations/${id}`, { cookie })).json.conversation;
  assert.equal(snapshot.run.id, run.id);
  assert.equal(snapshot.messages[1].status, 'running');
  const second = await readEvents(ctx.port, eventsPath(id, run, lastSeq), cookie, (ev) => (ev ? 'close' : undefined));
  assert.equal(second.events[0].seq, lastSeq + 1);
  await request(ctx.port, 'POST', `/api/conversations/${id}/stop`, { body: {}, cookie });
  const stale = await readEvents(ctx.port, eventsPath(id, { id: 'unknown-run', seq: 0 }), cookie);
  assert.equal(stale.gone, true);
});

test('a crashing Claude process is reported as an error', async () => {
  const id = await newConversation();
  const { run } = await send(id, 'crash');
  const { events } = await readEvents(ctx.port, eventsPath(id, run), cookie);
  assert.equal(finalStatus(events), 'error');
  assert.match(events.find((e) => e.type === 'status' && e.status === 'error').error, /意外退出/);
});

test('input validation', async () => {
  const id = await newConversation();
  const post = (body) => request(ctx.port, 'POST', `/api/conversations/${id}/messages`, { body, cookie });
  assert.equal((await post({ text: '   ' })).status, 400);
  assert.equal((await post({ text: 'x'.repeat(20001) })).status, 400);
  assert.equal((await post({ text: 'hi', model: '--dangerously-skip-permissions' })).status, 400);
  const raw = await request(ctx.port, 'POST', `/api/conversations/${id}/messages`, { cookie, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(raw.status, 415);
});

test('/compact runs in the session, is shown as a compact part, and later turns can fork from it', async () => {
  const id = await newConversation();
  const early = await request(ctx.port, 'POST', `/api/conversations/${id}/messages`, { body: { text: '/compact' }, cookie });
  assert.equal(early.status, 400);
  assert.match(early.json.error, /没有可压缩/);

  const a = await send(id, '你好');
  await readEvents(ctx.port, eventsPath(id, a.run), cookie);
  const c = await send(id, '/compact', { parentId: a.assistantMessage.id });
  const { events } = await readEvents(ctx.port, eventsPath(id, c.run), cookie);
  assert.equal(finalStatus(events), 'done');
  let conv = (await request(ctx.port, 'GET', `/api/conversations/${id}`, { cookie })).json.conversation;
  const reply = conv.messages.find((m) => m.id === c.assistantMessage.id);
  assert.deepEqual(reply.parts, [{ type: 'compact', state: 'done', trigger: 'manual', preTokens: 21627, postTokens: 6081, durationMs: 900 }]);
  assert.equal(reply.sessionId, conv.messages[1].sessionId);
  assert.equal(reply.usage.costUsd, 0.05);

  // The compacted reply is a safe fork point: its replayed "Compacted" entry is the tail.
  const next = await send(id, 'echo after', { parentId: reply.id });
  await readEvents(ctx.port, eventsPath(id, next.run), cookie);
  const fork = await send(id, 'args', { parentId: reply.id });
  const r = await readEvents(ctx.port, eventsPath(id, fork.run), cookie);
  assert.match(textOf(r.events), new RegExp(`^resume=${reply.sessionId} at=replay-uuid fork=true`));
});

test('/status reports live context usage of the branch and recorded spend', async () => {
  const empty = await newConversation();
  let res = await request(ctx.port, 'GET', `/api/conversations/${empty}/status`, { cookie });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.hasSession, false);
  assert.equal(res.json.context.totalTokens, 13500);
  assert.equal(res.json.spend.branch.replies, 0);

  const id = await newConversation();
  const a = await send(id, '你好');
  const { events } = await readEvents(ctx.port, eventsPath(id, a.run), cookie);
  assert.ok(events.some((e) => e.type === 'meta' && e.usage?.costUsd === 0.0125));
  const b = await send(id, 'echo B', { parentId: a.assistantMessage.id });
  await readEvents(ctx.port, eventsPath(id, b.run), cookie);

  res = await request(ctx.port, 'GET', `/api/conversations/${id}/status`, { cookie });
  assert.equal(res.status, 200, res.text);
  const s = res.json;
  assert.equal(s.hasSession, true);
  assert.equal(s.model.value, 'default');
  assert.equal(s.context.maxTokens, 1000000);
  assert.equal(s.context.totalTokens, 182204);
  assert.ok(s.context.categories.some((x) => x.id === 'messages' && x.tokens === 168703));
  assert.equal(s.spend.branch.replies, 2);
  assert.equal(s.spend.branch.costUsd, 0.025);
  assert.equal(s.spend.branch.outputTokens, 40);
  assert.equal(s.spend.all.costUsd, 0.025);

  // The probe opens the session as a throwaway fork and never persists it.
  const conv = (await request(ctx.port, 'GET', `/api/conversations/${id}`, { cookie })).json.conversation;
  let args;
  const probe = new ContextProbe({
    cfg: { claudeBin: process.execPath, claudePrefixArgs: [fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))], claudeCwd: dirs.root },
    spawnImpl: (bin, argv, opts) => { args = argv; return spawn(bin, argv, opts); },
  });
  const sid = conv.messages.at(-1).sessionId;
  await probe.get({ resume: { sessionId: sid }, model: 'haiku' });
  assert.ok(args.includes('--fork-session') && args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--resume') + 1], sid);
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
});
