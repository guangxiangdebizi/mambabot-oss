import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { conversationWindow, messageView } from '../src/conversation-view.js';
import { LatestRequest, mergeWindow } from '../public/conversation-load.js';
import { login, makeDirs, request, startApp } from './helpers.js';

function fixture(count = 85) {
  const messages = [];
  for (let i = 0; i < count; i++) messages.push({
    id: randomUUID(), parentId: messages.at(-1)?.id || null, role: i % 2 ? 'assistant' : 'user',
    createdAt: new Date(i * 1000).toISOString(), status: 'done',
    parts: [{ type: 'text', text: `message-${i}` }, { type: 'tool', id: `tool-${i}`, name: 'Bash',
      state: 'done', summary: 'command', detail: 'secret body '.repeat(1000), output: 'large output '.repeat(1000) }],
  });
  return { id: randomUUID(), title: 'history fixture', version: 2, messages, leafId: messages.at(-1).id,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), settings: {}, tips: {} };
}

test('window strips tool bodies without mutating stored history; cursors cover the branch once', () => {
  const conv = fixture();
  const original = JSON.stringify(conv);
  let before = '';
  const seen = new Set();
  do {
    const page = conversationWindow(conv, new URLSearchParams({ before }));
    const loaded = page.messages.filter((m) => !m.deferred);
    assert.ok(loaded.length <= 30);
    for (const m of loaded) {
      assert.ok(!seen.has(m.id));
      seen.add(m.id);
      assert.equal(m.parts[1].output, undefined);
      assert.equal(m.parts[1].deferredDetail, true);
    }
    before = page.window.hasMore ? page.window.firstId : '';
  } while (before);
  assert.equal(seen.size, conv.messages.length);
  assert.equal(JSON.stringify(conv), original);
});

test('byte budget reduces the page, long text is recoverable, running text remains exact', () => {
  const conv = fixture(10);
  for (const m of conv.messages) m.parts[0].text = 'a'.repeat(100000);
  const page = conversationWindow(conv, new URLSearchParams());
  assert.ok(page.window.count < 10);
  assert.ok(page.window.bodyBytes <= 64 * 1024);
  assert.equal(page.messages.at(-1).deferredText, true);
  assert.equal(messageView(conv.messages[0], { fullText: true }).parts[0].text.length, 100000);
  conv.messages[0].status = 'running';
  assert.equal(messageView(conv.messages[0]).parts[0].text.length, 100000);
});

test('branch and cursor validation; merging pages retains already downloaded bodies', () => {
  const conv = fixture();
  const first = conversationWindow(conv, new URLSearchParams());
  const second = conversationWindow(conv, new URLSearchParams({ before: first.window.firstId }));
  assert.equal(mergeWindow(first, second).messages.filter((m) => !m.deferred).length, 60);
  assert.throws(() => conversationWindow(conv, new URLSearchParams({ before: 'invalid' })));
  assert.throws(() => conversationWindow(conv, new URLSearchParams({ leaf: 'invalid' })));
  const branch = conversationWindow(conv, new URLSearchParams({ leaf: conv.messages[12].id }));
  assert.equal(branch.window.count, 13);
  assert.equal(branch.leafId, conv.messages[12].id);
  const fork = { ...conv.messages[13], id: randomUUID(), parts: [{ type: 'text', text: 'alternate reply' }] };
  conv.messages.push(fork);
  const forkPage = conversationWindow(conv, new URLSearchParams({ leaf: fork.id }));
  assert.equal(forkPage.messages.find((m) => m.id === fork.id).deferred, undefined);
  assert.equal(forkPage.messages.find((m) => m.id === conv.messages[13].id).deferred, true);
  assert.equal(conv.leafId, conv.messages[84].id);
});

test('superseded requests cannot publish success, error or finally; cancelling a draft invalidates all', () => {
  const requests = new LatestRequest();
  const a = requests.begin();
  const b = requests.begin();
  assert.equal(a.signal.aborted, true);
  assert.equal(a.current(), false);
  assert.equal(b.current(), true);
  requests.cancel();
  assert.equal(b.current(), false);
  assert.equal(b.signal.aborted, true);
});

test('authenticated window/detail routes, gzip negotiation and legacy response compatibility', async () => {
  const dirs = await makeDirs();
  const ctx = await startApp(dirs);
  try {
    const conv = fixture();
    ctx.app.store.items.set(conv.id, conv);
    const cookie = await login(ctx.port, ctx.password);
    const base = `/api/conversations/${conv.id}`;
    assert.equal((await request(ctx.port, 'GET', `${base}?view=window`)).status, 401);
    assert.equal((await request(ctx.port, 'GET', `${base}/messages/${conv.leafId}?tool=tool-84`)).status, 401);
    const legacy = await request(ctx.port, 'GET', base, { cookie });
    assert.equal(legacy.json.conversation.messages[0].parts[1].output, conv.messages[0].parts[1].output);
    const page = await request(ctx.port, 'GET', `${base}?view=window`, { cookie });
    assert.equal(page.json.conversation.window.count, 30);
    const tool = await request(ctx.port, 'GET', `${base}/messages/${conv.leafId}?tool=tool-84`, { cookie });
    assert.deepEqual(tool.json.part, conv.messages.at(-1).parts[1]);
    const detail = await request(ctx.port, 'GET', `${base}/messages/${conv.leafId}`, { cookie });
    assert.equal(detail.json.message.parts[1].output, undefined);
    const commands = await request(ctx.port, 'GET', `${base}/commands`, { cookie });
    assert.equal(commands.json.commands.length, 85);
    assert.equal(commands.json.commands[0].output, undefined);
    assert.equal(commands.json.commands[0].messageId, conv.messages[0].id);
    assert.equal((await request(ctx.port, 'GET', `${base}?view=window&before=invalid`, { cookie })).status, 400);
    assert.equal((await request(ctx.port, 'GET', `${base}/messages/${randomUUID()}`, { cookie })).status, 404);
    assert.equal((await request(ctx.port, 'GET', `${base}/messages/${conv.leafId}?tool=unknown`, { cookie })).status, 404);
    const gz = await fetch(`${ctx.origin}${base}?view=window`, { headers: { Cookie: cookie, 'Accept-Encoding': 'gzip' } });
    assert.equal(gz.headers.get('content-encoding'), 'gzip');
    assert.match(gz.headers.get('server-timing'), /serialize;dur=/);
    assert.deepEqual(await gz.json(), page.json);
    const plain = await request(ctx.port, 'GET', `${base}?view=window`, { cookie, headers: { 'Accept-Encoding': 'gzip;q=0' } });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.deepEqual(plain.json, page.json);
  } finally { await ctx.app.close(); await dirs.cleanup(); }
});
