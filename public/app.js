import { renderMarkdown } from './markdown.js';
import { hydrateIcons, icon } from './icons.js';
import {
  browserSnapshot, helpKindLabel, open as openBrowser, startBrowserEvents, stopBrowserEvents,
} from './browser.js';
import {
  exportMarkdown, initExtras, notify, openPlusMenu, openSettings, openShare, openStatus, openTasks,
} from './extras.js';
import { initResizers } from './resize.js';

const $ = (id) => document.getElementById(id);
const ui = {
  boot: $('boot'), loginView: $('login-view'), loginForm: $('login-form'), password: $('password'),
  loginError: $('login-error'), loginSubmit: $('login-submit'), app: $('app-view'), sidebar: $('sidebar'),
  scrim: $('scrim'), menu: $('menu'), topNew: $('top-new'), sbCollapse: $('sb-collapse'), sbNew: $('sb-new'),
  newChat: $('new-chat'), search: $('search'), groups: $('conv-groups'), convEmpty: $('conv-empty'),
  theme: $('theme'), themeLabel: $('theme-label'), logout: $('logout'), title: $('chat-title'),
  modelBtn: $('model-btn'), modelBtnName: $('model-btn-name'), modelBtnEffort: $('model-btn-effort'),
  convMenuBtn: $('conv-menu-btn'), banner: $('banner'), scroller: $('scroller'), messages: $('messages'),
  jump: $('jump'), composer: $('composer'), attachList: $('attach-list'), input: $('input'),
  attachBtn: $('attach-btn'), fileInput: $('file-input'), composerModel: $('composer-model'), send: $('send'),
  stop: $('stop'), composerError: $('composer-error'), modelPop: $('model-pop'), modelList: $('model-list'),
  modelMore: $('model-more'), modelListMore: $('model-list-more'), modelRefresh: $('model-refresh'),
  effortSeg: $('effort-seg'), effortHint: $('effort-hint'), modelTiming: $('model-timing'), menuPop: $('menu-pop'),
  popScrim: $('pop-scrim'), renameDialog: $('rename-dialog'), renameForm: $('rename-form'), renameInput: $('rename-input'),
  renameCancel: $('rename-cancel'), confirmDialog: $('confirm-dialog'), confirmTitle: $('confirm-title'),
  confirmText: $('confirm-text'), confirmOk: $('confirm-ok'), toast: $('toast'), live: $('live'),
};

const EFFORT_LABEL = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };
const EFFORT_HINT = {
  low: '最快，适合简单问题', medium: '速度与质量平衡', high: '更深入的推理', xhigh: '更长时间思考', max: '最充分的推理，最慢',
};
// Aliases track the newest model of a family; pinned versions go under "更多版本".
const PRIMARY = new Set(['default', 'opus', 'sonnet', 'fable', 'haiku']);
const TOOL_LABELS = {
  Bash: '运行命令', Read: '读取文件', Write: '写入文件', Edit: '编辑文件', MultiEdit: '编辑文件',
  NotebookEdit: '编辑笔记本', Glob: '查找文件', Grep: '搜索内容', WebFetch: '获取网页', WebSearch: '网络搜索',
  'mcp__assistant-media__show_file': '展示文件',
  Agent: '子任务', Task: '子任务', TodoWrite: '更新待办', Skill: '使用技能', ToolSearch: '加载工具',
};
const BROWSER_TOOLS = {
  tabs: '标签页', navigate: '打开网页', snapshot: '读取页面结构', act: '操作页面', read: '读取页面', grep: '搜索页面',
  screenshot: '页面截图', run: '浏览器脚本', wait: '等待页面', evaluate: '执行页面脚本', diff: '查看页面变化',
  name_session: '命名浏览任务', windows: '浏览器窗口', tab_groups: '标签组', history: '浏览记录', credentials: '已保存密码',
  download: '下载文件', upload: '上传文件', pdf: '保存为 PDF', request_human_help: '请求你协助', await_human_help: '等待你完成',
  browser_profiles: '浏览器配置', browser_target: '选择浏览器', save_skill: '保存浏览技能', mark_skill_run: '记录技能运行',
};
const BROWSER_PREFIX = 'mcp__browseros-neo__';
const toolLabel = (name) => {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  if (name?.startsWith(BROWSER_PREFIX)) return `浏览器 · ${BROWSER_TOOLS[name.slice(BROWSER_PREFIX.length)] || name.slice(BROWSER_PREFIX.length)}`;
  return name?.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : name || '工具';
};
const isHelpTool = (name) => name === `${BROWSER_PREFIX}request_human_help`;
// The shown file itself appears in the reply, so its tool call needs no activity row.
const isQuietTool = (name) => name === `${BROWSER_PREFIX}await_human_help` || name === 'mcp__assistant-media__show_file';

const state = {
  conversations: [],
  conv: null, // { id, title, settings, messages, leafId, run }
  loading: false,
  es: null,
  run: null, // { id, messageId }
  sending: false,
  models: [],
  prefs: { model: 'default', effort: null },
  draftSel: null, // selection for a chat that does not exist yet
  attachments: [], // { key, file, status, id, name, type, size, image, url, error }
  editing: null, // user message id being edited
  stick: true,
  query: '',
  listCursor: null,
  listLoading: false,
  renderCount: 30, // newest messages rendered; more appear as the reader scrolls up
};
const MSG_PAGE = 30;

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
};

class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: raw ? headers : (body === undefined ? headers : { 'Content-Type': 'application/json', ...headers }),
      body: raw || (body === undefined ? undefined : JSON.stringify(body)),
    });
  } catch {
    throw new ApiError('无法连接服务器，请检查网络', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new ApiError('登录已失效，请重新登录', 401, data);
  }
  if (!res.ok) throw new ApiError(data?.error || `请求失败（${res.status}）`, res.status, data);
  return data;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function iconButton(name, label, cls = 'icon-btn act') {
  const b = el('button', cls);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  b.append(icon(name));
  return b;
}

function toast(text) {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { ui.toast.hidden = true; }, 2200);
}

function announce(text) { ui.live.textContent = text; }

function setError(node, message) {
  node.textContent = message || '';
  node.hidden = !message;
}

function showBanner(text, tone = 'warn') {
  ui.banner.textContent = text;
  ui.banner.dataset.tone = tone;
  ui.banner.hidden = false;
}
function hideBanner() { ui.banner.hidden = true; }

/* ================= browser hooks ================= */

let authed = false;
const browserHooks = {
  api,
  toast,
  isAuthed: () => authed,
  currentConvId: () => state.conv?.id || null,
  confirm: (title, text, ok = '接管') => confirmDialog(title, text, ok, false),
  onHelp(help) {
    announce(`助理需要你在浏览器中操作：${help.reason}`);
    if (help.convId !== state.conv?.id) {
      const c = state.conversations.find((x) => x.id === help.convId);
      showBanner(`对话“${c?.title || '另一个对话'}”中的助理在等你在浏览器里操作：${help.reason}`, 'warn');
    }
  },
  onChange(next, prev) {
    if (!state.conv) return;
    const relevant = (next.help?.convId === state.conv.id) || (prev.help?.convId === state.conv.id) || next.mode !== prev.mode;
    if (relevant) { const m = runMessage(); if (m) scheduleMessageRender(m); else render(); }
  },
};

/* ================= theme ================= */

const THEMES = ['system', 'light', 'dark'];
const THEME_LABEL = { system: '主题：跟随系统', light: '主题：浅色', dark: '主题：深色' };
function applyTheme(t) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
  ui.themeLabel.textContent = THEME_LABEL[t];
}

/* ================= views ================= */

function showLogin() {
  closeStream();
  stopBrowserEvents();
  authed = false;
  ui.boot.hidden = true;
  ui.app.hidden = true;
  ui.loginView.hidden = false;
  ui.password.value = '';
  ui.password.focus();
}

