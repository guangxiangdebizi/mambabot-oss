// The in-page reader: renders what /file or /preview returned (see src/preview.js) for any
// source (a project file, any host path a reply named, an attachment). Everything is built
// from text with DOM calls; Office content arrives as plain data, never as HTML.
import { renderMarkdown, safeHref } from './markdown.js';
import { icon } from './icons.js';
import { highlight, langOfFile } from './highlight.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
export const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const q = (params) => Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

/* ---------- sources ---------- */

/**
 * Where a file comes from. Every source builds the URLs of its reader data (`preview`), its
 * bytes (`raw`) and its embedded Office images (`part`), and resolves paths relative to it.
 */
export function projectSource(key, path) {
  const base = `/api/projects/${encodeURIComponent(key)}`;
  return {
    type: 'project', key, path, id: `p:${key}:${path}`,
    preview: (o = {}) => `${base}/file?${q({ path, ...o })}`,
    raw: (o = {}) => `${base}/raw?${q({ path, ...o })}`,
    part: (entry) => `${base}/part?${q({ path, entry })}`,
    resolve: (rel) => projectSource(key, joinPath(dirOf(path), rel)),
  };
}

export function hostSource(path, conv = null) {
  return {
    type: 'host', path, conv, id: `h:${conv || ''}:${path}`,
    preview: (o = {}) => `/api/files/file?${q({ path, conv, ...o })}`,
    raw: (o = {}) => `/api/files/raw?${q({ path, conv, ...o })}`,
    part: (entry) => `/api/files/part?${q({ path, conv, entry })}`,
    resolve: (rel) => (/^(\/|~\/|file:)/.test(rel) ? hostSource(rel, conv) : hostSource(joinPath(dirOf(path), rel), conv)),
  };
}

/**
 * A file on one of the owner's computers (远程机器): `root` is the folder the panel browses (an
 * allowed root, or a remote project's folder), `path` relative to it; `label` names the machine.
 */
export function remoteSource(machineId, root, path, label = '') {
  const base = `/api/machines/${encodeURIComponent(machineId)}`;
  return {
    type: 'remote', machineId, root, path, label, id: `r:${machineId}:${root}:${path}`,
    preview: (o = {}) => `${base}/file?${q({ root, path, ...o })}`,
    raw: (o = {}) => `${base}/raw?${q({ root, path, ...o })}`,
    part: (entry) => `${base}/part?${q({ root, path, entry })}`,
    // Links inside a remote document stay on that machine and inside the same folder.
    resolve: (rel) => (/^(\/|~\/|file:|[A-Za-z]:)/.test(rel) ? null : remoteSource(machineId, root, joinPath(dirOf(path), rel).replace(/^(\.\.\/)+/, ''), label)),
  };
}

export function uploadSource(id, name = '') {
  const base = `/api/uploads/${encodeURIComponent(id)}`;
  return {
    type: 'upload', id: `u:${id}`, uploadId: id, name,
    preview: (o = {}) => `${base}/preview${Object.keys(o).length ? `?${q(o)}` : ''}`,
    raw: (o = {}) => `${base}${Object.keys(o).length ? `?${q(o)}` : ''}`,
    part: (entry) => `${base}/part?${q({ entry })}`,
    resolve: () => null,
  };
}

function dirOf(path) {
  const i = String(path).lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}
function joinPath(dir, rel) {
  if (/^(\/|~\/|file:)/.test(rel)) return rel;
  const out = dir ? dir.split('/') : [];
  const lead = String(dir).startsWith('/') ? '/' : '';
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (out.length && out[out.length - 1] !== '' && out[out.length - 1] !== '..') out.pop(); else if (!lead) out.push('..'); } else out.push(seg);
  }
  const joined = out.filter((s, i) => s || i === 0).join('/');
  return lead && !joined.startsWith('/') ? `/${joined}` : joined;
}

/* ---------- images in Markdown ---------- */

export const remoteImageUrl = (url) => `/api/media/remote?url=${encodeURIComponent(url)}`;
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
export const isDataImage = (s) => DATA_IMAGE.test(s);

