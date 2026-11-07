// Small Markdown subset for model replies. Parsing produces a plain tree; rendering builds
// DOM nodes with textContent only, so model output can never become live HTML or script.
// Images and links to files are handed to the page (options.image / options.fileLink), which
// decides where they load from; without those hooks they stay text (e.g. on share pages).
// This module is also imported by the server (imageRefs), so it must not touch the DOM at load.

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const TASK = /^\[([ xX])\]\s+/;

const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]);
const isBlockStart = (lines, i) => {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || ITEM.test(l) || isTableStart(lines, i);
};

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const alignOf = (cell) => {
  const c = cell.trim();
  if (c.startsWith(':') && c.endsWith(':')) return 'center';
  if (c.endsWith(':')) return 'right';
  if (c.startsWith(':')) return 'left';
  return null;
};

export function parseBlocks(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1][0].repeat(3);
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      i += 1; // closing fence (absent while a reply is still streaming)
      blocks.push({ type: 'code', lang: fence[2], text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { i += 1; continue; }
    const h = line.match(HEADING);
    if (h) { blocks.push({ type: 'heading', level: h[1].length, text: h[2] }); i += 1; continue; }
    if (HR.test(line)) { blocks.push({ type: 'hr' }); i += 1; continue; }
    if (isTableStart(lines, i)) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map(alignOf);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const block = { type: 'table', header, rows };
      if (align.some(Boolean)) block.align = align;
      blocks.push(block);
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', children: parseBlocks(body.join('\n')) });
      continue;
    }
    const first = line.match(ITEM);
    if (first) {
      const indent = first[1].length;
      const ordered = /\d/.test(first[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(ITEM);
        if (m && m[1].length <= indent + 1) {
          if (/\d/.test(m[2]) !== ordered) break;
          items.push([m[3]]);
          i += 1;
        } else if (lines[i].trim() && (/^\s{2,}/.test(lines[i]) || m)) {
          items[items.length - 1].push(lines[i].replace(/^\s{1,4}/, ''));
          i += 1;
        } else if (!lines[i].trim() && i + 1 < lines.length && (/^\s{2,}\S/.test(lines[i + 1]) || ITEM.test(lines[i + 1]))) {
          const next = lines[i + 1].match(ITEM);
          if (next && next[1].length <= indent + 1 && /\d/.test(next[2]) !== ordered) break;
          i += 1;
        } else {
          break;
        }
      }
      const tasks = [];
      const bodies = items.map((body, n) => {
        const t = !ordered && body[0].match(TASK);
        tasks[n] = t ? t[1] !== ' ' : null;
        if (t) body[0] = body[0].slice(t[0].length);
        return parseBlocks(body.join('\n'));
      });
      const block = { type: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items: bodies };
      if (tasks.some((t) => t !== null)) block.tasks = tasks;
      blocks.push(block);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !isBlockStart(lines, i))) para.push(lines[i++]);
    blocks.push({ type: 'paragraph', text: para.join('\n') });
  }
  return blocks;
}

// Link/image targets: <anything but newline or >>, or a run without spaces that may hold one
// level of balanced parentheses (Wikipedia file names); an optional "title" follows.
const TARGET = String.raw`\s*(<[^>\n]+>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+"([^"\n]*)")?\s*`;
// Images also accept a bare path with spaces, as long as it ends in an image extension.
const IMAGE_TARGET = String.raw`\s*(<[^>\n]+>|(?:[^()\s]|\([^()\s]*\))+|[^()\n<>"]+?\.(?:png|jpe?g|gif|webp|svg|avif|bmp))(?:\s+"([^"\n]*)")?\s*`;
const INLINE = new RegExp([
  String.raw`(\`+)([^\`]|[^\`][\s\S]*?[^\`])\1(?!\`)`, // 1,2 code
  String.raw`!\[([^\]\n]*)\]\(${IMAGE_TARGET}\)`, // 3 alt, 4 src, 5 title
  String.raw`\[((?:[^[\]\n]|\[[^\]\n]*\])+)\]\(${TARGET}\)`, // 6 text, 7 href, 8 title
  String.raw`<(https?:\/\/[^\s<>]+)>`, // 9 autolink
  String.raw`\*\*(?=\S)([\s\S]*?\S)\*\*`, // 10 strong
  String.raw`__(?=\S)([\s\S]*?\S)__(?!\w)`, // 11 strong
  String.raw`~~(?=\S)([\s\S]*?\S)~~`, // 12 strikethrough
  String.raw`(?<![\w*\\])\*(?=[^\s*])([^*\n]*?[^\s*\\])\*(?![\w*])`, // 13 em
  String.raw`(?<![\w\\])_(?=[^\s_])([^_\n]*?[^\s_\\])_(?!\w)`, // 14 em
  String.raw`(<br\s*\/?>)`, // 15 line break written as HTML (common in table cells)
  String.raw`(https?:\/\/[^\s<>"'\`，。；：！？、）】」]+[^\s<>"'\`.,;:!?，。；：！？、）】」])`, // 16 bare URL
].join('|'), 'gi');