async function showApp() {
  ui.boot.hidden = true;
  ui.loginView.hidden = true;
  ui.app.hidden = false;
  if (store.get('aw.sb') === 'collapsed' && !narrow.matches) document.body.classList.add('sb-collapsed');
  authed = true;
  startBrowserEvents(browserHooks);
  await Promise.all([loadModels(), refreshList()]);
  const id = location.hash.slice(1);
  if (id) await openConversation(id);
  else startDraft();
}

/* ================= models ================= */

async function loadModels() {
  try {
    const data = await api('/api/models');
    state.models = data.models || [];
    state.prefs = data.prefs || state.prefs;
  } catch (err) {
    if (err.status !== 401) showBanner(`无法读取模型列表：${err.message}`, 'error');
  }
  updateModelChrome();
}

const findModel = (value) => state.models.find((m) => m.value === value) || null;
const modelByResolved = (id) => state.models.find((m) => m.resolvedModel === id && !PRIMARY.has(m.value))
  || state.models.find((m) => m.resolvedModel === id) || null;

/** The selection the next reply will use. */
function currentSel() {
  const base = state.conv?.settings?.model ? state.conv.settings : (state.draftSel || state.prefs);
  const m = findModel(base.model) || findModel('default') || state.models[0] || null;
  let effort = base.effort || null;
  if (m && effort && !m.efforts.includes(effort)) effort = null;
  return { model: m?.value || null, effort, info: m };
}

function effortText(sel) {
  if (!sel.info?.efforts?.length) return '';
  return sel.effort ? EFFORT_LABEL[sel.effort] : '默认强度';
}

function updateModelChrome() {
  const sel = currentSel();
  const name = sel.info ? (sel.info.value === 'default' ? `默认 · ${sel.info.description.split('·')[0].trim()}` : sel.info.displayName) : '模型不可用';
  ui.modelBtnName.textContent = name;
  ui.modelBtnEffort.textContent = sel.effort ? EFFORT_LABEL[sel.effort] : '';
  ui.modelBtn.setAttribute('aria-label', `模型：${name}${sel.effort ? `，推理强度 ${EFFORT_LABEL[sel.effort]}` : ''}。点击更换`);
  ui.composerModel.textContent = sel.info ? `${sel.info.value === 'default' ? '默认模型' : sel.info.displayName} · ${effortText(sel) || '—'}` : '';
  if (!ui.modelPop.hidden) renderModelPop();
  updatePermChip();
}

const PERM_LABEL = { manual: '逐条确认', acceptEdits: '自动改文件', auto: '自动判断', bypassPermissions: '完全放行' };
function updatePermChip() {
  const chip = $('perm-chip');
  const mode = state.prefs?.permissionMode || 'auto';
  chip.textContent = PERM_LABEL[mode] || mode;
  chip.classList.toggle('danger', mode === 'bypassPermissions');
  chip.setAttribute('aria-label', `权限：${PERM_LABEL[mode] || mode}。点击修改`);
  chip.title = '权限模式（点击修改）';
  chip.hidden = false;
}

function renderModelPop() {
  const sel = currentSel();
  const option = (m) => {
    const b = el('button', 'model-opt');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(m.value === sel.model));
    b.dataset.model = m.value;
    const text = el('span', 'model-opt-text');
    text.append(el('span', 'model-opt-name', m.value === 'default' ? `默认（${m.description.split('·')[0].trim()}）` : m.displayName));
    text.append(el('span', 'model-opt-desc', m.value === 'default' ? '跟随 Claude Code 推荐的模型' : `${m.description}${m.value !== m.resolvedModel ? '' : ''}`));
    const check = el('span', 'model-opt-check');
    check.append(icon('check', 18));
    b.append(text, check);
    return b;
  };
  ui.modelList.replaceChildren(...state.models.filter((m) => PRIMARY.has(m.value)).map(option));
  const more = state.models.filter((m) => !PRIMARY.has(m.value));
  ui.modelListMore.replaceChildren(...more.map(option));
  ui.modelMore.hidden = !more.length;
  if (more.some((m) => m.value === sel.model)) {
    ui.modelListMore.hidden = false;
    ui.modelMore.setAttribute('aria-expanded', 'true');
  }
  if (!state.models.length) ui.modelList.replaceChildren(el('p', 'conv-empty', '还没有拿到模型列表，点“刷新列表”重试。'));

  const efforts = sel.info?.efforts || [];
  ui.effortSeg.replaceChildren();
  const opts = [['', '默认'], ...['low', 'medium', 'high', 'xhigh', 'max'].map((e) => [e, EFFORT_LABEL[e]])];
  for (const [value, label] of opts) {
    const b = el('button', '', label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.effort = value;
    b.setAttribute('aria-checked', String((sel.effort || '') === value));
    b.disabled = !efforts.length || (value && !efforts.includes(value));
    ui.effortSeg.append(b);
  }
  ui.effortHint.textContent = !efforts.length ? '此模型不支持调节' : (sel.effort ? EFFORT_HINT[sel.effort] : '由 Claude Code 决定');
  const live = isLive();
  ui.modelTiming.hidden = !live;
  ui.modelTiming.textContent = live ? '当前回复仍在进行，所做更改从下一条回复开始生效。' : '';
}

async function setSelection(model, effort) {
  const m = findModel(model);
  if (!m) return;
  if (effort && !m.efforts.includes(effort)) effort = null;
  const prev = { conv: state.conv?.settings, draft: state.draftSel, prefs: state.prefs };
  const sel = { model, effort: effort || null };
  if (state.conv) state.conv.settings = sel; else state.draftSel = sel;
  state.prefs = sel;
  updateModelChrome();
  try {
    const jobs = [api('/api/prefs', { method: 'PUT', body: sel })];
    if (state.conv) jobs.push(api(`/api/conversations/${state.conv.id}`, { method: 'PATCH', body: { settings: sel } }));
    await Promise.all(jobs);
    const name = m.value === 'default' ? '默认模型' : m.displayName;
    announce(`已选择 ${name}${sel.effort ? `，${EFFORT_LABEL[sel.effort]}强度` : ''}`);
    if (isLive()) toast(`${name}将用于下一条回复`);
  } catch (err) {
    if (state.conv) state.conv.settings = prev.conv; else state.draftSel = prev.draft;
    state.prefs = prev.prefs;
    updateModelChrome();
    if (err.status !== 401) toast(`保存失败：${err.message}`);
  }
}

/* ================= popovers ================= */

let popAnchor = null;
function openPop(pop, anchor) {
  closePops();
  popAnchor = anchor;
  pop.hidden = false;
  ui.popScrim.hidden = false;
  anchor.setAttribute('aria-expanded', 'true');
  positionPop(pop, anchor);
}
function positionPop(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  pop.style.left = `${left}px`;
  const below = r.bottom + 6;
  const h = pop.offsetHeight;
  pop.style.top = `${below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below}px`;
}
function closePops(restoreFocus = false) {
  for (const pop of [ui.modelPop, ui.menuPop]) pop.hidden = true;
  ui.popScrim.hidden = true;
  if (popAnchor) {
    popAnchor.setAttribute('aria-expanded', 'false');
    if (restoreFocus) popAnchor.focus();
  }
  popAnchor = null;
}

function openModelPop() {
  renderModelPop();
  openPop(ui.modelPop, ui.modelBtn);
  (ui.modelPop.querySelector('[aria-checked="true"]') || ui.modelPop.querySelector('.model-opt'))?.focus();
}

function openMenu(anchor, items) {
  ui.menuPop.replaceChildren();
  for (const item of items) {
    const b = el('button', `menu-item${item.danger ? ' danger' : ''}`);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.append(icon(item.icon, 18), el('span', '', item.label));
    b.addEventListener('click', () => { closePops(); item.run(); });
    ui.menuPop.append(b);
  }
  openPop(ui.menuPop, anchor);
  ui.menuPop.querySelector('.menu-item')?.focus();
}

/* ================= conversation list ================= */

