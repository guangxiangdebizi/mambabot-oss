import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { login, makeDirs, readEvents, request, startApp, textOf } from './helpers.js';

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

test('a project is a directory; its chats run Claude there and are listed apart', async () => {
  let res = await post('/api/projects', { name: '  研报 / 2026 ' });
  assert.equal(res.status, 201, res.text);
  const project = res.json.project;
  assert.equal(project.name, '研报 / 2026');
  assert.equal(project.dir, join(await realpath(dirs.root), 'projects', '研报 - 2026'));

  res = await post('/api/conversations', { projectId: project.id });
  assert.equal(res.status, 201, res.text);
  const id = res.json.conversation.id;
  assert.equal(res.json.conversation.projectId, project.id);
  const loose = (await post('/api/conversations', {})).json.conversation.id;

  const sent = await post(`/api/conversations/${id}/messages`, { text: 'cwd?' });
  assert.equal(sent.status, 201, sent.text);
  const { events } = await readEvents(ctx.port, `/api/conversations/${id}/events?run=${sent.json.run.id}&after=0`, cookie);
  assert.equal(textOf(events), `cwd=${project.dir}`);

  const inProject = (await get(`/api/conversations?project=${project.id}`)).json.conversations.map((c) => c.id);
  const ungrouped = (await get('/api/conversations?project=none')).json.conversations.map((c) => c.id);
  assert.deepEqual(inProject, [id]);
  assert.ok(ungrouped.includes(loose) && !ungrouped.includes(id));
  const listed = (await get('/api/projects')).json.projects.find((p) => p.id === project.id);
  assert.equal(listed.conversations, 1);

  assert.equal((await request(ctx.port, 'PATCH', `/api/projects/${project.id}`, { body: { name: '研报' }, cookie })).status, 200);
  assert.equal((await post('/api/conversations', { projectId: '00000000-0000-4000-8000-000000000000' })).status, 400);

  // Deleting the project keeps its chats (ungrouped) in the same directory.
  assert.equal((await request(ctx.port, 'DELETE', `/api/projects/${project.id}`, { cookie })).status, 200);
  assert.ok((await get('/api/conversations?project=none')).json.conversations.some((c) => c.id === id));
  const again = await post(`/api/conversations/${id}/messages`, { text: 'cwd?', parentId: sent.json.assistantMessage.id });
  const second = await readEvents(ctx.port, `/api/conversations/${id}/events?run=${again.json.run.id}&after=0`, cookie);
  assert.equal(textOf(second.events), `cwd=${project.dir}`);
});

test('existing directories: must exist, and never hold credentials or service data', async () => {
  const outside = join(dirs.root, 'existing');
  await mkdir(outside);
  let res = await post('/api/projects', { name: '已有', dir: outside });
  assert.equal(res.status, 201, res.text);
  assert.equal((await post('/api/projects', { name: '重复', dir: outside })).status, 409);
  assert.equal((await post('/api/projects', { name: '不存在', dir: join(dirs.root, 'nope') })).status, 400);
  assert.equal((await post('/api/projects', { name: '相对', dir: 'existing' })).status, 400);
  res = await post('/api/projects', { name: '整个目录', dir: dirs.root });
  assert.equal(res.status, 400, 'a root that contains the config and data dirs is refused');
  assert.equal((await post('/api/projects', { name: '配置', dir: dirs.configDir })).status, 400);
  assert.equal((await post('/api/projects', { name: '' })).status, 400);
});

test('file panel: tree and previews stay inside the project and skip secrets', async () => {
  const { project } = (await post('/api/projects', { name: 'files' })).json;
  const dir = project.dir;
  await mkdir(join(dir, 'docs'));
  await mkdir(join(dir, '.git'));
  await writeFile(join(dir, 'docs', 'README.md'), '# 标题\n\n正文');
  await writeFile(join(dir, 'main.py'), 'print(1)\n');
  await writeFile(join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  await writeFile(join(dir, 'blob.bin'), Buffer.from([1, 0, 2, 0]));
  await writeFile(join(dir, '.env'), 'TOKEN=secret');
  await writeFile(join(dirs.root, 'outside.txt'), 'outside');
  await symlink(join(dirs.root, 'outside.txt'), join(dir, 'escape.txt'));
  const base = `/api/projects/${project.id}`;

  let res = await get(`${base}/tree`);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.entries.map((e) => e.name), ['docs', 'blob.bin', 'escape.txt', 'main.py', 'pic.png']);
  res = await get(`${base}/tree?path=docs`);
  assert.deepEqual(res.json.entries.map((e) => e.name), ['README.md']);

  res = await get(`${base}/file?path=docs/README.md`);
  assert.equal(res.json.file.kind, 'markdown');
  assert.equal(res.json.file.text, '# 标题\n\n正文');
  res = await get(`${base}/file?path=${encodeURIComponent(join(dir, 'main.py'))}`);
  assert.equal(res.json.file.kind, 'text', 'absolute paths inside the project work (links in replies)');
  assert.equal((await get(`${base}/file?path=blob.bin`)).json.file.kind, 'binary');
  assert.equal((await get(`${base}/file?path=pic.png`)).json.file.kind, 'image');
  res = await get(`${base}/raw?path=pic.png`);
  assert.equal(res.headers['content-type'], 'image/png');
  res = await get(`${base}/raw?path=main.py`);
  assert.match(res.headers['content-disposition'], /^attachment/);

  for (const bad of ['../outside.txt', 'escape.txt', '.env', '.git', join(dirs.root, 'outside.txt'), '/etc/passwd']) {
    const r = await get(`${base}/file?path=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 403, bad);
  }
  assert.equal((await get(`${base}/file?path=missing.md`)).status, 404);

  // The default working directory is browsable too, but not the service's own data.
  assert.equal((await get('/api/projects/default/tree')).status, 200);
  assert.equal((await get('/api/projects/default/file?path=data/sessions.json')).status, 403);
  assert.equal((await get('/api/projects/default')).status, 404);
  assert.equal((await request(ctx.port, 'GET', `${base}/tree`)).status, 401);
});
