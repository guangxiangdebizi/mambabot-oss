import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { progressText } from '../src/sidequestion.js';
import {
  finalStatus, login, makeDirs, readEvents, request, startApp, textOf,
} from './helpers.js';

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

const get = (path) => request(ctx.port, 'GET', path, { cookie });
const post = (path, body) => request(ctx.port, 'POST', path, { body, cookie });
const events = (convId, runId) => readEvents(ctx.port, `/api/conversations/${convId}/events?run=${runId}&after=0`, cookie);

async function answer(convId, id) {
  for (let i = 0; i < 100; i += 1) {
    const res = await get(`/api/conversations/${convId}/btw/${id}`);
    if (res.json.btw.status !== 'running') return res.json.btw;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('side question did not finish');
}

test('a new chat and its first message in one request; nothing is left behind on refusal', async () => {
  const before = (await get('/api/conversations')).json.conversations.length;
  assert.equal((await post('/api/conversations', { message: { text: '   ' } })).status, 400);
  assert.equal((await post('/api/conversations', { message: { text: '/compact' } })).status, 400);
  assert.equal((await post('/api/conversations', { model: 'nope', message: { text: 'hi' } })).status, 400);
  assert.equal((await get('/api/conversations')).json.conversations.length, before);

  const res = await post('/api/conversations', { model: 'haiku', message: { text: '你好' } });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.conversation.title, '你好');
  assert.equal(res.json.userMessage.parts[0].text, '你好');
  const { events: evs } = await events(res.json.conversation.id, res.json.run.id);
  assert.equal(textOf(evs), '你好，世界');
  assert.equal(finalStatus(evs), 'done');
  const conv = (await get(`/api/conversations/${res.json.conversation.id}`)).json.conversation;
  assert.equal(conv.settings.model, 'haiku');
  assert.equal(conv.messages.length, 2);
});

test('/btw after a reply: a read-only throwaway fork, kept out of the chat', async () => {
  const res = await post('/api/conversations', { message: { text: '你好' } });
  const convId = res.json.conversation.id;
  await events(convId, res.json.run.id);
  const session = (await get(`/api/conversations/${convId}`)).json.conversation.messages[1].sessionId;
  assert.ok(session);

  assert.equal((await post(`/api/conversations/${convId}/btw`, { text: ' ' })).status, 400);
  const asked = await post(`/api/conversations/${convId}/btw`, { text: 'btw?' });
  assert.equal(asked.status, 202, asked.text);
  const done = await answer(convId, asked.json.btw.id);
  assert.equal(done.status, 'done');
  assert.equal(done.answer, `tools=Read,Grep,Glob mode=dontAsk strict=true persist=false resume=${session} fork=true effort=low progress=false`);
  assert.equal(done.anchorId, res.json.assistantMessage.id);

  const conv = (await get(`/api/conversations/${convId}`)).json.conversation;
  assert.equal(conv.messages.length, 2, 'the side question is not a message');
  assert.equal(conv.btw.length, 1);
  assert.equal((await request(ctx.port, 'DELETE', `/api/conversations/${convId}/btw/${done.id}`, { cookie })).status, 200);
  assert.equal((await get(`/api/conversations/${convId}`)).json.conversation.btw.length, 0);
  assert.equal((await post('/api/conversations', {})).status, 201);
});

test('/btw while a reply runs: answered at once with the progress so far, the reply keeps going', async () => {
  const res = await post('/api/conversations', { message: { text: 'slow' } });
  const convId = res.json.conversation.id;
  const run = events(convId, res.json.run.id);
  await new Promise((r) => setTimeout(r, 200));
  const asked = await post(`/api/conversations/${convId}/btw`, { text: 'btw?' });
  assert.equal(asked.status, 202, asked.text);
  assert.equal(asked.json.btw.anchorId, res.json.assistantMessage.id);
  // One at a time per chat.
  assert.equal((await post(`/api/conversations/${convId}/btw`, { text: 'btw?' })).status, 409);
  const done = await answer(convId, asked.json.btw.id);
  assert.match(done.answer, /resume= fork=false effort=low progress=true$/);
  assert.equal((await get(`/api/conversations/${convId}`)).json.conversation.running, true, 'the main reply is untouched');
  await post(`/api/conversations/${convId}/stop`, {});
  const { events: evs } = await run;
  assert.equal(finalStatus(evs), 'stopped');
});

test('progress text: the owner message, steps with the one in progress, added messages', () => {
  const now = new Date('2026-11-11T10:05:00Z');
  const text = progressText(
    { parts: [{ type: 'text', text: '整理报表' }] },
    {
      parts: [
        { type: 'text', text: '先看看数据。' },
        { type: 'tool', name: 'Bash', summary: 'python build.py', state: 'running', at: '2026-11-11T10:02:00Z' },
        { type: 'followup', text: '再加一列' },
      ],
      queued: [{ text: '别改 X 文件' }],
    },
    now,
  );
  assert.match(text, /所有者这一轮的消息：整理报表/);
  assert.match(text, /- 运行命令：python build\.py（进行中，已 3 分钟/);
  assert.match(text, /所有者中途补充：再加一列/);
  assert.match(text, /还没看到的补充：别改 X 文件/);
});
