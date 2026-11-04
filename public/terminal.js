// Terminal panel: the owner's own commands (run in the chat's project directory, output
// streamed live, stdin and stop) and, in the same list, every command Claude ran in this
// chat with its output.
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);
const ui = {
  panel: $('term-panel'), chip: $('term-btn'), dot: $('term-dot'), back: $('tm-back'), close: $('tm-close'),
  clear: $('tm-clear'), filter: $('tm-filter'), root: $('tm-root'), feed: $('tm-feed'), form: $('tm-form'),
  prompt: $('tm-prompt'), input: $('tm-input'), run: $('tm-run'), stop: $('tm-stop'),
};
const narrow = window.matchMedia('(max-width: 767px)');
const HISTORY_KEY = 'aw.termHist';

let hooks = {};
const st = {
  key: null, name: '', cwd: '', entries: [], es: null, filter: 'all',
  expanded: new Set(), collapsed: new Set(), // explicit toggles; defaults depend on who ran it
  claudeSig: '', history: [], histAt: -1, stick: true,
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const base = () => `/api/terminal/${encodeURIComponent(st.key)}`;
const running = () => st.entries.find((e) => e.status === 'running') || null;

/** Plain text from terminal output: no escape sequences, carriage returns overwrite the line. */
export function cleanOutput(text) {
  return String(text || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .split('\n')
    .map((line) => {
      const l = line.endsWith('\r') ? line.slice(0, -1) : line;
      const i = l.lastIndexOf('\r');
      return i >= 0 ? l.slice(i + 1) : l;
    })
    .join('\n');
}

export function isTerminalOpen() { return !ui.panel.hidden; }

export function setTerminalRoot(key, name) {
  if (key === st.key) { st.name = name; renderBar(); return; }
  Object.assign(st, { key, name, cwd: '', entries: [] });
  if (isTerminalOpen()) connect();
  renderBar();
  renderFeed();
}

export function openTerminal() {
  hooks.closeOthers?.();
  ui.panel.hidden = false;
  document.body.classList.add('bp-open');
  ui.chip.setAttribute('aria-expanded', 'true');
  connect();
  renderFeed(true);
  if (!narrow.matches) ui.input.focus();
  else ui.back.focus();
}

export function closeTerminal({ focus = true } = {}) {
  if (ui.panel.hidden) return;
  ui.panel.hidden = true;
  document.body.classList.remove('bp-open');
  ui.chip.setAttribute('aria-expanded', 'false');
  // Keep streaming only while someone looks; a running command continues on the server.
  st.es?.close();
  st.es = null;
  if (focus) ui.chip.focus();
}

/** Opens the panel at one of Claude's commands (a Bash call in a reply). */
export function showClaudeCommand(toolId) {
  st.filter = 'all';
  st.expanded.add(toolId);
  st.collapsed.delete(toolId);
  if (!isTerminalOpen()) openTerminal();
  renderFilter();
  renderFeed();
  const node = ui.feed.querySelector(`[data-id="${CSS.escape(toolId)}"]`);
  if (node) {
    st.stick = false;
    node.scrollIntoView({ block: 'start' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1600);
  }
}

/** The chat's commands changed (streaming, another chat opened): redraw if it matters. */
export function refreshTerminalClaude() {
  if (!isTerminalOpen()) return;
  const sig = (hooks.claudeCommands?.() || []).map((c) => `${c.id}:${c.state}:${c.output?.length || 0}`).join('|');
  if (sig === st.claudeSig) return;
  renderFeed();
}

function connect() {
  st.es?.close();
  if (!st.key) return;
  const key = st.key;
  const es = new EventSource(`${base()}/events`);
  st.es = es;
  es.onmessage = (e) => {
    if (st.es !== es || st.key !== key) return;
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    onEvent(ev);
  };
  es.onerror = () => {
    if (st.es !== es || es.readyState !== EventSource.CLOSED) return;
    st.es = null;
    setTimeout(() => { if (!st.es && isTerminalOpen()) connect(); }, 3000);
  };
}

function onEvent(ev) {
  if (ev.type === 'snapshot') {
    st.cwd = ev.cwd;
    st.entries = ev.entries;
    renderBar();
    renderFeed();
    return;
  }
  if (ev.type === 'start') {
    if (!st.entries.some((e) => e.id === ev.entry.id)) st.entries.push(ev.entry);
    renderFeed();
  } else if (ev.type === 'out') {
    const e = st.entries.find((x) => x.id === ev.id);
    if (!e) return;
    e.output += ev.data;
    scheduleEntry(e.id);
  } else if (ev.type === 'end') {
    const i = st.entries.findIndex((x) => x.id === ev.entry.id);
    if (i >= 0) st.entries[i] = ev.entry; else st.entries.push(ev.entry);
    st.cwd = ev.cwd || st.cwd;
    renderBar();
    renderFeed();
  }
  renderControls();
}

let pending = new Set();
let raf = null;
function scheduleEntry(id) {
  pending.add(id);
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = null;
    for (const pid of pending) {
      const e = st.entries.find((x) => x.id === pid);
      const node = ui.feed.querySelector(`[data-id="${CSS.escape(pid)}"]`);
      if (e && node) node.replaceWith(entryNode(mine(e)));
    }
    pending = new Set();
    if (st.stick) ui.feed.scrollTop = ui.feed.scrollHeight;
  });
}

/* ---------- rendering ---------- */

const shortPath = (p) => (p || '').replace(/^\/home\/[^/]+/, '~');

function renderBar() {
  const where = st.name || '默认工作目录';
  ui.root.textContent = `${where} · ${shortPath(st.cwd)}`;
  ui.root.title = st.cwd;
  ui.prompt.textContent = `${shortPath(st.cwd).split('/').pop() || '/'} $`;
}

function renderFilter() {
  for (const b of ui.filter.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.filter === st.filter));
}

