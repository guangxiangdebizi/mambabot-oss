// A small, non-validating XML reader for Office documents. No DTDs and no custom entities
// (so no entity expansion attacks); names keep their namespace prefix ("w:p", "a:t").

export class XmlError extends Error {}
export const STOP = Symbol('stop');

const ENTITY = /&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi;
const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(ENTITY, (m, e) => {
    if (e[0] !== '#') return NAMED[e.toLowerCase()];
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(code); } catch { return ''; }
  });
}

const isNameChar = (c) => c > 32 && c !== 47 && c !== 62 && c !== 61; // not space / > =

/**
 * Streams `xml` to handlers: open(name, attrs, selfClosing), close(name), text(string).
 * A handler returning STOP ends the scan early.
 */
export function sax(xml, { open = () => {}, close = () => {}, text = () => {} } = {}) {
  const len = xml.length;
  let i = 0;
  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      if (text(decodeEntities(xml.slice(i))) === STOP) return;
      break;
    }
    if (lt > i && text(decodeEntities(xml.slice(i, lt))) === STOP) return;
    const c = xml[lt + 1];
    if (c === '!') {
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt + 4);
        i = end < 0 ? len : end + 3;
      } else if (xml.startsWith('<![CDATA[', lt)) {
        const end = xml.indexOf(']]>', lt + 9);
        if (text(xml.slice(lt + 9, end < 0 ? len : end)) === STOP) return;
        i = end < 0 ? len : end + 3;
      } else {
        // DOCTYPE and the like: skipped, internal subsets included.
        let depth = 0;
        let j = lt + 2;
        for (; j < len; j += 1) {
          if (xml[j] === '[') depth += 1;
          else if (xml[j] === ']') depth -= 1;
          else if (xml[j] === '>' && depth <= 0) break;
        }
        i = j + 1;
      }
      continue;
    }
    if (c === '?') {
      const end = xml.indexOf('?>', lt + 2);
      i = end < 0 ? len : end + 2;
      continue;
    }
    if (c === '/') {
      const end = xml.indexOf('>', lt + 2);
      if (end < 0) throw new XmlError('XML 不完整');
      if (close(xml.slice(lt + 2, end).trim()) === STOP) return;
      i = end + 1;
      continue;
    }
    // Start tag: name, then attributes (quote-aware), then > or />.
    let j = lt + 1;
    while (j < len && isNameChar(xml.charCodeAt(j))) j += 1;
    const name = xml.slice(lt + 1, j);
    const attrs = {};
    let selfClosing = false;
    for (;;) {
      while (j < len && xml.charCodeAt(j) <= 32) j += 1;
      if (j >= len) throw new XmlError('XML 不完整');
      const ch = xml[j];
      if (ch === '>') { j += 1; break; }
      if (ch === '/' && xml[j + 1] === '>') { selfClosing = true; j += 2; break; }
      const k0 = j;
      while (j < len && isNameChar(xml.charCodeAt(j))) j += 1;
      const key = xml.slice(k0, j);
      while (j < len && xml.charCodeAt(j) <= 32) j += 1;
      if (xml[j] !== '=') { if (!key) j += 1; continue; }
      j += 1;
      while (j < len && xml.charCodeAt(j) <= 32) j += 1;
      const q = xml[j];
      if (q !== '"' && q !== "'") throw new XmlError('XML 属性格式错误');
      const vEnd = xml.indexOf(q, j + 1);
      if (vEnd < 0) throw new XmlError('XML 不完整');
      attrs[key] = decodeEntities(xml.slice(j + 1, vEnd));
      j = vEnd + 1;
    }
    i = j;
    if (open(name, attrs, selfClosing) === STOP) return;
    if (selfClosing && close(name) === STOP) return;
  }
}

/** Element tree: { n: name, a: attrs, c: [child elements and text strings] }. */
export function parseXml(xml, { maxNodes = 1_000_000 } = {}) {
  const root = { n: '#root', a: {}, c: [] };
  const stack = [root];
  let nodes = 0;
  sax(xml, {
    open(name, a) {
      nodes += 1;
      if (nodes > maxNodes) throw new XmlError('文档过于复杂，无法预览');
      const node = { n: name, a, c: [] };
      stack[stack.length - 1].c.push(node);
      stack.push(node);
    },
    close() {
      if (stack.length > 1) stack.pop();
    },
    text(t) {
      if (t) stack[stack.length - 1].c.push(t);
    },
  });
  return root;
}

export const kids = (node, name) => (node?.c || []).filter((k) => typeof k !== 'string' && (!name || k.n === name));
export const child = (node, name) => (node?.c || []).find((k) => typeof k !== 'string' && k.n === name) || null;

/** First descendant (depth-first) with this name. */
export function find(node, name) {
  for (const k of node?.c || []) {
    if (typeof k === 'string') continue;
    if (k.n === name) return k;
    const hit = find(k, name);
    if (hit) return hit;
  }
  return null;
}

/** Every descendant with this name, in document order (not descending into matches). */
export function findAll(node, name, out = []) {
  for (const k of node?.c || []) {
    if (typeof k === 'string') continue;
    if (k.n === name) out.push(k);
    else findAll(k, name, out);
  }
  return out;
}

/** All text under a node. */
export function textOf(node) {
  if (typeof node === 'string') return node;
  return (node?.c || []).map(textOf).join('');
}

/** Local name without the namespace prefix. */
export const local = (name) => name.slice(name.indexOf(':') + 1);
