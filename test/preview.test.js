import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipError, entryData, readZip } from '../src/zip.js';
import { parseXml, sax, STOP, textOf } from '../src/xml.js';
import { OfficeError, officePart, officePreview } from '../src/office.js';
import { buildPreview, decodeText, kindOf, parseDelimited, parseRange } from '../src/preview.js';
import { HostFiles } from '../src/hostfiles.js';
import { RemoteImages, isPublicAddress } from '../src/remote.js';
import { imageRefs, parseInline, looksLikeFileRef } from '../public/markdown.js';
import { PNG, makeZip, sampleDocx, samplePptx, sampleXlsx } from './zipfix.js';

test('zip: stored and deflated entries, inflate cap, damaged archives', () => {
  const buf = makeZip({ 'a.txt': 'hello', 'dir/b.xml': 'x'.repeat(5000) });
  const entries = readZip(buf);
  assert.deepEqual([...entries.keys()], ['a.txt', 'dir/b.xml']);
  assert.equal(entryData(buf, entries.get('a.txt')).toString(), 'hello');
  assert.equal(entryData(buf, entries.get('dir/b.xml')).length, 5000);
  assert.throws(() => entryData(buf, entries.get('dir/b.xml'), 100), ZipError);
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), ZipError);
});

test('xml: entities, CDATA, comments, no DTD expansion, early stop', () => {
  const tree = parseXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "boom">]><r a="1 &gt; 0"><!-- c --><t>&lt;&#x4e2d;&#25991;&amp;&a;</t><![CDATA[<raw>]]></r>');
  const r = tree.c[0];
  assert.equal(r.a.a, '1 > 0');
  assert.equal(textOf(r), '<中文&&a;<raw>');
  let seen = 0;
  sax('<a><b/><b/><b/></a>', { open(name) { if (name === 'b') { seen += 1; return STOP; } return undefined; } });
  assert.equal(seen, 1);
});

test('docx: headings via styles, runs, safe links, lists, tables with merges, images', () => {
  const d = officePreview(sampleDocx(), 'docx');
  const [h1, h2, para, li1, li2, li3, bullet, cn, empty, table, pics] = d.blocks;
  assert.deepEqual(h1, { t: 'p', runs: [{ text: '标题 <一>' }], h: 1 });
  assert.equal(h2.h, 1);
  assert.equal(h2.align, 'center');
  assert.deepEqual(para.runs.map((r) => r.text), ['粗体 ', '斜体', '\t制表\n换行', '链接', '坏链接']);
  assert.equal(para.runs[0].b, true);
  assert.equal(para.runs[1].i, true);
  assert.equal(para.runs[1].b, undefined);
  assert.equal(para.runs[3].href, 'https://example.com/a?b=1&c=2');
  assert.equal(para.runs[4].href, undefined, 'javascript: links are dropped');
  assert.deepEqual([li1.list.label, li2.list.label, li3.list.label], ['1.', '1.a)', '2.']);
  assert.equal(bullet.list.label, '•');
  assert.equal(cn.list.label, '一、');
  assert.deepEqual(empty, { t: 'p', runs: [] });
  assert.equal(table.rows[0][0].colspan, 2);
  assert.equal(table.rows[0][1].rowspan, 2);
  assert.equal(table.rows[1].length, 2);
  assert.deepEqual(pics.runs[0], { img: 'word/media/image1.png', alt: '示意图', w: 100, h: 50 });
  assert.equal(pics.runs[1].unsupported, 'EMF');
  assert.equal(officePart(sampleDocx(), 'word/media/image1.png').type, 'image/png');
  assert.throws(() => officePart(sampleDocx(), 'word/document.xml'), OfficeError);
  assert.throws(() => officePreview(Buffer.from('PK nope'), 'docx'), OfficeError);
});

test('xlsx: shared strings, number and date formats, merges, sheets', () => {
  const x = officePreview(sampleXlsx(), 'sheet');
  assert.deepEqual(x.sheets, [{ name: '销售' }, { name: '隐藏', hidden: true }]);
  assert.deepEqual(x.table.rows, [
    ['日期', '金额', '富文本'],
    ['2025-01-01', '1,234,567.89', '12.34%', 'TRUE'],
    ['2025-01-01', '0.3', '内联', '公式结果'],
    ['2025-01-01 12:00', '#DIV/0!'],
  ]);
  assert.deepEqual(x.table.merges, [[0, 2, 0, 3]]);
  const second = officePreview(sampleXlsx(), 'sheet', { sheet: 1 });
  assert.equal(second.sheet, 1);
  assert.deepEqual(second.table.rows, [['', '42']]);
});

