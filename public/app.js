import { renderMarkdown } from './markdown.js';
import { hydrateIcons, icon } from './icons.js';
import {
  browserSnapshot, close as closeBrowser, helpKindLabel, open as openBrowser, startBrowserEvents, stopBrowserEvents,
} from './browser.js';
import {
  closeFiles, initFiles, openFiles, openPath, openRemote, openUpload, refreshFilesSoon, setFilesRoot,
} from './files.js';
import {
  checkMachine, findMachine, folderPicker, initMachines, loadMachines, machines, onMachinesChange,
} from './machines.js';
import { isDataImage, mdImage, remoteImageUrl } from './reader.js';
import { highlight } from './highlight.js';
import {
  closeTerminal, initTerminal, openTerminal, refreshTerminalClaude, setTerminalRoot, showClaudeCommand,
} from './terminal.js';
import {
  exportMarkdown, initExtras, notify, openPlusMenu, openSettings, openShare, openStatus, openTasks,
} from './extras.js';
import { initResizers } from './resize.js';
import { LatestRequest, mergeWindow } from './conversation-load.js';

const conversationReads = new LatestRequest();
const historyReads = new LatestRequest();
let commandIndex = { convId: null, commands: [] };

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
  projChip: $('proj-chip'), projChipName: $('proj-chip-name'), projectDialog: $('project-dialog'),
  projectForm: $('project-form'), projectName: $('project-name'), projectDir: $('project-dir'),
  projectHint: $('project-hint'), projectError: $('project-error'), projectWhere: $('project-where'),
  projectLoc: $('project-loc'), projectLocal: $('project-local'), projectRemote: $('project-remote'),
  askMode: $('ask-mode'),
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
// Tools whose summary is a file path (clickable into the file panel), and those that may change files.
const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const CHANGE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);
// Inline code in a reply that looks like a file path: has a slash or a file extension, no spaces.
const PATH_RE = /^(?:~\/|\.{1,2}\/|\/)?(?:[\w.\-\u4e00-\u9fff]+\/)*[\w\-\u4e00-\u9fff][\w.\-\u4e00-\u9fff]*(?:\.[A-Za-z][A-Za-z0-9]{0,7}|\/)$/;
// A Windows path (D:\Projects\x.docx) can only be on one of the owner's computers.
const WIN_PATH_RE = /^[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\r\n]*$/;
const looksLikePath = (s) => s.length < 300 && ((PATH_RE.test(s) && (s.includes('/') || /\.[A-Za-z]/.test(s)) && !/^\d/.test(s))
  || (WIN_PATH_RE.test(s) && machines().length > 0));
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
  projects: [],
  projectConvs: new Map(), // project id -> its chats (expanded projects only)
  openProjects: new Set(), // expanded in the sidebar
  draftProject: null, // project of a chat that does not exist yet
  defaultDir: '',
  askMode: 'add', // while a reply runs: 'add' joins the running turn, 'ask' is a side question (/btw)
};
const MSG_PAGE = 30;

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
};

class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