/**
 * An image of a reply or Markdown file: a zoomable link around an <img>, or a placeholder.
 * `url` null means it cannot load here; `remote` (with remoteMode 'click') waits for a tap.
 */
export function mdImage({ url, alt = '', title = '', block = false, src = '', remote = false, deferred = false }) {
  const label = alt || title || src.split('/').pop() || '图片';
  if (!url) return el('span', 'md-img-alt', `[图片：${label}]`);
  if (deferred) {
    const b = el('button', 'md-img-load');
    b.type = 'button';
    b.dataset.url = url;
    b.dataset.alt = label;
    if (block) b.dataset.block = '1';
    let host = '';
    try { host = new URL(src).host; } catch { /* keep empty */ }
    b.append(icon('image', 16), el('span', '', `加载图片${host ? `（${host}）` : ''}`));
    return b;
  }
  const a = el('a', `md-img-link${block ? ' block' : ''}`);
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.dataset.view = label;
  const img = el('img', 'md-img');
  img.alt = label;
  img.loading = 'lazy';
  img.decoding = 'async';
  if (title) img.title = title;
  img.src = url;
  img.addEventListener('error', () => {
    const fail = el('span', 'md-img-error');
    fail.append(icon('image', 16), el('span', '', `图片无法显示：${remote ? src : (src || label)}`));
    fail.title = remote ? '外链图片下载失败或不是图片' : '文件不存在、不是图片，或位于不能在网页上查看的位置';
    a.replacement = fail; // a re-render reuses the placeholder, not the broken image
    a.replaceWith(fail);
  }, { once: true });
  a.append(img);
  return a;
}

/* ---------- renderers ---------- */

function lineView(text, lang = '') {
  const box = el('div', 'fp-code');
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const nums = el('pre', 'fp-ln', lines.map((_, i) => i + 1).join('\n'));
  nums.setAttribute('aria-hidden', 'true');
  const src = el('pre', 'fp-src');
  const code = el('code');
  const body = lines.join('\n');
  code.append(highlight(document, body, lang) || document.createTextNode(body));
  src.append(code);
  box.append(nums, src);
  return box;
}