const LIST_PAGE = 40;
const listQuery = (extra) => {
  const p = new URLSearchParams({ limit: String(extra.limit || LIST_PAGE) });
  if (state.query.trim()) p.set('q', state.query.trim());
  if (extra.before) p.set('before', extra.before);
  return `/api/conversations?${p}`;
};

/** Reloads the top of the history, keeping as many rows as are already loaded. */
async function refreshList() {
  const seq = (state.listSeq = (state.listSeq || 0) + 1);
  try {
    const limit = Math.min(200, Math.max(LIST_PAGE, state.conversations.length));
    const data = await api(listQuery({ limit }));
    if (seq !== state.listSeq) return;
    state.conversations = data.conversations;
    state.listCursor = data.nextCursor;
  } catch (err) {
    if (err.status !== 401) showBanner(err.message, 'error');
  }
  renderList();
}

/** Next page when the sidebar is scrolled to its end. */
async function loadMoreList() {
  if (!state.listCursor || state.listLoading) return;
  state.listLoading = true;
  const seq = state.listSeq;
  try {
    const data = await api(listQuery({ before: state.listCursor }));
    if (seq !== state.listSeq) return;
    const known = new Set(state.conversations.map((c) => c.id));
    state.conversations.push(...data.conversations.filter((c) => !known.has(c.id)));
    state.listCursor = data.nextCursor;
  } catch (err) {
    if (err.status !== 401) toast(err.message);
  } finally {
    state.listLoading = false;
  }
  renderList();
}

const listObserver = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) loadMoreList();
}, { root: document.querySelector('.conv-nav'), rootMargin: '0px 0px 200px 0px' });

