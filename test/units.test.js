import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, parseInline, safeHref } from '../public/markdown.js';
import { LoginLimiter, checkHost, checkOrigin, hashPassword, verifyPassword } from '../src/auth.js';
import { StreamTranslator, approvalDetail, summarizeTool } from '../src/stream.js';

test('markdown keeps HTML as text and only links safe protocols', () => {
  const blocks = parseBlocks('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'paragraph']);
  assert.deepEqual(parseInline(blocks[0].text), [{ type: 'text', text: '<script>alert(1)</script>' }]);
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('data:text/html,hi'), null);
  assert.deepEqual(parseInline('[x](javascript:alert(1))').map((t) => t.type), ['text']);
  const link = parseInline('见 https://example.com/a?b=1。');
  assert.equal(link[1].type, 'link');
  assert.equal(link[1].href, 'https://example.com/a?b=1');
  assert.deepEqual(link[2], { type: 'text', text: '。' });
});

test('markdown block structure: code, lists, tables, unclosed fence while streaming', () => {
  const md = '# 标题\n\n- 一\n- 二\n  - 嵌套\n\n1. 甲\n2. 乙\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = "<b>";\n```\n\n```py\nprint(1)';
  const blocks = parseBlocks(md);
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'list', 'list', 'table', 'code', 'code']);
  assert.equal(blocks[1].items.length, 2);
  assert.equal(blocks[1].items[1][1].type, 'list');
  assert.equal(blocks[2].ordered, true);
  assert.deepEqual(blocks[3].rows, [['1', '2']]);
  assert.equal(blocks[4].text, 'const x = "<b>";');
  assert.equal(blocks[5].text, 'print(1)');
  assert.deepEqual(parseInline('a `b` **c**').map((t) => t.type), ['text', 'code', 'text', 'strong']);
});

test('password hashing round-trips and rejects wrong secrets', async () => {
  const rec = await hashPassword('correct horse');
  assert.equal(await verifyPassword('correct horse', rec), true);
  assert.equal(await verifyPassword('correct hors', rec), false);
  assert.ok(!JSON.stringify(rec).includes('correct horse'));
});

test('login limiter: per-key and global windows', () => {
  let now = 0;
  const lim = new LoginLimiter({ perKey: 2, global: 3, windowMs: 1000, now: () => now });
  lim.fail('a'); lim.fail('a');
  assert.equal(lim.check('a').allowed, false);
  assert.equal(lim.check('b').allowed, true);
  lim.fail('b');
  assert.equal(lim.check('c').allowed, false, 'global ceiling');
  now = 1001;
  assert.equal(lim.check('a').allowed, true, 'window expires');
});

test('host allowlist and same-origin checks', () => {
  const hosts = ['localhost', '127.0.0.1', '[::1]'];
  assert.equal(checkHost('127.0.0.1:3400', hosts), true);
  assert.equal(checkHost('localhost:8080', hosts), true);
  assert.equal(checkHost('[::1]:3400', hosts), true);
  assert.equal(checkHost('rebind.evil.example:3400', hosts), false);
  assert.equal(checkHost(undefined, hosts), false);
  assert.equal(checkOrigin({ host: '127.0.0.1:3400', origin: 'http://127.0.0.1:3400' }), true);
  assert.equal(checkOrigin({ host: '127.0.0.1:3400', origin: 'http://127.0.0.1:9999' }), false);
  assert.equal(checkOrigin({ host: '127.0.0.1:3400' }), false);
  assert.equal(checkOrigin({ host: '127.0.0.1:3400', origin: 'null' }), false);
  assert.equal(checkOrigin({ host: 'a', origin: 'http://a', 'sec-fetch-site': 'same-site' }), false);
});

test('stream translator: streamed text is not duplicated, tools tracked, subagents ignored', () => {
  const msg = { parts: [] };
  const events = [];
  const t = new StreamTranslator(msg, (e) => events.push(e));
  t.handle({ type: 'system', subtype: 'init', session_id: 's1' });
  t.handle({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
  t.handle({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '先看' } } });
  t.handle({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'secret' } } });
  t.handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '先看' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls -la\nrm x', description: '列出文件' } }] } });
  t.handle({ type: 'assistant', parent_tool_use_id: 'tu1', message: { id: 'sub', content: [{ type: 'text', text: '子代理内部' }] } });
  t.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'raw output' }] } });
  t.handle({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: '完成' }] } });
  t.handle({ type: 'result', subtype: 'success', session_id: 's1', result: '完成' });
  assert.deepEqual(msg.parts, [
    { type: 'text', text: '先看' },
    { type: 'tool', id: 'tu1', name: 'Bash', summary: '列出文件', state: 'done', detail: 'ls -la\nrm x' },
    { type: 'text', text: '完成' },
  ]);
  assert.equal(t.sessionId, 's1');
  assert.ok(!JSON.stringify(events).includes('secret'));
  assert.ok(!JSON.stringify(events).includes('raw output'));
  // Part events are snapshots, so replaying them later cannot double-count text.
  assert.equal(events.find((e) => e.type === 'part' && e.index === 0).part.text, '');
});

