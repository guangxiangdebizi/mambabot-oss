import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { login, makeDirs, rawPost, readEvents, request, startApp } from './helpers.js';
import { PNG, sampleDocx, sampleXlsx } from './zipfix.js';

let dirs;
let ctx;
let cookie;
let outside;

before(async () => {
  dirs = await makeDirs();
  ctx = await startApp(dirs);
  cookie = await login(ctx.port, ctx.password);
  // Files a reply might name: in the chat's directory and elsewhere on the host.
  outside = join(dirs.root, 'elsewhere');
  await mkdir(outside, { recursive: true });
  await writeFile(join(dirs.claudeCwd, 'chart.png'), PNG);
  await writeFile(join(outside, 'report.docx'), sampleDocx());
  await writeFile(join(outside, 'data.xlsx'), sampleXlsx());
  await writeFile(join(outside, 'clip.mp4'), Buffer.alloc(1000, 7));
  await writeFile(join(outside, 'page.html'), '<h1>hi</h1><script>alert(1)</script>');
});
after(async () => {
  await ctx.app.close();
  await dirs.cleanup();
});

const get = (path, headers = {}) => request(ctx.port, 'GET', path, { cookie, headers });
const enc = encodeURIComponent;

/** GET returning the raw body bytes. */
function getBytes(path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: ctx.port, path, headers: { Host: `127.0.0.1:${ctx.port}`, Cookie: cookie, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('host files: reader data and bytes for paths anywhere, with a session only', async () => {
  const path = join(outside, 'report.docx');
  assert.equal((await request(ctx.port, 'GET', `/api/files/file?path=${enc(path)}`)).status, 401);
  let res = await get(`/api/files/file?path=${enc(path)}`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.file.kind, 'docx');
  assert.equal(res.json.file.path, await realpath(path));
  assert.equal(res.json.file.blocks[0].runs[0].text, '标题 <一>');

  const part = await getBytes(`/api/files/part?path=${enc(path)}&entry=${enc('word/media/image1.png')}`);
  assert.equal(part.status, 200);
  assert.equal(part.headers['content-type'], 'image/png');
  assert.deepEqual(part.body, PNG);
  assert.equal((await get(`/api/files/part?path=${enc(path)}&entry=${enc('word/document.xml')}`)).status, 422);

  res = await get(`/api/files/file?path=${enc(join(outside, 'data.xlsx'))}&sheet=1`);
  assert.equal(res.json.file.sheet, 1);
  assert.deepEqual(res.json.file.table.rows, [['', '42']]);

  // Relative paths resolve against the chat's directory.
  const conv = (await request(ctx.port, 'POST', '/api/conversations', { body: {}, cookie })).json.conversation.id;
  const img = await getBytes(`/api/files/raw?path=chart.png&conv=${conv}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.equal(img.headers['content-disposition'].startsWith('inline'), true);
  assert.deepEqual(img.body, PNG);
});

test('host files: credentials and service data are refused', async () => {
  for (const p of [join(dirs.configDir, 'auth.json'), join(dirs.dataDir, 'sessions.json'), '/proc/self/environ']) {
    const res = await get(`/api/files/raw?path=${enc(p)}`);
    assert.equal(res.status, 403, p);
  }
  assert.equal((await get(`/api/files/file?path=${enc(join(outside, 'nope.txt'))}`)).status, 404);
});

test('media is streamed with byte ranges; unknown types download; HTML renders without scripts', async () => {
  const path = enc(join(outside, 'clip.mp4'));
  const full = await getBytes(`/api/files/raw?path=${path}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['content-type'], 'video/mp4');
  assert.equal(full.body.length, 1000);
  const part = await getBytes(`/api/files/raw?path=${path}`, { Range: 'bytes=10-19' });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], 'bytes 10-19/1000');
  assert.equal(part.body.length, 10);
  assert.equal((await getBytes(`/api/files/raw?path=${path}`, { Range: 'bytes=5000-' })).status, 416);

  const docx = await getBytes(`/api/files/raw?path=${enc(join(outside, 'report.docx'))}`);
  assert.equal(docx.headers['content-type'], 'application/octet-stream');
  assert.match(docx.headers['content-disposition'], /^attachment/);

  const html = enc(join(outside, 'page.html'));
  const asFile = await getBytes(`/api/files/raw?path=${html}`);
  assert.match(asFile.headers['content-disposition'], /^attachment/);
  const rendered = await getBytes(`/api/files/raw?path=${html}&render=html`);
  assert.equal(rendered.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(rendered.headers['content-security-policy'], /^sandbox allow-same-origin; default-src 'none'/);
  assert.equal(rendered.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal((await get(`/api/files/file?path=${html}`)).json.file.kind, 'html');
});

test('attachments open in the reader: preview, embedded images, ranges', async () => {
  const up = await rawPost(ctx.port, '/api/uploads', sampleXlsx(), {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-File-Name': enc('销售.xlsx'), Cookie: cookie,
  });
  assert.equal(up.status, 201, up.text);
  const id = up.json.attachment.id;
  let res = await get(`/api/uploads/${id}/preview`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.file.kind, 'sheet');
  assert.equal(res.json.file.name, '销售.xlsx');
  assert.equal((await request(ctx.port, 'GET', `/api/uploads/${id}/preview`)).status, 401);

  const doc = await rawPost(ctx.port, '/api/uploads', sampleDocx(), { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'r.docx', Cookie: cookie });
  const part = await getBytes(`/api/uploads/${doc.json.attachment.id}/part?entry=${enc('word/media/image1.png')}`);
  assert.deepEqual(part.body, PNG);

  // A browser-declared type never makes a non-media file inline.
  const fake = await rawPost(ctx.port, '/api/uploads', Buffer.from('<script>1</script>'), { 'Content-Type': 'text/html', 'X-File-Name': 'x.html', Cookie: cookie });
  const served = await getBytes(`/api/uploads/${fake.json.attachment.id}`);
  assert.equal(served.headers['content-type'], 'application/octet-stream');
  const ranged = await getBytes(`/api/uploads/${fake.json.attachment.id}`, { Range: 'bytes=0-6' });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.body.toString(), '<script');
});

test('project files: reader data, embedded images, sheets', async () => {
  await writeFile(join(dirs.claudeCwd, 'notes.docx'), sampleDocx());
  let res = await get('/api/projects/default/file?path=notes.docx');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.file.kind, 'docx');
  assert.equal(res.json.file.path, 'notes.docx');
  const part = await getBytes(`/api/projects/default/part?path=notes.docx&entry=${enc('word/media/image1.png')}`);
  assert.equal(part.status, 200);
  res = await get(`/api/projects/default/file?path=${enc('/etc/hosts')}`);
  assert.equal(res.status, 403, 'the project tree stays inside its directory');
});