function groupOf(iso) {
  const d = new Date(iso);
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const diff = (day - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff < 7) return '过去 7 天';
  if (diff < 30) return '过去 30 天';
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

function renderList() {
  const q = state.query.trim();
  const list = state.conversations;
  listObserver.disconnect();
  ui.groups.replaceChildren();
  ui.convEmpty.hidden = list.length > 0;
  ui.convEmpty.textContent = q ? '没有匹配的对话' : '还没有对话';
  let group = null;
  let ul = null;
  for (const c of list) {
    const g = groupOf(c.updatedAt);
    if (g !== group) {
      group = g;
      ui.groups.append(el('h2', 'conv-group-title', g));
      ul = el('ul', 'conv-list');
      ui.groups.append(ul);
    }
    const li = el('li', `conv-li${state.conv?.id === c.id ? ' current' : ''}`);
    const btn = el('button', 'conv-item');
    btn.type = 'button';
    btn.dataset.id = c.id;
    if (state.conv?.id === c.id) btn.setAttribute('aria-current', 'page');
    const label = el('span', 'conv-text');
    label.append(el('span', 'conv-title', c.title || '新对话'));
    if (c.snippet) label.append(el('span', 'conv-snippet', c.snippet));
    btn.append(label);
    if (c.running) {
      const dot = el('span', 'conv-running');
      dot.title = '回复中';
      btn.append(dot, el('span', 'sr-only', '回复中'));
    }
    const more = iconButton('more', `“${c.title || '新对话'}”的选项`, 'icon-btn conv-more');
    more.dataset.id = c.id;
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    li.append(btn, more);
    ul.append(li);
  }
  if (state.listCursor) {
    const moreBtn = el('button', 'list-more', state.listLoading ? '加载中…' : '加载更多对话');
    moreBtn.type = 'button';
    moreBtn.addEventListener('click', loadMoreList);
    ui.groups.append(moreBtn);
    listObserver.observe(moreBtn);
  }
}

function convMenu(anchor, id) {
  const c = state.conversations.find((x) => x.id === id) || state.conv;
  openMenu(anchor, [
    { icon: 'share', label: '分享', run: () => openShare(id) },
    { icon: 'gauge', label: '上下文与花费', run: () => openStatus(id) },
    { icon: 'file', label: '导出 Markdown', run: () => exportMarkdown(id) },
    { icon: 'pencil', label: '重命名', run: () => renameConversation(id, c?.title || '') },
    { icon: 'trash', label: '删除', danger: true, run: () => removeConversation(id, c?.title || '新对话') },
  ]);
}

function renameConversation(id, current) {
  ui.renameInput.value = current;
  ui.renameDialog.showModal();
  ui.renameInput.select();
  ui.renameDialog.onclose = async () => {
    if (ui.renameDialog.returnValue !== 'ok') return;
    const title = ui.renameInput.value.trim();
    if (!title || title === current) return;
    try {
      await api(`/api/conversations/${id}`, { method: 'PATCH', body: { title } });
      if (state.conv?.id === id) state.conv.title = title;
      await refreshList();
      updateChrome();
    } catch (err) {
      if (err.status !== 401) toast(err.message);
    }
  };
}

function confirmDialog(title, text, okText = '删除', danger = true) {
  ui.confirmTitle.textContent = title;
  ui.confirmText.textContent = text;
  ui.confirmOk.textContent = okText;
  ui.confirmOk.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  ui.confirmDialog.returnValue = '';
  ui.confirmDialog.showModal();
  return new Promise((resolve) => { ui.confirmDialog.onclose = () => resolve(ui.confirmDialog.returnValue === 'ok'); });
}

async function removeConversation(id, title) {
  const c = state.conversations.find((x) => x.id === id);
  if (c?.running) { toast('请先停止正在进行的回复'); return; }
  if (!(await confirmDialog('删除对话？', `将删除“${title}”。删除后无法恢复。`))) return;
  try {
    await api(`/api/conversations/${id}`, { method: 'DELETE' });
    if (state.conv?.id === id) startDraft();
    await refreshList();
    toast('已删除');
  } catch (err) {
    if (err.status !== 401) toast(err.message);
  }
}

/* ================= conversation & tree ================= */

const byId = () => new Map((state.conv?.messages || []).map((m) => [m.id, m]));
function pathTo(leafId) {
  const map = byId();
  const out = [];
  for (let m = map.get(leafId); m; m = map.get(m.parentId)) out.unshift(m);
  return out;
}
const childrenOf = (parentId) => (state.conv?.messages || [])
  .filter((m) => (m.parentId ?? null) === (parentId ?? null))
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
function deepestLeaf(id) {
  let cur = id;
  for (;;) {
    const kids = childrenOf(cur);
    if (!kids.length) return cur;
    cur = kids[kids.length - 1].id;
  }
}
const visiblePath = () => (state.conv ? pathTo(state.conv.leafId) : []);
const runMessage = () => (state.run ? byId().get(state.run.messageId) : null);
function isLive() {
  const m = runMessage();
  return Boolean(m && (m.status === 'running' || m.status === 'stopping'));
}

/** Mirrors the server's resumePlan(): can a new turn start under this assistant reply? */
function canBranchFrom(parentId) {
  const map = byId();
  let m = map.get(parentId);
  while (m && !(m.role === 'assistant' && m.sessionId)) m = map.get(m.parentId);
  if (!m) return true;
  return Boolean(m.tailUuid || (m.tipKey && state.conv.tips?.[m.sessionId] === m.tipKey));
}

function startDraft() {
  closeStream();
  state.conv = null;
  state.run = null;
  state.editing = null;
  state.draftSel = null;
  state.renderCount = MSG_PAGE;
  history.replaceState(null, '', location.pathname);
  render(true);
  renderList();
  updateModelChrome();
  if (!coarse.matches) ui.input.focus();
}

async function openConversation(id) {
  closeStream();
  state.loading = true;
  state.editing = null;
  state.renderCount = MSG_PAGE;
  state.conv = { id, title: '', messages: [], leafId: null, settings: null };
  render();
  try {
    const { conversation } = await api(`/api/conversations/${id}`);
    if (state.conv?.id !== id) return;
    state.conv = conversation;
    state.run = conversation.run ? { id: conversation.run.id, messageId: conversation.run.messageId } : null;
    history.replaceState(null, '', `#${id}`);
    if (conversation.run) openStream(conversation.run.id, conversation.run.seq);
  } catch (err) {
    if (err.status === 401) return;
    state.conv = null;
    history.replaceState(null, '', location.pathname);
    showBanner(err.status === 404 ? '这个对话不存在或已被删除' : err.message, 'error');
  } finally {
    state.loading = false;
    render(true);
    renderList();
    updateModelChrome();
  }
}

async function switchBranch(messageId, dir) {
  if (isLive()) { toast('回复进行中，结束后再切换分支'); return; }
  const msg = byId().get(messageId);
  const sibs = childrenOf(msg.parentId);
  const i = sibs.findIndex((s) => s.id === messageId) + dir;
  if (i < 0 || i >= sibs.length) return;
  const leafId = deepestLeaf(sibs[i].id);
  const prevLeaf = state.conv.leafId;
  state.conv.leafId = leafId;
  render();
  try {
    await api(`/api/conversations/${state.conv.id}`, { method: 'PATCH', body: { leafId } });
  } catch (err) {
    state.conv.leafId = prevLeaf;
    render();
    if (err.status !== 401) toast(err.message);
  }
}

/* ================= streaming ================= */

function closeStream() {
  if (state.es) state.es.close();
  state.es = null;
}

function openStream(runId, after) {
  closeStream();
  const convId = state.conv.id;
  const es = new EventSource(`/api/conversations/${convId}/events?run=${encodeURIComponent(runId)}&after=${after}`);
  state.es = es;
  es.onopen = () => hideBanner();
  es.onmessage = (e) => {
    if (state.es !== es || state.conv?.id !== convId) return;
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    applyEvent(ev);
  };
  es.addEventListener('gone', () => {
    if (state.es !== es) return;
    closeStream();
    reloadCurrent();
  });
  es.onerror = () => {
    if (state.es !== es) return;
    if (es.readyState === EventSource.CLOSED) {
      closeStream();
      showBanner('连接已断开，正在重新连接…', 'warn');
      setTimeout(reloadCurrent, 1500);
    } else {
      showBanner('连接中断，正在重新连接…', 'warn');
    }
  };
}

async function reloadCurrent() {
  if (!state.conv) return;
  try {
    const { conversation } = await api(`/api/conversations/${state.conv.id}`);
    if (state.conv?.id !== conversation.id) return;
    state.conv = conversation;
    state.run = conversation.run ? { id: conversation.run.id, messageId: conversation.run.messageId } : state.run;
    hideBanner();
    if (conversation.run) openStream(conversation.run.id, conversation.run.seq);
  } catch (err) {
    if (err.status === 0) {
      showBanner('无法连接服务器，稍后自动重试…', 'warn');
      setTimeout(reloadCurrent, 4000);
      return;
    }
    if (err.status !== 401) showBanner(err.message, 'error');
  }
  render();
  refreshList();
}

function applyEvent(ev) {
  const msg = runMessage();
  if (!msg) return;
  if (ev.type === 'part') {
    msg.parts[ev.index] = ev.part;
    if (ev.part.type === 'approval' && ev.part.state === 'pending') {
      announce('有操作需要你的授权');
      notify(`有操作需要你的授权：${ev.part.summary || ev.part.tool || ''}`);
    }
  } else if (ev.type === 'text') {
    if (!msg.parts[ev.index]) msg.parts[ev.index] = { type: 'text', text: '' };
    msg.parts[ev.index].text += ev.delta;
  } else if (ev.type === 'meta') {
    if (ev.modelUsed) msg.modelUsed = ev.modelUsed;
    if (ev.usage) msg.usage = ev.usage;
  } else if (ev.type === 'status') {
    msg.status = ev.status;
    if (ev.error) msg.error = ev.error;
    const title = state.conv?.title || '对话';
    if (ev.status === 'done') { announce('回复完成'); notify(`“${title}”回复完成`); }
    else if (ev.status === 'error') { announce('回复出错'); notify(`“${title}”回复出错`); }
    else if (ev.status === 'stopped') announce('已停止');
  } else if (ev.type === 'end') {
    closeStream();
    // Pick up session/branch metadata written at the end of the run.
    reloadCurrent();
    return;
  }
  scheduleMessageRender(msg);
}

/* ================= rendering ================= */

let rafPending = null;
function scheduleMessageRender(msg) {
  if (rafPending) return;
  rafPending = requestAnimationFrame(() => {
    rafPending = null;
    const node = ui.messages.querySelector(`[data-id="${msg.id}"]`);
    if (node) fillMessage(node, msg);
    else renderMessages();
    updateChrome();
    if (state.stick) scrollToBottom();
    else ui.jump.hidden = false;
  });
}

function distanceFromBottom() {
  const s = ui.scroller;
  return s.scrollHeight - s.scrollTop - s.clientHeight;
}
function scrollToBottom(smooth = false) {
  ui.scroller.scrollTo({ top: ui.scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  state.stick = true;
  ui.jump.hidden = true;
}

function render(toBottom = false) {
  const keep = !toBottom && !state.stick ? ui.scroller.scrollTop : null;
  renderMessages();
  updateChrome();
  if (toBottom || state.stick) scrollToBottom();
  else if (keep !== null) ui.scroller.scrollTop = keep;
}

function updateChrome() {
  const conv = state.conv;
  ui.title.textContent = conv?.title || (conv && state.loading ? '加载中…' : '新对话');
  document.title = conv?.title ? `${conv.title} · MambaBot` : 'MambaBot';
  const live = isLive();
  ui.send.hidden = live;
  ui.stop.hidden = !live;
  const stopping = runMessage()?.status === 'stopping';
  ui.stop.disabled = stopping;
  ui.stop.setAttribute('aria-label', stopping ? '正在停止' : '停止生成');
  const uploading = state.attachments.some((a) => a.status === 'uploading');
  const hasContent = ui.input.value.trim() || state.attachments.some((a) => a.status === 'ready');
  ui.send.disabled = state.sending || state.loading || uploading || !hasContent
    || state.attachments.some((a) => a.status === 'error') || !state.models.length;
  ui.send.title = uploading ? '附件上传中…' : '发送';
  ui.convMenuBtn.hidden = !conv || state.loading;
}

function pickFiles() {
  if (state.attachments.length >= 8) { toast('一次最多 8 个附件'); return; }
  ui.fileInput.click();
}

function setComposer(text) {
  ui.input.value = text;
  autosize();
  ui.input.focus();
  ui.input.setSelectionRange(text.length, text.length);
  ui.input.dispatchEvent(new Event('input'));
}

function renderMessages() {
  const box = ui.messages;
  const focusKey = document.activeElement?.dataset?.focusKey;
  box.replaceChildren();
  if (state.loading) {
    box.append(emptyState('加载对话中…', ''));
    return;
  }
  const path = visiblePath();
  if (!state.conv || path.length === 0) {
    box.append(emptyState('有什么可以帮忙的？', '可以发送文字、图片或文件。需要授权的操作，会在对话里请你确认。'));
    return;
  }
  // Long chats: only the newest messages are built; older ones on demand (scroll up / button).
  // The message being edited always stays in the window.
  const editIdx = state.editing ? path.findIndex((m) => m.id === state.editing) : -1;
  let start = Math.max(0, path.length - state.renderCount);
  if (editIdx >= 0 && editIdx < start) start = editIdx;
  earlierObserver.disconnect();
  if (start > 0) {
    const more = el('button', 'load-earlier', `显示更早的消息（还有 ${start} 条）`);
    more.type = 'button';
    more.addEventListener('click', loadEarlier);
    box.append(more);
    earlierObserver.observe(more);
  }
  for (const msg of path.slice(start)) {
    const node = el('article', `msg msg-${msg.role}`);
    node.dataset.id = msg.id;
    fillMessage(node, msg);
    box.append(node);
  }
  if (focusKey) box.querySelector(`[data-focus-key="${focusKey}"]`)?.focus();
}

/** Renders one more page above, keeping what the reader is looking at in place. */
function loadEarlier() {
  if (state.loadingEarlier) return;
  state.loadingEarlier = true;
  const s = ui.scroller;
  const fromBottom = s.scrollHeight - s.scrollTop;
  state.renderCount += MSG_PAGE;
  renderMessages();
  s.scrollTop = s.scrollHeight - fromBottom;
  requestAnimationFrame(() => { state.loadingEarlier = false; });
}

// Fires when the "earlier" button nears the top of the viewport, but not on the initial
// render (which scrolls to the bottom), so opening a chat never cascades through history.
const earlierObserver = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && !state.stick) loadEarlier();
}, { root: ui.scroller, rootMargin: '300px 0px 0px 0px' });

