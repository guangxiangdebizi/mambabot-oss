import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login, makeDirs, readEvents, request, startApp } from './helpers.js';

test('service restart marks an in-flight reply interrupted and keeps sessions and history', async () => {
  const dirs = await makeDirs();
  try {
    const first = await startApp(dirs);
    const cookie = await login(first.port, first.password);
    const conv = (await request(first.port, 'POST', '/api/conversations', { body: {}, cookie })).json.conversation;
    const { run } = (await request(first.port, 'POST', `/api/conversations/${conv.id}/messages`, { body: { text: 'slow' }, cookie })).json;
    await readEvents(first.port, `/api/conversations/${conv.id}/events?run=${run.id}&after=0`, cookie, (ev, all) => (all.length >= 3 ? 'close' : undefined));
    const started = Date.now();
    await first.app.close();
    assert.ok(Date.now() - started < 5000, 'shutdown is bounded');

    const second = await startApp(dirs);
    try {
      const got = await request(second.port, 'GET', `/api/conversations/${conv.id}`, { cookie });
      assert.equal(got.status, 200, 'session cookie survives restart');
      const msg = got.json.conversation.messages[1];
      assert.equal(msg.status, 'interrupted');
      assert.match(msg.parts[0].text, /第1行/);
      assert.equal(got.json.conversation.run, null);
    } finally {
      await second.app.close();
    }
  } finally {
    await dirs.cleanup();
  }
});

test('failed logins are rate limited per client', async () => {
  const dirs = await makeDirs();
  const ctx = await startApp(dirs);
  try {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await request(ctx.port, 'POST', '/api/login', { body: { password: `wrong${i}` } })).status, 401);
    }
    const blocked = await request(ctx.port, 'POST', '/api/login', { body: { password: ctx.password } });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers['retry-after']) > 0);
  } finally {
    await ctx.app.close();
    await dirs.cleanup();
  }
});

test('concurrent login KDF work is bounded before scrypt starts', async () => {
  const dirs = await makeDirs();
  const ctx = await startApp(dirs, { maxLoginInFlight: 2 });
  try {
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => request(ctx.port, 'POST', '/api/login', { body: { password: `nope${i}` } })));
    const statuses = results.map((r) => r.status).sort();
    assert.ok(statuses.filter((s) => s === 401).length <= 2, `at most 2 reached scrypt: ${statuses}`);
    assert.ok(statuses.includes(429), `some were rejected early: ${statuses}`);
    assert.ok(results.find((r) => r.status === 429).json.error.includes('过于频繁'));
    // Capacity is released afterwards.
    assert.equal((await request(ctx.port, 'POST', '/api/login', { body: { password: ctx.password } })).status, 200);
  } finally {
    await ctx.app.close();
    await dirs.cleanup();
  }
});
