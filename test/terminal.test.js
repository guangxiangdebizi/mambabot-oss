import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { login, makeDirs, request, startApp } from './helpers.js';

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

const post = (path, body) => request(ctx.port, 'POST', path, { body, cookie });
const snapshot = async (key) => (await request(ctx.port, 'GET', `/api/terminal/${key}`, { cookie })).json;

async function finished(key, id) {
  for (let i = 0; i < 100; i += 1) {
    const e = (await snapshot(key)).entries.find((x) => x.id === id);
    if (e && e.status !== 'running') return e;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('command did not finish');
}

test('terminal: runs in the project directory, keeps cd, reports exit codes', async () => {
  const { project } = (await post('/api/projects', { name: 'term' })).json;
  const key = project.id;
  assert.equal((await snapshot(key)).cwd, project.dir);
  await mkdir(join(project.dir, 'sub'));

  let res = await post(`/api/terminal/${key}/run`, { command: 'pwd; echo err >&2; cd sub' });
  assert.equal(res.status, 201, res.text);
  let e = await finished(key, res.json.entry.id);
  assert.equal(e.status, 'done');
  assert.equal(e.output, `${project.dir}\nerr\n`);
  assert.equal((await snapshot(key)).cwd, join(project.dir, 'sub'));

  res = await post(`/api/terminal/${key}/run`, { command: 'pwd; exit 3' });
  e = await finished(key, res.json.entry.id);
  assert.equal(e.status, 'error');
  assert.equal(e.exitCode, 3);
  assert.equal(e.output.trim(), join(project.dir, 'sub'));

  // The default root starts in the default working directory.
  assert.equal((await snapshot('default')).cwd, dirs.root);
  assert.equal((await request(ctx.port, 'GET', '/api/terminal/nope', { cookie })).status, 404);
  assert.equal((await request(ctx.port, 'GET', `/api/terminal/${key}`)).status, 401);
  assert.equal((await post(`/api/terminal/${key}/run`, { command: '  ' })).status, 400);
  assert.ok(await realpath(project.dir));
});

test('terminal: one command at a time, stdin and stop', async () => {
  let res = await post('/api/terminal/default/run', { command: 'read x; echo "got:$x"' });
  const id = res.json.entry.id;
  assert.equal((await post('/api/terminal/default/run', { command: 'echo busy' })).status, 409);
  assert.equal((await post('/api/terminal/default/input', { text: 'yes' })).status, 200);
  let e = await finished('default', id);
  assert.match(e.output, /got:yes/);

  res = await post('/api/terminal/default/run', { command: 'sleep 30' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await post('/api/terminal/default/stop', {})).status, 200);
  e = await finished('default', res.json.entry.id);
  assert.equal(e.status, 'stopped');
  assert.equal((await post('/api/terminal/default/stop', {})).status, 409);

  res = await post('/api/terminal/default/clear', {});
  assert.deepEqual(res.json.entries, []);
});