function emptyState(title, hint) {
  const wrap = el('div', 'empty');
  wrap.append(el('p', 'empty-title', title));
  if (hint) wrap.append(el('p', 'empty-hint', hint));
  return wrap;
}

function fillMessage(node, msg) {
  const focusKey = node.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
  node.replaceChildren();
  node.append(el('h2', 'sr-only', msg.role === 'user' ? '你说' : '助理回复'));
  if (msg.role === 'user') fillUser(node, msg);
  else fillAssistant(node, msg);
  if (focusKey) node.querySelector(`[data-focus-key="${focusKey}"]`)?.focus();
}

const textOf = (msg) => msg.parts.filter((p) => p.type === 'text').map((p) => p.text || '').join('\n\n');

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentView(a) {
  if (a.image) {
    const link = el('a');
    link.href = `/api/uploads/${a.id}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.dataset.view = a.name;
    const img = el('img');
    img.src = `/api/uploads/${a.id}`;
    img.alt = a.name;
    img.loading = 'lazy';
    link.append(img);
    return link;
  }
  const chip = el('a', 'file-chip');
  chip.href = `/api/uploads/${a.id}`;
  chip.append(icon('file', 18), el('span', 'file-chip-name', a.name), el('span', 'file-chip-size', formatSize(a.size)));
  return chip;
}

/** A file Claude showed with assistant-media show_file. */
function shownFile(part) {
  const fig = el('figure', `shown-file${part.attachment?.image ? ' image' : ''}`);
  fig.append(attachmentView(part.attachment));
  if (part.caption) fig.append(el('figcaption', '', part.caption));
  return fig;
}

function openViewer(src, name) {
  const dlg = $('image-viewer');
  $('viewer-img').src = src;
  $('viewer-img').alt = name || '';
  $('viewer-name').textContent = name || '';
  $('viewer-open').href = src;
  if (!dlg.open) dlg.showModal();
}

function branchNav(msg) {
  const sibs = childrenOf(msg.parentId);
  if (sibs.length < 2) return null;
  const i = sibs.findIndex((s) => s.id === msg.id);
  const nav = el('span', 'branch-nav');
  const prev = iconButton('chevron-left', '上一个版本');
  prev.dataset.action = 'branch';
  prev.dataset.dir = '-1';
  prev.dataset.id = msg.id;
  prev.dataset.focusKey = `${msg.id}-prev`;
  prev.disabled = i === 0;
  const next = iconButton('chevron-right', '下一个版本');
  next.dataset.action = 'branch';
  next.dataset.dir = '1';
  next.dataset.id = msg.id;
  next.dataset.focusKey = `${msg.id}-next`;
  next.disabled = i === sibs.length - 1;
  const label = el('span', '', `${i + 1} / ${sibs.length}`);
  label.setAttribute('aria-label', `第 ${i + 1} 个版本，共 ${sibs.length} 个`);
  nav.append(prev, label, next);
  return nav;
}

function fillUser(node, msg) {
  if (msg.attachments?.length) {
    const box = el('div', 'user-attach');
    for (const a of msg.attachments) box.append(attachmentView(a));
    node.append(box);
  }
  if (state.editing === msg.id) {
    node.append(editBox(msg));
    return;
  }
  const text = textOf(msg);
  if (text) node.append(el('div', 'bubble', text));
  const actions = el('div', 'msg-actions');
  const copy = iconButton('copy', '复制');
  copy.dataset.action = 'copy-msg';
  copy.dataset.id = msg.id;
  actions.append(copy);
  if (!isLive() && canBranchFrom(msg.parentId)) {
    const edit = iconButton('edit', '编辑消息');
    edit.dataset.action = 'edit';
    edit.dataset.id = msg.id;
    edit.dataset.focusKey = `${msg.id}-edit`;
    actions.append(edit);
  }
  const nav = branchNav(msg);
  if (nav) actions.append(nav);
  node.append(actions);
}

function editBox(msg) {
  const box = el('div', 'edit-box');
  const ta = el('textarea');
  ta.value = textOf(msg);
  ta.setAttribute('aria-label', '编辑消息');
  ta.dataset.focusKey = `${msg.id}-editing`;
  const resize = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.5)}px`; };
  ta.addEventListener('input', resize);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { state.editing = null; render(); }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !coarse.matches) {
      e.preventDefault();
      submitEdit(msg, ta.value);
    }
  });
  const actions = el('div', 'edit-actions');
  actions.append(el('span', 'edit-note', '发送后会生成新的分支，原消息仍可切换查看'));
  const cancel = el('button', 'btn btn-ghost btn-sm', '取消');
  cancel.type = 'button';
  cancel.addEventListener('click', () => { state.editing = null; render(); });
  const ok = el('button', 'btn btn-primary btn-sm', '发送');
  ok.type = 'button';
  ok.addEventListener('click', () => submitEdit(msg, ta.value));
  actions.append(cancel, ok);
  box.append(ta, actions);
  requestAnimationFrame(() => { resize(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
  return box;
}

function modelBadge(msg) {
  const used = msg.modelUsed;
  const want = msg.requested?.model ? findModel(msg.requested.model) : null;
  const usedInfo = used ? modelByResolved(used) : null;
  const name = usedInfo?.displayName || used || (want ? (want.value === 'default' ? '默认模型' : want.displayName) : '');
  if (!name) return null;
  const effort = msg.requested?.effort ? ` · ${EFFORT_LABEL[msg.requested.effort]}` : '';
  const mismatch = used && want && want.resolvedModel !== used;
  const b = el('span', `model-badge${mismatch ? ' mismatch' : ''}`, `${name}${effort}${mismatch ? '（与所选不同）' : ''}`);
  b.title = used ? `运行时报告的模型：${used}` : '等待运行时确认模型';
  return b;
}

const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n ?? '—'));

function compactNote(part) {
  const p = el('p', `compact-note ${part.state}`);
  p.append(icon('collapse', 16));
  let text = '正在压缩上下文…';
  if (part.state === 'failed') text = '压缩上下文失败，上下文保持不变';
  else if (part.state === 'done') {
    const label = part.trigger === 'auto' ? '上下文接近上限，已自动压缩' : '上下文已压缩';
    text = part.preTokens !== null && part.postTokens !== null ? `${label}：${fmtTokens(part.preTokens)} → ${fmtTokens(part.postTokens)} tokens` : label;
  }
  p.append(el('span', '', text));
  return p;
}

/** Sends a CLI slash command as the next message on the current branch. */
function sendCommand(text) {
  if (!state.conv?.id) { toast('当前对话还没有内容'); return; }
  if (isLive() || state.sending) { toast('请等这条回复结束'); return; }
  ui.input.value = text;
  autosize();
  send();
}

