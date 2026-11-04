// Read-only file panel: the current project's directory tree and a preview of one file
// (Markdown rendered, code with line numbers, images inline, anything else as a download).
import { renderMarkdown } from './markdown.js';
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);
const ui = {
  panel: $('files-panel'), chip: $('files-btn'), back: $('fp-back'), close: $('fp-close'), refresh: $('fp-refresh'),
  rootName: $('fp-root-name'), rootDir: $('fp-root-dir'), tree: $('fp-tree'), view: $('fp-view'), up: $('fp-up'),
  path: $('fp-path'), source: $('fp-source'), download: $('fp-download'), body: $('fp-body'),
};
const narrow = window.matchMedia('(max-width: 767px)');

let hooks = {};
const st = {
  key: null, // project id or 'default'
  name: '',
  dir: '',
  dirs: new Map(), // relative dir -> { entries, truncated } | { error }
  open: new Set(['']), // expanded dirs
  file: null, // preview of the open file
  showSource: false,
  seq: 0,
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const base = () => `/api/projects/${encodeURIComponent(st.key)}`;
const q = (path) => `?path=${encodeURIComponent(path)}`;
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function isFilesOpen() { return !ui.panel.hidden; }

/** Which directory the panel shows: follows the chat (its project, or the default one). */
export function setFilesRoot(key, name) {
  if (key === st.key) { st.name = name; renderRoot(); return; }
  Object.assign(st, { key, name, dir: '', file: null, showSource: false });
  st.dirs.clear();
  st.open = new Set(['']);
  st.seq += 1;
  if (isFilesOpen()) load();
  renderRoot();
}

export function openFiles() {
  hooks.closeOthers?.();
  ui.panel.hidden = false;
  document.body.classList.add('bp-open');
  ui.chip.setAttribute('aria-expanded', 'true');
  load();
  if (narrow.matches) ui.back.focus();
}

export function closeFiles({ focus = true } = {}) {
  if (ui.panel.hidden) return;
  ui.panel.hidden = true;
  document.body.classList.remove('bp-open');
  ui.chip.setAttribute('aria-expanded', 'false');
  if (focus) ui.chip.focus();
}

async function fetchDir(path) {
  const seq = st.seq;
  try {
    const data = await hooks.api(`${base()}/tree${q(path)}`);
    if (seq !== st.seq) return;
    st.dir = data.root;
    st.dirs.set(path, { entries: data.entries, truncated: data.truncated });
  } catch (err) {
    if (seq !== st.seq || err.status === 401) return;
    st.dirs.set(path, { error: err.message });
    if (err.status === 404 || err.status === 403) st.open.delete(path);
  }
}

/** (Re)loads every expanded directory, and the open file. */
async function load() {
  if (!st.key) return;
  renderTree();
  await Promise.all([...st.open].map(fetchDir));
  renderRoot();
  renderTree();
  if (st.file) await showFile(st.file.path, { keepScroll: true, quiet: true });
}

let soon = null;
/** Claude changed files: refresh once things settle, only while someone is looking. */
export function refreshFilesSoon() {
  if (!isFilesOpen()) return;
  clearTimeout(soon);
  soon = setTimeout(load, 800);
}

/** Opens a path from a reply (relative to the project, or absolute inside it). */
export async function openPath(path) {
  if (!isFilesOpen()) openFiles();
  await showFile(path);
}

async function showFile(path, { keepScroll = false, quiet = false } = {}) {
  const seq = st.seq;
  let file;
  try {
    ({ file } = await hooks.api(`${base()}/file${q(path)}`));
  } catch (err) {
    if (seq !== st.seq || err.status === 401) return;
    if (quiet) { st.file = null; renderView(); return; }
    hooks.toast(err.status === 404 ? `找不到文件：${path}` : err.message);
    return;
  }
  if (seq !== st.seq) return;
  if (file.kind === 'dir') {
    // Expand the folder and every parent in the tree.
    const parts = file.path ? file.path.split('/') : [];
    for (let i = 0; i <= parts.length; i += 1) st.open.add(parts.slice(0, i).join('/'));
    st.file = null;
    renderView();
    await load();
    return;
  }
  const same = st.file?.path === file.path;
  const scroll = keepScroll && same ? ui.body.scrollTop : 0;
  if (!same) st.showSource = false;
  st.file = file;
  renderView();
  ui.body.scrollTop = scroll;
}

/* ---------- rendering ---------- */

// Long paths are cut at the start (direction: rtl in CSS); the LRMs keep their slashes in place.
function renderRoot() {
  ui.rootName.textContent = st.name || '默认工作目录';
  ui.rootDir.textContent = st.dir ? `\u200e${st.dir}\u200e` : '';
  ui.rootDir.title = st.dir;
  const label = st.key && st.key !== 'default' ? `文件：${st.name}` : '文件';
  ui.chip.title = label;
  ui.chip.setAttribute('aria-label', `${label}（打开文件面板）`);
}

function renderTree() {
  const top = st.dirs.get('');
  ui.tree.replaceChildren();
  if (!top) { ui.tree.append(el('p', 'fp-note', '加载中…')); return; }
  if (top.error) { ui.tree.append(el('p', 'fp-note', top.error)); return; }
  if (!top.entries.length) {
    ui.tree.append(el('p', 'fp-note', '目录是空的。让 Claude 在这个项目里写的文档和代码会出现在这里。'));
    return;
  }
  ui.tree.append(branch('', 0));
}

function branch(path, depth) {
  const data = st.dirs.get(path);
  const ul = el('ul', 'fp-list');
  ul.setAttribute('role', depth ? 'group' : 'presentation');
  if (!data) { ul.append(el('li', 'fp-note', '加载中…')); return ul; }
  if (data.error) { ul.append(el('li', 'fp-note', data.error)); return ul; }
  for (const e of data.entries) {
    const rel = path ? `${path}/${e.name}` : e.name;
    const li = el('li');
    li.setAttribute('role', 'treeitem');
    const b = el('button', `fp-item${st.file?.path === rel ? ' current' : ''}`);
    b.type = 'button';
    b.dataset.path = rel;
    b.dataset.type = e.type;
    b.style.paddingLeft = `${8 + depth * 16}px`;
    if (e.type === 'dir') {
      const open = st.open.has(rel);
      li.setAttribute('aria-expanded', String(open));
      const chev = icon(open ? 'chevron-down' : 'chevron-right', 14);
      chev.classList.add('fp-chev');
      b.append(chev, icon('folder', 16), el('span', 'fp-name', e.name));
      li.append(b);
      if (open) li.append(branch(rel, depth + 1));
    } else {
      const spacer = el('span', 'fp-chev');
      b.append(spacer, icon('file', 16), el('span', 'fp-name', e.name), el('span', 'fp-size', fmtSize(e.size)));
      li.append(b);
    }
    ul.append(li);
  }
  if (data.truncated) ul.append(el('li', 'fp-note', '文件太多，只显示前 1000 个'));
  return ul;
}

function lineView(text) {
  const box = el('div', 'fp-code');
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const nums = el('pre', 'fp-ln', lines.map((_, i) => i + 1).join('\n'));
  nums.setAttribute('aria-hidden', 'true');
  const src = el('pre', 'fp-src');
  src.append(el('code', '', lines.join('\n')));
  box.append(nums, src);
  return box;
}

function renderView() {
  const f = st.file;
  ui.tree.hidden = Boolean(f);
  ui.view.hidden = !f;
  renderTree();
  if (!f) return;
  ui.path.textContent = `\u200e${f.path}\u200e`;
  ui.path.title = f.path;
  ui.download.href = `${base()}/raw${q(f.path)}&download=1`;
  ui.source.hidden = f.kind !== 'markdown';
  ui.source.textContent = st.showSource ? '预览' : '源码';
  ui.body.replaceChildren();
  if (f.kind === 'markdown' && !st.showSource) {
    const md = el('div', 'md fp-md');
    md.append(renderMarkdown(f.text));
    ui.body.append(md);
  } else if (f.kind === 'markdown' || f.kind === 'text') {
    ui.body.append(lineView(f.text));
  } else if (f.kind === 'image') {
    const img = el('img', 'fp-img');
    img.src = `${base()}/raw${q(f.path)}&t=${encodeURIComponent(f.mtime)}`;
    img.alt = f.name;
    ui.body.append(img);
  } else {
    const box = el('div', 'fp-binary');
    box.append(icon('file', 32), el('p', '', `${f.name} · ${fmtSize(f.size)}`), el('p', 'fp-note', '这个文件无法在网页里预览。'));
    const a = el('a', 'btn btn-primary btn-sm', '下载');
    a.href = ui.download.href;
    box.append(a);
    ui.body.append(box);
  }
  if (f.truncated) ui.body.append(el('p', 'fp-note', `文件较大（${fmtSize(f.size)}），只显示前 512 KB，完整内容请下载。`));
}

/* ---------- wiring ---------- */

export function initFiles(h) {
  hooks = h;
  renderRoot();
  ui.chip.addEventListener('click', () => (isFilesOpen() ? closeFiles() : openFiles()));
  ui.close.addEventListener('click', () => closeFiles());
  ui.back.addEventListener('click', () => closeFiles());
  ui.refresh.addEventListener('click', load);
  ui.up.addEventListener('click', () => { st.file = null; renderView(); });
  ui.source.addEventListener('click', () => { st.showSource = !st.showSource; renderView(); });
  ui.tree.addEventListener('click', async (e) => {
    const b = e.target.closest('.fp-item');
    if (!b) return;
    const { path, type } = b.dataset;
    if (type === 'dir') {
      if (st.open.has(path)) {
        st.open.delete(path);
        renderTree();
      } else {
        st.open.add(path);
        renderTree();
        await fetchDir(path);
        renderTree();
      }
      ui.tree.querySelector(`.fp-item[data-path="${CSS.escape(path)}"]`)?.focus();
    } else {
      showFile(path);
    }
  });
  // Images open in the shared viewer, as in replies.
  ui.body.addEventListener('click', (e) => {
    const img = e.target.closest('.fp-img');
    if (img) hooks.openViewer?.(img.src, st.file?.name || '');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isFilesOpen() && narrow.matches && !document.querySelector('dialog[open]')) closeFiles();
  });
}