function renderControls() {
  const r = running();
  ui.stop.hidden = !r;
  ui.run.textContent = r ? '发送' : '运行';
  ui.input.placeholder = r ? '命令运行中：输入内容回车发送给它' : '输入命令，回车运行';
  ui.dot.hidden = !r;
}

const mine = (e) => ({
  id: e.id, who: 'me', command: e.command, cwd: e.cwd, at: e.startedAt, output: e.output, clipped: e.clipped,
  state: e.status, exitCode: e.exitCode,
});

function items() {
  const out = [];
  if (st.filter !== 'claude') out.push(...st.entries.map(mine));
  if (st.filter !== 'me') {
    for (const c of hooks.claudeCommands?.() || []) {
      out.push({ id: c.id, who: 'claude', command: c.command, desc: c.desc, at: c.at, output: c.output, state: c.state });
    }
  }
  return out.sort((a, b) => (a.at || '').localeCompare(b.at || ''));
}

function stateText(it) {
  if (it.state === 'running') return '运行中…';
  if (it.state === 'stopped') return '已停止';
  if (it.who === 'me') return it.exitCode === 0 ? '完成' : `退出码 ${it.exitCode ?? '?'}`;
  return it.state === 'error' ? '失败' : '完成';
}

function isOpen(it) {
  if (st.expanded.has(it.id)) return true;
  if (st.collapsed.has(it.id)) return false;
  return it.who === 'me';
}