function fillAssistant(node, msg) {
  const body = el('div', 'msg-body');
  let tools = [];
  const flushTools = (running) => {
    if (!tools.length) return;
    body.append(activityBlock(tools, running));
    tools = [];
  };
  const live = msg.status === 'running' || msg.status === 'stopping';
  msg.parts.forEach((part, i) => {
    if (part.type === 'tool' && isQuietTool(part.name)) return;
    if (part.type === 'tool' && isHelpTool(part.name)) {
      flushTools(false);
      body.append(handoffCard(part, msg));
      return;
    }
    if (part.type === 'tool') { tools.push(part); return; }
    flushTools(live && i === msg.parts.length);
    if (part.type === 'text') {
      const div = el('div', 'md');
      div.append(renderMarkdown(part.text));
      body.append(div);
    } else if (part.type === 'approval') {
      body.append(renderApproval(part, msg));
    } else if (part.type === 'notice') {
      body.append(el('p', 'notice', part.text));
    } else if (part.type === 'compact') {
      body.append(compactNote(part));
    } else if (part.type === 'file' && part.attachment) {
      body.append(shownFile(part));
    }
  });
  flushTools(live);
  node.append(body);

  const status = renderStatus(msg);
  if (status) node.append(status);
  if (live) return;
  const actions = el('div', 'msg-actions');
  const copy = iconButton('copy', '复制回复');
  copy.dataset.action = 'copy-msg';
  copy.dataset.id = msg.id;
  actions.append(copy);
  const parent = byId().get(msg.parentId);
  if (parent && canBranchFrom(parent.parentId) && !isLive()) {
    const regen = iconButton('refresh', '重新生成');
    regen.dataset.action = 'regenerate';
    regen.dataset.id = msg.id;
    regen.dataset.focusKey = `${msg.id}-regen`;
    actions.append(regen);
  }
  const nav = branchNav(msg);
  if (nav) actions.append(nav);
  const badge = modelBadge(msg);
  if (badge) actions.append(badge);
  node.append(actions);
}

function handoffCard(part, msg) {
  const snap = browserSnapshot();
  const live = msg.status === 'running' || msg.status === 'stopping';
  const pending = live && snap.help?.convId === state.conv?.id;
  const box = el('div', `handoff${pending ? ' pending' : ''}`);
  box.setAttribute('role', 'group');
  const head = el('p', 'handoff-head');
  const kind = /登录|扫码|login/i.test(part.summary || '') ? 'login' : (snap.help?.kind || 'other');
  head.append(icon('hand', 18), el('span', '', pending ? `需要你在浏览器中${helpKindLabel(snap.help.kind)}` : `助理请求过你的协助（${helpKindLabel(kind)}）`));
  box.append(head);
  box.append(el('p', 'handoff-reason', (pending ? snap.help.reason : part.summary) || '需要你在浏览器中操作'));
  if (pending && snap.help.details) box.append(el('p', 'handoff-sub', snap.help.details));
  if (pending) {
    box.append(el('p', 'handoff-sub', snap.mode === 'human'
      ? '你正在操作。完成后在浏览器面板点“交还给助理”。'
      : '助理已暂停。打开浏览器面板，点“开始操作”，即可扫码、输入或点击。'));
    const b = el('button', 'btn btn-primary btn-sm', snap.mode === 'human' ? '回到浏览器' : '打开浏览器');
    b.type = 'button';
    b.dataset.action = 'open-browser';
    b.dataset.focusKey = `${part.id}-open`;
    box.append(b);
  } else {
    box.append(el('p', 'handoff-state', live ? '已交还，助理正在核实并继续。' : (part.state === 'error' ? '这次协助请求没有完成。' : '已处理。')));
  }
  return box;
}

function activityBlock(tools, running) {
  const det = el('details', `activity${running ? ' running' : ''}`);
  const sum = el('summary');
  const last = tools[tools.length - 1];
  const active = tools.filter((t) => t.state === 'running');
  const failed = tools.filter((t) => t.state === 'error').length;
  let text;
  if (active.length) text = `${toolLabel(active[active.length - 1].name)}${active[active.length - 1].summary ? `：${active[active.length - 1].summary}` : ''}`;
  else text = `已完成 ${tools.length} 个操作${failed ? `（${failed} 个失败）` : ''}`;
  if (!active.length && tools.length === 1) text = `${toolLabel(last.name)}${last.summary ? `：${last.summary}` : ''}${failed ? '（失败）' : ''}`;
  sum.append(icon('tool', 16), el('span', 'activity-text', text));
  const chev = icon('chevron-down', 16);
  chev.classList.add('chev');
  sum.append(chev);
  det.append(sum);
  const ul = el('ul', 'tool-list');
  for (const t of tools) {
    const li = el('li', `tool-li tool-${t.state}`);
    const row = el('div', 'tool-row');
    row.append(el('span', 'tool-label', toolLabel(t.name)));
    row.append(el('span', 'tool-summary', t.summary || ''));
    row.append(el('span', 'tool-state', { running: '进行中', done: '完成', error: '失败' }[t.state] || ''));
    li.append(row);
    if (t.detail) li.append(el('pre', 'tool-detail', t.detail));
    ul.append(li);
  }
  det.append(ul);
  det.dataset.key = tools[0].id;
  if (openActivities.has(tools[0].id)) det.open = true;
  det.addEventListener('toggle', () => {
    if (det.open) openActivities.add(tools[0].id); else openActivities.delete(tools[0].id);
  });
  return det;
}
const openActivities = new Set();

function renderApproval(part, msg) {
  const box = el('div', `approval approval-${part.state}`);
  box.setAttribute('role', 'group');
  const titleId = `ap-${part.id}`;
  box.setAttribute('aria-labelledby', titleId);
  const head = el('p', 'approval-head');
  head.id = titleId;
  head.append(icon('shield', 18), el('span', '', part.state === 'pending' ? `需要你的授权：${toolLabel(part.tool)}` : `授权请求：${toolLabel(part.tool)}`));
  box.append(head);
  if (part.summary) box.append(el('p', 'approval-summary', part.summary));
  box.append(el('pre', 'approval-detail', part.detail || ''));
  if (part.state === 'pending' && msg.status === 'running') {
    const actions = el('div', 'approval-actions');
    const choices = [['allow', '允许', 'btn-primary']];
    if (part.canAllowForRun) choices.push(['allow_run', '本次回复内都允许', 'btn-ghost']);
    choices.push(['deny', '拒绝', 'btn-ghost']);
    for (const [decision, text, cls] of choices) {
      const b = el('button', `btn ${cls} btn-sm`, text);
      b.type = 'button';
      b.dataset.action = 'approve';
      b.dataset.decision = decision;
      b.dataset.approval = part.id;
      b.dataset.focusKey = `${part.id}-${decision}`;
      actions.append(b);
    }
    box.append(actions);
  } else {
    box.append(el('p', 'approval-state', { allowed: '已允许', allowed_run: '已允许（本次回复内不再询问同类操作）', denied: '已拒绝', expired: '已失效，未执行', pending: '已失效，未执行' }[part.state] || ''));
  }
  return box;
}

function renderStatus(msg) {
  const p = el('div', `msg-status status-${msg.status}`);
  const waiting = msg.parts.some((x) => x.type === 'approval' && x.state === 'pending');
  switch (msg.status) {
    case 'running':
      if (waiting) { p.textContent = '等待你的授权…'; break; }
      if (browserSnapshot().help?.convId === state.conv?.id) { p.textContent = '等待你在浏览器中操作…'; break; }
      if (msg.parts.length) return null;
      p.append(thinkingDots(), el('span', 'sr-only', '正在思考'));
      break;
    case 'stopping': p.textContent = '正在停止…'; break;
    case 'stopped': p.textContent = '已停止生成'; break;
    case 'error': {
      p.setAttribute('role', 'alert');
      p.append(el('span', '', `出错了：${msg.error || '未知错误'}`));
      const parent = byId().get(msg.parentId);
      if (parent && canBranchFrom(parent.parentId) && !isLive()) {
        const retry = el('button', 'btn btn-ghost btn-sm', '重试');
        retry.type = 'button';
        retry.dataset.action = 'regenerate';
        retry.dataset.id = msg.id;
        p.append(retry);
      }
      break;
    }
    case 'interrupted': p.textContent = msg.error || '这条回复已中断'; break;
    default: return null;
  }
  return p;
}

function thinkingDots() {
  const d = el('span', 'thinking');
  d.append(el('i'), el('i'), el('i'));
  return d;
}

/* ================= actions ================= */

function selBody() {
  const sel = currentSel();
  return { model: sel.model, effort: sel.effort || undefined };
}