test('images a reply shows with Markdown are saved when it ends', async () => {
  const conv = (await request(ctx.port, 'POST', '/api/conversations', { body: {}, cookie })).json.conversation.id;
  const sent = await request(ctx.port, 'POST', `/api/conversations/${conv}/messages`, {
    body: { text: 'echo ![图表](chart.png) ![缺](missing.png) ![网](https://example.com/x.png) ![密](../config/auth.json)' }, cookie,
  });
  assert.equal(sent.status, 201, sent.text);
  const { events } = await readEvents(ctx.port, `/api/conversations/${conv}/events?run=${sent.json.run.id}&after=0`, cookie);
  const meta = events.find((e) => e.type === 'meta' && e.media);
  assert.ok(meta, 'the saved images are announced before the reply ends');
  const msg = (await get(`/api/conversations/${conv}`)).json.conversation.messages.find((m) => m.role === 'assistant');
  assert.deepEqual(Object.keys(msg.media), ['chart.png']);
  assert.equal(msg.media['chart.png'].image, true);
  // The original can go away; the reply keeps its copy.
  await rm(join(dirs.claudeCwd, 'chart.png'));
  const copy = await getBytes(`/api/uploads/${msg.media['chart.png'].id}`);
  assert.equal(copy.headers['content-type'], 'image/png');
  assert.deepEqual(copy.body, PNG);
});

test('web images come through the proxy, never from private addresses', async () => {
  const res = await get(`/api/media/remote?url=${enc(`http://127.0.0.1:${ctx.port}/healthz`)}`);
  assert.equal(res.status, 403);
  assert.equal((await get(`/api/media/remote?url=${enc('file:///etc/passwd')}`)).status, 400);
  assert.equal((await request(ctx.port, 'GET', `/api/media/remote?url=${enc('https://example.com/a.png')}`)).status, 401);
});

test('remote image preference', async () => {
  let res = await request(ctx.port, 'PUT', '/api/prefs', { body: { remoteImages: 'click' }, cookie });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.prefs.remoteImages, 'click');
  assert.equal((await request(ctx.port, 'PUT', '/api/prefs', { body: { remoteImages: 'always' }, cookie })).status, 400);
  res = await request(ctx.port, 'PUT', '/api/prefs', { body: { remoteImages: 'auto' }, cookie });
  assert.equal(res.json.prefs.remoteImages, 'auto');
});

test('static files: ETag revalidation, gzip, immutable vendor files with their own CSP', async () => {
  const first = await getBytes('/app.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-encoding'], 'gzip');
  assert.ok(gunzipSync(first.body).toString().includes('renderMarkdown'));
  const again = await getBytes('/app.js', { 'If-None-Match': first.headers.etag });
  assert.equal(again.status, 304);
  const worker = await getBytes('/vendor/pdfjs/6.5.438/pdf.worker.min.mjs');
  assert.equal(worker.status, 200);
  assert.match(worker.headers['content-type'], /^text\/javascript/);
  assert.match(worker.headers['cache-control'], /immutable/);
  assert.match(worker.headers['content-security-policy'], /script-src 'self' 'wasm-unsafe-eval'/);
  const page = await getBytes('/');
  assert.doesNotMatch(page.headers['content-security-policy'], /wasm-unsafe-eval/);
  const cmap = await getBytes('/vendor/pdfjs/6.5.438/cmaps/UniGB-UCS2-H.bcmap');
  assert.equal(cmap.status, 200);
  assert.equal((await getBytes('/vendor/pdfjs/6.5.438/LICENSE')).status, 404);
});