test('tool summaries and approval details', () => {
  assert.equal(summarizeTool('Bash', { command: 'echo a\necho b' }), 'echo a');
  assert.equal(summarizeTool('Read', { file_path: '/etc/hosts' }), '/etc/hosts');
  assert.equal(approvalDetail('Bash', { command: 'sudo -n systemctl restart x' }), 'sudo -n systemctl restart x');
  assert.match(approvalDetail('Write', { file_path: '/tmp/a', content: 'hello' }), /文件：\/tmp\/a\n\nhello/);
  assert.match(approvalDetail('Other', { a: 'x'.repeat(5000) }), /已截断/);
});

test('RFB filter passes the handshake and display traffic, gates input', async () => {
  const { RfbFilter } = await import('../src/browser.js');
  let allow = false;
  const f = new RfbFilter(() => allow);
  const hs = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]);
  const enc = Buffer.from([2, 0, 0, 2, 0, 0, 0, 7, 0, 0, 0, 0]);
  const fbur = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
  const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);
  const ptr = Buffer.from([5, 1, 0, 10, 0, 20]);
  const all = Buffer.concat([hs, enc, fbur, key, ptr]);
  // Split at awkward points to exercise buffering.
  const out = [...f.push(all.subarray(0, 9)).out, ...f.push(all.subarray(9, 21)).out, ...f.push(all.subarray(21)).out];
  assert.deepEqual(Buffer.concat(out), Buffer.concat([hs, enc, fbur]));
  allow = true;
  assert.deepEqual(Buffer.concat(f.push(Buffer.concat([key, ptr])).out), Buffer.concat([key, ptr]));
  assert.ok(f.push(Buffer.from([99, 0, 0])).error);
});

test('WebSocket frames: masked client frames decode, server frames encode', async () => {
  const { FrameParser, encodeFrame } = await import('../src/ws.js');
  const got = [];
  const p = new FrameParser((op, data) => got.push([op, data.toString()]));
  const payload = Buffer.from('hello');
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
  const frame = Buffer.concat([Buffer.from([0x82, 0x80 | payload.length]), mask, masked]);
  assert.equal(p.push(frame.subarray(0, 3)), null);
  assert.equal(p.push(frame.subarray(3)), null);
  assert.deepEqual(got, [[2, 'hello']]);
  assert.equal(new FrameParser(() => {}).push(Buffer.from([0x82, 0x05, 1, 2, 3, 4, 5])), 'unmasked client frame');
  assert.deepEqual([...encodeFrame(Buffer.alloc(200)).subarray(0, 4)], [0x82, 126, 0, 200]);
});

test('BrowserOS tab list: page id to URL', async () => {
  const { pageUrl } = await import('../src/browser.js');
  const text = "User's tabs:\n[1] about:blank (about:blank)\n\nYour tabs:\n[3] https://passport.bilibili.com/login (账号登录)\n[4] https://example.com/ (Example)";
  assert.equal(pageUrl(text, 3), 'https://passport.bilibili.com/login');
  assert.equal(pageUrl(text, null), 'https://example.com/');
  assert.equal(pageUrl("User's tabs:\n[1] about:blank (about:blank)", 9), null);
});

test('session cost: last cumulative cost-state entry of the CLI transcript', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { sessionCost } = await import('../src/context.js');
  const root = await mkdtemp(join(tmpdir(), 'aw-cost-'));
  const cfg = { claudeProjectsDir: root, claudeCwd: '/home/x/assistant-home' };
  const sid = '6f318f48-7cf4-48be-b9eb-827dd903ced7';
  await mkdir(join(root, '-home-x-assistant-home'));
  await writeFile(join(root, '-home-x-assistant-home', `${sid}.jsonl`), [
    JSON.stringify({ type: 'cost-state', totalCostUSD: 0.5 }),
    JSON.stringify({ type: 'assistant', message: { content: 'x' } }),
    JSON.stringify({ type: 'cost-state', totalCostUSD: 1.2345678 }),
    JSON.stringify({ type: 'mode' }),
  ].join('\n'));
  assert.deepEqual(await sessionCost(cfg, sid), { costUsd: 1.234568, sessionId: sid });
  assert.equal(await sessionCost(cfg, '00000000-0000-4000-8000-000000000000'), null);
  assert.equal(await sessionCost(cfg, '../etc/passwd'), null);
  await rm(root, { recursive: true, force: true });
});

test('handoff: generic lines, browser lines only with a browser, host notes appended', async () => {
  const { RunManager } = await import('../src/runner.js');
  const runs = new RunManager({ cfg: { claudeCwd: '/srv/home', browserEnabled: false }, store: null });
  let text = runs.handoff('manual');
  assert.match(text, /工作目录：\/srv\/home。/);
  assert.doesNotMatch(text, /browseros-neo/);
  assert.match(text, /当前权限模式：逐条确认。$/);
  runs.cfg.browserEnabled = true;
  runs.handoffExtra = '这台机器的说明';
  text = runs.handoff('auto');
  assert.match(text, /browseros-neo/);
  assert.match(text, /这台机器的说明\n当前权限模式：auto/);
});