function entryNode(it) {
  const open = isOpen(it);
  const box = el('div', `tm-entry who-${it.who} st-${it.state}`);
  box.dataset.id = it.id;
  const head = el('button', 'tm-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(open));
  const chev = icon(open ? 'chevron-down' : 'chevron-right', 14);
  const first = (it.command || '').split('\n')[0];
  head.append(chev, el('span', 'tm-who', it.who === 'me' ? '你' : 'Claude'), el('code', 'tm-cmd', first || it.desc || '（命令）'), el('span', 'tm-state', stateText(it)));
  box.append(head);
  if (it.who === 'claude' && it.desc && it.desc !== first) box.append(el('p', 'tm-desc', it.desc));
  if (!open) return box;
  const body = el('div', 'tm-body');
  if (it.who === 'me') body.append(el('p', 'tm-meta', `${shortPath(it.cwd)} · ${new Date(it.at).toLocaleTimeString('zh-CN', { hour12: false })}`));
  // The header shows the first line; the whole command only when there is more to it.
  if ((it.command || '').includes('\n') || (it.command || '').length > 80) body.append(el('pre', 'tm-full', it.command));
  const text = cleanOutput(it.output);
  if (it.clipped) body.append(el('p', 'tm-meta', '输出较长，只保留最后 512 KB'));
  if (text) body.append(el('pre', 'tm-out', text));
  else if (it.state !== 'running') body.append(el('p', 'tm-meta', it.who === 'claude' && it.output === undefined ? '这条命令没有记录输出（较早的回复不保存输出）' : '（没有输出）'));
  box.append(body);
  return box;
}

function renderFeed(toBottom = false) {
  const list = items();
  st.claudeSig = (hooks.claudeCommands?.() || []).map((c) => `${c.id}:${c.state}:${c.output?.length || 0}`).join('|');
  const keep = ui.feed.scrollTop;
  ui.feed.replaceChildren();
  if (!list.length) {
    const empty = el('div', 'tm-empty');
    empty.append(icon('terminal', 28),
      el('p', '', st.filter === 'claude' ? 'Claude 在这个对话里还没有运行过命令。' : '在下面输入命令，回车运行。'),
      el('p', 'tm-meta', '命令在当前项目目录里运行，cd 会保留到下一条命令；需要交互输入时，在运行中直接输入回车发送。Claude 在这个对话里运行的命令也会列在这里，点开能看完整命令和输出。'));
    ui.feed.append(empty);
  }
  for (const it of list) ui.feed.append(entryNode(it));
  if (toBottom || st.stick) ui.feed.scrollTop = ui.feed.scrollHeight;
  else ui.feed.scrollTop = keep;
  renderControls();
}

/* ---------- actions ---------- */

async function submit() {
  const text = ui.input.value;
  const r = running();
  try {
    if (r) {
      await hooks.api(`${base()}/input`, { method: 'POST', body: { text } });
    } else {
      const command = text.trim();
      if (!command) return;
      st.history = [...st.history.filter((h) => h !== command), command].slice(-100);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(st.history)); } catch { /* storage unavailable */ }
      st.histAt = -1;
      st.stick = true;
      const { entry } = await hooks.api(`${base()}/run`, { method: 'POST', body: { command } });
      if (!st.entries.some((e) => e.id === entry.id)) st.entries.push(entry);
      renderFeed(true);
    }
    ui.input.value = '';
  } catch (err) {
    if (err.status !== 401) hooks.toast(err.message);
  }
}

async function stop() {
  try {
    await hooks.api(`${base()}/stop`, { method: 'POST', body: {} });
  } catch (err) {
    if (err.status !== 401) hooks.toast(err.message);
  }
}

async function clearMine() {
  try {
    const snap = await hooks.api(`${base()}/clear`, { method: 'POST', body: {} });
    st.entries = snap.entries;
    renderFeed();
  } catch (err) {
    if (err.status !== 401) hooks.toast(err.message);
  }
}

export function initTerminal(h) {
  hooks = h;
  try { st.history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { st.history = []; }
  renderBar();
  ui.chip.addEventListener('click', () => (isTerminalOpen() ? closeTerminal() : openTerminal()));
  ui.close.addEventListener('click', () => closeTerminal());
  ui.back.addEventListener('click', () => closeTerminal());
  ui.clear.addEventListener('click', clearMine);
  ui.stop.addEventListener('click', stop);
  ui.form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  ui.input.addEventListener('keydown', (e) => {
    if (e.key === 'c' && e.ctrlKey && running() && !ui.input.selectionStart && !ui.input.value) { e.preventDefault(); stop(); return; }
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || running() || !st.history.length) return;
    e.preventDefault();
    if (e.key === 'ArrowUp') st.histAt = st.histAt < 0 ? st.history.length - 1 : Math.max(0, st.histAt - 1);
    else st.histAt = st.histAt < 0 ? -1 : st.histAt + 1;
    if (st.histAt >= st.history.length) st.histAt = -1;
    ui.input.value = st.histAt < 0 ? '' : st.history[st.histAt];
  });
  ui.filter.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (!b) return;
    st.filter = b.dataset.filter;
    renderFilter();
    renderFeed(true);
  });
  ui.feed.addEventListener('click', (e) => {
    const head = e.target.closest('.tm-head');
    if (!head) return;
    const id = head.closest('.tm-entry').dataset.id;
    const it = items().find((x) => x.id === id);
    if (!it) return;
    if (isOpen(it)) { st.expanded.delete(id); st.collapsed.add(id); } else { st.collapsed.delete(id); st.expanded.add(id); }
    st.stick = false;
    renderFeed();
  });
  ui.feed.addEventListener('scroll', () => {
    st.stick = ui.feed.scrollHeight - ui.feed.scrollTop - ui.feed.clientHeight < 40;
  }, { passive: true });
  window.addEventListener('resize', () => { if (st.stick) ui.feed.scrollTop = ui.feed.scrollHeight; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isTerminalOpen() && narrow.matches && !document.querySelector('dialog[open]')) closeTerminal();
  });
}
