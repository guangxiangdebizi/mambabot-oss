import { ZipError, entryData, entryText, readZip } from './zip.js';
import { STOP, child, find, findAll, kids, local, parseXml, sax, textOf } from './xml.js';

// Office Open XML (docx / xlsx / pptx) to plain data for the in-page reader. The output is a
// tree of text runs, tables and image references; the page builds DOM nodes from it with
// textContent only, so nothing in a document can become live HTML. Images stay inside the
// archive and are fetched one by one (officePart) when the reader shows them.

const MAX_XML = 24 * 1024 * 1024;
const MAX_BLOCKS = 6000;
const MAX_TABLE_ROWS = 2000;
export const SHEET_MAX_ROWS = 1000;
export const SHEET_MAX_COLS = 60;
const MAX_SLIDES = 300;
const EMU_PER_PX = 9525;

// Formats a browser can draw; EMF/WMF/TIFF are left out (shown as a placeholder instead).
export const MEDIA_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
};
const mediaType = (name) => MEDIA_TYPES[String(name).split('.').pop().toLowerCase()] || null;

export class OfficeError extends Error {}

/* ---------------- package helpers ---------------- */

function normalizePart(path) {
  const out = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** Relationships of one part: id -> { type, external, target, path }. */
function relsOf(buf, entries, partPath) {
  const slash = partPath.lastIndexOf('/');
  const dir = slash >= 0 ? partPath.slice(0, slash + 1) : '';
  const xml = entryText(buf, entries, `${dir}_rels/${partPath.slice(slash + 1)}.rels`, 8 * 1024 * 1024);
  const map = new Map();
  if (!xml) return map;
  sax(xml, {
    open(name, a) {
      if (local(name) !== 'Relationship' || !a.Id) return;
      const external = a.TargetMode === 'External';
      const target = a.Target || '';
      map.set(a.Id, {
        type: (a.Type || '').split('/').pop(), external, target,
        path: external ? null : normalizePart(target.startsWith('/') ? target : dir + target),
      });
    },
  });
  return map;
}

/** The package's main part (word/document.xml, xl/workbook.xml, ppt/presentation.xml). */
function mainPart(buf, entries, fallback) {
  const rels = relsOf(buf, entries, '');
  for (const r of rels.values()) if (r.type === 'officeDocument' && r.path && entries.has(r.path)) return r.path;
  return fallback;
}

const safeLink = (href) => (/^(https?:|mailto:)/i.test(href || '') ? href : null);
const onOff = (node) => Boolean(node) && !/^(0|false|off|none)$/i.test(node.a['w:val'] ?? node.a.val ?? '1');

function mergeRuns(runs) {
  const out = [];
  const key = (r) => `${r.b ? 1 : 0}${r.i ? 1 : 0}${r.u ? 1 : 0}${r.s ? 1 : 0}${r.sup ? 1 : 0}${r.sub ? 1 : 0}${r.href || ''}`;
  for (const r of runs) {
    const last = out[out.length - 1];
    if (r.text !== undefined && last && last.text !== undefined && key(last) === key(r)) last.text += r.text;
    else out.push(r);
  }
  return out;
}

const clean = (o) => {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === false || o[k] === null) delete o[k];
  return o;
};

/* ---------------- numbering (docx lists) ---------------- */

const CN_DIGITS = '零一二三四五六七八九';
function chineseCount(n) {
  if (n <= 0 || n > 9999) return String(n);
  const units = ['', '十', '百', '千'];
  const ds = String(n).split('').map(Number);
  let out = '';
  let zero = false;
  ds.forEach((d, i) => {
    const u = units[ds.length - 1 - i];
    if (d === 0) { zero = out.length > 0; return; }
    if (zero) { out += '零'; zero = false; }
    out += (d === 1 && u === '十' && i === 0 ? '' : CN_DIGITS[d]) + u;
  });
  return out;
}
function roman(n) {
  if (n <= 0 || n >= 4000) return String(n);
  const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}