export function safeHref(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

const unwrap = (t) => (t && t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t);

/** A link target that names a file on the host rather than a web page. */
export function looksLikeFileRef(href) {
  const h = String(href || '').trim();
  if (!h || h.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(h) && !/^file:\/\//i.test(h)) return false;
  return /^(\/|~\/|\.{1,2}\/|file:\/\/)/i.test(h) || /^[^\s?#]+\.[A-Za-z0-9]{1,8}$/.test(h);
}

export function parseInline(text) {
  const out = [];
  let last = 0;
  const str = String(text);
  for (const m of str.matchAll(INLINE)) {
    if (m.index > last) out.push({ type: 'text', text: str.slice(last, m.index) });
    if (m[1]) out.push({ type: 'code', text: m[2].trim() || m[2] });
    else if (m[4] !== undefined) out.push({ type: 'image', alt: m[3], src: unwrap(m[4]), title: m[5] || '' });
    else if (m[7] !== undefined) {
      const target = unwrap(m[7]);
      const href = safeHref(target);
      if (href) out.push({ type: 'link', href, children: parseInline(m[6]) });
      else if (looksLikeFileRef(target)) out.push({ type: 'filelink', path: target, children: parseInline(m[6]) });
      else out.push({ type: 'text', text: m[0] });
    } else if (m[9]) {
      const href = safeHref(m[9]);
      out.push(href ? { type: 'link', href, children: [{ type: 'text', text: m[9] }] } : { type: 'text', text: m[0] });
    } else if (m[10] || m[11]) out.push({ type: 'strong', children: parseInline(m[10] || m[11]) });
    else if (m[12]) out.push({ type: 'del', children: parseInline(m[12]) });
    else if (m[13] || m[14]) out.push({ type: 'em', children: parseInline(m[13] || m[14]) });
    else if (m[15]) out.push({ type: 'text', text: '\n' });
    else if (m[16]) {
      const href = safeHref(m[16]);
      out.push(href ? { type: 'link', href, children: [{ type: 'text', text: m[16] }] } : { type: 'text', text: m[16] });
    }
    last = m.index + m[0].length;
  }
  if (last < str.length) out.push({ type: 'text', text: str.slice(last) });
  return out;
}

/** Image sources in a reply, in order (code blocks and code spans excluded). */
export function imageRefs(src) {
  const out = [];
  const inline = (text) => {
    for (const tok of parseInline(text)) {
      if (tok.type === 'image') out.push(tok.src);
      else if (tok.children) for (const c of tok.children) if (c.type === 'image') out.push(c.src);
    }
  };
  const walk = (blocks) => {
    for (const b of blocks) {
      if (b.type === 'paragraph' || b.type === 'heading') inline(b.text);
      else if (b.type === 'quote') walk(b.children);
      else if (b.type === 'list') b.items.forEach(walk);
      else if (b.type === 'table') [b.header, ...b.rows].forEach((row) => row.forEach(inline));
    }
  };
  walk(parseBlocks(src));
  return [...new Set(out)];
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const plainText = (toks) => toks.map((t) => (t.children ? plainText(t.children) : t.text ?? t.alt ?? '')).join('');

function renderTokens(doc, parent, toks, opts) {
  for (const tok of toks) {
    if (tok.type === 'text') {
      tok.text.split('\n').forEach((piece, idx) => {
        if (idx) parent.append(doc.createElement('br'));
        if (piece) parent.append(doc.createTextNode(piece));
      });
    } else if (tok.type === 'code') {
      parent.append(el(doc, 'code', '', tok.text));
    } else if (tok.type === 'strong' || tok.type === 'em' || tok.type === 'del') {
      const node = el(doc, tok.type);
      renderTokens(doc, node, tok.children, opts);
      parent.append(node);
    } else if (tok.type === 'link') {
      const a = el(doc, 'a');
      renderTokens(doc, a, tok.children.filter((c) => c.type !== 'link'), opts);
      a.href = tok.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      parent.append(a);
    } else if (tok.type === 'filelink') {
      const node = opts.fileLink ? opts.fileLink(tok.path, plainText(tok.children)) : null;
      if (node) parent.append(node);
      else renderTokens(doc, parent, tok.children, opts);
    } else if (tok.type === 'image') {
      const node = opts.image ? opts.image(tok, false) : null;
      parent.append(node || el(doc, 'span', 'md-img-alt', `[图片${tok.alt ? `：${tok.alt}` : ''}]`));
    }
  }
}

const renderInline = (doc, parent, text, opts) => renderTokens(doc, parent, parseInline(text), opts);

/** A paragraph that holds only images (and spaces/line breaks) becomes a figure group. */
function figureGroup(doc, text, opts) {
  const toks = parseInline(text);
  const images = toks.filter((t) => t.type === 'image');
  if (!images.length || !opts.image || toks.some((t) => t.type !== 'image' && !(t.type === 'text' && !t.text.trim()))) return null;
  const wrap = el(doc, 'div', `md-figures${images.length > 1 ? ' multi' : ''}`);
  for (const tok of images) {
    const fig = el(doc, 'figure', 'md-figure');
    fig.append(opts.image(tok, true));
    const caption = tok.title || tok.alt;
    if (caption && !/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(caption)) fig.append(el(doc, 'figcaption', '', caption));
    wrap.append(fig);
  }
  return wrap;
}

function renderBlocks(doc, parent, blocks, opts, tight = false) {
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph': {
        const figs = figureGroup(doc, b.text, opts);
        if (figs) parent.append(figs);
        else if (tight && blocks.length === 1) renderInline(doc, parent, b.text, opts);
        else { const p = el(doc, 'p'); renderInline(doc, p, b.text, opts); parent.append(p); }
        break;
      }
      case 'heading': {
        const h = el(doc, `h${Math.min(b.level + 2, 6)}`);
        renderInline(doc, h, b.text, opts);
        parent.append(h);
        break;
      }
      case 'code': {
        const wrap = el(doc, 'div', 'code-block');
        const bar = el(doc, 'div', 'code-bar');
        bar.append(el(doc, 'span', 'code-lang', b.lang || '代码'));
        const copy = el(doc, 'button', 'code-copy', '复制');
        copy.type = 'button';
        copy.dataset.action = 'copy-code';
        bar.append(copy);
        const pre = el(doc, 'pre');
        const code = el(doc, 'code');
        code.append(opts.highlight?.(b.text, b.lang) || doc.createTextNode(b.text));
        pre.append(code);
        wrap.append(bar, pre);
        parent.append(wrap);
        break;
      }
      case 'hr': parent.append(el(doc, 'hr')); break;
      case 'quote': {
        const q = el(doc, 'blockquote');
        renderBlocks(doc, q, b.children, opts);
        parent.append(q);
        break;
      }
      case 'list': {
        const list = el(doc, b.ordered ? 'ol' : 'ul');
        if (b.ordered && b.start !== 1) list.start = b.start;
        b.items.forEach((item, n) => {
          const li = el(doc, 'li');
          const task = b.tasks?.[n];
          if (task !== undefined && task !== null) {
            li.className = 'task';
            const box = el(doc, 'input');
            box.type = 'checkbox';
            box.checked = task;
            box.disabled = true;
            box.setAttribute('aria-label', task ? '已完成' : '未完成');
            li.append(box);
          }
          renderBlocks(doc, li, item, opts, true);
          list.append(li);
        });
        if (b.tasks) list.classList.add('task-list');
        parent.append(list);
        break;
      }
      case 'table': {
        const wrap = el(doc, 'div', 'table-wrap');
        const table = el(doc, 'table');
        const thead = el(doc, 'thead');
        const hr = el(doc, 'tr');
        const align = (cell, c) => { if (b.align?.[c]) cell.style.textAlign = b.align[c]; };
        b.header.forEach((cell, c) => { const th = el(doc, 'th'); align(th, c); renderInline(doc, th, cell, opts); hr.append(th); });
        thead.append(hr);
        const tbody = el(doc, 'tbody');
        for (const row of b.rows) {
          const tr = el(doc, 'tr');
          for (let c = 0; c < b.header.length; c += 1) { const td = el(doc, 'td'); align(td, c); renderInline(doc, td, row[c] ?? '', opts); tr.append(td); }
          tbody.append(tr);
        }
        table.append(thead, tbody);
        wrap.append(table);
        parent.append(wrap);
        break;
      }
      default: break;
    }
  }
}

/**
 * @param opts.image (token {alt, src, title}, block: boolean) => Node   where an image loads from
 * @param opts.fileLink (path, label) => Node|null   a link to a file on the host
 * @param opts.highlight (code, lang) => Node|null   syntax-highlighted code
 */
export function renderMarkdown(src, doc = globalThis.document, opts = {}) {
  const frag = doc.createDocumentFragment();
  renderBlocks(doc, frag, parseBlocks(src), opts);
  return frag;
}