async function ensureConversation() {
  if (state.conv) return state.conv.id;
  const sel = currentSel();
  const { conversation } = await api('/api/conversations', { method: 'POST', body: { model: sel.model, effort: sel.effort || undefined } });
  state.conv = { ...conversation, messages: [], leafId: null, run: null };
  history.replaceState(null, '', `#${conversation.id}`);
  return conversation.id;
}

function afterStart(res) {
  state.conv.leafId = res.leafId;
  state.run = { id: res.run.id, messageId: res.run.messageId };
  state.conv.settings = { model: res.assistantMessage.requested.model, effort: res.assistantMessage.requested.effort || null };
  render(true);
  openStream(res.run.id, res.run.seq);
  refreshList();
}

async function send() {
  const text = ui.input.value.trim();
  const ready = state.attachments.filter((a) => a.status === 'ready');
  if ((!text && !ready.length) || state.sending || isLive()) return;
  if (state.attachments.some((a) => a.status === 'uploading')) { setError(ui.composerError, '附件还在上传，请稍候'); return; }
  setError(ui.composerError, '');
  state.sending = true;
  updateChrome();
  try {
    const convId = await ensureConversation();
    const path = visiblePath();
    const parentId = path.length ? path[path.length - 1].id : null;
    const res = await api(`/api/conversations/${convId}/messages`, {
      method: 'POST', body: { text, parentId, attachments: ready.map((a) => a.id), ...selBody() },
    });
    if (state.conv?.id !== convId) return;
    ui.input.value = '';
    clearAttachments();
    autosize();
    state.conv.messages.push(res.userMessage, res.assistantMessage);
    if (!state.conv.title) state.conv.title = (text || ready[0]?.name || '').slice(0, 40);
    afterStart(res);
  } catch (err) {
    if (err.status !== 401) setError(ui.composerError, err.message);
  } finally {
    state.sending = false;
    updateChrome();
  }
}

async function submitEdit(msg, value) {
  const text = value.trim();
  if (!text && !msg.attachments?.length) return;
  if (isLive()) return;
  try {
    const res = await api(`/api/conversations/${state.conv.id}/messages`, {
      method: 'POST', body: { text, parentId: msg.parentId, attachments: (msg.attachments || []).map((a) => a.id), ...selBody() },
    });
    state.editing = null;
    state.conv.messages.push(res.userMessage, res.assistantMessage);
    afterStart(res);
  } catch (err) {
    if (err.status !== 401) toast(err.message);
  }
}

async function regenerate(assistantId) {
  if (isLive()) return;
  const msg = byId().get(assistantId);
  try {
    const res = await api(`/api/conversations/${state.conv.id}/regenerate`, {
      method: 'POST', body: { userMessageId: msg.parentId, ...selBody() },
    });
    state.conv.messages.push(res.assistantMessage);
    afterStart(res);
  } catch (err) {
    if (err.status !== 401) toast(err.message);
  }
}

async function stop() {
  if (!state.conv) return;
  ui.stop.disabled = true;
  try {
    await api(`/api/conversations/${state.conv.id}/stop`, { method: 'POST', body: {} });
  } catch (err) {
    if (err.status === 409) reloadCurrent();
    else if (err.status !== 401) setError(ui.composerError, err.message);
  }
}

async function decide(button) {
  const { approval, decision } = button.dataset;
  const group = button.closest('.approval-actions');
  group?.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    await api(`/api/conversations/${state.conv.id}/approvals/${approval}`, { method: 'POST', body: { decision } });
  } catch (err) {
    if (err.status === 401) return;
    showBanner(err.message, 'error');
    reloadCurrent();
  }
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      button.replaceChildren(icon('check', 18));
      setTimeout(() => button.replaceChildren(icon('copy', 18)), 1500);
    }
    announce('已复制');
  } catch {
    toast('复制失败，请手动选择文本');
  }
}

async function copyCode(button) {
  const code = button.closest('.code-block')?.querySelector('code')?.textContent || '';
  try {
    await navigator.clipboard.writeText(code);
    button.textContent = '已复制';
  } catch {
    button.textContent = '复制失败';
  }
  setTimeout(() => { button.textContent = '复制'; }, 1500);
}

/* ================= attachments ================= */

let attKey = 0;
function addFiles(files) {
  for (const file of files) {
    if (state.attachments.length >= 8) { toast('一次最多 8 个附件'); break; }
    if (file.size > 20 * 1024 * 1024) { toast(`${file.name || '文件'} 超过 20 MB`); continue; }
    const a = {
      key: ++attKey, file, status: 'uploading', name: file.name || `粘贴的图片.${(file.type.split('/')[1] || 'png')}`,
      type: file.type, size: file.size, image: /^image\/(png|jpeg|gif|webp)$/.test(file.type),
    };
    if (a.image) a.url = URL.createObjectURL(file);
    state.attachments.push(a);
    upload(a);
  }
  renderAttachments();
}

async function upload(a) {
  try {
    const { attachment } = await api('/api/uploads', {
      method: 'POST', raw: a.file, headers: { 'Content-Type': a.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(a.name) },
    });
    if (!state.attachments.includes(a)) return;
    Object.assign(a, { status: 'ready', id: attachment.id, image: attachment.image });
  } catch (err) {
    if (!state.attachments.includes(a)) return;
    a.status = 'error';
    a.error = err.status === 413 ? '文件过大' : err.message;
  }
  renderAttachments();
}

function removeAttachment(key) {
  const i = state.attachments.findIndex((a) => a.key === key);
  if (i < 0) return;
  const [a] = state.attachments.splice(i, 1);
  if (a.url) URL.revokeObjectURL(a.url);
  renderAttachments();
  ui.input.focus();
}

function clearAttachments() {
  for (const a of state.attachments) if (a.url) URL.revokeObjectURL(a.url);
  state.attachments = [];
  renderAttachments();
}

function renderAttachments() {
  ui.attachList.replaceChildren();
  ui.attachList.hidden = !state.attachments.length;
  for (const a of state.attachments) {
    const item = el('div', `att${a.image && a.url ? ' image' : ''}${a.status === 'error' ? ' error' : ''}`);
    item.title = a.error ? `${a.name}：${a.error}` : a.name;
    if (a.image && a.url) {
      const img = el('img');
      img.src = a.url;
      img.alt = a.name;
      item.append(img);
    } else {
      const ic = el('span', 'att-icon');
      ic.append(icon('file', 18));
      const meta = el('span', 'att-meta');
      meta.append(el('span', 'att-name', a.name));
      meta.append(el('span', 'att-sub', a.status === 'error' ? a.error : (a.status === 'uploading' ? '上传中…' : formatSize(a.size))));
      item.append(ic, meta);
    }
    if (a.status === 'uploading' && a.image) item.append(el('span', 'att-progress', '上传中'));
    if (a.status === 'error' && a.image) item.append(el('span', 'att-progress', '失败'));
    const x = iconButton('x', `移除 ${a.name}`, 'att-x');
    x.addEventListener('click', () => removeAttachment(a.key));
    item.append(x);
    ui.attachList.append(item);
  }
  updateChrome();
}

/* ================= layout ================= */

const narrow = window.matchMedia('(max-width: 767px)');
const coarse = window.matchMedia('(pointer: coarse)');

function setDrawer(open) {
  document.body.classList.toggle('drawer-open', open);
  ui.scrim.hidden = !open;
  ui.menu.setAttribute('aria-expanded', String(open));
  if (open) ui.newChat.focus();
}

function toggleSidebar() {
  if (narrow.matches) { setDrawer(!document.body.classList.contains('drawer-open')); return; }
  const collapsed = document.body.classList.toggle('sb-collapsed');
  store.set('aw.sb', collapsed ? 'collapsed' : 'open');
  ui.menu.setAttribute('aria-expanded', String(!collapsed));
  (collapsed ? ui.menu : ui.sbCollapse).focus();
}

