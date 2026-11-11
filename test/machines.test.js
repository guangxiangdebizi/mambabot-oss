import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  displayPath, parseLsLine, remotePath, remoteWithin, sshHosts, unescapeSftp,
} from '../src/machines.js';
import { login, makeDirs, readEvents, request, startApp, textOf } from './helpers.js';

const FAKE_SFTP = fileURLToPath(new URL('./fixtures/fake-sftp.mjs', import.meta.url));

test('ssh_config aliases, remote paths and sftp listings', () => {
  assert.deepEqual(sshHosts('Host my-pc this-pc\n  HostName 127.0.0.1\nhost=work.box\nHost *\nHost !bad gw?\nMatch all\n'), ['my-pc', 'this-pc', 'work.box']);
  assert.equal(remotePath('D:\\Projects\\毕业设计\\'), '/D:/Projects/毕业设计');
  assert.equal(remotePath('d:'), '/d:/');
  assert.equal(remotePath('/home/me/../me/work/'), '/home/me/work');
  assert.throws(() => remotePath('Projects'), /绝对路径/);
  assert.throws(() => remotePath('/a"b'), /路径格式/);
  assert.equal(displayPath('/D:/Projects/x'), 'D:\\Projects\\x');
  assert.equal(displayPath('/home/me'), '/home/me');
  assert.ok(remoteWithin('/D:/projects/X', '/d:/Projects'));
  assert.ok(!remoteWithin('/home/me/work2', '/home/me/work'));
  assert.equal(unescapeSftp('\\345\\255\\220 a\\\\b'), '子 a\\b');
  const now = new Date('2026-11-11T00:00:00');
  const a = parseLsLine('drwxr-xr-x    ? 26214 197121        0 Nov 10 12:00 My Docs', now);
  assert.deepEqual([a.type, a.name, a.size], ['dir', 'My Docs', 0]);
  const b = parseLsLine('-rw-r--r--    ? NT AUTHORITY SYSTEM   1234 Dec  3  2024 报告 一.pdf', now);
  assert.deepEqual([b.type, b.name, b.size], ['file', '报告 一.pdf', 1234]);
  assert.equal(new Date(b.mtime).getFullYear(), 2024);
  assert.equal(parseLsLine('lrwxrwxrwx    ? 0 0 13 Nov 11 01:45 link', now).type, 'link');
  assert.equal(parseLsLine('Remote working directory: /x', now), null);
});

let dirs;
let ctx;
let cookie;
let fake;

before(async () => {
  dirs = await makeDirs();
  fake = join(dirs.root, 'remote');
  const work = join(fake, 'home', 'me', 'work');
  await mkdir(join(work, '子 目录'), { recursive: true });
  await mkdir(join(work, 'AppData', 'Local'), { recursive: true });
  await mkdir(join(fake, 'home', 'me', 'secret'), { recursive: true });
  await writeFile(join(work, '报告 一.md'), '# 标题\n\n正文');
  await writeFile(join(work, '子 目录', 'a.txt'), 'hello');
  await writeFile(join(work, '.env'), 'TOKEN=x');
  await writeFile(join(work, 'big.bin'), Buffer.alloc(3000));
  await writeFile(join(fake, 'home', 'me', 'secret', 'key.txt'), 'nope');
  await symlink(join(fake, 'home', 'me', 'secret'), join(work, 'link'));
  await writeFile(join(dirs.root, 'ssh_config'), 'Host my-pc\n  HostName 127.0.0.1\nHost offline-pc\n');
  process.env.FAKE_SFTP_ROOT = fake;
  ctx = await startApp(dirs, {
    sftpBin: process.execPath, sftpPrefixArgs: [FAKE_SFTP], sshConfigPath: join(dirs.root, 'ssh_config'), remoteMaxBytes: 2048,
  });
  cookie = await login(ctx.port, ctx.password);
});
after(async () => {
  await ctx.app.close();
  await dirs.cleanup();
});

const get = (path) => request(ctx.port, 'GET', path, { cookie });
const post = (path, body) => request(ctx.port, 'POST', path, { body, cookie });
const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