async function api(path, { method = 'GET', body, raw, headers = {}, signal } = {}) {
  const timeout = method === 'GET' && path.startsWith('/api/conversations/') ? AbortSignal.timeout(30000) : null;
  const fetchSignal = timeout ? (signal ? AbortSignal.any([signal, timeout]) : timeout) : signal;
  let res;
  try {
    res = await fetch(path, {
      method,
      signal: fetchSignal,
      credentials: 'same-origin',
      headers: raw ? headers : (body === undefined ? headers : { 'Content-Type': 'application/json', ...headers }),
      body: raw || (body === undefined ? undefined : JSON.stringify(body)),
    });
  } catch (err) {
    if (timeout?.aborted && !signal?.aborted) throw new ApiError('加载超时，请重试', 0);
    if (signal?.aborted || err.name === 'AbortError') throw err;
    throw new ApiError('无法连接服务器，请检查网络', 0);
  }
  let data = null;
  try { data = await res.json(); } catch (err) {
    if (timeout?.aborted && !signal?.aborted) throw new ApiError('加载超时，请重试', 0);
    if (signal?.aborted || err.name === 'AbortError') throw err;
    if (res.ok) throw new ApiError('响应未完整接收，请重试', 0);
  }
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new ApiError('登录已失效，请重新登录', 401, data);
  }
  if (!res.ok) throw new ApiError(data?.error || `请求失败（${res.status}）`, res.status, data);
  if (path.includes('view=window')) {
    const timing = performance.getEntriesByName(new URL(path, location.href).href).at(-1);
    if (timing) console.debug('conversation-network', {
      queueAndConnectMs: Math.round(timing.requestStart - timing.fetchStart),
      ttfbMs: Math.round(timing.responseStart - timing.requestStart),
      downloadMs: Math.round(timing.responseEnd - timing.responseStart),
      bytes: timing.encodedBodySize, serverTiming: res.headers.get('Server-Timing'),
    });
  }
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
  onOpen: () => { closeFiles({ focus: false }); closeTerminal({ focus: false }); },
  onHelp(help) {
    announce(`助理需要你在浏览器中操作：${help.reason}`);
    if (help.convId !== state.conv?.id) {
      const c = findConv(help.convId);
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
  conversationReads.cancel();
  historyReads.cancel();
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
  try { state.openProjects = new Set(JSON.parse(store.get('aw.projOpen') || '[]')); } catch { /* keep none */ }
  startBrowserEvents(browserHooks);
  await Promise.all([loadModels(), refreshList(), loadMachines()]);
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
// Without a search the main list holds the ungrouped chats; projects list their own.
const listQuery = (extra) => {
  const p = new URLSearchParams({ limit: String(extra.limit || LIST_PAGE) });
  if (state.query.trim()) p.set('q', state.query.trim());
  else p.set('project', 'none');
  if (extra.before) p.set('before', extra.before);
  return `/api/conversations?${p}`;
};
const projectChats = (id) => api(`/api/conversations?project=${encodeURIComponent(id)}`).then((d) => d.conversations);

function findConv(id) {
  return state.conversations.find((c) => c.id === id)
    || [...state.projectConvs.values()].flat().find((c) => c.id === id) || null;
}
const findProject = (id) => (id && state.projects.find((p) => p.id === id)) || null;
/** Project of the open chat (or of the new chat being drafted). */
const currentProject = () => findProject(state.conv ? state.conv.projectId : state.draftProject);

/** Reloads the top of the history, keeping as many rows as are already loaded. */
async function refreshList() {
  const seq = (state.listSeq = (state.listSeq || 0) + 1);
  try {
    const limit = Math.min(200, Math.max(LIST_PAGE, state.conversations.length));
    const [data, proj] = await Promise.all([api(listQuery({ limit })), api('/api/projects')]);
    const open = state.query.trim() ? [] : proj.projects.filter((p) => state.openProjects.has(p.id));
    const lists = await Promise.all(open.map(async (p) => [p.id, await projectChats(p.id)]));
    if (seq !== state.listSeq) return;
    state.conversations = data.conversations;
    state.listCursor = data.nextCursor;
    state.projects = proj.projects;
    state.defaultDir = proj.defaultDir;
    state.projectConvs = new Map(lists);
  } catch (err) {
    if (err.status !== 401) showBanner(err.message, 'error');
  }
  renderList();
  updateChrome();
  checkRemoteProjects();
}

/** Online state of the machines remote projects live on (each checked at most once a minute). */
function checkRemoteProjects() {
  const ids = [...new Set(state.projects.filter((p) => p.remote).map((p) => p.remote.machineId))];
  for (const id of ids) {
    checkMachine(id).then((m) => {
      if (!m) return;
      let changed = false;
      for (const p of state.projects) {
        if (p.remote?.machineId === id && p.remote.online !== m.online) { p.remote.online = m.online; changed = true; }
      }
      if (changed) renderList();
    });
  }
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

function convRow(c) {
  const li = el('li', `conv-li${state.conv?.id === c.id ? ' current' : ''}`);
  const btn = el('button', 'conv-item');
  btn.type = 'button';
  btn.dataset.id = c.id;
  if (state.conv?.id === c.id) btn.setAttribute('aria-current', 'page');
  const label = el('span', 'conv-text');
  label.append(el('span', 'conv-title', c.title || '新对话'));
  const project = state.query.trim() && findProject(c.projectId);
  if (c.snippet || project) label.append(el('span', 'conv-snippet', c.snippet || `项目：${project.name}`));
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
  return li;
}

function projectSection() {
  const box = el('section', 'proj-section');
  box.setAttribute('aria-label', '项目');
  const head = el('div', 'proj-head');
  head.append(el('h2', 'conv-group-title', '项目'));
  const add = iconButton('folder-plus', '新建项目', 'icon-btn proj-add');
  add.dataset.action = 'new-project';
  head.append(add);
  box.append(head);
  const ul = el('ul', 'conv-list');
  if (!state.projects.length) {
    const li = el('li', 'conv-li');
    const b = el('button', 'conv-item proj-empty');
    b.type = 'button';
    b.dataset.action = 'new-project';
    b.append(icon('folder-plus', 18), el('span', 'conv-text', '新建项目'));
    li.append(b);
    ul.append(li);
  }
  for (const p of state.projects) {
    const open = state.openProjects.has(p.id);
    const li = el('li', 'proj-li');
    const row = el('div', `conv-li${!state.conv && state.draftProject === p.id ? ' current' : ''}`);
    const btn = el('button', 'conv-item proj-item');
    btn.type = 'button';
    btn.dataset.project = p.id;
    btn.setAttribute('aria-expanded', String(open));
    btn.title = p.remote ? `${p.remote.machine || '远程机器'}：${p.remote.display}` : p.dir;
    const label = el('span', 'conv-text');
    label.append(el('span', 'conv-title', p.name));
    // A project on one of the owner's computers names the machine, and says when it is offline.
    if (p.remote) label.append(el('span', `conv-snippet proj-machine${p.remote.online === false ? ' offline' : ''}`, `${p.remote.machine || '远程机器（已删除）'}${p.remote.online === false ? ' · 离线' : ''}`));
    btn.append(icon(open ? 'chevron-down' : 'chevron-right', 14), icon(p.remote ? 'monitor' : 'folder', 18), label);
    if (p.running && !open) btn.append(el('span', 'conv-running'));
    const more = iconButton('more', `项目“${p.name}”的选项`, 'icon-btn conv-more proj-more');
    more.dataset.project = p.id;
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    row.append(btn, more);
    li.append(row);
    if (open) {
      const sub = el('ul', 'conv-list proj-chats');
      const nb = el('button', 'conv-item proj-new');
      nb.type = 'button';
      nb.dataset.project = p.id;
      nb.append(icon('compose', 16), el('span', 'conv-text', '新对话'));
      const nli = el('li', 'conv-li');
      nli.append(nb);
      sub.append(nli);
      const chats = state.projectConvs.get(p.id);
      if (!chats) sub.append(el('li', 'conv-empty', '加载中…'));
      else for (const c of chats) sub.append(convRow(c));
      li.append(sub);
    }
    ul.append(li);
  }
  box.append(ul);
  return box;
}

function renderList() {
  const q = state.query.trim();
  const list = state.conversations;
  listObserver.disconnect();
  ui.groups.replaceChildren();
  ui.convEmpty.hidden = true;
  if (!q) ui.groups.append(projectSection());
  if (!list.length) ui.groups.append(el('p', 'conv-empty', q ? '没有匹配的对话' : (state.projects.length ? '项目之外还没有对话' : '还没有对话')));
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
    ul.append(convRow(c));
  }
  if (state.listCursor) {
    const moreBtn = el('button', 'list-more', state.listLoading ? '加载中…' : '加载更多对话');
    moreBtn.type = 'button';
    moreBtn.addEventListener('click', loadMoreList);
    ui.groups.append(moreBtn);
    listObserver.observe(moreBtn);
  }
}

function saveOpenProjects() {
  store.set('aw.projOpen', JSON.stringify([...state.openProjects]));
}

async function toggleProject(id) {
  if (state.openProjects.delete(id)) {
    saveOpenProjects();
    renderList();
    return;
  }
  state.openProjects.add(id);
  saveOpenProjects();
  renderList();
  try {
    state.projectConvs.set(id, await projectChats(id));
  } catch (err) {
    if (err.status !== 401) toast(err.message);
  }
  renderList();
  ui.groups.querySelector(`.proj-item[data-project="${CSS.escape(id)}"]`)?.focus();
}

const LOCAL_HINT = () => `目录留空时新建 ${state.defaultDir ? `${state.defaultDir}/projects/` : 'projects/'}<名称>；也可以填服务器上已有目录的绝对路径。项目里的对话都在这个目录中运行，共用其中的文件、CLAUDE.md 和记忆。`;
// The folder chosen in the remote picker (new project on one of the owner's computers).
let pickedDir = '';

function newProject() {
  ui.projectName.value = '';
  ui.projectDir.value = '';
  setError(ui.projectError, '');
  // Location: this server, or one of the remote machines set up in Settings.
  const ms = machines();
  ui.projectWhere.hidden = !ms.length;
  ui.projectLoc.replaceChildren();
  const opt = (value, text) => { const o = el('option', '', text); o.value = value; ui.projectLoc.append(o); };
  opt('', '云机（这台服务器）');
  for (const m of ms) opt(m.id, `${m.name} · ${m.host}${m.online === false ? '（离线）' : ''}`);
  ui.projectLoc.value = '';
  projectLocation();
  ui.projectDialog.showModal();
  ui.projectName.focus();
}

function projectLocation() {
  const m = findMachine(ui.projectLoc.value);
  ui.projectLocal.hidden = Boolean(m);
  ui.projectRemote.hidden = !m;
  ui.projectRemote.replaceChildren();
  pickedDir = '';
  if (!m) { ui.projectHint.textContent = LOCAL_HINT(); return; }
  const manual = el('input');
  manual.id = 'project-rdir';
  manual.autocomplete = 'off';
  manual.spellcheck = false;
  manual.placeholder = m.roots[0]?.display || '';
  const label = el('label', 'field-label', '或直接填写路径');
  label.htmlFor = manual.id;
  ui.projectRemote.append(el('span', 'field-label', '选择文件夹'), folderPicker(m, (path) => { pickedDir = path; }), label, manual);
  ui.projectHint.textContent = `项目文件留在 ${m.name} 上，Claude 仍在服务器上运行（工作目录 projects/<名称>，放这个项目的 CLAUDE.md 和记忆），通过 ssh ${m.host} 操作这些文件。只能选设置里允许浏览的目录。`;
}

async function createProject() {
  const name = ui.projectName.value.trim();
  if (!name) { setError(ui.projectError, '请填写项目名称'); return; }
  const machine = findMachine(ui.projectLoc.value);
  const body = { name, dir: ui.projectDir.value.trim() };
  if (machine) {
    const typed = $('project-rdir')?.value.trim();
    Object.assign(body, { dir: '', machineId: machine.id, remoteDir: typed || pickedDir });
    if (!body.remoteDir) { setError(ui.projectError, '请选择或填写这台电脑上的文件夹'); return; }
  }
  const submit = ui.projectForm.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const { project } = await api('/api/projects', { method: 'POST', body });
    ui.projectDialog.close();
    state.openProjects.add(project.id);
    saveOpenProjects();
    newChat(project.id);
    await refreshList();
    toast(`已创建项目“${project.name}”`);
  } catch (err) {
    if (err.status !== 401) setError(ui.projectError, err.message);
  } finally {
    submit.disabled = false;
  }
}

function projectMenu(anchor, id) {
  const p = findProject(id);
  if (!p) return;
  openMenu(anchor, [
    { icon: 'compose', label: '新对话', run: () => newChat(id) },
    { icon: 'folder', label: '浏览文件', run: () => { if (currentProject()?.id !== id) newChat(id); openFiles(); } },
    { icon: 'pencil', label: '重命名', run: () => renameProject(id, p.name) },
    { icon: 'trash', label: '删除项目', danger: true, run: () => removeProject(p) },
  ]);
}

function renameProject(id, current) {
  askName('重命名项目', current, 60, async (name) => {
    await api(`/api/projects/${id}`, { method: 'PATCH', body: { name } });
    await refreshList();
  });
}

async function removeProject(p) {
  const n = p.conversations;
  if (!(await confirmDialog('删除项目？', `将删除项目“${p.name}”。${n ? `其中 ${n} 个对话会移到项目之外，仍在原目录中运行。` : ''}服务器上的目录 ${p.dir} 和里面的文件不会被删除。`))) return;
  try {
    await api(`/api/projects/${p.id}`, { method: 'DELETE' });
    state.openProjects.delete(p.id);
    saveOpenProjects();
    if (state.draftProject === p.id) state.draftProject = null;
    if (state.conv?.projectId === p.id) state.conv.projectId = null;
    await refreshList();
    render();
    toast('已删除项目');
  } catch (err) {
    if (err.status !== 401) toast(err.message);
  }
}

function convMenu(anchor, id) {
  const c = findConv(id) || state.conv;
  openMenu(anchor, [
    { icon: 'share', label: '分享', run: () => openShare(id) },
    { icon: 'gauge', label: '上下文与花费', run: () => openStatus(id) },
    { icon: 'file', label: '导出 Markdown', run: () => exportMarkdown(id) },
    { icon: 'pencil', label: '重命名', run: () => renameConversation(id, c?.title || '') },
    { icon: 'trash', label: '删除', danger: true, run: () => removeConversation(id, c?.title || '新对话') },
  ]);
}

/** The shared rename dialog: calls `save(name)` when the owner changes the name. */
function askName(title, current, max, save) {
  ui.renameDialog.querySelector('.dialog-title').textContent = title;
  ui.renameInput.maxLength = max;
  ui.renameInput.value = current;
  ui.renameDialog.showModal();
  ui.renameInput.select();
  ui.renameDialog.onclose = async () => {
    if (ui.renameDialog.returnValue !== 'ok') return;
    const name = ui.renameInput.value.trim();
    if (!name || name === current) return;
    try {
      await save(name);
    } catch (err) {
      if (err.status !== 401) toast(err.message);
    }
  };
}

function renameConversation(id, current) {
  askName('重命名对话', current, 80, async (title) => {
    await api(`/api/conversations/${id}`, { method: 'PATCH', body: { title } });
    if (state.conv?.id === id) state.conv.title = title;
    await refreshList();
    updateChrome();
  });
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
  const c = findConv(id);
  if (c?.running) { toast('请先停止正在进行的回复'); return; }
  if (!(await confirmDialog('删除对话？', `将删除“${title}”。删除后无法恢复。`))) return;
  try {
    await api(`/api/conversations/${id}`, { method: 'DELETE' });
    if (state.conv?.id === id) startDraft(state.conv.projectId || null);
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

function startDraft(projectId = null) {
  conversationReads.cancel();
  historyReads.cancel();
  state.loading = false;
  state.loadingEarlier = false;
  closeStream();
  state.conv = null;
  state.run = null;
  state.editing = null;
  state.draftSel = null;
  state.draftProject = projectId;
  state.renderCount = MSG_PAGE;
  history.replaceState(null, '', location.pathname);
  render(true);
  renderList();
  updateModelChrome();
  if (!coarse.matches) ui.input.focus();
}

async function openConversation(id) {
  const request = conversationReads.begin();
  historyReads.cancel();
  state.loadingEarlier = false;
  const started = performance.now();
  state.historyFailed = false;
  commandIndex = { convId: null, commands: [] };
  closeStream();
  imageNodes.clear();
  state.loading = true;
  state.editing = null;
  state.renderCount = MSG_PAGE;
  state.conv = { id, title: '', messages: [], leafId: null, settings: null };
  state.run = null;
  render();
  try {
    const { conversation } = await api(`/api/conversations/${id}?view=window`, { signal: request.signal });
    if (!request.current() || state.conv?.id !== id) return;
    state.conv = conversation;
    state.renderCount = conversation.window?.count || MSG_PAGE;
    console.debug('conversation-load', { downloadAndParseMs: Math.round(performance.now() - started) });
    state.run = conversation.run ? { id: conversation.run.id, messageId: conversation.run.messageId } : null;
    history.replaceState(null, '', `#${id}`);
    pollRunningSide();
    if (!$('term-panel').hidden) loadCommandIndex().catch((err) => { if (err.name !== 'AbortError' && err.status !== 401) toast(err.message); });
    if (conversation.projectId && !state.openProjects.has(conversation.projectId)) {
      state.openProjects.add(conversation.projectId);
      saveOpenProjects();
      refreshList();
    }
    if (conversation.run) openStream(conversation.run.id, conversation.run.seq);
  } catch (err) {
    if (!request.current()) return;
    if (err.status === 401) return;
    state.conv = null;
    history.replaceState(null, '', location.pathname);
    showBanner(err.status === 404 ? '这个对话不存在或已被删除' : err.message, 'error');
  } finally {
    if (!request.current()) return;
    state.loading = false;
    const rendering = performance.now();
    render(true);
    renderList();
    updateModelChrome();
    console.debug('conversation-load', { renderMs: Math.round(performance.now() - rendering), totalMs: Math.round(performance.now() - started) });
  }
}

async function switchBranch(messageId, dir) {
  if (isLive()) { toast('回复进行中，结束后再切换分支'); return; }
  const msg = byId().get(messageId);
  const sibs = childrenOf(msg.parentId);
  const i = sibs.findIndex((s) => s.id === messageId) + dir;
  if (i < 0 || i >= sibs.length) return;
  const leafId = deepestLeaf(sibs[i].id);
  const conv = state.conv;
  const request = conversationReads.begin();
  historyReads.cancel();
  state.loading = true;
  state.loadingEarlier = false;
  render();
  try {
    await api(`/api/conversations/${conv.id}`, { method: 'PATCH', body: { leafId } });
    if (!request.current()) return;
    const { conversation } = await api(`/api/conversations/${conv.id}?view=window&leaf=${leafId}`, { signal: request.signal });
    if (!request.current()) return;
    state.conv = conversation;
    commandIndex = { convId: null, commands: [] };
    state.renderCount = conversation.window?.count || MSG_PAGE;
  } catch (err) {
    if (!request.current()) return;
    if (err.status !== 401) toast(err.message);
  } finally {
    if (request.current()) { state.loading = false; render(true); }
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
  if (!state.conv || state.loading) return;
  const previous = state.conv;
  const request = conversationReads.begin();
  try {
    const { conversation } = await api(`/api/conversations/${previous.id}?view=window`, { signal: request.signal });
    if (!request.current() || state.conv?.id !== conversation.id) return;
    state.conv = mergeWindow(state.conv, conversation);
    state.run = conversation.run ? { id: conversation.run.id, messageId: conversation.run.messageId } : null;
    hideBanner();
    pollRunningSide();
    if (conversation.run) openStream(conversation.run.id, conversation.run.seq);
  } catch (err) {
    if (!request.current()) return;
    if (err.status === 0) {
      showBanner('无法连接服务器，稍后自动重试…', 'warn');
      setTimeout(() => { if (request.current()) reloadCurrent(); }, 4000);
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
    if (ev.part.type === 'tool' && ev.part.state !== 'running' && CHANGE_TOOLS.has(ev.part.name)) refreshFilesSoon();
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
    if (ev.queued) msg.queued = ev.queued;
    if (ev.background !== undefined) msg.background = ev.background;
    if (ev.media) msg.media = ev.media;
  } else if (ev.type === 'status') {
    msg.status = ev.status;
    if (ev.error) msg.error = ev.error;
    const title = state.conv?.title || '对话';
    if (ev.status === 'done') { announce('回复完成'); notify(`“${title}”回复完成`); }
    else if (ev.status === 'error') { announce('回复出错'); notify(`“${title}”回复出错`); }
    else if (ev.status === 'stopped') announce('已停止');
  } else if (ev.type === 'end') {
    closeStream();
    refreshFilesSoon();
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
    refreshTerminalClaude();
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
  refreshTerminalClaude();
  if (toBottom || state.stick) scrollToBottom();
  else if (keep !== null) ui.scroller.scrollTop = keep;
}

function updateChrome() {
  const conv = state.conv;
  ui.title.textContent = conv?.title || (conv && state.loading ? '加载中…' : '新对话');
  document.title = conv?.title ? `${conv.title} · MambaBot` : 'MambaBot';
  const live = isLive();
  const uploading = state.attachments.some((a) => a.status === 'uploading');
  const hasContent = ui.input.value.trim() || state.attachments.some((a) => a.status === 'ready');
  // One button: while a reply runs it stops it when the composer is empty, and otherwise
  // sends the text into the running turn (as in the Claude Code terminal).
  const showStop = live && !ui.input.value.trim() && !state.attachments.length;
  ui.stop.hidden = !showStop;
  ui.send.hidden = showStop;
  ui.input.placeholder = live ? '补充或纠正，会在当前步骤完成后交给 Claude' : '给 MambaBot 发消息';
  const asking = live && state.askMode === 'ask';
  ui.askMode.hidden = !live;
  for (const b of ui.askMode.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.mode === state.askMode));
  if (live) ui.input.placeholder = asking ? '提问：马上由旁路回答，不打断当前任务' : '补充要求：Claude 完成当前步骤后会看到';
  ui.send.setAttribute('aria-label', asking ? '旁路提问' : (live ? '追加到当前任务' : '发送'));
  const stopping = runMessage()?.status === 'stopping';
  ui.stop.disabled = stopping;
  ui.stop.setAttribute('aria-label', stopping ? '正在停止' : '停止生成');
  ui.send.disabled = state.sending || state.loading || uploading || !hasContent
    || state.attachments.some((a) => a.status === 'error') || !state.models.length;
  ui.send.title = uploading ? '附件上传中…' : (asking ? '旁路提问' : (live ? '追加到当前任务' : '发送'));
  ui.convMenuBtn.hidden = !conv?.id || state.loading;
  const project = currentProject();
  ui.projChip.hidden = !project;
  ui.projChipName.textContent = project?.name || '';
  ui.projChip.title = project ? (project.remote
    ? `项目在 ${project.remote.machine || '远程机器'}：${project.remote.display}（点击浏览文件）`
    : `项目目录：${project.dir}（点击浏览文件）`) : '';
  const pr = project?.remote ? {
    machineId: project.remote.machineId, root: project.remote.path, label: project.remote.machine || '远程机器', display: project.remote.display,
  } : null;
  setFilesRoot(project ? project.id : 'default', project?.name || '', pr);
  setTerminalRoot(project ? project.id : 'default', project?.name || '');
}

/** Commands Claude ran on the shown branch, for the terminal panel. */
function claudeCommands() {
  const out = new Map((commandIndex.convId === state.conv?.id ? commandIndex.commands : []).map((c) => [c.id, c]));
  for (const m of visiblePath()) {
    if (m.role !== 'assistant') continue;
    for (const p of m.parts) {
      if (p.type !== 'tool' || p.name !== 'Bash') continue;
      out.set(p.id, { id: p.id, messageId: m.id, command: p.detail || p.summary || '', desc: p.summary, output: p.output,
        state: p.state, at: p.at || m.createdAt, deferredDetail: p.deferredDetail });
    }
  }
  return [...out.values()];
}

async function loadCommandIndex() {
  const conv = state.conv;
  if (!conv?.id) return;
  const { commands } = await api(`/api/conversations/${conv.id}/commands`, { signal: conversationReads.current?.signal });
  if (state.conv?.id !== conv.id || state.conv.leafId !== conv.leafId) return;
  commandIndex = { convId: conv.id, commands };
  refreshTerminalClaude();
}

const toolLoads = new Map();
async function loadToolDetail(messageId, toolId) {
  const conv = state.conv;
  const msg = conv?.messages.find((m) => m.id === messageId);
  const cached = msg?.parts.find((p) => p.id === toolId);
  if (cached && !cached.deferredDetail) return cached;
  const key = `${conv?.id}:${messageId}:${toolId}`;
  if (toolLoads.has(key)) return toolLoads.get(key);
  const promise = (async () => {
    const { part } = await api(`/api/conversations/${conv.id}/messages/${messageId}?tool=${encodeURIComponent(toolId)}`, { signal: conversationReads.current?.signal });
    if (state.conv?.id !== conv.id) throw new DOMException('Conversation changed', 'AbortError');
    const current = state.conv.messages.find((m) => m.id === messageId);
    const index = current?.parts.findIndex((p) => p.id === toolId) ?? -1;
    if (index >= 0) current.parts[index] = part;
    const command = commandIndex.convId === conv.id && commandIndex.commands.find((c) => c.id === toolId);
    if (command) Object.assign(command, { command: part.detail || part.summary || '', output: part.output, deferredDetail: false });
    return part;
  })();
  toolLoads.set(key, promise);
  try { return await promise; } finally { toolLoads.delete(key); }
}

async function loadFullText(msg) {
  if (!msg?.deferredText) return msg;
  const conv = state.conv;
  const { message } = await api(`/api/conversations/${conv.id}/messages/${msg.id}`, { signal: conversationReads.current?.signal });
  if (state.conv?.id !== conv.id) throw new DOMException('Conversation changed', 'AbortError');
  const index = state.conv.messages.findIndex((m) => m.id === msg.id);
  if (index >= 0) state.conv.messages[index] = message;
  return message;
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
  const fullPath = visiblePath();
  const path = fullPath.filter((m) => !m.deferred);
  if (!state.conv || path.length === 0) {
    const project = currentProject();
    box.append(project
      ? emptyState(`项目：${project.name}`, project.remote
        ? `项目文件在 ${project.remote.machine || '远程机器'} 的 ${project.remote.display}，Claude 会通过 SSH 操作它们${project.remote.online === false ? '（这台电脑现在离线）' : ''}。同一项目的对话共用服务器上 ${project.dir} 里的 CLAUDE.md 和记忆；右侧“文件”面板显示远程目录。`
        : `这个对话在项目目录 ${project.dir} 中运行，和同一项目的其他对话共用这里的文件、CLAUDE.md 和记忆。Claude 写的文档可以在右侧“文件”面板里预览。`)
      : emptyState('有什么可以帮忙的？', '可以发送文字、图片或文件。需要授权的操作，会在对话里请你确认。'));
    return;
  }
  // Long chats: only the newest messages are built; older ones on demand (scroll up / button).
  // The message being edited always stays in the window.
  const editIdx = state.editing ? path.findIndex((m) => m.id === state.editing) : -1;
  let start = Math.max(0, path.length - state.renderCount);
  if (editIdx >= 0 && editIdx < start) start = editIdx;
  earlierObserver.disconnect();
  const remaining = fullPath.length - path.length + start;
  if (remaining > 0) {
    const more = el('button', 'load-earlier', state.loadingEarlier ? '加载更早的消息…' : `显示更早的消息（还有 ${remaining} 条）`);
    more.type = 'button';
    more.disabled = state.loadingEarlier;
    more.addEventListener('click', loadEarlier);
    box.append(more);
    earlierObserver.observe(more);
  }
  for (const msg of path.slice(start)) {
    const node = el('article', `msg msg-${msg.role}`);
    node.dataset.id = msg.id;
    fillMessage(node, msg);
    box.append(node);
    for (const b of state.conv.btw || []) if (b.anchorId === msg.id) box.append(btwCard(b));
  }
  if (focusKey) box.querySelector(`[data-focus-key="${focusKey}"]`)?.focus();
}

/** Renders one more page above, keeping what the reader is looking at in place. */
async function loadEarlier() {
  if (state.loadingEarlier || state.loading || !state.conv) return;
  const conv = state.conv;
  const request = historyReads.begin();
  state.loadingEarlier = true;
  state.historyFailed = false;
  const button = ui.messages.querySelector('.load-earlier');
  if (button) { button.disabled = true; button.textContent = '加载更早的消息…'; }
  const s = ui.scroller;
  const fromBottom = s.scrollHeight - s.scrollTop;
  const loaded = visiblePath().filter((m) => !m.deferred);
  try {
    if (loaded.length <= state.renderCount && loaded[0]?.parentId) {
      const { conversation } = await api(`/api/conversations/${conv.id}?view=window&leaf=${conv.leafId}&before=${loaded[0].id}`, { signal: request.signal });
      if (!request.current() || state.conv?.id !== conv.id || state.conv.leafId !== conv.leafId) return;
      state.conv = mergeWindow(state.conv, conversation);
    }
    state.renderCount += MSG_PAGE;
  } catch (err) {
    if (request.current() && err.name !== 'AbortError' && err.status !== 401) {
      state.historyFailed = true;
      toast(err.message);
    }
  } finally {
    if (request.current() && state.conv?.id === conv.id) {
      state.loadingEarlier = false;
      renderMessages();
      s.scrollTop = s.scrollHeight - fromBottom;
    }
  }
}

// Fires when the "earlier" button nears the top of the viewport, but not on the initial
// render (which scrolls to the bottom), so opening a chat never cascades through history.
const earlierObserver = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && !state.stick && !state.historyFailed) loadEarlier();
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
  // Opens in the reader (PDF, Word, Excel, PPT, media…); the reader has the download button.
  chip.dataset.upload = a.id;
  chip.dataset.name = a.name;
  chip.title = `在网页中打开 ${a.name}`;
  chip.append(icon('file', 18), el('span', 'file-chip-name', a.name), el('span', 'file-chip-size', formatSize(a.size)));
  return chip;
}

/* ---------- images in replies ---------- */

// Web images the owner tapped to load (when 外链图片 is set to 点击后显示).
const revealed = new Set();
// <img> nodes per message, reused while a reply streams so its images do not reload or flicker.
const imageNodes = new Map();

/**
 * Where an image of a reply or a Markdown file loads from: the copy saved when the reply
 * ended, the web (through the server's proxy), or a path on the host (relative ones against
 * `resolveLocal`, i.e. the chat's directory or the Markdown file's).
 */
function imageTarget(srcText, { media = null, resolveLocal }) {
  const src = String(srcText || '').trim();
  if (media?.[src]) return { url: `/api/uploads/${encodeURIComponent(media[src].id)}` };
  if (isDataImage(src)) return { url: src.replace(/\s+/g, '') };
  if (/^https?:\/\//i.test(src)) {
    const url = remoteImageUrl(src);
    return { url, remote: true, deferred: state.prefs?.remoteImages === 'click' && !revealed.has(url) };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^file:\/\//i.test(src)) return { url: null };
  return { url: resolveLocal(src) };
}

const chatFileUrl = (path) => `/api/files/raw?path=${encodeURIComponent(path)}${state.conv?.id ? `&conv=${encodeURIComponent(state.conv.id)}` : ''}`;

function replyMarkdownOptions(msg) {
  let cache = imageNodes.get(msg.id);
  if (!cache) { cache = new Map(); imageNodes.set(msg.id, cache); }
  const used = new Set();
  return {
    image(tok, block) {
      const t = imageTarget(tok.src, { media: msg.media, resolveLocal: chatFileUrl });
      const key = `${block ? 'b' : 'i'}|${t.url}|${t.deferred ? 1 : 0}`;
      const hit = cache.get(key);
      if (hit && !used.has(key)) { used.add(key); return hit.replacement || hit; }
      const node = mdImage({ ...t, alt: tok.alt, title: tok.title, block, src: tok.src });
      if (!used.has(key)) { cache.set(key, node); used.add(key); }
      return node;
    },
    highlight: (code, lang) => highlight(document, code, lang),
    fileLink(path, label) {
      const a = el('a', 'path-link file-link', label || path);
      a.href = chatFileUrl(path);
      a.dataset.path = path;
      a.title = `在网页中打开 ${path}`;
      return a;
    },
  };
}

/** For Markdown files in the reader: relative images resolve against the file's own folder. */
function readerImage(tok, block, src) {
  const t = imageTarget(tok.src, { resolveLocal: (p) => src.resolve(p)?.raw() || null });
  return mdImage({ ...t, alt: tok.alt, title: tok.title, block, src: tok.src });
}

/** A file Claude showed with assistant-media show_file. */
function shownFile(part) {
  const fig = el('figure', `shown-file${part.attachment?.image ? ' image' : ''}`);
  fig.append(attachmentView(part.attachment));
  if (part.caption) fig.append(el('figcaption', '', part.caption));
  return fig;
}

/** Full-screen image viewer; `list` ({ src, name }) adds previous/next (buttons, ←/→, swipe). */
const gallery = { list: [], index: 0 };
function openViewer(src, name, list = null, index = 0) {
  gallery.list = list && list.length > 1 ? list : [{ src, name }];
  gallery.index = list && list.length > 1 ? Math.max(0, index) : 0;
  showViewerImage();
  const dlg = $('image-viewer');
  if (!dlg.open) dlg.showModal();
}
function showViewerImage() {
  const { src, name } = gallery.list[gallery.index];
  $('viewer-img').src = src;
  $('viewer-img').alt = name || '';
  $('viewer-name').textContent = name || '';
  $('viewer-open').href = src;
  const many = gallery.list.length > 1;
  $('viewer-prev').hidden = !many;
  $('viewer-next').hidden = !many;
  $('viewer-count').hidden = !many;
  $('viewer-count').textContent = `${gallery.index + 1} / ${gallery.list.length}`;
}
function stepViewer(d) {
  if (gallery.list.length < 2) return;
  gallery.index = (gallery.index + d + gallery.list.length) % gallery.list.length;
  showViewerImage();
}
/** Every zoomable image in a container, for the viewer's previous/next. */
function galleryOf(root, link) {
  const all = [...root.querySelectorAll('a[data-view]')].filter((a) => a.querySelector('img'));
  return { list: all.map((a) => ({ src: a.href, name: a.dataset.view })), index: Math.max(0, all.indexOf(link)) };
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
  if (msg.status === 'sending') {
    node.classList.add('sending');
    node.append(el('div', 'msg-sending', '发送中…'));
    return;
  }
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
  const mdOpts = replyMarkdownOptions(msg);
  let tools = [];
  const flushTools = (running) => {
    if (!tools.length) return;
    body.append(activityBlock(tools, running, msg.id));
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
      div.append(renderMarkdown(part.text, document, mdOpts));
      linkPaths(div);
      body.append(div);
    } else if (part.type === 'approval') {
      body.append(renderApproval(part, msg));
    } else if (part.type === 'notice') {
      body.append(el('p', 'notice', part.text));
    } else if (part.type === 'compact') {
      body.append(compactNote(part));
    } else if (part.type === 'file' && part.attachment) {
      body.append(shownFile(part));
    } else if (part.type === 'followup') {
      body.append(followupView(part));
    }
  });
  flushTools(live);
  if (msg.deferredText) {
    const more = el('button', 'link-btn', '展开完整回复');
    more.type = 'button';
    more.addEventListener('click', async () => {
      more.disabled = true;
      more.textContent = '加载完整回复…';
      try { const full = await loadFullText(msg); fillMessage(node, full); }
      catch (err) {
        if (err.name !== 'AbortError' && err.status !== 401) toast(err.message);
        more.disabled = false; more.textContent = '展开完整回复';
      }
    });
    body.append(more);
  }
  for (const q of msg.queued || []) body.append(followupView(q, true, msg));
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

/** Inline code that names a file becomes a link into the file panel. */
function linkPaths(root) {
  for (const code of root.querySelectorAll('code')) {
    if (code.closest('pre') || !looksLikePath(code.textContent)) continue;
    markPath(code, code.textContent);
  }
}
function markPath(node, path) {
  node.classList.add('path-link');
  node.dataset.path = path;
  node.tabIndex = 0;
  node.setAttribute('role', 'link');
  node.title = '在文件面板中打开';
}

/**
 * Where a queued message waits: Claude sees it once the step it is on ends, so name that step
 * (and how long it has been running) instead of a vague "after the current step".
 */
function queuedNote(part, msg) {
  if (part.sending) return '发送中…';
  const step = [...(msg?.parts || [])].reverse().find((p) => p.type === 'tool' && p.state === 'running');
  if (step) {
    const mins = step.at ? Math.floor((Date.now() - new Date(step.at)) / 60000) : 0;
    return `已排队 · Claude 完成「${toolLabel(step.name)}${mins >= 1 ? `（已 ${mins} 分钟）` : ''}」后会看到`;
  }
  if (msg?.parts.some((p) => p.type === 'approval' && p.state === 'pending')) return '已排队 · 你处理完授权、Claude 做完这一步后会看到';
  return '已排队 · Claude 完成当前这一步后会看到';
}

/** A message the owner added while this reply ran: queued, seen by Claude, or never delivered. */
function followupView(part, queued = false, msg = null) {
  const box = el('div', `followup${queued ? ' queued' : ''}${part.undelivered ? ' undelivered' : ''}`);
  if (part.attachments?.length) {
    const files = el('div', 'user-attach');
    for (const a of part.attachments) files.append(attachmentView(a));
    box.append(files);
  }
  if (part.text) box.append(el('div', 'bubble', part.text));
  if (queued) {
    const note = el('div', 'followup-note', queuedNote(part, msg));
    if (!part.sending) note.title = '想马上得到回答、又不打断任务，可以在输入框旁切到“提问”，或发送 /btw 问题';
    box.append(note);
  }
  if (part.undelivered) {
    const note = el('div', 'followup-note', '未送达：回复在这条消息送达前已结束');
    if (part.text) {
      const b = el('button', 'link-btn', '放回输入框');
      b.type = 'button';
      b.dataset.action = 'refill';
      b.dataset.text = part.text;
      note.append(b);
    }
    box.append(note);
  }
  return box;
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

function activityBlock(tools, running, messageId) {
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
  let built = false;
  const build = () => {
  if (built) return;
  built = true;
  const ul = el('ul', 'tool-list');
  for (const t of tools) {
    const li = el('li', `tool-li tool-${t.state}`);
    const row = el('div', 'tool-row');
    row.append(el('span', 'tool-label', toolLabel(t.name)));
    const summaryNode = el('span', 'tool-summary', t.summary || '');
    if (PATH_TOOLS.has(t.name) && t.summary && !t.summary.endsWith('…')) markPath(summaryNode, t.summary);
    row.append(summaryNode);
    row.append(el('span', 'tool-state', { running: '进行中', done: '完成', error: '失败' }[t.state] || ''));
    li.append(row);
    const details = el('details', 'tool-lazy-detail');
    details.append(el('summary', '', '查看详情'));
    const content = el('div');
    details.append(content);
    let loaded = false;
    let loading = false;
    const populate = async () => {
      if (loaded || loading || !details.open) return;
      loading = true;
      content.textContent = '加载详情…';
      try {
        const part = t.deferredDetail ? await loadToolDetail(messageId, t.id) : t;
        content.replaceChildren();
        if (part.detail) content.append(el('pre', 'tool-detail', part.detail));
        if (part.output) content.append(el('pre', 'tool-output', part.output.length > 2000 ? `${part.output.slice(0, 2000)}\n…` : part.output));
        if (!part.detail && !part.output) content.append(el('p', '', '没有更多详情'));
        loaded = true;
      } catch (err) {
        content.textContent = err.name === 'AbortError' ? '加载已取消' : '加载失败';
        const retry = el('button', 'link-btn', '重试');
        retry.type = 'button'; retry.addEventListener('click', populate); content.append(retry);
      } finally { loading = false; }
    };
    details.addEventListener('toggle', populate);
    li.append(details);
    if (t.name === 'Bash') {
      const open = el('button', 'link-btn tool-open', '在终端面板查看');
      open.type = 'button';
      open.dataset.tool = t.id;
      li.append(open);
    }
    ul.append(li);
  }
  det.append(ul);
  };
  det.dataset.key = tools[0].id;
  if (openActivities.has(tools[0].id)) { det.open = true; build(); }
  det.addEventListener('toggle', () => {
    if (det.open) { openActivities.add(tools[0].id); build(); } else openActivities.delete(tools[0].id);
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
  if (part.reason) box.append(el('p', 'approval-reason', `${part.safetyCheck ? 'Claude Code 安全检查（任何权限模式下都会询问）' : '原因'}：${part.reason}`));
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
      if (msg.background) { p.textContent = `等待 ${msg.background} 个后台任务 · 可以继续发消息`; break; }
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
  const { conversation } = await api('/api/conversations', {
    method: 'POST', body: { model: sel.model, effort: sel.effort || undefined, projectId: state.draftProject || undefined },
  });
  state.conv = { ...conversation, messages: [], leafId: null, run: null };
  history.replaceState(null, '', `#${conversation.id}`);
  return conversation.id;
}

function afterStart(res) {
  state.askMode = 'add';
  state.conv.leafId = res.leafId;
  state.run = { id: res.run.id, messageId: res.run.messageId };
  state.conv.settings = { model: res.assistantMessage.requested.model, effort: res.assistantMessage.requested.effort || null };
  render(true);
  openStream(res.run.id, res.run.seq);
  refreshList();
}

const localId = () => `local-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Puts the text back into an empty composer after a failed send (never over newer typing). */
function restoreComposer(text, attachments = []) {
  if (ui.input.value.trim() || state.attachments.length) {
    for (const a of attachments) if (a.url) URL.revokeObjectURL(a.url);
    return false;
  }
  ui.input.value = text;
  state.attachments = attachments;
  renderAttachments();
  autosize();
  return true;
}

/**
 * Sends the composer. The message shows at once (marked 发送中) and the composer clears; if the
 * request fails both come back with the reason. A new chat is created by the same request.
 * While a reply runs the text joins it (补充) or goes to a side question (提问, or /btw …).
 */
async function send(extra = {}) {
  const text = ui.input.value.trim();
  const ready = state.attachments.filter((a) => a.status === 'ready');
  if ((!text && !ready.length) || state.sending) return;
  if (state.attachments.some((a) => a.status === 'uploading')) { setError(ui.composerError, '附件还在上传，请稍候'); return; }
  setError(ui.composerError, '');
  const btw = text.match(/^\/btw(?:\s+([\s\S]*))?$/);
  if (btw || (isLive() && state.askMode === 'ask')) {
    const question = btw ? (btw[1] || '').trim() : text;
    if (!question) { setError(ui.composerError, '用法：/btw 你的问题'); return; }
    if (ready.length) { setError(ui.composerError, '旁路提问不能带附件'); return; }
    askSide(question);
    return;
  }
  if (isLive()) { sendFollowup(text, ready); return; }
  state.sending = true;
  const saved = { text: ui.input.value, attachments: state.attachments.slice() };
  const draft = !state.conv;
  if (draft) {
    state.conv = {
      id: null, title: '', messages: [], leafId: null, settings: null, projectId: state.draftProject, btw: [], pending: true,
    };
  }
  const conv = state.conv;
  const path = visiblePath();
  const parentId = path.length ? path[path.length - 1].id : null;
  const temp = {
    id: localId(), role: 'user', parentId, createdAt: new Date().toISOString(), status: 'sending',
    parts: [{ type: 'text', text }], attachments: ready.map((a) => ({ id: a.id, name: a.name, type: a.type, size: a.size, image: a.image })),
  };
  const prevLeaf = conv.leafId;
  conv.messages.push(temp);
  conv.leafId = temp.id;
  ui.input.value = '';
  state.attachments = [];
  renderAttachments();
  autosize();
  render(true);
  let retryOffline = false;
  try {
    const attachments = ready.map((a) => a.id);
    let res;
    if (draft) {
      res = await api('/api/conversations', {
        method: 'POST', body: { ...selBody(), projectId: conv.projectId || undefined, message: { text, attachments }, ...extra },
      });
      Object.assign(conv, res.conversation, { pending: false });
      if (state.conv === conv) history.replaceState(null, '', `#${conv.id}`);
    } else {
      res = await api(`/api/conversations/${conv.id}/messages`, {
        method: 'POST', body: { text, parentId, attachments, ...selBody(), ...extra },
      });
    }
    conv.messages = conv.messages.filter((m) => m !== temp);
    conv.messages.push(res.userMessage, res.assistantMessage);
    for (const a of saved.attachments) if (a.url) URL.revokeObjectURL(a.url);
    if (state.conv !== conv) { refreshList(); return; }
    if (!conv.title) conv.title = (text || ready[0]?.name || '').slice(0, 40);
    afterStart(res);
  } catch (err) {
    conv.messages = conv.messages.filter((m) => m !== temp);
    conv.leafId = prevLeaf;
    if (state.conv !== conv) return;
    if (draft) state.conv = null;
    const restored = restoreComposer(saved.text, saved.attachments);
    render();
    if (err.status === 409 && err.data?.remoteOffline && restored) retryOffline = `${err.data.machine || '这台电脑'} `;
    else if (err.status !== 401) setError(ui.composerError, `发送失败：${err.message}${restored ? '。内容已放回输入框，可以重试' : ''}`);
  } finally {
    state.sending = false;
    updateChrome();
  }
  // The project's computer is offline: ask before sending anyway (Claude is told so).
  if (retryOffline && await confirmDialog('远程机器离线', `${retryOffline}当前离线，Claude 无法访问项目文件。仍然发送吗？发送后会告诉 Claude 这台电脑离线，不让它反复尝试连接。`, '仍然发送', false)) send({ ignoreOffline: true });
}

/** Adds to the running reply; Claude Code picks it up after the step it is on. */
async function sendFollowup(text, ready) {
  const conv = state.conv;
  const msgId = state.run.messageId;
  const saved = { text: ui.input.value, attachments: state.attachments.slice() };
  const temp = {
    id: localId(), text, createdAt: new Date().toISOString(), sending: true,
    attachments: ready.map((a) => ({ id: a.id, name: a.name, type: a.type, size: a.size, image: a.image })),
  };
  const msg = byId().get(msgId);
  if (msg) { msg.queued = [...(msg.queued || []), temp]; scheduleMessageRender(msg); }
  ui.input.value = '';
  state.attachments = [];
  renderAttachments();
  autosize();
  state.sending = true;
  updateChrome();
  try {
    const { followup } = await api(`/api/conversations/${conv.id}/followups`, {
      method: 'POST', body: { text, attachments: ready.map((a) => a.id) },
    });
    for (const a of saved.attachments) if (a.url) URL.revokeObjectURL(a.url);
    // The stream usually reports it too; whichever comes first shows it.
    const m = conv.messages.find((x) => x.id === msgId);
    if (m) {
      m.queued = (m.queued || []).filter((q) => q !== temp);
      if (!m.queued.some((q) => q.id === followup.id) && !m.parts.some((p) => p.id === followup.id)) m.queued.push(followup);
      if (state.conv === conv) scheduleMessageRender(m);
    }
  } catch (err) {
    const m = conv.messages.find((x) => x.id === msgId);
    if (m) m.queued = (m.queued || []).filter((q) => q !== temp);
    if (state.conv !== conv) return;
    if (m) scheduleMessageRender(m);
    const restored = restoreComposer(saved.text, saved.attachments);
    if (err.status !== 401) setError(ui.composerError, `${err.message}${restored ? '（内容已放回输入框）' : ''}`);
  } finally {
    state.sending = false;
    updateChrome();
  }
}

/* ---------- side questions (/btw) ---------- */

const sidePolls = new Map();

/** Asks a side question: answered right away by a separate read-only session. */
async function askSide(question) {
  const conv = state.conv;
  if (!conv?.id || !visiblePath().length) { setError(ui.composerError, '先发一条消息，再旁路提问'); return; }
  const anchorId = isLive() ? state.run.messageId : conv.leafId;
  const temp = { id: localId(), question, answer: '', status: 'running', anchorId, createdAt: new Date().toISOString() };
  conv.btw = [...(conv.btw || []), temp];
  const savedText = ui.input.value;
  ui.input.value = '';
  autosize();
  render();
  try {
    const { btw } = await api(`/api/conversations/${conv.id}/btw`, { method: 'POST', body: { text: question } });
    if (state.conv?.id !== conv.id) return;
    state.conv.btw = (state.conv.btw || []).filter((b) => b !== temp && b.id !== btw.id).concat(btw);
    render();
    pollSide(btw.id);
  } catch (err) {
    conv.btw = (conv.btw || []).filter((b) => b !== temp);
    if (state.conv !== conv) return;
    render();
    const restored = restoreComposer(savedText);
    if (err.status !== 401) setError(ui.composerError, `${err.message}${restored ? '（问题已放回输入框）' : ''}`);
  }
}

function pollRunningSide() {
  for (const b of state.conv?.btw || []) if (b.status === 'running' && !b.id.startsWith('local-')) pollSide(b.id);
}

/** Follows one side question until it is answered (the answer text grows as it streams). */
function pollSide(id) {
  if (sidePolls.has(id)) return;
  const convId = state.conv.id;
  const stop = () => { clearTimeout(sidePolls.get(id)); sidePolls.delete(id); };
  const tick = async () => {
    if (state.conv?.id !== convId) { stop(); return; }
    try {
      const { btw } = await api(`/api/conversations/${convId}/btw/${id}`);
      const list = state.conv?.id === convId ? state.conv.btw || [] : [];
      const i = list.findIndex((b) => b.id === id);
      if (i < 0) { stop(); return; }
      const changed = list[i].answer !== btw.answer || list[i].status !== btw.status;
      list[i] = btw;
      if (changed) updateBtw(btw);
      if (btw.status !== 'running') {
        stop();
        if (btw.status === 'done') announce('旁路提问已回答');
        return;
      }
    } catch (err) {
      if (err.status === 404 || err.status === 401) { stop(); return; }
    }
    sidePolls.set(id, setTimeout(tick, 900));
  };
  sidePolls.set(id, setTimeout(tick, 500));
}

function updateBtw(b) {
  const node = ui.messages.querySelector(`[data-btw="${CSS.escape(b.id)}"]`);
  if (!node) return;
  node.replaceWith(btwCard(b));
  if (state.stick) scrollToBottom();
}

function btwCard(b) {
  const box = el('section', `btw btw-${b.status}`);
  box.dataset.btw = b.id;
  box.setAttribute('aria-label', '旁路提问');
  const head = el('div', 'btw-head');
  head.append(icon('question', 16), el('span', 'btw-label', '旁路提问'), el('span', 'btw-sub', '不打断主任务，也不进入对话上下文'));
  const actions = el('span', 'btw-actions');
  if (b.status === 'done' && b.answer) {
    const bring = el('button', 'link-btn', '带入对话');
    bring.type = 'button';
    bring.dataset.action = 'btw-bring';
    bring.dataset.id = b.id;
    bring.title = '把这条问答放进输入框，作为下一条消息的背景';
    actions.append(bring);
  }
  if (!b.id.startsWith('local-')) {
    const x = iconButton('x', '删除这条旁路问答', 'icon-btn btw-x');
    x.dataset.action = 'btw-remove';
    x.dataset.id = b.id;
    actions.append(x);
  }
  head.append(actions);
  box.append(head, el('div', 'btw-q', b.question));
  const ans = el('div', 'btw-a');
  if (b.answer) {
    const md = el('div', 'md');
    md.append(renderMarkdown(b.answer, document, { highlight: (code, lang) => highlight(document, code, lang) }));
    ans.append(md);
  }
  if (b.status === 'running') {
    const wait = el('p', 'btw-wait');
    wait.append(thinkingDots(), el('span', '', b.answer ? '' : '正在回答…'));
    ans.append(wait);
  } else if (b.status === 'error') ans.append(el('p', 'btw-error', `没有回答：${b.error || '未知错误'}`));
  box.append(ans);
  return box;
}

const quoteLines = (text) => text.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n');

/** Appends a block (a quote, a side answer) to the composer, after what is already typed. */
function appendToComposer(block) {
  const cur = ui.input.value.replace(/\s+$/, '');
  ui.input.value = `${cur ? `${cur}\n\n` : ''}${block}\n`;
  autosize();
  ui.input.focus();
  const end = ui.input.value.length;
  ui.input.setSelectionRange(end, end);
  ui.input.scrollTop = ui.input.scrollHeight;
  ui.input.dispatchEvent(new Event('input'));
}

function bringBtw(id) {
  const b = (state.conv?.btw || []).find((x) => x.id === id);
  if (!b) return;
  appendToComposer(`（以下是刚才的一条旁路问答，供参考）\n${quoteLines(`问：${b.question}`)}\n>\n${quoteLines(`答：${b.answer}`)}`);
}

async function removeBtw(id) {
  const conv = state.conv;
  try {
    await api(`/api/conversations/${conv.id}/btw/${id}`, { method: 'DELETE' });
  } catch (err) {
    if (err.status !== 404) { if (err.status !== 401) toast(err.message); return; }
  }
  conv.btw = (conv.btw || []).filter((b) => b.id !== id);
  if (state.conv === conv) render();
}

/* ---------- quoting a selection ---------- */

const quoteBtn = el('button', 'quote-btn');
quoteBtn.type = 'button';
quoteBtn.hidden = true;
quoteBtn.append(icon('quote', 16), el('span', '', '引用'));
quoteBtn.setAttribute('aria-label', '引用选中的内容到输入框');
let pendingQuote = null;
let quoteHide = null;
let selecting = false;

/** The selected text in the chat as a Markdown quote (code stays a code block), or null. */
function selectionQuote() {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const anc = node.nodeType === 1 ? node : node.parentElement;
  if (!anc || !ui.messages.contains(anc) || anc.closest('.edit-box, textarea, button')) return null;
  const raw = sel.toString().replace(/[​‎‏]/g, '');
  if (!raw.trim()) return null;
  const pre = anc.closest('pre');
  let text;
  if (pre) {
    const lang = pre.closest('.code-block')?.querySelector('.code-lang')?.textContent || '';
    const body = raw.replace(/^\n+|\s+$/g, '');
    const fence = body.includes('```') ? '````' : '```';
    text = `${fence}${lang && lang !== '代码' ? lang : ''}\n${body}\n${fence}`;
  } else {
    text = quoteLines(raw.trim().replace(/\n{3,}/g, '\n\n'));
  }
  return { text, rect: range.getBoundingClientRect() };
}

function placeQuoteBtn() {
  clearTimeout(quoteHide);
  const q = selecting ? null : selectionQuote();
  if (!q) {
    // A short grace period: on phones tapping the button can clear the selection first.
    quoteHide = setTimeout(() => { quoteBtn.hidden = true; pendingQuote = null; }, 300);
    return;
  }
  pendingQuote = q.text;
  quoteBtn.hidden = false;
  const w = quoteBtn.offsetWidth;
  const hgt = quoteBtn.offsetHeight;
  let left;
  let top;
  if (coarse.matches) {
    // Above the composer, away from the system's copy / select-all menu.
    const r = ui.composer.getBoundingClientRect();
    left = r.left + (r.width - w) / 2;
    top = r.top - hgt - 10;
  } else {
    const r = q.rect;
    left = r.left + (r.width - w) / 2;
    top = r.top - hgt - 8;
    if (top < 8) top = r.bottom + 8;
  }
  quoteBtn.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, left))}px`;
  quoteBtn.style.top = `${Math.max(8, top)}px`;
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
    if (file.size > 50 * 1024 * 1024) { toast(`${file.name || '文件'} 超过 50 MB`); continue; }
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

function newChat(projectId = null) {
  startDraft(projectId);
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
  if (!ui.send.disabled) send();
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
initFiles({
  api, toast, openViewer, mdImage: readerImage, machines, closeOthers: () => { closeBrowser({ focus: false }); closeTerminal({ focus: false }); },
});
initMachines({ api, toast, confirm: (title, text) => confirmDialog(title, text, '删除', true) });
onMachinesChange(() => { if (authed) updateChrome(); });
initTerminal({ api, toast, claudeCommands, loadCommandIndex,
  loadClaudeCommand: (id) => {
    const command = claudeCommands().find((c) => c.id === id);
    return command ? loadToolDetail(command.messageId, id) : Promise.resolve();
  }, closeOthers: () => { closeBrowser({ focus: false }); closeFiles({ focus: false }); } });
const PANELS = { files: openFiles, terminal: openTerminal, browser: openBrowser };
for (const b of document.querySelectorAll('.panel-tab[data-panel]')) b.addEventListener('click', () => PANELS[b.dataset.panel]());
initExtras({
  api, toast, openMenu, newChat: () => newChat(currentProject()?.id || null), openModelPop, openBrowser, openFiles, openTerminal, pickFiles, setComposer, sendCommand,
  input: () => ui.input,
  currentConv: () => (state.conv?.id ? { id: state.conv.id, live: isLive() } : null),
  models: () => state.models,
  prefs: () => state.prefs || { model: 'default', effort: null },
  setPrefs: (p) => { state.prefs = { ...state.prefs, ...p }; updateModelChrome(); },
  rerender: () => { imageNodes.clear(); render(); },
  confirm: (title, text) => confirmDialog(title, text, '删除', true),
  openConversation: (id) => { if (narrow.matches) setDrawer(false); openConversation(id); },
  renameCurrent: () => (state.conv?.id ? renameConversation(state.conv.id, state.conv.title || '') : toast('当前还没有对话')),
});
ui.fileInput.addEventListener('change', () => {
  addFiles([...ui.fileInput.files]);
  ui.fileInput.value = '';
});
ui.stop.addEventListener('click', stop);
// The new chat buttons stay in the current project, as in its sidebar section.
for (const b of [ui.newChat, ui.sbNew, ui.topNew]) b.addEventListener('click', () => newChat(b === ui.newChat ? null : currentProject()?.id || null));
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
  if (e.target.closest('[data-action="new-project"]')) { newProject(); return; }
  const pmore = e.target.closest('.proj-more');
  if (pmore) { projectMenu(pmore, pmore.dataset.project); return; }
  const pnew = e.target.closest('.proj-new');
  if (pnew) { newChat(pnew.dataset.project); return; }
  const pitem = e.target.closest('.proj-item');
  if (pitem) { toggleProject(pitem.dataset.project); return; }
  const more = e.target.closest('.conv-more');
  if (more) { convMenu(more, more.dataset.id); return; }
  const btn = e.target.closest('.conv-item');
  if (!btn) return;
  if (narrow.matches) setDrawer(false);
  if (btn.dataset.id !== state.conv?.id) openConversation(btn.dataset.id);
});
ui.convMenuBtn.addEventListener('click', () => state.conv && convMenu(ui.convMenuBtn, state.conv.id));
/**
 * A path a reply names that lives on one of the owner's computers: inside the remote project's
 * folder, or a Windows path inside a machine's allowed folders. Null otherwise (a host path).
 */
function remoteTarget(raw) {
  let p = String(raw || '').trim().replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(p)) p = `/${p}`;
  if (!p.startsWith('/')) return null;
  const win = /^\/[A-Za-z]:/.test(p);
  const fold = (x) => (/^\/[A-Za-z]:/.test(x) ? x.toLowerCase() : x);
  const candidates = [];
  const project = currentProject();
  if (project?.remote) candidates.push({ machineId: project.remote.machineId, root: project.remote.path, label: project.remote.machine || '' });
  if (win) for (const m of machines()) for (const r of m.roots) candidates.push({ machineId: m.id, root: r.path, label: m.name });
  for (const c of candidates) {
    const root = c.root.replace(/\/$/, '');
    if (fold(p) === fold(root) || fold(p).startsWith(`${fold(root)}/`)) return { ...c, rel: p.slice(root.length).replace(/^\//, '') };
  }
  return null;
}

function openReplyPath(path) {
  const t = remoteTarget(path);
  if (t && t.rel) openRemote(t.machineId, t.root, t.rel, t.label);
  else openPath(path, state.conv?.id || null);
}

ui.messages.addEventListener('click', (e) => {
  const modified = e.ctrlKey || e.metaKey || e.shiftKey;
  const pathLink = e.target.closest('.path-link');
  if (pathLink) {
    if (modified && pathLink.href) return;
    e.preventDefault();
    openReplyPath(pathLink.dataset.path);
    return;
  }
  const toolOpen = e.target.closest('.tool-open');
  if (toolOpen) { showClaudeCommand(toolOpen.dataset.tool); return; }
  const view = e.target.closest('a[data-view]');
  if (view && !modified) {
    e.preventDefault();
    const g = galleryOf(ui.messages, view);
    openViewer(view.href, view.dataset.view, g.list, g.index);
    return;
  }
  const upload = e.target.closest('a[data-upload]');
  if (upload && !modified) {
    e.preventDefault();
    openUpload(upload.dataset.upload, upload.dataset.name);
    return;
  }
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === 'approve') decide(btn);
  else if (action === 'copy-code') copyCode(btn);
  else if (action === 'copy-msg') {
    loadFullText(byId().get(id)).then((msg) => copyText(textOf(msg), btn))
      .catch((err) => { if (err.name !== 'AbortError' && err.status !== 401) toast(err.message); });
  }
  else if (action === 'edit') { state.editing = id; render(); }
  else if (action === 'regenerate') regenerate(id);
  else if (action === 'branch') switchBranch(id, Number(btn.dataset.dir));
  else if (action === 'open-browser') openBrowser();
  else if (action === 'refill') setComposer(btn.dataset.text || '');
  else if (action === 'btw-bring') bringBtw(id);
  else if (action === 'btw-remove') removeBtw(id);
});
ui.messages.addEventListener('keydown', (e) => {
  const pathLink = e.key === 'Enter' && e.target.closest('.path-link');
  if (pathLink) { e.preventDefault(); openReplyPath(pathLink.dataset.path); }
});
// Quoting: select text in a message, then 引用 adds it to the composer as a Markdown quote.
document.body.append(quoteBtn);
quoteBtn.addEventListener('pointerdown', (e) => e.preventDefault());
quoteBtn.addEventListener('click', () => {
  if (!pendingQuote) return;
  appendToComposer(pendingQuote);
  document.getSelection()?.removeAllRanges();
  quoteBtn.hidden = true;
  pendingQuote = null;
});
let quoteRaf = null;
const schedulePlaceQuote = () => {
  if (quoteRaf) return;
  quoteRaf = requestAnimationFrame(() => { quoteRaf = null; placeQuoteBtn(); });
};
document.addEventListener('selectionchange', schedulePlaceQuote);
// With a mouse the button appears once the drag ends.
ui.messages.addEventListener('mousedown', (e) => { if (e.button === 0) { selecting = true; quoteBtn.hidden = true; } });
document.addEventListener('mouseup', () => { if (selecting) { selecting = false; schedulePlaceQuote(); } });
ui.scroller.addEventListener('scroll', () => { if (!quoteBtn.hidden) schedulePlaceQuote(); }, { passive: true });
// 补充 / 提问 while a reply runs.
ui.askMode.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  state.askMode = b.dataset.mode;
  updateChrome();
  ui.input.focus();
});
ui.askMode.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault();
  state.askMode = state.askMode === 'add' ? 'ask' : 'add';
  updateChrome();
  ui.askMode.querySelector(`[data-mode="${state.askMode}"]`)?.focus();
});
// Queued messages name the step they wait for and how long it has run: keep that current.
setInterval(() => {
  const m = isLive() ? runMessage() : null;
  if (m?.queued?.length) scheduleMessageRender(m);
}, 30000);
// A web image waiting for a tap (外链图片: 点击后显示), in replies and in the reader.
document.addEventListener('click', (e) => {
  const b = e.target.closest('.md-img-load');
  if (!b) return;
  revealed.add(b.dataset.url);
  b.replaceWith(mdImage({ url: b.dataset.url, alt: b.dataset.alt, block: b.dataset.block === '1', remote: true, src: b.dataset.alt }));
});
$('viewer-prev').addEventListener('click', () => stepViewer(-1));
$('viewer-next').addEventListener('click', () => stepViewer(1));
$('image-viewer').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { e.preventDefault(); stepViewer(-1); } else if (e.key === 'ArrowRight') { e.preventDefault(); stepViewer(1); }
});
{
  let x0 = null;
  const stage = $('image-viewer');
  stage.addEventListener('touchstart', (e) => { x0 = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (x0 === null || gallery.list.length < 2) return;
    const dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 50) { stepViewer(dx < 0 ? 1 : -1); e.preventDefault(); }
  });
}
ui.projChip.addEventListener('click', () => openFiles());
ui.projectForm.addEventListener('submit', (e) => { e.preventDefault(); createProject(); });
ui.projectLoc.addEventListener('change', projectLocation);
$('project-cancel').addEventListener('click', () => ui.projectDialog.close());
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