function letters(n) {
  let s = '';
  while (n > 0) { n -= 1; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
function formatNumber(n, fmt) {
  switch (fmt) {
    case 'decimalZero': return n < 10 ? `0${n}` : String(n);
    case 'lowerLetter': return letters(n);
    case 'upperLetter': return letters(n).toUpperCase();
    case 'lowerRoman': return roman(n);
    case 'upperRoman': return roman(n).toUpperCase();
    case 'chineseCounting': case 'chineseCountingThousand': case 'ideographTraditional': case 'japaneseCounting':
    case 'taiwaneseCounting': case 'taiwaneseCountingThousand': case 'ideographZodiac':
      return chineseCount(n);
    case 'chineseLegalSimplified': return chineseCount(n).replace(/[一二三四五六七八九十百千]/g, (c) => '壹贰叁肆伍陆柒捌玖拾佰仟'['一二三四五六七八九十百千'.indexOf(c)]);
    case 'decimalEnclosedCircle': case 'decimalEnclosedCircleChinese': return CIRCLED[n - 1] || String(n);
    case 'none': return '';
    default: return String(n);
  }
}

function readNumbering(buf, entries, path) {
  const xml = path && entryText(buf, entries, path, MAX_XML);
  const abstract = new Map();
  const nums = new Map();
  if (!xml) return { abstract, nums };
  const tree = parseXml(xml);
  const levelsOf = (node) => {
    const levels = [];
    for (const lvl of kids(node, 'w:lvl')) {
      levels[Number(lvl.a['w:ilvl']) || 0] = {
        start: Number(child(lvl, 'w:start')?.a['w:val'] ?? 1),
        fmt: child(lvl, 'w:numFmt')?.a['w:val'] || 'decimal',
        text: child(lvl, 'w:lvlText')?.a['w:val'] ?? '',
      };
    }
    return levels;
  };
  for (const an of findAll(tree, 'w:abstractNum')) abstract.set(an.a['w:abstractNumId'], levelsOf(an));
  for (const num of findAll(tree, 'w:num')) {
    const levels = (abstract.get(child(num, 'w:abstractNumId')?.a['w:val']) || []).map((l) => l && { ...l });
    for (const ov of kids(num, 'w:lvlOverride')) {
      const i = Number(ov.a['w:ilvl']) || 0;
      const start = child(ov, 'w:startOverride')?.a['w:val'];
      const lvl = child(ov, 'w:lvl');
      if (lvl) levels[i] = levelsOf({ c: [{ ...lvl, a: { ...lvl.a, 'w:ilvl': '0' } }] })[0];
      if (start !== undefined && levels[i]) levels[i].start = Number(start);
    }
    nums.set(num.a['w:numId'], levels);
  }
  return { abstract, nums };
}

function listLabel(ctx, numId, ilvl) {
  const levels = ctx.numbering.nums.get(numId);
  if (!levels) return { label: '•', ordered: false };
  const lvl = levels[ilvl] || { fmt: 'bullet', text: '•', start: 1 };
  let counters = ctx.counters.get(numId);
  if (!counters) { counters = []; ctx.counters.set(numId, counters); }
  counters[ilvl] = counters[ilvl] === undefined ? lvl.start : counters[ilvl] + 1;
  for (let i = ilvl + 1; i < counters.length; i += 1) counters[i] = undefined;
  if (lvl.fmt === 'bullet') {
    const ch = lvl.text || '•';
    // Symbol/Wingdings bullets live in the private use area and would show as boxes.
    const label = /[-]/.test(ch) || !ch.trim() ? ['•', '◦', '▪'][ilvl % 3] : ch;
    return { label, ordered: false };
  }
  const label = lvl.text.replace(/%(\d)/g, (m, d) => {
    const i = Number(d) - 1;
    const l = levels[i] || lvl;
    const n = counters[i] ?? l.start ?? 1;
    return formatNumber(n, i === ilvl ? lvl.fmt : (l.fmt === 'bullet' ? 'decimal' : l.fmt));
  });
  return { label, ordered: true };
}

/* ---------------- docx ---------------- */

function readStyles(buf, entries, path) {
  const styles = new Map();
  const xml = path && entryText(buf, entries, path, MAX_XML);
  if (!xml) return styles;
  const tree = parseXml(xml);
  for (const s of findAll(tree, 'w:style')) {
    const pPr = child(s, 'w:pPr');
    const numPr = child(pPr, 'w:numPr');
    const outline = child(pPr, 'w:outlineLvl')?.a['w:val'];
    styles.set(s.a['w:styleId'], {
      name: child(s, 'w:name')?.a['w:val'] || '',
      basedOn: child(s, 'w:basedOn')?.a['w:val'] || null,
      outline: outline === undefined ? null : Number(outline),
      numId: child(numPr, 'w:numId')?.a['w:val'] ?? null,
      ilvl: child(numPr, 'w:ilvl')?.a['w:val'] ?? null,
    });
  }
  return styles;
}

function styleChain(ctx, id) {
  const out = [];
  for (let s = ctx.styles.get(id), n = 0; s && n < 12; s = ctx.styles.get(s.basedOn), n += 1) out.push(s);
  return out;
}

function headingLevel(ctx, styleId, pPr) {
  const own = child(pPr, 'w:outlineLvl')?.a['w:val'];
  if (own !== undefined && Number(own) < 9) return Math.min(6, Number(own) + 1);
  for (const s of styleChain(ctx, styleId)) {
    const m = s.name.match(/^heading\s*(\d)$/i);
    if (m) return Math.min(6, Number(m[1]));
    if (/^title$/i.test(s.name)) return 1;
    if (/^subtitle$/i.test(s.name)) return 2;
    if (s.outline !== null && s.outline < 9) return Math.min(6, s.outline + 1);
  }
  return 0;
}

function imageRun(ctx, blipId, extent, alt) {
  const rel = ctx.rels.get(blipId);
  if (!rel || rel.external || !rel.path) return null;
  ctx.images += 1;
  const run = { img: rel.path, alt: alt || '' };
  if (!mediaType(rel.path)) run.unsupported = rel.path.split('.').pop().toUpperCase();
  if (extent) {
    const w = Math.round(Number(extent.a.cx) / EMU_PER_PX);
    const h = Math.round(Number(extent.a.cy) / EMU_PER_PX);
    if (w > 0 && h > 0) Object.assign(run, { w, h });
  }
  return run;
}

/** Runs of a paragraph (text with formatting, line breaks, inline images). */
function paragraphRuns(node, ctx, out, link = null, extra = []) {
  for (const k of node.c) {
    if (typeof k === 'string') continue;
    switch (k.n) {
      case 'w:r': {
        const rPr = child(k, 'w:rPr');
        const va = child(rPr, 'w:vertAlign')?.a['w:val'];
        const fmt = clean({
          b: onOff(child(rPr, 'w:b')), i: onOff(child(rPr, 'w:i')),
          u: Boolean(child(rPr, 'w:u')) && child(rPr, 'w:u').a['w:val'] !== 'none',
          s: onOff(child(rPr, 'w:strike')) || onOff(child(rPr, 'w:dstrike')),
          sup: va === 'superscript', sub: va === 'subscript', href: link || undefined,
        });
        for (const r of k.c) {
          if (typeof r === 'string') continue;
          if (r.n === 'w:t') out.push({ ...fmt, text: textOf(r) });
          else if (r.n === 'w:tab') out.push({ ...fmt, text: '\t' });
          else if (r.n === 'w:br' || r.n === 'w:cr') out.push({ ...fmt, text: '\n' });
          else if (r.n === 'w:noBreakHyphen') out.push({ ...fmt, text: '‑' });
          else if (r.n === 'w:drawing' || r.n === 'w:pict' || r.n === 'w:object' || r.n === 'mc:AlternateContent') {
            const choice = r.n === 'mc:AlternateContent' ? (child(r, 'mc:Choice') || child(r, 'mc:Fallback')) : r;
            for (const blip of findAll(choice, 'a:blip')) {
              const img = imageRun(ctx, blip.a['r:embed'], find(choice, 'wp:extent'), find(choice, 'wp:docPr')?.a.descr);
              if (img) out.push(img);
            }
            for (const im of findAll(choice, 'v:imagedata')) {
              const img = imageRun(ctx, im.a['r:id'], null, im.a['o:title']);
              if (img) out.push(img);
            }
            // Text boxes become their own paragraphs after this one.
            for (const box of findAll(choice, 'w:txbxContent')) extra.push(...bodyBlocks(box, ctx, 1));
          }
        }
        break;
      }
      case 'w:hyperlink': {
        const rel = k.a['r:id'] ? ctx.rels.get(k.a['r:id']) : null;
        paragraphRuns(k, ctx, out, rel?.external ? safeLink(rel.target) : link, extra);
        break;
      }
      case 'w:ins': case 'w:smartTag': case 'w:fldSimple': case 'w:customXml': case 'w:dir': case 'w:bdo':
        paragraphRuns(k, ctx, out, link, extra);
        break;
      case 'w:sdt':
        paragraphRuns(child(k, 'w:sdtContent') || { c: [] }, ctx, out, link, extra);
        break;
      case 'm:oMathPara': case 'm:oMath':
        out.push({ text: findAll(k, 'm:t').map(textOf).join(''), i: true });
        break;
      default: break; // deletions, bookmarks, comments, proofing marks
    }
  }
  return out;
}

function paragraphBlock(p, ctx) {
  const pPr = child(p, 'w:pPr');
  const styleId = child(pPr, 'w:pStyle')?.a['w:val'] || null;
  const extra = [];
  const runs = mergeRuns(paragraphRuns(p, ctx, [], null, extra)).filter((r) => r.img || r.text);
  const block = { t: 'p', runs };
  const h = headingLevel(ctx, styleId, pPr);
  if (h) block.h = h;
  const jc = child(pPr, 'w:jc')?.a['w:val'];
  if (jc === 'center' || jc === 'right' || jc === 'end') block.align = jc === 'end' ? 'right' : jc;
  let numPr = child(pPr, 'w:numPr');
  let numId = child(numPr, 'w:numId')?.a['w:val'] ?? null;
  let ilvl = child(numPr, 'w:ilvl')?.a['w:val'] ?? null;
  if (numId === null) {
    const s = styleChain(ctx, styleId).find((x) => x.numId !== null);
    if (s) { numId = s.numId; ilvl = ilvl ?? s.ilvl; }
  }
  if (numId !== null && numId !== '0' && runs.length) {
    const level = Math.min(8, Number(ilvl) || 0);
    block.list = { level, ...listLabel(ctx, numId, level) };
  }
  return [block, ...extra];
}

function cellBlocks(tc, ctx, depth) {
  const blocks = bodyBlocks(tc, ctx, depth + 1);
  // Word cells always end with a paragraph; trailing empty ones only add height.
  while (blocks.length > 1 && blocks[blocks.length - 1].t === 'p' && !blocks[blocks.length - 1].runs.length) blocks.pop();
  return blocks;
}

function tableBlock(tbl, ctx, depth) {
  const rows = [];
  const origin = []; // column -> the cell a vertical merge continues
  let truncated = false;
  for (const tr of kids(tbl, 'w:tr')) {
    if (rows.length >= MAX_TABLE_ROWS) { truncated = true; break; }
    const row = [];
    let col = 0;
    const cells = [];
    for (const k of tr.c) {
      if (typeof k === 'string') continue;
      if (k.n === 'w:tc') cells.push(k);
      else if (k.n === 'w:sdt' || k.n === 'w:customXml') cells.push(...findAll(k, 'w:tc'));
    }
    for (const tc of cells) {
      const tcPr = child(tc, 'w:tcPr');
      const span = Math.max(1, Number(child(tcPr, 'w:gridSpan')?.a['w:val']) || 1);
      const vm = child(tcPr, 'w:vMerge');
      if (vm && vm.a['w:val'] !== 'restart' && origin[col]) {
        origin[col].rowspan = (origin[col].rowspan || 1) + 1;
        col += span;
        continue;
      }
      const cell = { blocks: cellBlocks(tc, ctx, depth) };
      if (span > 1) cell.colspan = span;
      for (let c = col; c < col + span; c += 1) origin[c] = vm ? cell : null;
      row.push(cell);
      col += span;
    }
    rows.push(row);
  }
  return clean({ t: 'table', rows, truncated });
}

function bodyBlocks(node, ctx, depth = 0) {
  const blocks = [];
  for (const k of node?.c || []) {
    if (typeof k === 'string') continue;
    if (ctx.blocks >= MAX_BLOCKS) { ctx.truncated = true; break; }
    if (k.n === 'w:p') {
      for (const b of paragraphBlock(k, ctx)) {
        // Runs of empty paragraphs are spacing; one is enough.
        const prev = blocks[blocks.length - 1];
        if (b.t === 'p' && !b.runs.length && !b.h && prev?.t === 'p' && !prev.runs.length) continue;
        blocks.push(b);
        ctx.blocks += 1;
      }
    } else if (k.n === 'w:tbl') {
      if (depth < 6) { blocks.push(tableBlock(k, ctx, depth)); ctx.blocks += 1; }
    } else if (k.n === 'w:sdt') {
      blocks.push(...bodyBlocks(child(k, 'w:sdtContent'), ctx, depth));
    } else if (k.n === 'w:customXml' || k.n === 'w:ins' || k.n === 'w:txbxContent') {
      blocks.push(...bodyBlocks(k, ctx, depth));
    }
  }
  return blocks;
}

function docx(buf, entries) {
  const docPath = mainPart(buf, entries, 'word/document.xml');
  const xml = entryText(buf, entries, docPath, MAX_XML);
  if (xml === null) throw new OfficeError('不是有效的 Word 文档');
  const rels = relsOf(buf, entries, docPath);
  const partOf = (type, fallback) => [...rels.values()].find((r) => r.type === type)?.path || fallback;
  const ctx = {
    rels,
    styles: readStyles(buf, entries, partOf('styles', 'word/styles.xml')),
    numbering: readNumbering(buf, entries, partOf('numbering', 'word/numbering.xml')),
    counters: new Map(), images: 0, blocks: 0, truncated: false,
  };
  const body = find(parseXml(xml), 'w:body');
  const blocks = bodyBlocks(body, ctx);
  while (blocks.length && blocks[blocks.length - 1].t === 'p' && !blocks[blocks.length - 1].runs.length) blocks.pop();
  return clean({ kind: 'docx', blocks, truncated: ctx.truncated });
}

/* ---------------- xlsx ---------------- */

const BUILTIN_FORMATS = {
  1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'yyyy-mm-dd', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
  22: 'yyyy-mm-dd h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
  // East Asian built-in date formats
  27: 'yyyy-mm', 28: 'm-d', 29: 'm-d', 30: 'm-d-yy', 31: 'yyyy-mm-dd', 32: 'h:mm', 33: 'h:mm:ss', 34: 'h:mm', 35: 'h:mm:ss', 36: 'yyyy-mm',
  50: 'yyyy-mm', 51: 'm-d', 52: 'yyyy-mm', 53: 'm-d', 54: 'm-d', 55: 'h:mm', 56: 'h:mm:ss', 57: 'yyyy-mm', 58: 'm-d',
};

function formatKind(code) {
  const plain = String(code || '').replace(/"[^"]*"|\\.|\[[^\]]*\]|_.|\*./g, '');
  if (!plain || /^general$/i.test(plain) || plain === '@') return { type: 'general' };
  // y/d mean a date, h/s a time (m alone is month or minute, decided by its neighbours).
  if (/[ydhs]/i.test(plain)) return { type: 'date', date: /[yd]/i.test(plain), time: /[hs]/i.test(plain) };
  const section = plain.split(';')[0];
  const dec = (section.match(/\.([0#?]+)/) || [])[1]?.length || 0;
  if (section.includes('%')) return { type: 'percent', dec };
  if (/E[+-]/i.test(section)) return { type: 'sci', dec };
  return { type: 'number', dec, group: section.includes(',') };
}

/** Excel serial day number to a UTC Date (the 1900 system counts a phantom 1900-02-29). */
function excelDate(serial, date1904) {
  const days = date1904 ? serial - 24107 : (serial < 60 ? serial + 1 : serial) - 25569;
  return new Date(Math.round(days * 86400) * 1000);
}

const pad = (n) => String(n).padStart(2, '0');
function formatCell(raw, kind, date1904) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return String(raw);
  switch (kind?.type) {
    case 'date': {
      const d = excelDate(v, date1904);
      if (Number.isNaN(d.getTime())) return String(raw);
      const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
      const secs = d.getUTCSeconds();
      const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${secs ? `:${pad(secs)}` : ''}`;
      if (kind.date && kind.time) return `${day} ${time}`;
      if (kind.time && !kind.date) return time;
      return day;
    }
    case 'percent': return `${(v * 100).toFixed(kind.dec)}%`;
    case 'sci': return v.toExponential(kind.dec);
    case 'number': {
      const s = v.toFixed(kind.dec);
      if (!kind.group) return s;
      const [i, f] = s.split('.');
      return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
    }
    default: return String(Number(v.toPrecision(15)));
  }
}

function colIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return n - 1;
}
const rowIndex = (ref) => Number((ref.match(/\d+/) || ['0'])[0]) - 1;

function readSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  let inSi = false;
  let inT = false;
  let skip = 0;
  let cur = '';
  sax(xml, {
    open(name) {
      const n = local(name);
      if (n === 'si') { inSi = true; cur = ''; } else if (n === 'rPh' || n === 'phoneticPr') skip += 1;
      else if (n === 't' && inSi && !skip) inT = true;
    },
    close(name) {
      const n = local(name);
      if (n === 'si') { out.push(cur); inSi = false; } else if (n === 'rPh' || n === 'phoneticPr') skip = Math.max(0, skip - 1);
      else if (n === 't') inT = false;
    },
    text(t) { if (inT) cur += t; },
  });
  return out;
}

function readCellFormats(xml) {
  const custom = new Map();
  const xfs = [];
  if (!xml) return xfs;
  const tree = parseXml(xml);
  for (const f of findAll(tree, 'numFmt')) custom.set(Number(f.a.numFmtId), f.a.formatCode);
  const cellXfs = find(tree, 'cellXfs');
  for (const xf of kids(cellXfs, 'xf')) {
    const id = Number(xf.a.numFmtId || 0);
    xfs.push(formatKind(custom.get(id) ?? BUILTIN_FORMATS[id] ?? 'General'));
  }
  return xfs;
}

function xlsx(buf, entries, sheetIndex = 0) {
  const wbPath = mainPart(buf, entries, 'xl/workbook.xml');
  const wbXml = entryText(buf, entries, wbPath, MAX_XML);
  if (wbXml === null) throw new OfficeError('不是有效的 Excel 工作簿');
  const rels = relsOf(buf, entries, wbPath);
  const sheets = [];
  let date1904 = false;
  sax(wbXml, {
    open(name, a) {
      const n = local(name);
      if (n === 'sheet') sheets.push({ name: a.name || `Sheet${sheets.length + 1}`, rid: a['r:id'], hidden: a.state === 'hidden' || a.state === 'veryHidden' });
      else if (n === 'workbookPr') date1904 = a.date1904 === '1' || a.date1904 === 'true';
    },
  });
  if (!sheets.length) throw new OfficeError('工作簿里没有工作表');
  const partOf = (type, fallback) => [...rels.values()].find((r) => r.type === type)?.path || fallback;
  const strings = readSharedStrings(entryText(buf, entries, partOf('sharedStrings', 'xl/sharedStrings.xml'), MAX_XML));
  const formats = readCellFormats(entryText(buf, entries, partOf('styles', 'xl/styles.xml'), MAX_XML));
  const index = Math.min(Math.max(0, Number(sheetIndex) || 0), sheets.length - 1);
  const sheetPath = rels.get(sheets[index].rid)?.path;
  const xml = sheetPath ? entryText(buf, entries, sheetPath, 64 * 1024 * 1024) : null;
  const rows = [];
  let cols = 0;
  let truncatedRows = false;
  let truncatedCols = false;
  let dimension = null;
  if (xml) {
    let rowIdx = -1;
    let cell = null;
    let field = null;
    let nextRow = 0;
    sax(xml, {
      open(name, a) {
        switch (local(name)) {
          case 'dimension': dimension = a.ref || null; break;
          case 'row': {
            rowIdx = a.r ? Number(a.r) - 1 : nextRow;
            nextRow = rowIdx + 1;
            if (rowIdx >= SHEET_MAX_ROWS) { truncatedRows = true; return STOP; }
            break;
          }
          case 'c': cell = { col: a.r ? colIndex(a.r) : (rows[rowIdx]?.length || 0), t: a.t || 'n', s: Number(a.s || 0), v: '', is: '' }; break;
          case 'v': field = 'v'; break;
          case 't': if (cell && cell.t === 'inlineStr') field = 'is'; break;
          case 'rPh': field = null; break;
          default: break;
        }
        return undefined;
      },
      close(name) {
        const n = local(name);
        if (n === 'v' || n === 't') field = null;
        else if (n === 'c' && cell && rowIdx >= 0) {
          let text;
          switch (cell.t) {
            case 's': text = strings[Number(cell.v)] ?? ''; break;
            case 'inlineStr': text = cell.is; break;
            case 'b': text = cell.v === '1' ? 'TRUE' : 'FALSE'; break;
            case 'str': case 'e': case 'd': text = cell.v; break;
            default: text = cell.v === '' ? '' : formatCell(cell.v, formats[cell.s], date1904);
          }
          if (cell.col >= SHEET_MAX_COLS) truncatedCols = true;
          else if (text !== '') {
            while (rows.length <= rowIdx) rows.push([]);
            const row = rows[rowIdx];
            while (row.length < cell.col) row.push('');
            row[cell.col] = text;
            cols = Math.max(cols, cell.col + 1);
          }
          cell = null;
        }
      },
      text(t) {
        if (cell && field === 'v') cell.v += t;
        else if (cell && field === 'is') cell.is += t;
      },
    });
  }
  // Merged ranges come after the cell data.
  const merges = [];
  const at = xml ? xml.lastIndexOf('<mergeCells') : -1;
  if (at >= 0) {
    for (const m of xml.slice(at).matchAll(/<(?:\w+:)?mergeCell\s+ref="([A-Z]+\d+):([A-Z]+\d+)"/g)) {
      const r0 = rowIndex(m[1]); const c0 = colIndex(m[1]); const r1 = rowIndex(m[2]); const c1 = colIndex(m[2]);
      if (r0 < rows.length && c0 < SHEET_MAX_COLS && (r1 > r0 || c1 > c0)) merges.push([r0, c0, Math.min(r1, rows.length - 1), Math.min(c1, SHEET_MAX_COLS - 1)]);
      if (merges.length >= 2000) break;
    }
  }
  let totalRows = rows.length;
  if (dimension && /:/.test(dimension)) totalRows = Math.max(totalRows, rowIndex(dimension.split(':')[1]) + 1);
  return clean({
    kind: 'sheet', sheets: sheets.map((s) => clean({ name: s.name, hidden: s.hidden })), sheet: index,
    table: clean({ rows, cols, merges: merges.length ? merges : undefined, truncatedRows, truncatedCols, totalRows }),
  });
}

/* ---------------- pptx ---------------- */

function drawingRuns(p) {
  const out = [];
  for (const k of p.c) {
    if (typeof k === 'string') continue;
    if (k.n === 'a:r' || k.n === 'a:fld') {
      const rPr = child(k, 'a:rPr');
      out.push(clean({
        text: textOf(child(k, 'a:t') || { c: [] }),
        b: rPr?.a.b === '1' || rPr?.a.b === 'true', i: rPr?.a.i === '1' || rPr?.a.i === 'true',
        u: Boolean(rPr?.a.u) && rPr.a.u !== 'none', s: Boolean(rPr?.a.strike) && rPr.a.strike !== 'noStrike',
        href: undefined,
      }));
    } else if (k.n === 'a:br') out.push({ text: '\n' });
  }
  return mergeRuns(out).filter((r) => r.text);
}

function textParas(txBody) {
  const paras = [];
  for (const p of kids(txBody, 'a:p')) {
    const runs = drawingRuns(p);
    if (!runs.length) continue;
    const level = Number(child(p, 'a:pPr')?.a.lvl || 0);
    paras.push(level ? { level, runs } : { runs });
  }
  return paras;
}

function slideItems(node, srels, slide) {
  for (const k of node?.c || []) {
    if (typeof k === 'string') continue;
    if (k.n === 'p:sp') {
      const ph = find(child(k, 'p:nvSpPr'), 'p:ph');
      const type = ph?.a.type || (ph ? 'body' : null);
      if (type === 'sldNum' || type === 'dt' || type === 'ftr') continue;
      const paras = textParas(child(k, 'p:txBody'));
      if (!paras.length) continue;
      if ((type === 'title' || type === 'ctrTitle') && !slide.title) slide.title = paras.map((p) => p.runs.map((r) => r.text).join('')).join(' ');
      else slide.items.push({ t: 'text', paras, ...(type === 'subTitle' ? { sub: true } : {}) });
    } else if (k.n === 'p:pic') {
      const blip = find(k, 'a:blip');
      const rel = blip && srels.get(blip.a['r:embed']);
      if (rel && !rel.external && rel.path) {
        const item = { t: 'img', src: rel.path, alt: find(k, 'p:cNvPr')?.a.descr || '' };
        if (!mediaType(rel.path)) item.unsupported = rel.path.split('.').pop().toUpperCase();
        const ext = find(child(k, 'p:spPr'), 'a:ext');
        if (ext) Object.assign(item, { w: Math.round(Number(ext.a.cx) / EMU_PER_PX), h: Math.round(Number(ext.a.cy) / EMU_PER_PX) });
        slide.items.push(item);
      }
    } else if (k.n === 'p:graphicFrame') {
      const tbl = find(k, 'a:tbl');
      if (tbl) {
        const rows = kids(tbl, 'a:tr').slice(0, 200).map((tr) => kids(tr, 'a:tc').map((tc) => {
          const cell = { text: textParas(child(tc, 'a:txBody')).map((p) => p.runs.map((r) => r.text).join('')).join('\n') };
          if (Number(tc.a.gridSpan) > 1) cell.colspan = Number(tc.a.gridSpan);
          if (Number(tc.a.rowSpan) > 1) cell.rowspan = Number(tc.a.rowSpan);
          return (tc.a.hMerge === '1' || tc.a.vMerge === '1') ? null : cell;
        }).filter(Boolean));
        slide.items.push({ t: 'table', rows });
      } else if (find(k, 'c:chart')) {
        slide.items.push({ t: 'note', text: '图表' });
      } else if (find(k, 'dgm:relIds')) {
        slide.items.push({ t: 'note', text: 'SmartArt 图形' });
      }
    } else if (k.n === 'p:grpSp') {
      slideItems(k, srels, slide);
    } else if (k.n === 'mc:AlternateContent') {
      slideItems(child(k, 'mc:Choice') || child(k, 'mc:Fallback'), srels, slide);
    }
  }
}

function pptx(buf, entries) {
  const presPath = mainPart(buf, entries, 'ppt/presentation.xml');
  const presXml = entryText(buf, entries, presPath, MAX_XML);
  if (presXml === null) throw new OfficeError('不是有效的 PowerPoint 演示文稿');
  const rels = relsOf(buf, entries, presPath);
  const ids = [];
  sax(presXml, { open(name, a) { if (name === 'p:sldId' && a['r:id']) ids.push(a['r:id']); } });
  const slides = [];
  let truncated = false;
  for (const rid of ids) {
    if (slides.length >= MAX_SLIDES) { truncated = true; break; }
    const path = rels.get(rid)?.path;
    const xml = path && entryText(buf, entries, path, MAX_XML);
    if (!xml) continue;
    const slide = { n: slides.length + 1, title: '', items: [] };
    const srels = relsOf(buf, entries, path);
    slideItems(find(parseXml(xml), 'p:spTree'), srels, slide);
    const notesPath = [...srels.values()].find((r) => r.type === 'notesSlide')?.path;
    const notesXml = notesPath && entryText(buf, entries, notesPath, 8 * 1024 * 1024);
    if (notesXml) {
      const notes = { title: '', items: [] };
      slideItems(find(parseXml(notesXml), 'p:spTree'), new Map(), notes);
      const text = notes.items.filter((i) => i.t === 'text').flatMap((i) => i.paras.map((p) => p.runs.map((r) => r.text).join(''))).join('\n').trim();
      if (text) slide.notes = text;
    }
    if (!slide.title) delete slide.title;
    slides.push(slide);
  }
  return clean({ kind: 'slides', slides, truncated });
}

/* ---------------- entry points ---------------- */

export const OFFICE_KINDS = { '.docx': 'docx', '.docm': 'docx', '.dotx': 'docx', '.xlsx': 'sheet', '.xlsm': 'sheet', '.xltx': 'sheet', '.pptx': 'slides', '.pptm': 'slides', '.ppsx': 'slides', '.potx': 'slides' };

/** Reader data for an Office file (`kind` from OFFICE_KINDS). */
export function officePreview(buf, kind, { sheet = 0 } = {}) {
  let entries;
  try {
    entries = readZip(buf);
  } catch (err) {
    if (err instanceof ZipError) throw new OfficeError(`无法读取这个文件（${err.message}）。如果是旧版 .doc/.xls/.ppt 改了扩展名，请另存为新格式。`);
    throw err;
  }
  try {
    if (kind === 'docx') return docx(buf, entries);
    if (kind === 'sheet') return xlsx(buf, entries, sheet);
    if (kind === 'slides') return pptx(buf, entries);
  } catch (err) {
    if (err instanceof ZipError || err.name === 'XmlError') throw new OfficeError(`文件内容无法解析：${err.message}`);
    throw err;
  }
  throw new OfficeError('不支持的文件类型');
}

/** One embedded image of an Office file, for <img> in the reader. */
export function officePart(buf, entryName) {
  const type = mediaType(entryName);
  if (!type) throw new OfficeError('只能读取文档里的图片');
  let entries;
  try { entries = readZip(buf); } catch { throw new OfficeError('无法读取这个文件'); }
  const entry = entries.get(String(entryName));
  if (!entry) throw new OfficeError('文档里没有这张图片');
  return { data: entryData(buf, entry, 32 * 1024 * 1024), type };
}
