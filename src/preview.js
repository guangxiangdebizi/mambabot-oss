import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { OFFICE_KINDS, OfficeError, officePart, officePreview } from './office.js';

// What the in-page reader needs for one file on this host: its kind and, for text, tables
// and Office documents, the content as plain data. Shared by project files, any host path a
// reply mentions, and attachments. Also serves the bytes themselves (with Range, for media).

const MAX_TEXT = 512 * 1024;
const SNIFF = 8192;
export const MAX_OFFICE = 30 * 1024 * 1024;
const TABLE_ROWS = 1000;
const TABLE_COLS = 60;

export const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ogv': 'video/ogg' };
const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.flac': 'audio/flac', '.weba': 'audio/webm',
};
const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
const HTML = new Set(['.html', '.htm', '.xhtml']);
const LEGACY_OFFICE = new Set(['.doc', '.xls', '.ppt', '.wps', '.et', '.dps', '.rtf', '.odt', '.ods', '.odp', '.pages', '.numbers', '.key']);

/** Content types that may be shown inline from this origin (they cannot run script). */
export const INLINE_TYPES = new Set([
  ...Object.values(IMAGE_TYPES).filter((t) => t !== 'image/svg+xml'), ...Object.values(VIDEO_TYPES), ...Object.values(AUDIO_TYPES),
]);

export class PreviewError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Reader kind from the file name alone (text vs binary is sniffed later). */
export function kindOf(name) {
  const ext = extname(String(name)).toLowerCase();
  if (IMAGE_TYPES[ext]) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (OFFICE_KINDS[ext]) return OFFICE_KINDS[ext];
  if (ext === '.csv' || ext === '.tsv') return 'table';
  if (VIDEO_TYPES[ext]) return 'video';
  if (AUDIO_TYPES[ext]) return 'audio';
  if (MARKDOWN.has(ext)) return 'markdown';
  if (HTML.has(ext)) return 'html';
  if (ext === '.ipynb') return 'notebook';
  if (LEGACY_OFFICE.has(ext)) return 'legacy';
  return 'text';
}

/** Content type for serving a file by name (null: unknown, sent as a download). */
export function typeOf(name) {
  const ext = extname(String(name)).toLowerCase();
  return IMAGE_TYPES[ext] || VIDEO_TYPES[ext] || AUDIO_TYPES[ext] || (ext === '.pdf' ? 'application/pdf' : null);
}

/**
 * UTF-8 (BOM or not), UTF-16 with a BOM, else GB18030: Windows tools in China still write
 * GBK text and CSV by default. A multibyte character cut by the size limit is dropped.
 */
export function decodeText(buf, truncated = false) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const body = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  for (let cut = 0; cut <= (truncated ? 3 : 0); cut += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, body.length - cut));
    } catch { /* try a shorter tail, then GB18030 */ }
  }
  try {
    return new TextDecoder('gb18030').decode(body).replace(/�+$/, '');
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

const isUtf16 = (buf) => (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);

/** RFC 4180-ish CSV/TSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseDelimited(text, sep) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let truncated = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      rows.push(row); row = [];
      if (rows.length >= TABLE_ROWS) { truncated = i + 1 < text.length; break; }
    } else field += ch;
  }
  if (!truncated && (field !== '' || row.length)) { row.push(field); rows.push(row); }
  let cols = 0;
  let truncatedCols = false;
  for (let r = 0; r < rows.length; r += 1) {
    if (rows[r].length > TABLE_COLS) { rows[r] = rows[r].slice(0, TABLE_COLS); truncatedCols = true; }
    cols = Math.max(cols, rows[r].length);
  }
  return { rows, cols, truncatedRows: truncated, truncatedCols };
}

function guessSeparator(text, ext) {
  if (ext === '.tsv') return '\t';
  const head = text.slice(0, 4096).split('\n').slice(0, 5).join('\n');
  const count = (c) => head.split(c).length - 1;
  return [',', '\t', ';', '|'].sort((a, b) => count(b) - count(a))[0];
}

// Converting an Office file is the only expensive step: remember the last few results.
const cache = new Map();
const CACHE_MAX = 16;
function cacheGet(key) {
  if (!cache.has(key)) return null;
  const v = cache.get(key);
  cache.delete(key);
  cache.set(key, v);
  return v;
}
function cacheSet(key, v) {
  cache.set(key, v);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/** Converts OfficeError and friends into PreviewError. */
function friendly(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof OfficeError) throw new PreviewError(422, err.message);
    throw err;
  }
}

/**
 * Reader data for the regular file at `path`. `info` gives the display path/name and the
 * options: `sheet` (workbook sheet index).
 */