test('pptx: titles, levels, pictures, tables, notes, groups; slide numbers skipped', () => {
  const p = officePreview(samplePptx(), 'slides');
  assert.equal(p.slides.length, 2);
  const [s1, s2] = p.slides;
  assert.equal(s1.title, '季度总结');
  assert.deepEqual(s1.items[0].paras, [{ runs: [{ text: '收入增长', b: true }] }, { level: 1, runs: [{ text: '环比 12%' }] }]);
  assert.deepEqual(s1.items[1], { t: 'img', src: 'ppt/media/image1.png', alt: '图表', w: 200, h: 100 });
  assert.deepEqual(s1.items[2], { t: 'table', rows: [[{ text: '表头' }]] });
  assert.equal(s1.items.length, 3);
  assert.equal(s1.notes, '记得讲成本');
  assert.equal(s2.items[0].paras[0].runs[0].text, '分组里的文字');
});

test('text decoding: UTF-8 with BOM, GBK, UTF-16, cut multibyte tail', () => {
  assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), 'a');
  assert.equal(decodeText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x2c, 0x31])), '中文,1');
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65])), '中文');
  const cut = Buffer.from('中文', 'utf8').subarray(0, 5);
  assert.equal(decodeText(cut, true), '中');
});

test('CSV parsing: quotes, doubled quotes, newlines in fields', () => {
  const t = parseDelimited('a,"b,c","say ""hi"""\n1,"two\nlines",3\r\n', ',');
  assert.deepEqual(t.rows, [['a', 'b,c', 'say "hi"'], ['1', 'two\nlines', '3']]);
  assert.equal(t.cols, 3);
});

test('byte ranges', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
  assert.equal(parseRange('bytes=200-300', 100), false);
  assert.equal(parseRange('bytes=0-1,5-6', 100), null);
  assert.equal(parseRange(undefined, 100), null);
});