function runsInto(parent, runs, ctx) {
  for (const r of runs || []) {
    if (r.img) { parent.append(officeImage(r, ctx)); continue; }
    let node = document.createDocumentFragment();
    String(r.text).split('\n').forEach((piece, i) => {
      if (i) node.append(el('br'));
      if (piece) node.append(document.createTextNode(piece));
    });
    for (const [flag, tag] of [['sub', 'sub'], ['sup', 'sup'], ['s', 'del'], ['u', 'u'], ['i', 'em'], ['b', 'strong']]) {
      if (!r[flag]) continue;
      const w = el(tag);
      w.append(node);
      node = w;
    }
    const href = r.href && safeHref(r.href);
    if (href) {
      const a = el('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.append(node);
      node = a;
    }
    parent.append(node);
  }
}

function officeImage(r, ctx) {
  if (r.unsupported) return el('span', 'doc-img-missing', `[${r.unsupported} 图片无法在网页中显示]`);
  const url = ctx.src.part(r.img || r.src);
  const a = el('a', 'doc-img-link');
  a.href = url;
  a.dataset.view = r.alt || '图片';
  const img = el('img', 'doc-img');
  img.loading = 'lazy';
  img.alt = r.alt || '';
  if (r.w) img.width = r.w;
  if (r.h && r.w) img.height = r.h;
  img.src = url;
  img.addEventListener('error', () => a.replaceWith(el('span', 'doc-img-missing', '[图片无法显示]')), { once: true });
  a.append(img);
  return a;
}

function docBlocks(parent, blocks, ctx) {
  for (const b of blocks) {
    if (b.t === 'table') {
      const wrap = el('div', 'table-wrap doc-table-wrap');
      const table = el('table', 'doc-table');
      for (const row of b.rows) {
        const tr = el('tr');
        for (const cell of row) {
          const td = el('td');
          if (cell.colspan) td.colSpan = cell.colspan;
          if (cell.rowspan) td.rowSpan = cell.rowspan;
          docBlocks(td, cell.blocks, ctx);
          tr.append(td);
        }
        table.append(tr);
      }
      wrap.append(table);
      parent.append(wrap);
      if (b.truncated) parent.append(el('p', 'fp-note', '表格太长，只显示前 2000 行。'));
      continue;
    }
    let node;
    let target;
    if (b.h) node = el(`h${Math.min(6, b.h + 1)}`, 'doc-h');
    else if (b.list) {
      // Label and text side by side, so long labels (“一、”, “1.2.3”) never overlap the text.
      node = el('div', 'doc-li');
      node.style.paddingLeft = `${b.list.level * 1.5}em`;
      target = el('span', 'doc-li-text');
      node.append(el('span', 'doc-li-label', b.list.label), target);
    } else node = el('p', b.runs.length ? '' : 'doc-empty');
    if (b.align) node.style.textAlign = b.align;
    runsInto(target || node, b.runs, ctx);
    parent.append(node);
  }
}

function sheetView(file, ctx) {
  const box = el('div', 'sheet-view');
  if (file.sheets.length > 1) {
    const tabs = el('div', 'sheet-tabs');
    tabs.setAttribute('role', 'tablist');
    file.sheets.forEach((s, i) => {
      const b = el('button', `sheet-tab${i === file.sheet ? ' current' : ''}${s.hidden ? ' hidden-sheet' : ''}`, s.name + (s.hidden ? '（隐藏）' : ''));
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(i === file.sheet));
      b.addEventListener('click', () => { if (i !== file.sheet) ctx.reload({ sheet: i }); });
      tabs.append(b);
    });
    box.append(tabs);
  }
  const t = file.table;
  if (!t.rows.length) {
    box.append(el('p', 'fp-note', '这个工作表是空的。'));
    return box;
  }
  box.append(gridTable(t, { colLetters: true }));
  const notes = [];
  if (t.truncatedRows) notes.push(`共约 ${t.totalRows || '很多'} 行，只显示前 ${t.rows.length} 行`);
  if (t.truncatedCols) notes.push('列太多，只显示前 60 列');
  if (notes.length) box.append(el('p', 'fp-note', `${notes.join('；')}。完整内容请下载。`));
  return box;
}

const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/** Spreadsheet-style grid with row numbers; merges are [r0, c0, r1, c1]. */
function gridTable(t, { colLetters = false, header = false } = {}) {
  const wrap = el('div', 'grid-wrap');
  const table = el('table', 'grid');
  const covered = new Set();
  const spans = new Map();
  for (const [r0, c0, r1, c1] of t.merges || []) {
    spans.set(`${r0},${c0}`, { rs: r1 - r0 + 1, cs: c1 - c0 + 1 });
    for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) if (r !== r0 || c !== c0) covered.add(`${r},${c}`);
  }
  if (colLetters) {
    const thead = el('thead');
    const tr = el('tr');
    tr.append(el('th', 'grid-corner'));
    for (let c = 0; c < t.cols; c += 1) tr.append(el('th', 'grid-col', colName(c)));
    thead.append(tr);
    table.append(thead);
  }
  const tbody = el('tbody');
  t.rows.forEach((row, r) => {
    const tr = el('tr');
    if (header && r === 0) tr.className = 'grid-head';
    tr.append(el('th', 'grid-row', String(r + 1)));
    for (let c = 0; c < t.cols; c += 1) {
      const key = `${r},${c}`;
      if (covered.has(key)) continue;
      const td = el('td', '', row[c] ?? '');
      const span = spans.get(key);
      if (span) { td.rowSpan = span.rs; td.colSpan = span.cs; }
      if (/^-?[\d,]+(\.\d+)?%?$/.test(row[c] ?? '')) td.className = 'num';
      tr.append(td);
    }
    tbody.append(tr);
  });
  table.append(tbody);
  wrap.append(table);
  return wrap;
}

