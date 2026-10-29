// Small Markdown subset for model replies. Parsing produces a plain tree; rendering builds
// DOM nodes with textContent only, so model output can never become live HTML or script.

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

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
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      blocks.push({ type: 'table', header, rows });
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
      blocks.push({
        type: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1,
        items: items.map((body) => parseBlocks(body.join('\n'))),
      });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !isBlockStart(lines, i))) para.push(lines[i++]);
    blocks.push({ type: 'paragraph', text: para.join('\n') });
  }
  return blocks;
}

const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|\[([^\]\n]+)\]\(([^()\s]+)\)|(https?:\/\/[^\s<>"'`，。；：！？、）】」]+[^\s<>"'`.,;:!?，。；：！？、）】」])/g;

export function safeHref(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

export function parseInline(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(INLINE)) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[1]) out.push({ type: 'code', text: m[2].trim() || m[2] });
    else if (m[3]) out.push({ type: 'strong', children: parseInline(m[3]) });
    else if (m[4]) {
      const href = safeHref(m[5]);
      out.push(href ? { type: 'link', href, children: parseInline(m[4]) } : { type: 'text', text: m[0] });
    } else if (m[6]) {
      const href = safeHref(m[6]);
      out.push(href ? { type: 'link', href, children: [{ type: 'text', text: m[6] }] } : { type: 'text', text: m[6] });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderInline(doc, parent, text) {
  for (const tok of parseInline(text)) {
    if (tok.type === 'text') {
      tok.text.split('\n').forEach((piece, idx) => {
        if (idx) parent.append(doc.createElement('br'));
        if (piece) parent.append(doc.createTextNode(piece));
      });
    } else if (tok.type === 'code') {
      parent.append(el(doc, 'code', '', tok.text));
    } else if (tok.type === 'strong') {
      const strong = el(doc, 'strong');
      for (const child of tok.children) renderInline(doc, strong, child.text ?? '');
      parent.append(strong);
    } else if (tok.type === 'link') {
      const a = el(doc, 'a', '', tok.children.map((c) => c.text ?? '').join(''));
      a.href = tok.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      parent.append(a);
    }
  }
}

function renderBlocks(doc, parent, blocks, tight = false) {
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph': {
        if (tight && blocks.length === 1) renderInline(doc, parent, b.text);
        else { const p = el(doc, 'p'); renderInline(doc, p, b.text); parent.append(p); }
        break;
      }
      case 'heading': {
        const h = el(doc, `h${Math.min(b.level + 2, 6)}`);
        renderInline(doc, h, b.text);
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
        pre.append(el(doc, 'code', '', b.text));
        wrap.append(bar, pre);
        parent.append(wrap);
        break;
      }
      case 'hr': parent.append(el(doc, 'hr')); break;
      case 'quote': {
        const q = el(doc, 'blockquote');
        renderBlocks(doc, q, b.children);
        parent.append(q);
        break;
      }
      case 'list': {
        const list = el(doc, b.ordered ? 'ol' : 'ul');
        if (b.ordered && b.start !== 1) list.start = b.start;
        for (const item of b.items) {
          const li = el(doc, 'li');
          renderBlocks(doc, li, item, true);
          list.append(li);
        }
        parent.append(list);
        break;
      }
      case 'table': {
        const wrap = el(doc, 'div', 'table-wrap');
        const table = el(doc, 'table');
        const thead = el(doc, 'thead');
        const hr = el(doc, 'tr');
        for (const cell of b.header) { const th = el(doc, 'th'); renderInline(doc, th, cell); hr.append(th); }
        thead.append(hr);
        const tbody = el(doc, 'tbody');
        for (const row of b.rows) {
          const tr = el(doc, 'tr');
          for (let c = 0; c < b.header.length; c += 1) { const td = el(doc, 'td'); renderInline(doc, td, row[c] ?? ''); tr.append(td); }
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

export function renderMarkdown(src, doc = globalThis.document) {
  const frag = doc.createDocumentFragment();
  renderBlocks(doc, frag, parseBlocks(src));
  return frag;
}