function autosize() {
  ui.input.style.height = 'auto';
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, window.innerHeight * 0.4)}px`;
  updateChrome();
}

function newChat() {
  startDraft();
  if (narrow.matches) setDrawer(false);
}

/* ================= wiring ================= */

hydrateIcons();
applyTheme(store.get('aw.theme') || 'system');

ui.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = ui.password.value;
  if (!password) { setError(ui.loginError, '请输入登录密钥'); return; }
  setError(ui.loginError, '');
  ui.loginSubmit.disabled = true;
  ui.loginSubmit.textContent = '登录中…';
  try {
    await api('/api/login', { method: 'POST', body: { password } });
    await showApp();
  } catch (err) {
    const wait = err.data?.retryAfterSec;
    setError(ui.loginError, err.status === 429 && wait ? `尝试次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试` : err.message);
    ui.password.select();
  } finally {
    ui.loginSubmit.disabled = false;
    ui.loginSubmit.textContent = '登录';
  }
});

ui.composer.addEventListener('submit', (e) => { e.preventDefault(); send(); });
ui.composer.addEventListener('click', (e) => { if (e.target === ui.composer) ui.input.focus(); });
ui.input.addEventListener('input', autosize);
ui.input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229 || coarse.matches) return;
  e.preventDefault();
  if (!ui.send.disabled && !isLive()) send();
});
ui.input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});
ui.composer.addEventListener('dragover', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  ui.composer.classList.add('dragover');
});
ui.composer.addEventListener('dragleave', () => ui.composer.classList.remove('dragover'));
ui.composer.addEventListener('drop', (e) => {
  ui.composer.classList.remove('dragover');
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  addFiles([...e.dataTransfer.files]);
});
ui.attachBtn.addEventListener('click', () => openPlusMenu(ui.attachBtn));
$('open-tasks').addEventListener('click', () => { if (narrow.matches) setDrawer(false); openTasks(); });
$('open-settings').addEventListener('click', () => { if (narrow.matches) setDrawer(false); openSettings(); });
$('perm-chip').addEventListener('click', () => openSettings());
initResizers();
initExtras({
  api, toast, openMenu, newChat, openModelPop, openBrowser, pickFiles, setComposer, sendCommand,
  input: () => ui.input,
  currentConv: () => (state.conv?.id ? { id: state.conv.id, live: isLive() } : null),
  models: () => state.models,
  prefs: () => state.prefs || { model: 'default', effort: null },
  setPrefs: (p) => { state.prefs = { ...state.prefs, ...p }; updateModelChrome(); },
  confirm: (title, text) => confirmDialog(title, text, '删除', true),
  openConversation: (id) => { if (narrow.matches) setDrawer(false); openConversation(id); },
  renameCurrent: () => (state.conv?.id ? renameConversation(state.conv.id, state.conv.title || '') : toast('当前还没有对话')),
});
ui.fileInput.addEventListener('change', () => {
  addFiles([...ui.fileInput.files]);
  ui.fileInput.value = '';
});
ui.stop.addEventListener('click', stop);
for (const b of [ui.newChat, ui.sbNew, ui.topNew]) b.addEventListener('click', newChat);
ui.sbCollapse.addEventListener('click', toggleSidebar);
ui.menu.addEventListener('click', toggleSidebar);
ui.scrim.addEventListener('click', () => setDrawer(false));
let searchTimer = null;
ui.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = ui.search.value;
    state.conversations = [];
    state.listCursor = null;
    refreshList();
  }, 250);
});
ui.theme.addEventListener('click', () => {
  const cur = store.get('aw.theme') || 'system';
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  store.set('aw.theme', next);
  applyTheme(next);
});
ui.logout.addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: {} }); } catch { /* already logged out */ }
  showLogin();
});
ui.groups.addEventListener('click', (e) => {
  const more = e.target.closest('.conv-more');
  if (more) { convMenu(more, more.dataset.id); return; }
  const btn = e.target.closest('.conv-item');
  if (!btn) return;
  if (narrow.matches) setDrawer(false);
  if (btn.dataset.id !== state.conv?.id) openConversation(btn.dataset.id);
});
ui.convMenuBtn.addEventListener('click', () => state.conv && convMenu(ui.convMenuBtn, state.conv.id));
ui.messages.addEventListener('click', (e) => {
  const view = e.target.closest('a[data-view]');
  if (view && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    e.preventDefault();
    openViewer(view.href, view.dataset.view);
    return;
  }
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === 'approve') decide(btn);
  else if (action === 'copy-code') copyCode(btn);
  else if (action === 'copy-msg') copyText(textOf(byId().get(id)), btn);
  else if (action === 'edit') { state.editing = id; render(); }
  else if (action === 'regenerate') regenerate(id);
  else if (action === 'branch') switchBranch(id, Number(btn.dataset.dir));
  else if (action === 'open-browser') openBrowser();
});
ui.scroller.addEventListener('scroll', () => {
  const d = distanceFromBottom();
  state.stick = d < 80;
  if (state.stick) ui.jump.hidden = true;
  else if (d > 400) ui.jump.hidden = false;
}, { passive: true });
ui.jump.addEventListener('click', () => scrollToBottom(true));

ui.modelBtn.addEventListener('click', () => (ui.modelPop.hidden ? openModelPop() : closePops()));
ui.modelPop.addEventListener('click', (e) => {
  const opt = e.target.closest('.model-opt');
  if (opt) {
    const sel = currentSel();
    setSelection(opt.dataset.model, sel.effort);
    renderModelPop();
    ui.modelPop.querySelector(`[data-model="${CSS.escape(opt.dataset.model)}"]`)?.focus();
    return;
  }
  const eff = e.target.closest('#effort-seg button');
  if (eff && !eff.disabled) {
    setSelection(currentSel().model, eff.dataset.effort || null);
    renderModelPop();
    ui.effortSeg.querySelector(`[data-effort="${eff.dataset.effort}"]`)?.focus();
  }
});
ui.modelPop.addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const group = e.target.closest('[role="radiogroup"]');
  if (!group) return;
  const items = [...group.querySelectorAll('button:not(:disabled)')];
  const i = items.indexOf(e.target);
  if (i < 0) return;
  e.preventDefault();
  const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
  items[(i + step + items.length) % items.length].focus();
});
ui.modelMore.addEventListener('click', () => {
  const open = ui.modelListMore.hidden;
  ui.modelListMore.hidden = !open;
  ui.modelMore.setAttribute('aria-expanded', String(open));
  if (!narrow.matches) positionPop(ui.modelPop, ui.modelBtn);
});
ui.modelRefresh.addEventListener('click', async () => {
  ui.modelRefresh.disabled = true;
  ui.modelRefresh.textContent = '刷新中…';
  try {
    const data = await api('/api/models/refresh', { method: 'POST', body: {} });
    state.models = data.models;
    updateModelChrome();
    toast('模型列表已更新');
  } catch (err) {
    if (err.status !== 401) toast(err.message);
  } finally {
    ui.modelRefresh.disabled = false;
    ui.modelRefresh.textContent = '刷新列表';
  }
});
ui.popScrim.addEventListener('click', () => closePops());
ui.renameCancel.addEventListener('click', () => ui.renameDialog.close('cancel'));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!ui.modelPop.hidden || !ui.menuPop.hidden) { closePops(true); return; }
    if (document.body.classList.contains('drawer-open')) { setDrawer(false); ui.menu.focus(); }
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); newChat(); }
});
narrow.addEventListener('change', () => { setDrawer(false); closePops(); });
window.addEventListener('resize', () => { if (popAnchor && !narrow.matches) positionPop(ui.modelPop.hidden ? ui.menuPop : ui.modelPop, popAnchor); });
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && id !== state.conv?.id) openConversation(id);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !ui.app.hidden) {
    refreshList();
    if (state.conv && isLive() && !state.es) reloadCurrent();
  }
});

(async function boot() {
  try {
    const { authenticated } = await api('/api/session');
    if (authenticated) await showApp();
    else showLogin();
  } catch (err) {
    ui.boot.textContent = `${err.message}。请刷新页面重试。`;
  }
}());