test('reader kinds and previews of files on disk', async () => {
  assert.equal(kindOf('a.PDF'), 'pdf');
  assert.equal(kindOf('x.docx'), 'docx');
  assert.equal(kindOf('x.xlsm'), 'sheet');
  assert.equal(kindOf('x.pptx'), 'slides');
  assert.equal(kindOf('x.doc'), 'legacy');
  assert.equal(kindOf('x.mov'), 'video');
  assert.equal(kindOf('notes.ipynb'), 'notebook');
  assert.equal(kindOf('Makefile'), 'text');
  const dir = await mkdtemp(join(tmpdir(), 'aw-prev-'));
  try {
    await writeFile(join(dir, 'r.docx'), sampleDocx());
    await writeFile(join(dir, 'g.csv'), Buffer.from([0xd6, 0xd0, 0x2c, 0x31, 0x0a, 0xce, 0xc4, 0x2c, 0x32]));
    await writeFile(join(dir, 'n.ipynb'), JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['# 标题'] }, { cell_type: 'code', execution_count: 1, source: 'print(1)', outputs: [{ output_type: 'stream', text: ['1\n'] }, { output_type: 'display_data', data: { 'image/png': PNG.toString('base64') } }] }] }));
    await writeFile(join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 0]));
    await writeFile(join(dir, 'old.doc'), 'x');
    const docx = await buildPreview(join(dir, 'r.docx'), { display: 'r.docx' });
    assert.equal(docx.kind, 'docx');
    assert.equal(docx.path, 'r.docx');
    assert.ok(docx.blocks.length > 5);
    const csv = await buildPreview(join(dir, 'g.csv'));
    assert.deepEqual(csv.table.rows, [['中', '1'], ['文', '2']]);
    const nb = await buildPreview(join(dir, 'n.ipynb'));
    assert.equal(nb.kind, 'notebook');
    assert.equal(nb.notebook.cells[1].outputs[0].text, '1\n');
    assert.match(nb.notebook.cells[1].outputs[1].image, /^data:image\/png;base64,/);
    assert.equal((await buildPreview(join(dir, 'bin.dat'))).kind, 'binary');
    const old = await buildPreview(join(dir, 'old.doc'));
    assert.equal(old.kind, 'binary');
    assert.match(old.note, /旧版/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('host files: any path a reply names, but never credentials or service data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-host-'));
  try {
    // As parsed from AW_CLAUDE_ACCOUNTS: the default account (~/.claude) has no dir of its own.
    const cfg = {
      configDir: join(root, 'config'), dataDir: join(root, 'data'), claudeCwd: join(root, 'home'),
      claudeAccounts: [{ id: 'a', name: '主账号', dir: null }, { id: 'b', name: '第二个', dir: join(root, 'claude-2') }],
    };
    for (const d of [cfg.configDir, cfg.dataDir, cfg.claudeCwd, join(root, 'elsewhere', '.git')]) await mkdir(d, { recursive: true });
    await writeFile(join(cfg.configDir, 'auth.json'), '{}');
    await writeFile(join(cfg.claudeCwd, 'pic.png'), PNG);
    await writeFile(join(root, 'elsewhere', 'report.pdf'), '%PDF-1.4');
    await writeFile(join(root, 'elsewhere', '.env.local'), 'SECRET=1');
    await writeFile(join(root, 'elsewhere', '.git', 'config'), '[core]');
    await symlink(join(cfg.configDir, 'auth.json'), join(cfg.claudeCwd, 'innocent.png'));
    const files = new HostFiles(cfg);
    assert.equal((await files.file('pic.png', cfg.claudeCwd)).size, PNG.length);
    assert.ok((await files.file(join(root, 'elsewhere', 'report.pdf'))).real.endsWith('report.pdf'));
    assert.ok((await files.locate(`file://${join(root, 'elsewhere', 'report.pdf')}`)).endsWith('report.pdf'));
    const refused = async (p, status) => assert.rejects(files.locate(p, cfg.claudeCwd), (err) => err.status === status);
    await refused(join(cfg.configDir, 'auth.json'), 403);
    await refused('innocent.png', 403);
    await refused(join(root, 'elsewhere', '.env.local'), 403);
    await refused(join(root, 'elsewhere', '.git', 'config'), 403);
    await refused('/proc/self/environ', 403);
    await mkdir(join(root, 'claude-2'), { recursive: true });
    await writeFile(join(root, 'claude-2', 'settings.json'), '{}');
    await refused(join(root, 'claude-2', 'settings.json'), 403);
    await refused(join(root, 'missing.png'), 404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remote images: public addresses only, images only, cached', async () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fd00::1', 'not-an-ip']) {
    assert.equal(isPublicAddress(a), false, a);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(a), true, a);

  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (req.url === '/a.png') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(PNG); return; }
    if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html></html>'); return; }
    if (req.url === '/hop') { res.writeHead(302, { Location: '/a.png' }); res.end(); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), 'aw-remote-'));
  try {
    const strict = new RemoteImages({ dataDir: dir, log: { warn() {} } });
    await assert.rejects(strict.get(`${base}/a.png`), (err) => err.status === 403);
    await assert.rejects(strict.get('ftp://example.com/a.png'), (err) => err.status === 400);
    await assert.rejects(strict.get('http://user:pw@example.com/a.png'), (err) => err.status === 400);
    const lax = new RemoteImages({ dataDir: dir, log: { warn() {} }, allowPrivate: true });
    const img = await lax.get(`${base}/hop`);
    assert.equal(img.type, 'image/png');
    assert.equal(img.size, PNG.length);
    const before = hits;
    await lax.get(`${base}/hop`);
    assert.equal(hits, before, 'second request comes from the cache');
    await assert.rejects(lax.get(`${base}/page`), (err) => err.status === 415);
    await assert.rejects(lax.get(`${base}/missing.png`), (err) => err.status === 502);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('markdown: images, file links, emphasis; image sources for snapshots', () => {
  assert.deepEqual(parseInline('看 ![图 1](/tmp/a b.png "说明") 了'), [
    { type: 'text', text: '看 ' }, { type: 'image', alt: '图 1', src: '/tmp/a b.png', title: '说明' }, { type: 'text', text: ' 了' },
  ]);
  assert.equal(parseInline('![w](https://x.org/File:A_(b).jpg)')[0].src, 'https://x.org/File:A_(b).jpg');
  assert.equal(parseInline('[报告](./out/r.pdf)')[0].type, 'filelink');
  assert.equal(parseInline('[x](javascript:alert(1))')[0].type, 'text');
  assert.equal(parseInline('[a](#top)')[0].type, 'text');
  assert.equal(looksLikeFileRef('docs/a.md'), true);
  assert.equal(looksLikeFileRef('mailto:a@b.c'), false);
  assert.deepEqual(parseInline('*斜* ~~删~~ snake_case').map((t) => t.type), ['em', 'text', 'del', 'text']);
  assert.deepEqual(imageRefs('![a](x.png)\n\n```\n![b](y.png)\n```\n\n- ![c](z.png) `![d](w.png)`\n\n|h|\n|-|\n|![e](https://e.org/e.png)|'), ['x.png', 'z.png', 'https://e.org/e.png']);
});

test('syntax highlighting: tokens become classed spans, text is unchanged', async () => {
  const { highlight, langOfFile } = await import('../public/highlight.js');
  const doc = {
    createDocumentFragment: () => ({ kids: [], append(...n) { this.kids.push(...n); } }),
    createElement: () => ({}),
    createTextNode: (t) => ({ textContent: t }),
  };
  const code = 'const a = "x"; // hi\nfunction f(n) { return n * 2; }';
  const frag = highlight(doc, code, 'js');
  assert.equal(frag.kids.map((k) => k.textContent).join(''), code);
  const cls = (t) => frag.kids.find((k) => k.textContent === t)?.className;
  assert.equal(cls('const'), 'hl-k');
  assert.equal(cls('"x"'), 'hl-s');
  assert.equal(cls('// hi'), 'hl-c');
  assert.equal(cls('f'), 'hl-f');
  assert.equal(highlight(doc, code, 'brainfuck'), null);
  assert.equal(highlight(doc, '+a\n-b', 'diff').kids[0].className, 'hl-ins');
  assert.equal(langOfFile('src/server.js'), 'js');
  assert.equal(langOfFile('notes.txt'), '');
});