function slidesView(file, ctx) {
  const box = el('div', 'slides');
  for (const s of file.slides) {
    const sec = el('section', 'slide');
    const head = el('div', 'slide-head');
    head.append(el('span', 'slide-n', `${s.n}`));
    if (s.title) head.append(el('h3', 'slide-title', s.title));
    sec.append(head);
    for (const item of s.items) {
      if (item.t === 'text') {
        const ul = el('div', `slide-text${item.sub ? ' sub' : ''}`);
        for (const p of item.paras) {
          const para = el('p', 'slide-p');
          if (p.level) para.style.paddingLeft = `${p.level * 1.2}em`;
          runsInto(para, p.runs, ctx);
          ul.append(para);
        }
        sec.append(ul);
      } else if (item.t === 'img') {
        const fig = el('div', 'slide-img');
        fig.append(officeImage(item, ctx));
        sec.append(fig);
      } else if (item.t === 'table') {
        const wrap = el('div', 'table-wrap doc-table-wrap');
        const table = el('table', 'doc-table');
        for (const row of item.rows) {
          const tr = el('tr');
          for (const cell of row) {
            const td = el('td', '', cell.text);
            if (cell.colspan) td.colSpan = cell.colspan;
            if (cell.rowspan) td.rowSpan = cell.rowspan;
            tr.append(td);
          }
          table.append(tr);
        }
        wrap.append(table);
        sec.append(wrap);
      } else if (item.t === 'note') {
        sec.append(el('p', 'fp-note', `[${item.text}，网页中不显示]`));
      }
    }
    if (!s.items.length && !s.title) sec.append(el('p', 'fp-note', '（这一页没有文字或图片）'));
    if (s.notes) {
      const notes = el('details', 'slide-notes');
      notes.append(el('summary', '', '演讲者备注'), el('p', '', s.notes));
      sec.append(notes);
    }
    box.append(sec);
  }
  if (file.truncated) box.append(el('p', 'fp-note', '页数太多，只显示前 300 页。'));
  return box;
}

function notebookView(nb, ctx) {
  const box = el('div', 'nb');
  for (const c of nb.cells) {
    const cell = el('div', `nb-cell ${c.type}`);
    if (c.type === 'markdown') {
      const md = el('div', 'md');
      md.append(renderMarkdown(c.source, document, ctx.mdOptions));
      cell.append(md);
    } else {
      const head = el('div', 'nb-prompt', c.type === 'code' ? `In [${c.count ?? ' '}]` : 'raw');
      const pre = el('pre', 'nb-src');
      const code = el('code');
      code.append((c.type === 'code' && highlight(document, c.source, nb.lang || 'python')) || document.createTextNode(c.source));
      pre.append(code);
      cell.append(head, pre);
      for (const o of c.outputs || []) {
        if (o.image) {
          const a = el('a', 'doc-img-link');
          a.href = o.image;
          a.dataset.view = '输出图片';
          const img = el('img', 'doc-img');
          img.src = o.image;
          img.alt = '输出图片';
          a.append(img);
          cell.append(a);
        } else if (o.markdown !== undefined) {
          const md = el('div', 'md nb-out');
          md.append(renderMarkdown(o.markdown, document, ctx.mdOptions));
          cell.append(md);
        } else cell.append(el('pre', `nb-out${o.error ? ' error' : ''}`, o.text));
      }
    }
    box.append(cell);
  }
  if (!nb.cells.length) box.append(el('p', 'fp-note', '笔记本是空的。'));
  return box;
}

function binaryCard(file, ctx, note) {
  const box = el('div', 'fp-binary');
  box.append(icon('file', 32), el('p', '', `${file.name || ''}${file.size !== undefined ? ` · ${fmtSize(file.size)}` : ''}`), el('p', 'fp-note', note || file.note || '这个文件无法在网页里预览。'));
  const a = el('a', 'btn btn-primary btn-sm', '下载');
  a.href = ctx.src.raw({ download: 1 });
  box.append(a);
  return box;
}

/**
 * Renders `file` (reader data) from `src` into `body`.
 * ctx: { showSource, reload(params), openSource(src), mdImage(token, block, src), remoteMode }
 * Returns { destroy() } for viewers that hold resources (PDF).
 */