export async function buildPreview(path, { display = basename(path), name = basename(path), sheet = 0 } = {}) {
  const st = await stat(path);
  if (st.isDirectory()) return { path: display, kind: 'dir' };
  if (!st.isFile()) throw new PreviewError(400, '这不是普通文件');
  const ext = extname(name).toLowerCase();
  const base = { path: display, name, size: st.size, mtime: st.mtime.toISOString(), type: typeOf(name) };
  let kind = kindOf(name);
  if (['image', 'pdf', 'video', 'audio'].includes(kind)) return { ...base, kind };
  if (kind === 'legacy') {
    return { ...base, kind: 'binary', note: '旧版或非 OOXML 格式（.doc/.xls/.ppt/WPS/OpenDocument 等）暂不能在网页里预览。可以下载查看，或让 Claude 转换成 PDF 或 docx/xlsx/pptx。' };
  }
  if (kind === 'docx' || kind === 'sheet' || kind === 'slides') {
    if (st.size > MAX_OFFICE) return { ...base, kind: 'binary', note: `文件超过 ${MAX_OFFICE / 1024 / 1024} MB，无法在网页里预览，请下载查看。` };
    const key = `${path}|${st.size}|${st.mtimeMs}|${kind}|${sheet}`;
    let data = cacheGet(key);
    if (!data) {
      const buf = await readFile(path);
      data = friendly(() => officePreview(buf, kind, { sheet }));
      cacheSet(key, data);
    }
    return { ...base, ...data };
  }
  // Everything else is text unless it looks binary.
  const fh = await open(path, 'r');
  let buf;
  try {
    buf = Buffer.alloc(Math.min(st.size, MAX_TEXT));
    await fh.read(buf, 0, buf.length, 0);
  } finally {
    await fh.close();
  }
  const truncated = st.size > MAX_TEXT;
  if (!isUtf16(buf) && buf.subarray(0, SNIFF).includes(0)) return { ...base, kind: 'binary' };
  const text = decodeText(buf, truncated);
  if (kind === 'table') {
    const table = parseDelimited(text, guessSeparator(text, ext));
    return { ...base, kind: 'table', table: { ...table, truncatedRows: table.truncatedRows || truncated } };
  }
  if (kind === 'notebook') {
    if (truncated) kind = 'text';
    else {
      try {
        return { ...base, kind: 'notebook', notebook: notebookView(JSON.parse(text)) };
      } catch {
        kind = 'text';
      }
    }
  }
  return { ...base, kind, text, truncated };
}

/** Jupyter notebook: Markdown and code cells, text outputs and PNG/JPEG outputs (as data: URLs). */
function notebookView(nb) {
  const join = (v) => (Array.isArray(v) ? v.join('') : String(v ?? ''));
  const lang = nb?.metadata?.language_info?.name || nb?.metadata?.kernelspec?.language || '';
  const cells = [];
  let images = 0;
  for (const c of (Array.isArray(nb?.cells) ? nb.cells : []).slice(0, 500)) {
    const cell = { type: c.cell_type === 'markdown' ? 'markdown' : c.cell_type === 'code' ? 'code' : 'raw', source: join(c.source).slice(0, 100000) };
    if (c.cell_type === 'code') {
      if (c.execution_count) cell.count = c.execution_count;
      cell.outputs = [];
      for (const o of (Array.isArray(c.outputs) ? c.outputs : []).slice(0, 50)) {
        const data = o.data || {};
        if (o.output_type === 'stream') cell.outputs.push({ text: join(o.text).slice(-20000) });
        else if (o.output_type === 'error') cell.outputs.push({ text: `${o.ename}: ${o.evalue}`, error: true });
        else if ((data['image/png'] || data['image/jpeg']) && images < 60) {
          const type = data['image/png'] ? 'image/png' : 'image/jpeg';
          const b64 = join(data[type]).replace(/\s+/g, '');
          if (b64.length < 4 * 1024 * 1024 && /^[A-Za-z0-9+/=]+$/.test(b64)) {
            cell.outputs.push({ image: `data:${type};base64,${b64}` });
            images += 1;
          }
        } else if (data['text/markdown']) cell.outputs.push({ markdown: join(data['text/markdown']).slice(0, 50000) });
        else if (data['text/plain']) cell.outputs.push({ text: join(data['text/plain']).slice(-20000) });
      }
    }
    cells.push(cell);
  }
  return { lang, cells };
}

/** One embedded image of an Office file. */
export async function previewPart(path, entry) {
  const st = await stat(path);
  if (!st.isFile() || st.size > MAX_OFFICE) throw new PreviewError(400, '无法读取这个文件');
  const buf = await readFile(path);
  return friendly(() => officePart(buf, entry));
}

/** Parses a single "bytes=a-b" range against `size`; null for none/unsupported, false if unsatisfiable. */
export function parseRange(header, size) {
  const m = String(header || '').match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return false;
  return { start, end };
}

/**
 * Streams a file: inline for types that cannot script (images, audio, video; SVG under a
 * sandbox CSP), as an attachment otherwise; honours a single byte range.
 */
export function sendFile(req, res, { path, name, size, type, download = false, cache = 'no-cache', html = false }) {
  const svg = type === 'image/svg+xml';
  // An HTML file rendered in the reader's iframe: no script, no network, framed only by this app.
  const asHtml = html && !download && kindOf(name) === 'html';
  const inline = asHtml || (!download && type && (INLINE_TYPES.has(type) || svg));
  const headers = {
    'Content-Type': asHtml ? 'text/html; charset=utf-8' : (inline ? type : 'application/octet-stream'),
    'Cache-Control': cache,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
  };
  // An SVG opened on its own must not run scripts in this origin.
  if (svg) headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  if (asHtml) {
    headers['Content-Security-Policy'] = "sandbox allow-same-origin; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self'; frame-ancestors 'self'";
    headers['X-Frame-Options'] = 'SAMEORIGIN';
  }
  const range = parseRange(req.headers.range, size);
  if (range === false) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  const { start, end } = range || { start: 0, end: size - 1 };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  headers['Content-Length'] = size ? end - start + 1 : 0;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || !size) return res.end();
  createReadStream(path, { start, end }).on('error', () => res.destroy()).pipe(res);
  return undefined;
}
