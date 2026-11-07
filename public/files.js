// File panel: the current project's directory tree (read-only) and the reader, which opens
// project files, any host file a reply names, and attachments (see reader.js for the kinds).
import { icon } from './icons.js';
import { fmtSize, hasSourceToggle, hostSource, projectSource, renderPreview, uploadSource } from './reader.js';

const $ = (id) => document.getElementById(id);
const ui = {
  panel: $('files-panel'), chip: $('files-btn'), back: $('fp-back'), close: $('fp-close'), refresh: $('fp-refresh'),
  rootName: $('fp-root-name'), rootDir: $('fp-root-dir'), tree: $('fp-tree'), view: $('fp-view'), up: $('fp-up'),
  path: $('fp-path'), source: $('fp-source'), download: $('fp-download'), body: $('fp-body'), wide: $('fp-wide'),
};
const narrow = window.matchMedia('(max-width: 767px)');

let hooks = {};
const st = {
  key: null, // project id or 'default'
  name: '',
  dir: '',
  dirs: new Map(), // relative dir -> { entries, truncated } | { error }
  open: new Set(['']), // expanded dirs
  // The reader: where the open file comes from, its reader data, options (sheet), viewer handle.
  view: null, // { src, file, params, error, loading, showSource, handle }
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

export function isFilesOpen() { return !ui.panel.hidden; }

/** Which directory the panel shows: follows the chat (its project, or the default one). */
export function setFilesRoot(key, name) {
  if (key === st.key) { st.name = name; renderRoot(); return; }
  Object.assign(st, { key, name, dir: '' });
  st.dirs.clear();
  st.open = new Set(['']);
  st.seq += 1;
  // A project file belongs to the old root; files from replies and attachments stay open.
  if (st.view?.src.type === 'project') closeView();
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
  setWide(false);
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
  if (st.view && !st.view.loading) await loadView(st.view.src, { quiet: true, keepScroll: true });
}

let soon = null;
/** Claude changed files: refresh once things settle, only while someone is looking. */
export function refreshFilesSoon() {
  if (!isFilesOpen()) return;
  clearTimeout(soon);
  soon = setTimeout(load, 800);
}

/**
 * Opens a path from a reply: relative to the chat's directory, or absolute anywhere on the
 * host (credential locations are refused by the server).
 */
export async function openPath(path, conv = null) {
  await openSource(hostSource(path, conv));
}

/** Opens an attachment (or a file Claude showed) in the reader. */
export async function openUpload(id, name) {
  await openSource(uploadSource(id, name));
}

export async function openSource(src) {
  if (!isFilesOpen()) openFiles();
  await loadView(src);
}

function closeView() {
  st.view?.handle?.destroy();
  st.view = null;
  renderView();
}

/** Fetches reader data for `src` and shows it; `params` (e.g. sheet) persist for refreshes. */
async function loadView(src, { quiet = false, keepScroll = false, params } = {}) {
  const same = st.view?.src.id === src.id;
  const scroll = keepScroll && same ? ui.body.scrollTop : 0;
  const view = {
    src, file: same ? st.view.file : null, params: params || (same ? st.view.params : {}) || {},
    showSource: same ? st.view.showSource : false, loading: true, handle: null,
  };
  if (!same || !quiet) {
    st.view?.handle?.destroy();
    st.view = view;
    if (!same) renderView();
  } else {
    view.handle = st.view.handle;
    st.view = view;
  }
  let file;
  try {
    ({ file } = await hooks.api(src.preview(view.params)));
  } catch (err) {
    if (st.view !== view || err.status === 401) return;
    view.loading = false;
    if (quiet) { if (err.status === 404) closeView(); return; }
    view.error = err.status === 404 ? `找不到文件：${src.path || src.name || ''}` : err.message;
    view.file = null;
    renderView();
    return;
  }
  if (st.view !== view) return;
  view.loading = false;
  if (file.kind === 'dir' && src.type === 'project') {
    // Expand the folder and every parent in the tree.
    const parts = file.path ? file.path.split('/') : [];
    for (let i = 0; i <= parts.length; i += 1) st.open.add(parts.slice(0, i).join('/'));
    st.view = null;
    renderView();
    await load();
    return;
  }
  // A quiet refresh of an unchanged file keeps the viewer (and its scroll position) as it is.
  if (quiet && same && view.file && view.file.mtime === file.mtime && view.file.size === file.size) {
    view.file = file;
    return;
  }
  view.handle?.destroy();
  view.handle = null;
  view.file = file;
  renderView();
  ui.body.scrollTop = scroll;
}

/* ---------- rendering ---------- */

// Long paths are cut at the start (direction: rtl in CSS); the LRMs keep their slashes in place.
function renderRoot() {
  ui.rootName.textContent = st.name || '默认工作目录';
  ui.rootDir.textContent = st.dir ? `‎${st.dir}‎` : '';
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

const FILE_ICONS = { image: 'image' };
function kindIcon(name) {
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(name) ? FILE_ICONS.image : 'file';
}

function branch(path, depth) {
  const data = st.dirs.get(path);
  const ul = el('ul', 'fp-list');
  ul.setAttribute('role', depth ? 'group' : 'presentation');
  if (!data) { ul.append(el('li', 'fp-note', '加载中…')); return ul; }
  if (data.error) { ul.append(el('li', 'fp-note', data.error)); return ul; }
  const current = st.view?.src.type === 'project' ? st.view.src.path : null;
  for (const e of data.entries) {
    const rel = path ? `${path}/${e.name}` : e.name;
    const li = el('li');
    li.setAttribute('role', 'treeitem');
    const b = el('button', `fp-item${current === rel ? ' current' : ''}`);
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
      b.append(spacer, icon(kindIcon(e.name), 16), el('span', 'fp-name', e.name), el('span', 'fp-size', fmtSize(e.size)));
      li.append(b);
    }
    ul.append(li);
  }
  if (data.truncated) ul.append(el('li', 'fp-note', '文件太多，只显示前 1000 个'));
  return ul;
}

function displayPath(v) {
  if (v.src.type === 'upload') return v.file?.name || v.src.name || '附件';
  const p = v.file?.path || v.src.path || '';
  // A host file inside the panel's root reads better relative to it.
  if (v.src.type === 'host' && st.dir && p.startsWith(`${st.dir}/`)) return p.slice(st.dir.length + 1);
  return p;
}

function renderView() {
  const v = st.view;
  ui.tree.hidden = Boolean(v);
  ui.view.hidden = !v;
  renderTree();
  if (!v) return;
  const shown = displayPath(v);
  ui.path.textContent = `‎${shown}‎`;
  ui.path.title = v.src.type === 'upload' ? `附件：${shown}` : (v.file?.path || v.src.path || '');
  ui.download.href = v.src.raw({ download: 1 });
  ui.source.hidden = !hasSourceToggle(v.file);
  ui.source.textContent = v.showSource ? '预览' : '源码';
  ui.body.replaceChildren();
  ui.body.dataset.kind = v.file?.kind || '';
  if (v.error) { ui.body.append(el('p', 'fp-note', v.error)); return; }
  if (!v.file) { ui.body.append(el('p', 'fp-note', '加载中…')); return; }
  v.handle = renderPreview(ui.body, v.file, v.src, {
    showSource: v.showSource,
    reload: (params) => loadView(v.src, { params: { ...v.params, ...params } }),
    openSource: (src) => loadView(src),
    mdImage: hooks.mdImage,
  });
}

function setWide(on) {
  document.body.classList.toggle('fp-wide', on);
  ui.wide.setAttribute('aria-pressed', String(on));
  ui.wide.replaceChildren(icon(on ? 'collapse' : 'expand', 18));
  ui.wide.title = on ? '退出全屏阅读' : '全屏阅读';
  ui.wide.setAttribute('aria-label', ui.wide.title);
}

/* ---------- wiring ---------- */

export function initFiles(h) {
  hooks = h;
  renderRoot();
  setWide(false);
  ui.chip.addEventListener('click', () => (isFilesOpen() ? closeFiles() : openFiles()));
  ui.close.addEventListener('click', () => closeFiles());
  ui.back.addEventListener('click', () => closeFiles());
  ui.refresh.addEventListener('click', load);
  ui.wide.addEventListener('click', () => setWide(!document.body.classList.contains('fp-wide')));
  ui.up.addEventListener('click', () => closeView());
  ui.source.addEventListener('click', () => {
    if (!st.view) return;
    st.view.handle?.destroy();
    st.view.showSource = !st.view.showSource;
    renderView();
  });
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
      loadView(projectSource(st.key, path));
    }
  });
  // Images (files, Markdown, documents, slides) open in the shared viewer, as in replies.
  ui.body.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-view]');
    if (!link || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    const all = [...ui.body.querySelectorAll('a[data-view]')];
    hooks.openViewer?.(link.href, link.dataset.view, all.map((a) => ({ src: a.href, name: a.dataset.view })), all.indexOf(link));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isFilesOpen() || document.querySelector('dialog[open]')) return;
    if (document.body.classList.contains('fp-wide')) setWide(false);
    else if (narrow.matches) closeFiles();
  });
}