export function renderPreview(body, file, src, ctx) {
  const full = { ...ctx, src };
  full.mdOptions = {
    image: (tok, block) => ctx.mdImage(tok, block, src),
    highlight: (code, lang) => highlight(document, code, lang),
    fileLink: (path, label) => {
      const target = src.resolve(path);
      if (!target) return null;
      const a = el('a', 'path-link file-link', label || path);
      a.href = target.raw();
      a.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        ctx.openSource(target);
      });
      return a;
    },
  };
  let handle = null;
  switch (file.kind) {
    case 'markdown':
      if (ctx.showSource) body.append(lineView(file.text, 'markdown'));
      else {
        const md = el('div', 'md fp-md');
        md.append(renderMarkdown(file.text, document, full.mdOptions));
        body.append(md);
      }
      break;
    case 'html':
      if (ctx.showSource) body.append(lineView(file.text, 'html'));
      else {
        const frame = el('iframe', 'fp-html');
        frame.setAttribute('sandbox', 'allow-same-origin');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.title = file.name || 'HTML 预览';
        frame.src = src.raw({ render: 'html' });
        body.append(frame, el('p', 'fp-note fp-html-note', '网页预览不运行脚本，也不加载外部资源；需要交互的页面请下载后用浏览器打开。'));
      }
      break;
    case 'text':
      body.append(lineView(file.text, langOfFile(file.name || file.path)));
      break;
    case 'image': {
      const a = el('a', 'fp-img-link');
      a.href = src.raw();
      a.dataset.view = file.name || '';
      const img = el('img', 'fp-img');
      img.src = src.raw({ t: file.mtime });
      img.alt = file.name || '';
      a.append(img);
      body.append(a);
      break;
    }
    case 'pdf': {
      const box = el('div', 'pdf-view');
      body.append(box);
      let viewer = null;
      let dead = false;
      import('./pdfview.js').then(({ renderPdf }) => {
        if (!dead) viewer = renderPdf(box, src.raw({ t: file.mtime }), { scroller: body, name: file.name });
      }).catch(() => box.replaceChildren(binaryCard(file, full, 'PDF 阅读组件加载失败，可以下载后查看。')));
      return { destroy() { dead = true; viewer?.destroy(); } };
    }
    case 'docx': {
      const doc = el('div', 'doc');
      docBlocks(doc, file.blocks, full);
      if (!file.blocks.length) doc.append(el('p', 'fp-note', '文档是空的。'));
      if (file.truncated) doc.append(el('p', 'fp-note', '文档太长，只显示了前面的部分，完整内容请下载。'));
      body.append(doc);
      break;
    }
    case 'sheet':
      body.append(sheetView(file, full));
      break;
    case 'slides':
      body.append(slidesView(file, full));
      break;
    case 'table': {
      const box = el('div', 'sheet-view');
      if (!file.table.rows.length) box.append(el('p', 'fp-note', '文件是空的。'));
      else box.append(gridTable(file.table, { header: true }));
      if (file.table.truncatedRows) box.append(el('p', 'fp-note', `只显示前 ${file.table.rows.length} 行，完整内容请下载。`));
      body.append(box);
      break;
    }
    case 'video': case 'audio': {
      const media = el(file.kind, `fp-${file.kind}`);
      media.controls = true;
      media.preload = 'metadata';
      media.setAttribute('playsinline', '');
      media.src = src.raw();
      media.addEventListener('error', () => media.replaceWith(binaryCard(file, full, '浏览器无法播放这个格式，可以下载后查看。')), { once: true });
      body.append(media);
      break;
    }
    case 'notebook':
      body.append(notebookView(file.notebook, full));
      break;
    case 'dir':
      body.append(el('p', 'fp-note', '这是一个目录。'));
      break;
    default:
      body.append(binaryCard(file, full));
  }
  if (file.truncated && (file.kind === 'text' || file.kind === 'markdown' || file.kind === 'html')) {
    body.append(el('p', 'fp-note', `文件较大（${fmtSize(file.size)}），只显示前 512 KB，完整内容请下载。`));
  }
  return handle || { destroy() {} };
}

/** Kinds that have a rendered view and a source view. */
export const hasSourceToggle = (file) => file && (file.kind === 'markdown' || file.kind === 'html');