test('remote machines: configured from ssh aliases, browsed read-only inside their roots', async () => {
  let res = await get('/api/machines');
  assert.deepEqual(res.json.sshHosts, ['my-pc', 'offline-pc']);
  assert.equal((await post('/api/machines', { name: 'PC', host: 'evil.example.com', roots: ['/home/me/work'] })).status, 400);
  assert.equal((await post('/api/machines', { name: 'PC', host: 'my-pc', roots: ['/'] })).status, 400);
  assert.equal((await post('/api/machines', { name: 'PC', host: 'my-pc', roots: ['C:\\Users\\me\\AppData'] })).status, 400);
  res = await post('/api/machines', { name: '我的电脑', host: 'my-pc', roots: ['/home/me/work'] });
  assert.equal(res.status, 201, res.text);
  const id = res.json.machine.id;
  const base = `/api/machines/${id}`;

  res = await get(`${base}/tree?${q({ root: '/home/me/work' })}`);
  assert.equal(res.status, 200, res.text);
  // Secrets, credential folders and symlinks are not listed; names with spaces and CJK are.
  assert.deepEqual(res.json.entries.map((e) => `${e.type}:${e.name}`), ['dir:子 目录', 'file:报告 一.md', 'file:big.bin']);
  assert.equal(res.json.rootDisplay, '/home/me/work');
  res = await get(`${base}/tree?${q({ root: '/home/me/work', path: '子 目录' })}`);
  assert.deepEqual(res.json.entries.map((e) => e.name), ['a.txt']);

  // Outside the root: refused by path, through a symlink, or by asking for another root.
  assert.equal((await get(`${base}/tree?${q({ root: '/home/me/work', path: '../secret' })}`)).status, 403);
  assert.equal((await get(`${base}/tree?${q({ root: '/home/me/work', path: 'link' })}`)).status, 403);
  assert.equal((await get(`${base}/file?${q({ root: '/home/me/work', path: 'link/key.txt' })}`)).status, 403);
  assert.equal((await get(`${base}/tree?${q({ root: '/home/me' })}`)).status, 403);
  assert.equal((await get(`${base}/tree?${q({ root: '/home/me/work/link' })}`)).status, 403);
  assert.equal((await get(`${base}/file?${q({ root: '/home/me/work', path: '.env' })}`)).status, 403);
  assert.equal((await get(`${base}/tree?${q({ root: '/home/me/work', path: 'AppData/Local' })}`)).status, 403);

  res = await get(`${base}/file?${q({ root: '/home/me/work', path: '报告 一.md' })}`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.file.kind, 'markdown');
  assert.equal(res.json.file.text, '# 标题\n\n正文');
  res = await get(`${base}/raw?${q({ root: '/home/me/work', path: '子 目录/a.txt', download: 1 })}`);
  assert.equal(res.text, 'hello');
  assert.match(res.headers['content-disposition'], /^attachment/);
  // Larger than the remote preview limit: refused before anything is copied.
  res = await get(`${base}/file?${q({ root: '/home/me/work', path: 'big.bin' })}`);
  assert.equal(res.status, 413);
  assert.equal((await get(`${base}/file?${q({ root: '/home/me/work', path: 'nope.txt' })}`)).status, 404);

  res = await get(`${base}/status?force=1`);
  assert.equal(res.json.machine.online, true);
});

test('an offline machine says so instead of spinning; remote projects warn before sending', async () => {
  let res = await post('/api/machines', { name: '家里的电脑', host: 'offline-pc', roots: ['D:\\Projects'] });
  assert.equal(res.status, 201, res.text);
  const off = res.json.machine;
  assert.deepEqual(off.roots, [{ path: '/D:/Projects', display: 'D:\\Projects' }]);
  res = await get(`/api/machines/${off.id}/tree?${q({ root: 'D:\\Projects' })}`);
  assert.equal(res.status, 503);
  assert.equal(res.json.offline, true);
  assert.match(res.json.error, /家里的电脑 离线或无法连接/);
  assert.equal((await get(`/api/machines/${off.id}/status`)).json.machine.online, false);
  // A project needs a reachable folder inside an allowed root.
  assert.equal((await post('/api/projects', { name: 'x', machineId: off.id, remoteDir: 'D:\\Projects\\x' })).status, 503);

  const pc = (await get('/api/machines')).json.machines.find((m) => m.host === 'my-pc');
  assert.equal((await post('/api/projects', { name: 'y', machineId: pc.id, remoteDir: '/home/me/secret' })).status, 403);
  res = await post('/api/projects', { name: '毕业设计', machineId: pc.id, remoteDir: '/home/me/work/子 目录' });
  assert.equal(res.status, 201, res.text);
  const project = res.json.project;
  assert.deepEqual([project.remote.path, project.remote.machine, project.remote.online], ['/home/me/work/子 目录', '我的电脑', true]);
  // The file panel browses the project's remote folder.
  res = await get(`/api/machines/${pc.id}/tree?${q({ root: project.remote.path })}`);
  assert.deepEqual(res.json.entries.map((e) => e.name), ['a.txt']);

  // Claude is told where the files are and how to reach them.
  res = await post('/api/conversations', { projectId: project.id, message: { text: 'handoff?' } });
  assert.equal(res.status, 201, res.text);
  let { events } = await readEvents(ctx.port, `/api/conversations/${res.json.conversation.id}/events?run=${res.json.run.id}&after=0`, cookie);
  assert.match(textOf(events), /项目文件在所有者的远程机器「我的电脑」上：\/home\/me\/work\/子 目录（服务器上的 SSH 别名 my-pc/);
  assert.doesNotMatch(textOf(events), /无法连接/);

  // A project on a machine that went offline: the owner is asked first.
  const machines = ctx.app.machines;
  const stored = machines.get(pc.id);
  stored.host = 'offline-pc';
  machines.status.delete(pc.id);
  const before = (await get('/api/conversations')).json.conversations.length;
  res = await post('/api/conversations', { projectId: project.id, message: { text: 'handoff?' } });
  assert.equal(res.status, 409);
  assert.equal(res.json.remoteOffline, true);
  assert.equal((await get('/api/conversations')).json.conversations.length, before, 'no empty chat is left behind');
  res = await post('/api/conversations', { projectId: project.id, message: { text: 'handoff?' }, ignoreOffline: true });
  assert.equal(res.status, 201, res.text);
  ({ events } = await readEvents(ctx.port, `/api/conversations/${res.json.conversation.id}/events?run=${res.json.run.id}&after=0`, cookie));
  assert.match(textOf(events), /无法连接（离线、休眠或网络断开）。不要反复尝试连接/);
  stored.host = 'my-pc';

  // A machine in use by a project cannot be removed.
  assert.equal((await request(ctx.port, 'DELETE', `/api/machines/${pc.id}`, { cookie })).status, 409);
  assert.equal((await request(ctx.port, 'DELETE', `/api/machines/${off.id}`, { cookie })).status, 200);
});
