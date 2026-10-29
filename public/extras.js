// Settings (account + plan usage), scheduled tasks, the "/" command palette and the "+" menu.
// Everything shown here comes from the backend; nothing is invented client-side.
import { icon } from './icons.js';

let h = null; // hooks from app.js
const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}
function button(text, cls, onClick, iconName) {
  const b = el('button', cls);
  b.type = 'button';
  if (iconName) b.append(icon(iconName, 16));
  b.append(el('span', '', text));
  b.addEventListener('click', onClick);
  return b;
}

/* ---------------- time formatting ---------------- */

const pad = (n) => String(n).padStart(2, '0');
function partsIn(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), t: `${p.hour}:${p.minute}` };
}
/** Relative day + time; `tz` shows it in that zone (task times use the server's), else device time. */
function when(iso, tz) {
  if (!iso) return '—';
  let a;
  let b;
  try {
    a = partsIn(new Date(iso), tz);
    b = partsIn(new Date(), tz);
  } catch {
    a = partsIn(new Date(iso));
    b = partsIn(new Date());
  }
  const diff = Math.round((Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d)) / 86400000);
  if (diff === 0) return `今天 ${a.t}`;
  if (diff === 1) return `明天 ${a.t}`;
  if (diff === -1) return `昨天 ${a.t}`;
  return `${a.m}月${a.d}日 ${a.t}`;
}
function until(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return '即将重置';
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440);
  const hr = Math.floor((m % 1440) / 60);
  const mi = m % 60;
  if (d) return `${d} 天 ${hr} 小时后`;
  if (hr) return `${hr} 小时 ${mi} 分后`;
  return `${mi} 分钟后`;
}

/* ================= settings ================= */

const LIMIT_LABEL = {
  session: '5 小时额度', weekly_all: '每周额度（所有模型）', weekly_opus: '每周额度（Opus）', weekly_sonnet: '每周额度（Sonnet）',
};
const limitLabel = (l) => LIMIT_LABEL[l.kind] || (l.group === 'weekly' ? `每周额度（${l.scope || l.kind}）` : l.kind);

const settings = { data: null, error: '', loading: false };

export function openSettings() {
  const dlg = $('settings-dialog');
  if (!dlg.open) dlg.showModal();
  renderSettings();
  loadAccount(false);
}

async function loadAccount(force) {
  settings.loading = true;
  settings.error = '';
  renderSettings();
  try {
    settings.data = await h.api(`/api/account${force ? '?refresh=1' : ''}`);
  } catch (err) {
    if (err.status === 401) return;
    settings.error = err.message;
  } finally {
    settings.loading = false;
    renderSettings();
  }
}

function section(title, ...extra) {
  const s = el('section', 'sheet-section');
  const head = el('div', 'sheet-section-head');
  head.append(el('h3', 'sheet-h', title), ...extra);
  s.append(head);
  return s;
}

function renderSettings() {
  const body = $('settings-body');
  body.replaceChildren();
  const { data, error, loading } = settings;

  const stamp = el('span', 'sheet-meta', data ? `更新于 ${when(data.fetchedAt)}` : '');
  const refresh = button(loading ? '读取中…' : '刷新', 'link-btn', () => loadAccount(true));
  refresh.disabled = loading;
  const usage = section('用量', stamp, refresh);
  if (error) usage.append(el('p', 'sheet-error', `读取失败：${error}`));
  if (!data && !error) usage.append(el('p', 'sheet-muted', '正在读取…'));
  if (data && !data.usage.available) usage.append(el('p', 'sheet-muted', '暂时拿不到用量数据。'));
  for (const l of data?.usage.limits || []) {
    const row = el('div', 'usage-row');
    const top = el('div', 'usage-top');
    top.append(el('span', 'usage-name', limitLabel(l)), el('span', 'usage-pct', l.percent === null ? '—' : `已用 ${l.percent}%`));
    const bar = el('div', 'usage-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', limitLabel(l));
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(l.percent ?? 0));
    const fill = el('span', `usage-fill${(l.percent ?? 0) >= 90 || l.severity === 'critical' ? ' crit' : (l.percent ?? 0) >= 75 || l.severity === 'warning' ? ' warn' : ''}`);
    fill.style.width = `${l.percent ?? 0}%`;
    bar.append(fill);
    row.append(top, bar);
    if (l.resetsAt) row.append(el('p', 'usage-reset', `${when(l.resetsAt)} 重置（${until(l.resetsAt)}）`));
    usage.append(row);
  }
  if (data?.usage.available) {
    const xu = data.usage.extraUsage;
    usage.append(el('p', 'sheet-muted', xu.enabled
      ? `额外用量：已开启${xu.utilization !== null ? `，已用 ${xu.utilization}%` : ''}`
      : '额外用量：未开启（额度用完后会暂停，等重置，不会额外扣费）'));
  }
  body.append(usage);

  body.append(permissionSection(), runSection(), notifySection());

  const acct = section('账号');
  const dl = el('dl', 'kv');
  const kv = (k, v) => { if (v) dl.append(el('dt', '', k), el('dd', '', v)); };
  kv('邮箱', data?.account.email);
  kv('套餐', data?.account.plan);
  kv('组织', data?.account.organization);
  if (dl.children.length) acct.append(dl);
  else acct.append(el('p', 'sheet-muted', data ? '没有账号信息' : '正在读取…'));
  body.append(acct);

  const about = section('关于');
  const dl2 = el('dl', 'kv');
  if (data?.version) dl2.append(el('dt', '', 'Claude Code'), el('dd', '', data.version));
  dl2.append(el('dt', '', '网址'), el('dd', '', location.host));
  about.append(dl2, el('p', 'sheet-muted', '用量和账号直接读取自 Claude Code（与终端里的 /usage 相同），读取不会调用模型，也不消耗额度。'));
  // Fixed slot so the async share list cannot land out of order across re-renders.
  const sharesSlot = el('div');
  body.append(sharesSlot, about);
  renderSharesSection(sharesSlot);
}

/* ================= notifications ================= */

const NOTIFY_KEY = 'aw.notify';
const notifySupported = () => typeof Notification !== 'undefined';
function notifyEnabled() {
  try { return localStorage.getItem(NOTIFY_KEY) === '1'; } catch { return false; }
}

/**
 * Called when a reply finishes or needs approval. Only while the page is in the background:
 * marks the tab title and, if the owner turned it on, shows a system notification.
 */
export function notify(text) {
  if (document.visibilityState === 'visible') return;
  if (!document.title.startsWith('● ')) document.title = `● ${document.title}`;
  if (!notifyEnabled() || !notifySupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification('MambaBot', { body: text, tag: 'assistant-web', icon: '/icon.svg' });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* e.g. Android Chrome without a service worker */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && document.title.startsWith('● ')) document.title = document.title.slice(2);
});

function notifySection() {
  const sec = section('提醒');
  const opt = el('label', 'perm-opt');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = notifyEnabled() && notifySupported() && Notification.permission === 'granted';
  const text = el('span', 'perm-text');
  text.append(el('span', 'perm-label', '系统通知'), el('span', 'perm-desc', '网页在后台时，回复完成、出错或需要你授权，就发一条系统通知。标签页标题前的 ● 不用开也会有。只在这台设备上生效。'));
  opt.append(box, text);
  const note = el('p', 'sheet-muted');
  const explain = () => {
    if (!notifySupported()) note.textContent = '这个浏览器不支持网页通知。iPhone 需要先把网页“添加到主屏幕”，再从主屏幕打开。';
    else if (Notification.permission === 'denied') note.textContent = '浏览器已拒绝本网站的通知，需要在浏览器的网站设置里重新允许。';
    else note.textContent = '';
    note.hidden = !note.textContent;
  };
  box.disabled = !notifySupported();
  box.addEventListener('change', async () => {
    let on = box.checked;
    if (on && Notification.permission !== 'granted') on = (await Notification.requestPermission()) === 'granted';
    box.checked = on;
    try { localStorage.setItem(NOTIFY_KEY, on ? '1' : '0'); } catch { /* private mode */ }
    explain();
    if (on) h.toast('已开启通知');
  });
  explain();
  sec.append(opt, note);
  return sec;
}

/* ================= Markdown export ================= */

/** Downloads the chat's current branch as Markdown (text, shown/attached file names). */
export async function exportMarkdown(id) {
  let conv;
  try {
    conv = (await h.api(`/api/conversations/${id}`)).conversation;
  } catch (err) {
    if (err.status !== 401) h.toast(err.message);
    return;
  }
  const byId = new Map(conv.messages.map((m) => [m.id, m]));
  const path = [];
  for (let m = byId.get(conv.leafId); m; m = byId.get(m.parentId)) path.unshift(m);
  const title = conv.title || '新对话';
  const out = [`# ${title}`, '', `导出于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`, ''];
  for (const m of path) {
    out.push(m.role === 'user' ? '## 我' : '## Claude', '');
    for (const a of m.attachments || []) out.push(`> 附件：${a.name}`);
    for (const p of m.parts) {
      if (p.type === 'text' && p.text) out.push(p.text, '');
      else if (p.type === 'file' && p.attachment) out.push(`> 展示的文件：${p.attachment.name}${p.caption ? `（${p.caption}）` : ''}`, '');
      else if (p.type === 'compact' && p.state === 'done') out.push('*（上下文已压缩）*', '');
      else if (p.type === 'notice') out.push(`> ${p.text}`, '');
    }
    if (m.error) out.push(`> ${m.error}`, '');
  }
  const blob = new Blob([`${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`], { type: 'text/markdown;charset=utf-8' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'chat'}.md`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ================= permissions ================= */

const PERM_OPTIONS = [
  ['manual', '逐条确认', '每个需要授权的操作都弹出卡片，由你允许或拒绝。最稳妥，也最费事。'],
  ['acceptEdits', '自动允许改文件', '读写、编辑文件直接放行；运行命令、联网等其他操作仍需你确认。'],
  ['auto', '自动判断', '由 Claude Code 判断风险：常规操作直接执行，拿不准的仍会弹卡片问你。'],
  ['bypassPermissions', '完全放行', '所有操作直接执行，包括用 sudo 以 root 运行的命令，不再弹授权卡片。'],
];

function permissionSection() {
  const sec = section('权限');
  const current = h.prefs().permissionMode || 'auto';
  const group = el('div', 'perm-list');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', '权限模式');
  const warn = el('p', 'perm-warn', '完全放行时，能登录这个网页的人、每个定时任务，以及助理浏览网页时读到的内容，都可能直接以 root 执行命令，中间不会再停下来问你。请保管好登录密钥。助理仍会在删除数据、改系统配置、对外发送之前先在回复里问你。');
  warn.hidden = current !== 'bypassPermissions';
  for (const [value, label, desc] of PERM_OPTIONS) {
    const opt = el('label', `perm-opt${value === 'bypassPermissions' ? ' risky' : ''}`);
    const r = el('input');
    r.type = 'radio';
    r.name = 'perm-mode';
    r.value = value;
    r.checked = value === current;
    const text = el('span', 'perm-text');
    text.append(el('span', 'perm-label', label), el('span', 'perm-desc', desc));
    opt.append(r, text);
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      group.querySelectorAll('input').forEach((x) => { x.disabled = true; });
      try {
        const { prefs } = await h.api('/api/prefs', { method: 'PUT', body: { permissionMode: value } });
        h.setPrefs(prefs);
        warn.hidden = value !== 'bypassPermissions';
        h.toast(`已切换为“${label}”，从下一条回复开始生效`);
      } catch (err) {
        if (err.status !== 401) h.toast(err.message);
        group.querySelector(`input[value="${h.prefs().permissionMode || 'auto'}"]`).checked = true;
      } finally {
        group.querySelectorAll('input').forEach((x) => { x.disabled = false; });
      }
    });
    group.append(opt);
  }
  sec.append(group, warn, el('p', 'sheet-muted', '对所有对话和定时任务生效；正在进行的回复保持原来的模式。'));
  return sec;
}

/* ================= concurrency ================= */

const PER_RUN_MB = 400; // observed ~300–400 MB per Claude Code process on this host

function runSection() {
  const sec = section('同时进行的回复');
  const row = el('div', 'inline-row');
  const sel = el('select');
  sel.id = 'max-runs';
  sel.setAttribute('aria-label', '最多同时进行的回复数');
  const info = el('p', 'sheet-muted', '读取中…');
  row.append(el('label', 'run-label', '最多'), sel, el('span', '', '个'));
  sec.append(row, info);
  (async () => {
    let sys;
    try { sys = await h.api('/api/system'); } catch (err) { if (err.status !== 401) info.textContent = err.message; return; }
    for (let n = 1; n <= sys.maxRunsCap; n += 1) { const o = el('option', '', String(n)); o.value = String(n); sel.append(o); }
    sel.value = String(sys.maxRuns);
    const gb = (mb) => (mb / 1024).toFixed(1);
    const suggest = sys.memAvailableMb ? Math.max(1, Math.min(sys.maxRunsCap, Math.floor((sys.memAvailableMb + sys.activeRuns * PER_RUN_MB) / PER_RUN_MB))) : null;
    info.textContent = `超过上限的新消息会提示稍后再试，到点的定时任务会顺延（最多 30 分钟）。每条进行中的回复约占 300–400 MB 内存，浏览器开着时另占约 0.5–1 GB。`
      + (sys.memTotalMb ? `服务器现在可用 ${gb(sys.memAvailableMb)} GB / 共 ${gb(sys.memTotalMb)} GB，进行中 ${sys.activeRuns} 个${suggest ? `，按当前内存估算建议不超过 ${suggest} 个` : ''}。内存不够时 Linux 会直接杀掉进程（没有 swap）。` : '');
    sel.addEventListener('change', async () => {
      sel.disabled = true;
      try {
        const { prefs } = await h.api('/api/prefs', { method: 'PUT', body: { maxRuns: Number(sel.value) } });
        h.setPrefs(prefs);
        h.toast(`最多同时 ${prefs.maxRuns} 个回复`);
      } catch (err) {
        if (err.status !== 401) h.toast(err.message);
        sel.value = String(sys.maxRuns);
      } finally {
        sel.disabled = false;
      }
    });
  })();
  return sec;
}

/* ================= model labels ================= */

const EFFORT_LABEL = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };
const findModel = (value) => h.models().find((m) => m.value === value) || null;

/** What a task will actually run with; null fields follow the owner's current default. */
function selText(model, effort) {
  const prefs = h.prefs();
  const m = findModel(model || prefs.model || 'default');
  const name = m?.displayName || model || prefs.model || 'default';
  const eff = effort || (model ? null : prefs.effort);
  const effText = eff ? (EFFORT_LABEL[eff] || eff) : '模型默认强度';
  if (model) return `${name} · ${effText}`;
  if (effort) return `默认模型（当前 ${name}）· ${effText}`;
  return `跟随默认（当前 ${name} · ${effText}）`;
}

/* ================= sharing ================= */

const shareUrl = (token) => `${location.origin}/s/${token}`;

/** Create / copy / refresh / revoke the read-only link of one conversation. */
export async function openShare(convId) {
  const dlg = $('share-dialog');
  const body = $('share-body');
  let share = null;
  let busy = false;
  const render = (error = '') => {
    body.replaceChildren();
    if (!share) {
      body.append(el('p', 'dialog-text', '生成一个只读链接，拿到链接的人不用登录就能看到当前这条分支到此刻为止的对话文字。不会包含附件文件、工具的输入输出和授权细节；之后的新消息也不会自动出现在链接里。'));
    } else {
      const row = el('div', 'share-link');
      const input = el('input');
      input.readOnly = true;
      input.value = shareUrl(share.token);
      input.setAttribute('aria-label', '分享链接');
      input.addEventListener('focus', () => input.select());
      row.append(input, button('复制', 'btn btn-primary btn-sm', async () => {
        try { await navigator.clipboard.writeText(input.value); h.toast('链接已复制'); } catch { input.select(); h.toast('请手动复制'); }
      }, 'copy'));
      body.append(row, el('p', 'sheet-muted', `快照时间 ${when(share.updatedAt)} · ${share.messageCount} 条消息。对话之后有新内容，可以点“更新为当前内容”，链接不变。`));
    }
    if (error) body.append(el('p', 'sheet-error', error));
    const actions = el('div', 'share-actions');
    if (share) {
      const stop = button('停止分享', 'btn btn-ghost danger-text', () => act('DELETE', '已停止分享，旧链接失效'));
      actions.append(stop, el('span', 'spacer'));
    }
    actions.append(button('关闭', 'btn btn-ghost', () => dlg.close()));
    const main = button(share ? '更新为当前内容' : '创建链接', 'btn btn-primary', () => act('POST', share ? '已更新' : '链接已创建'), share ? 'refresh' : 'share');
    actions.append(main);
    for (const b of actions.querySelectorAll('button')) b.disabled = busy;
    body.append(actions);
  };
  const act = async (method, okText) => {
    busy = true;
    render();
    try {
      share = (await h.api(`/api/conversations/${convId}/share`, { method, body: method === 'POST' ? {} : undefined })).share;
      h.toast(okText);
      busy = false;
      render();
    } catch (err) {
      busy = false;
      if (err.status !== 401) render(err.message);
    }
  };
  body.replaceChildren(el('p', 'dialog-text', '读取中…'));
  if (!dlg.open) dlg.showModal();
  try {
    share = (await h.api(`/api/conversations/${convId}/share`)).share;
    render();
  } catch (err) {
    if (err.status !== 401) render(err.message);
  }
}

async function renderSharesSection(container) {
  const sec = section('已分享的对话');
  container.append(sec);
  let list;
  try {
    list = (await h.api('/api/shares')).shares;
  } catch (err) {
    if (err.status !== 401) sec.append(el('p', 'sheet-error', err.message));
    return;
  }
  if (!list.length) {
    sec.append(el('p', 'sheet-muted', '还没有分享过对话。在对话的“⋯”菜单里选“分享”即可生成只读链接。'));
    return;
  }
  const ul = el('ul', 'share-list');
  for (const s of list) {
    const li = el('li', 'share-item');
    const a = el('a', '', s.title);
    a.href = shareUrl(s.token);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    li.append(a, el('span', '', when(s.updatedAt)), button('停止分享', 'link-btn danger-text', async () => {
      try {
        await h.api(`/api/shares/${s.token}`, { method: 'DELETE' });
        h.toast('已停止分享');
        li.remove();
        if (!ul.children.length) ul.replaceWith(el('p', 'sheet-muted', '没有正在分享的对话。'));
      } catch (err) {
        if (err.status !== 401) h.toast(err.message);
      }
    }));
    ul.append(li);
  }
  sec.append(ul);
}

/* ================= scheduled tasks ================= */

const tasks = { list: [], timezone: '', view: 'list', editing: null, error: '', poll: null, loaded: false };
const zoneLabel = () => ({ 'Asia/Shanghai': '北京时间', 'Asia/Chongqing': '北京时间', 'Asia/Hong_Kong': '香港时间' }[tasks.timezone] || tasks.timezone || '服务器时区');

export function openTasks() {
  const dlg = $('tasks-dialog');
  tasks.view = 'list';
  if (!dlg.open) dlg.showModal();
  renderTasks();
  loadTasks();
  clearInterval(tasks.poll);
  tasks.poll = setInterval(() => { if (tasks.view === 'list') loadTasks(); }, 15000);
}

async function loadTasks() {
  try {
    const data = await h.api('/api/tasks');
    tasks.list = data.tasks;
    tasks.timezone = data.timezone;
    tasks.error = '';
    tasks.loaded = true;
  } catch (err) {
    if (err.status === 401) return;
    tasks.error = err.message;
  }
  if (tasks.view === 'list') renderTasks();
}

async function taskAction(fn, okText) {
  try {
    const data = await fn();
    if (data?.tasks) tasks.list = data.tasks;
    if (okText) h.toast(okText);
  } catch (err) {
    if (err.status !== 401) h.toast(err.message);
  }
  renderTasks();
}

function renderTasks() {
  const body = $('tasks-body');
  body.replaceChildren();
  if (tasks.view === 'form') { body.append(taskForm(tasks.editing)); return; }

  const bar = el('div', 'tasks-bar');
  bar.append(el('p', 'sheet-muted', `按服务器时间（${zoneLabel()}）运行。任务里需要授权的操作，仍会在对应对话里等你确认。`));
  bar.append(button('新建任务', 'btn btn-primary btn-sm', () => { tasks.view = 'form'; tasks.editing = null; renderTasks(); }, 'plus'));
  body.append(bar);
  if (tasks.error) body.append(el('p', 'sheet-error', tasks.error));
  if (!tasks.loaded) {
    if (!tasks.error) body.append(el('p', 'sheet-muted', '正在读取…'));
    return;
  }
  if (!tasks.list.length) {
    const empty = el('div', 'tasks-empty');
    empty.append(el('p', 'sheet-h', '还没有定时任务'), el('p', 'sheet-muted', '可以在这里新建，也可以直接对助理说“每天早上 9 点帮我……”，它会创建任务并请你确认。'));
    body.append(empty);
    return;
  }
  const list = el('ul', 'task-list');
  for (const t of tasks.list) list.append(taskCard(t));
  body.append(list);
}

function taskCard(t) {
  const li = el('li', `task-card${t.enabled ? '' : ' off'}`);
  const head = el('div', 'task-head');
  head.append(el('span', 'task-name', t.name));
  if (t.createdBy === 'claude') head.append(el('span', 'task-badge', '助理创建'));
  const sw = el('button', 'switch');
  sw.type = 'button';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', String(t.enabled));
  sw.setAttribute('aria-label', `${t.enabled ? '停用' : '启用'}「${t.name}」`);
  sw.addEventListener('click', () => taskAction(() => h.api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { enabled: !t.enabled } }), t.enabled ? '已停用' : '已启用'));
  head.append(sw);

  const sched = el('p', 'task-sched');
  sched.append(icon('clock', 14), el('span', '', t.scheduleText));
  if (t.enabled && t.nextRunAt) sched.append(el('span', 'task-next', `下次 ${when(t.nextRunAt, tasks.timezone)}`));
  if (!t.enabled) sched.append(el('span', 'task-next', '已停用'));
  const prompt = el('p', 'task-prompt', t.prompt);

  const meta = el('div', 'task-meta');
  if (t.lastRunAt) {
    const status = t.lastStatus === 'failed' ? `上次 ${when(t.lastRunAt, tasks.timezone)} 未能运行：${t.lastError || '未知原因'}` : `上次 ${when(t.lastRunAt, tasks.timezone)} 已运行`;
    meta.append(el('span', t.lastStatus === 'failed' ? 'task-fail' : '', status));
    if (t.lastConversationId && t.lastStatus !== 'failed') {
      meta.append(button('查看对话', 'link-btn', () => { $('tasks-dialog').close(); h.openConversation(t.lastConversationId); }));
    }
  } else {
    meta.append(el('span', '', '还没有运行过'));
  }
  meta.append(el('span', '', t.target === 'same' ? '· 写入同一个对话' : '· 每次新建对话'));
  const modelLine = el('p', 'task-model', `模型：${selText(t.model, t.effort)}`);

  const actions = el('div', 'task-actions');
  actions.append(
    button('编辑', 'btn btn-ghost btn-sm', () => { tasks.view = 'form'; tasks.editing = t; renderTasks(); }, 'pencil'),
    button('立即运行', 'btn btn-ghost btn-sm', () => taskAction(() => h.api(`/api/tasks/${t.id}/run`, { method: 'POST', body: {} }), '已开始运行'), 'arrow-up'),
    button('让助理修改', 'btn btn-ghost btn-sm', () => {
      $('tasks-dialog').close();
      h.newChat();
      h.setComposer(`请帮我修改定时任务「${t.name}」（id: ${t.id}）：`);
    }, 'edit'),
    button('删除', 'btn btn-ghost btn-sm danger-text', async () => {
      if (!(await h.confirm('删除定时任务？', `将删除“${t.name}”，之后不会再运行。已产生的对话会保留。`))) return;
      taskAction(() => h.api(`/api/tasks/${t.id}`, { method: 'DELETE' }), '已删除');
    }, 'trash'),
  );
  li.append(head, sched, modelLine, prompt, meta, actions);
  return li;
}

/* ---- schedule builder: friendly modes that compile to a 5-field cron ---- */

const MODES = [['daily', '每天'], ['weekdays', '工作日'], ['weekly', '每周'], ['interval', '每隔'], ['cron', '自定义']];
const DAYS = [['1', '一'], ['2', '二'], ['3', '三'], ['4', '四'], ['5', '五'], ['6', '六'], ['0', '日']];

function fromCron(cron) {
  const p = String(cron || '').split(' ');
  const s = { mode: 'daily', time: '09:00', days: ['1'], every: 30, unit: 'm', cron: cron || '0 9 * * *' };
  if (p.length !== 5) return s;
  const [mi, hr, dom, mon, dow] = p;
  const num = (x) => /^\d+$/.test(x);
  if (num(mi) && num(hr) && dom === '*' && mon === '*') {
    s.time = `${pad(hr)}:${pad(mi)}`;
    if (dow === '*') return { ...s, mode: 'daily' };
    if (dow === '1-5') return { ...s, mode: 'weekdays' };
    if (/^[0-7](,[0-7])*$/.test(dow)) return { ...s, mode: 'weekly', days: dow.split(',').map((d) => String(Number(d) % 7)) };
  }
  const em = mi.match(/^\*\/(\d+)$/);
  if (em && hr === '*' && dom === '*' && mon === '*' && dow === '*') return { ...s, mode: 'interval', every: Number(em[1]), unit: 'm' };
  const eh = hr.match(/^\*\/(\d+)$/);
  if (mi === '0' && eh && dom === '*' && mon === '*' && dow === '*') return { ...s, mode: 'interval', every: Number(eh[1]), unit: 'h' };
  return { ...s, mode: 'cron' };
}

function toCron(s) {
  const [hh, mm] = (s.time || '09:00').split(':').map(Number);
  switch (s.mode) {
    case 'daily': return `${mm} ${hh} * * *`;
    case 'weekdays': return `${mm} ${hh} * * 1-5`;
    case 'weekly': return `${mm} ${hh} * * ${(s.days.length ? s.days : ['1']).slice().sort().join(',')}`;
    case 'interval': return s.unit === 'h' ? `0 */${Math.max(1, Math.min(23, s.every | 0))} * * *` : `*/${Math.max(1, Math.min(59, s.every | 0))} * * * *`;
    default: return s.cron.trim();
  }
}

function field(label, control, id) {
  const wrap = el('div', 'field');
  const l = el('label', 'field-label', label);
  l.htmlFor = id;
  control.id = id;
  wrap.append(l, control);
  return wrap;
}

function taskForm(t) {
  const s = fromCron(t?.cron);
  const form = el('form', 'task-form');
  form.noValidate = true;

  const name = el('input');
  name.maxLength = 60;
  name.value = t?.name || '';
  name.placeholder = '例如：每日晨报';
  const prompt = el('textarea', 'task-textarea');
  prompt.rows = 4;
  prompt.maxLength = 8000;
  prompt.value = t?.prompt || '';
  prompt.placeholder = '到点时发给助理的完整指令，例如：汇总我关注的新闻，列出 5 条要点。';

  // schedule
  const sched = el('fieldset', 'sched');
  sched.append(el('legend', 'field-label', '时间'));
  const seg = el('div', 'seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', '重复方式');
  const detail = el('div', 'sched-detail');
  const preview = el('p', 'sched-preview', '');
  preview.setAttribute('aria-live', 'polite');
  let previewTimer = null;
  const updatePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const cron = toCron(s);
      try {
        const r = await h.api('/api/tasks/preview', { method: 'POST', body: { cron } });
        preview.className = 'sched-preview';
        preview.textContent = `${r.text} · 接下来：${r.next.map((x) => when(x, tasks.timezone)).join('、')}`;
      } catch (err) {
        preview.className = 'sched-preview bad';
        preview.textContent = err.message;
      }
    }, 250);
  };
  const renderDetail = () => {
    detail.replaceChildren();
    for (const b of seg.children) b.setAttribute('aria-checked', String(b.dataset.mode === s.mode));
    if (['daily', 'weekdays', 'weekly'].includes(s.mode)) {
      const time = el('input');
      time.type = 'time';
      time.value = s.time;
      time.addEventListener('input', () => { s.time = time.value || '09:00'; updatePreview(); });
      detail.append(field('时刻', time, 'task-time'));
    }
    if (s.mode === 'weekly') {
      const days = el('div', 'days');
      days.setAttribute('role', 'group');
      days.setAttribute('aria-label', '星期');
      for (const [v, label] of DAYS) {
        const b = el('button', 'day', label);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(s.days.includes(v)));
        b.setAttribute('aria-label', `周${label}`);
        b.addEventListener('click', () => {
          s.days = s.days.includes(v) ? s.days.filter((d) => d !== v) : [...s.days, v];
          b.setAttribute('aria-pressed', String(s.days.includes(v)));
          updatePreview();
        });
        days.append(b);
      }
      detail.append(days);
    }
    if (s.mode === 'interval') {
      const row = el('div', 'inline-row');
      const n = el('input');
      n.type = 'number';
      n.min = '1';
      n.max = '59';
      n.value = String(s.every);
      n.setAttribute('aria-label', '间隔');
      const unit = el('select');
      unit.setAttribute('aria-label', '单位');
      for (const [v, l] of [['m', '分钟'], ['h', '小时']]) { const o = el('option', '', l); o.value = v; unit.append(o); }
      unit.value = s.unit;
      n.addEventListener('input', () => { s.every = Number(n.value) || 1; updatePreview(); });
      unit.addEventListener('change', () => { s.unit = unit.value; updatePreview(); });
      row.append(el('span', '', '每'), n, unit);
      detail.append(row);
    }
    if (s.mode === 'cron') {
      const c = el('input', 'mono');
      c.value = s.cron;
      c.placeholder = '分 时 日 月 星期，例如 0 9 * * 1-5';
      c.spellcheck = false;
      c.addEventListener('input', () => { s.cron = c.value; updatePreview(); });
      detail.append(field('cron 表达式', c, 'task-cron'));
    }
    updatePreview();
  };
  for (const [mode, label] of MODES) {
    const b = el('button', '', label);
    b.type = 'button';
    b.dataset.mode = mode;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => {
      if (mode === 'cron') s.cron = toCron(s);
      s.mode = mode;
      renderDetail();
    });
    seg.append(b);
  }
  sched.append(seg, detail, preview);

  // model + effort + target + enabled
  const prefs = h.prefs();
  const defModel = findModel(prefs.model || 'default');
  const model = el('select');
  const def = el('option', '', `跟随默认（当前 ${defModel?.displayName || prefs.model || 'default'}）`);
  def.value = '';
  model.append(def);
  for (const m of h.models()) { const o = el('option', '', m.displayName); o.value = m.value; model.append(o); }
  model.value = t?.model || '';
  const effort = el('select');
  const fillEffort = (keep) => {
    const m = model.value ? findModel(model.value) : defModel;
    const levels = m?.efforts || [];
    effort.replaceChildren();
    const d = el('option', '', model.value ? '模型默认' : `跟随默认（当前 ${prefs.effort ? EFFORT_LABEL[prefs.effort] : '模型默认'}）`);
    d.value = '';
    effort.append(d);
    for (const e of levels) { const o = el('option', '', EFFORT_LABEL[e] || e); o.value = e; effort.append(o); }
    effort.value = levels.includes(keep) ? keep : '';
    effort.disabled = !levels.length;
  };
  fillEffort(t?.effort || '');
  model.addEventListener('change', () => fillEffort(effort.value));

  const target = el('fieldset', 'radios');
  target.append(el('legend', 'field-label', '结果发到'));
  for (const [v, l] of [['new', '每次新建一个对话'], ['same', '始终写入同一个对话']]) {
    const lab = el('label', 'radio');
    const r = el('input');
    r.type = 'radio';
    r.name = 'task-target';
    r.value = v;
    r.checked = (t?.target || 'new') === v;
    lab.append(r, el('span', '', l));
    target.append(lab);
  }
  const enabledLab = el('label', 'radio');
  const enabled = el('input');
  enabled.type = 'checkbox';
  enabled.checked = t ? t.enabled : true;
  enabledLab.append(enabled, el('span', '', '启用'));

  const err = el('p', 'sheet-error');
  err.hidden = true;
  const actions = el('div', 'dialog-actions');
  const cancel = button('取消', 'btn btn-ghost', () => { tasks.view = 'list'; renderTasks(); loadTasks(); });
  const save = el('button', 'btn btn-primary', t ? '保存' : '创建');
  save.type = 'submit';
  actions.append(cancel, save);

  form.append(
    el('h3', 'sheet-h', t ? '编辑定时任务' : '新建定时任务'),
    field('名称', name, 'task-name'), field('指令', prompt, 'task-prompt'), sched,
    field('模型', model, 'task-model'), field('推理强度', effort, 'task-effort'), target, enabledLab, err, actions,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: name.value, prompt: prompt.value, cron: toCron(s), enabled: enabled.checked,
      model: model.value || null, effort: effort.value || null, target: form.querySelector('input[name="task-target"]:checked')?.value || 'new',
    };
    save.disabled = true;
    try {
      const data = t
        ? await h.api(`/api/tasks/${t.id}`, { method: 'PATCH', body })
        : await h.api('/api/tasks', { method: 'POST', body });
      tasks.list = data.tasks;
      tasks.view = 'list';
      h.toast(t ? '已保存' : '已创建');
      renderTasks();
    } catch (ex) {
      if (ex.status === 401) return;
      err.textContent = ex.message;
      err.hidden = false;
      save.disabled = false;
    }
  });
  queueMicrotask(() => { renderDetail(); name.focus(); });
  return form;
}

/* ================= /status: context window and spend ================= */

const CATEGORY_LABEL = {
  system_prompt: '系统提示', system_tools: '系统工具', memory_files: '记忆文件', skills: '技能',
  messages: '对话消息', mcp_tools: 'MCP 工具', custom_agents: '自定义代理', autocompact_buffer: '自动压缩预留', free_space: '剩余空间',
};
const tokens = (n) => (n === null || n === undefined ? '—' : n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));
const usd = (c) => `$${c < 1 ? c.toFixed(4) : c.toFixed(2)}`;

const status = { convId: null, data: null, error: '', loading: false };

export function openStatus(convId) {
  const id = convId || h.currentConv()?.id || null;
  const dlg = $('status-dialog');
  if (status.convId !== id) status.data = null;
  status.convId = id;
  if (!dlg.open) dlg.showModal();
  renderStatusSheet();
  if (id) loadStatus();
}

async function loadStatus() {
  const id = status.convId;
  status.loading = true;
  status.error = '';
  renderStatusSheet();
  try {
    const data = await h.api(`/api/conversations/${id}/status`);
    if (status.convId === id) status.data = data;
  } catch (err) {
    if (err.status === 401) return;
    if (status.convId === id) status.error = err.message;
  } finally {
    if (status.convId === id) {
      status.loading = false;
      renderStatusSheet();
    }
  }
}

function renderStatusSheet() {
  const body = $('status-body');
  body.replaceChildren();
  if (!status.convId) {
    body.append(el('p', 'sheet-muted', '当前还没有对话。发出第一条消息后，这里会显示上下文占用和花费。'));
    return;
  }
  const { data, error, loading } = status;
  const refresh = button(loading ? '读取中…' : '刷新', 'link-btn', () => loadStatus());
  refresh.disabled = loading;
  const ctxSec = section('上下文', el('span', 'sheet-meta', data ? `更新于 ${when(data.fetchedAt)}` : ''), refresh);
  if (error) ctxSec.append(el('p', 'sheet-error', `读取失败：${error}`));
  if (!data && !error) ctxSec.append(el('p', 'sheet-muted', '正在读取…（会短暂启动一次 Claude Code，不调用模型）'));
  const ctx = data?.context;
  if (data && !ctx) ctxSec.append(el('p', 'sheet-error', `拿不到上下文数据：${data.contextError || '未知原因'}`));
  if (ctx) {
    const pct = ctx.percentage ?? (ctx.maxTokens ? Math.round((ctx.totalTokens / ctx.maxTokens) * 100) : 0);
    const row = el('div', 'usage-row');
    const top = el('div', 'usage-top');
    top.append(el('span', 'usage-name', `${tokens(ctx.totalTokens)} / ${tokens(ctx.maxTokens)} tokens`), el('span', 'usage-pct', `已用 ${pct}%`));
    const bar = el('div', 'usage-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', '上下文占用');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(pct));
    const fill = el('span', `usage-fill${pct >= 90 ? ' crit' : pct >= 75 ? ' warn' : ''}`);
    fill.style.width = `${Math.min(100, pct)}%`;
    bar.append(fill);
    row.append(top, bar);
    ctxSec.append(row);
    const dl = el('dl', 'kv');
    const model = data.model.resolvedModel || ctx.model;
    dl.append(el('dt', '', '模型'), el('dd', '', `${data.model.displayName}${model && model !== data.model.displayName ? `（${model}）` : ''}`));
    dl.append(el('dt', '', '最大上下文'), el('dd', '', `${(ctx.maxTokens ?? 0).toLocaleString()} tokens`));
    for (const c of ctx.categories) {
      if (c.kind === 'deferred' || (!c.tokens && c.kind !== 'free')) continue;
      dl.append(el('dt', '', CATEGORY_LABEL[c.id] || c.name), el('dd', '', `${tokens(c.tokens)}`));
    }
    ctxSec.append(dl);
  }
  if (data?.running) ctxSec.append(el('p', 'sheet-muted', '回复进行中：显示的是这条回复开始之前的上下文。'));
  if (data?.lastCompact) {
    ctxSec.append(el('p', 'sheet-muted', `当前分支已压缩 ${data.compactions} 次，最近一次在${when(data.lastCompact.at)}。`));
  }
  const cur = h.currentConv();
  const canCompact = data?.hasSession && cur?.id === status.convId && !cur.live && !data.running;
  const compactRow = el('div', 'status-actions');
  const compact = button('压缩上下文', 'btn btn-ghost btn-sm', () => {
    $('status-dialog').close();
    h.sendCommand('/compact');
  }, 'collapse');
  compact.disabled = !canCompact;
  compactRow.append(compact, el('span', 'sheet-muted', '把较早的对话总结成摘要，释放上下文空间。也可以在输入框发送 /compact，后面可以跟上要保留的重点。'));
  ctxSec.append(compactRow);
  body.append(ctxSec);

  const spendSec = section('花费');
  if (data) {
    const { branch, cli } = data.spend;
    const dl = el('dl', 'kv');
    if (cli && cli.missing < cli.sessions) {
      dl.append(el('dt', '', '本对话累计'), el('dd', '', `${usd(cli.costUsd)}（含所有分支）`));
    }
    const recorded = branch.replies - branch.unrecorded;
    dl.append(el('dt', '', '当前分支'), el('dd', '', recorded ? `${usd(branch.costUsd)}（${recorded} 条回复有记录）` : '暂无逐条记录'));
    if (recorded) dl.append(el('dt', '', '当前分支 tokens'), el('dd', '', `输入 ${tokens(branch.inputTokens)} · 输出 ${tokens(branch.outputTokens)} · 缓存读 ${tokens(branch.cacheReadTokens)} · 缓存写 ${tokens(branch.cacheWriteTokens)}`));
    spendSec.append(dl);
    if (cli && cli.missing < cli.sessions) {
      spendSec.append(el('p', 'sheet-muted', `“本对话累计”是 Claude Code 在会话记录里记下的总数（与终端 /cost 同源）${cli.missing ? `，有 ${cli.missing} 个会话记录缺失，未计入` : ''}。`));
    }
    if (branch.unrecorded) spendSec.append(el('p', 'sheet-muted', `当前分支有 ${branch.unrecorded} 条回复生成于逐条记录上线之前，没有单独的花费，未计入“当前分支”。`));
    spendSec.append(el('p', 'sheet-muted', '金额是 Claude Code 按 API 标价折算的等价费用。用订阅账号登录时不按这个金额扣费，实际消耗看套餐额度。'));
    spendSec.append(button('查看套餐用量', 'link-btn', () => { $('status-dialog').close(); openSettings(); }));
  } else {
    spendSec.append(el('p', 'sheet-muted', error ? '—' : '正在读取…'));
  }
  body.append(spendSec);
}

/* ================= "/" command palette ================= */

// Handled by the page: each web reply is its own CLI process, so session settings like
// /model or /effort would not outlive that one reply.
const WEB_COMMANDS = [
  { name: 'new', description: '新建对话', run: () => h.newChat() },
  { name: 'clear', description: '开始新对话（网页端每个对话的上下文相互独立）', run: () => h.newChat() },
  { name: 'model', description: '选择模型和推理强度', run: () => h.openModelPop() },
  { name: 'effort', description: '调整推理强度', run: () => h.openModelPop() },
  { name: 'compact', description: '压缩当前对话的上下文（总结较早的内容，释放空间）', run: () => h.sendCommand('/compact') },
  { name: 'status', description: '查看上下文占用、最大上下文和本对话花费', run: () => openStatus() },
  { name: 'context', description: '同 /status：上下文占用明细', run: () => openStatus() },
  { name: 'cost', description: '同 /status：本对话花费', run: () => openStatus() },
  { name: 'usage', description: '查看用量、重置时间和账号', run: () => openSettings() },
  { name: 'tasks', description: '查看和管理定时任务', run: () => openTasks() },
  { name: 'rename', description: '重命名当前对话', run: () => h.renameCurrent() },
  { name: 'browser', description: '打开云端浏览器面板', run: () => h.openBrowser() },
  { name: 'upload', description: '上传文件或图片', run: () => h.pickFiles() },
];
// Terminal-only, session-scoped or replaced by a page feature above.
const HIDDEN = new Set([
  'color', 'focus', 'heapdump', 'config', 'autocompact', 'reload-plugins', 'reload-skills', 'auto-mode-setup',
  'agents', 'extra-usage', 'usage-credits', 'output-style', 'mcp', 'fast', 'loop', 'schedule', 'ultrareview',
  'workflow-launch-exec', 'remote-workflow', 'import', 'heap',
]);

const palette = { cli: null, loading: false, items: [], active: 0, open: false };

async function loadCommands() {
  if (palette.cli || palette.loading) return;
  palette.loading = true;
  try {
    palette.cli = (await h.api('/api/commands')).commands;
  } catch {
    palette.cli = [];
  } finally {
    palette.loading = false;
    updatePalette();
  }
}

function allCommands() {
  const web = new Set(WEB_COMMANDS.map((c) => c.name));
  const cli = (palette.cli || []).filter((c) => !HIDDEN.has(c.name) && !web.has(c.name));
  return [...WEB_COMMANDS.map((c) => ({ ...c, web: true })), ...cli];
}

function query() {
  const m = h.input().value.match(/^\/([\w:.-]*)$/);
  return m ? m[1].toLowerCase() : null;
}

function updatePalette() {
  const q = query();
  const pop = $('slash-pop');
  if (q === null) { closePalette(); return; }
  if (!palette.cli) loadCommands();
  const all = allCommands();
  const starts = all.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = all.filter((c) => !c.name.toLowerCase().startsWith(q) && (c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)));
  palette.items = [...starts, ...contains].slice(0, 40);
  palette.active = Math.min(palette.active, Math.max(0, palette.items.length - 1));
  pop.replaceChildren();
  if (!palette.items.length) {
    pop.append(el('p', 'slash-empty', palette.loading ? '正在读取指令…' : '没有匹配的指令'));
  }
  palette.items.forEach((c, i) => {
    const opt = el('div', `slash-opt${i === palette.active ? ' active' : ''}`);
    opt.id = `slash-${i}`;
    opt.setAttribute('role', 'option');
    opt.setAttribute('aria-selected', String(i === palette.active));
    const top = el('div', 'slash-top');
    top.append(el('span', 'slash-name', `/${c.name}`));
    if (c.argumentHint) top.append(el('span', 'slash-hint', c.argumentHint));
    if (c.web) top.append(el('span', 'slash-badge', '网页'));
    opt.append(top, el('div', 'slash-desc', c.description));
    opt.addEventListener('mousedown', (e) => e.preventDefault());
    opt.addEventListener('click', () => choose(i));
    pop.append(opt);
  });
  pop.hidden = false;
  palette.open = true;
  h.input().setAttribute('aria-expanded', 'true');
  h.input().setAttribute('aria-activedescendant', palette.items.length ? `slash-${palette.active}` : '');
  pop.querySelector('.slash-opt.active')?.scrollIntoView({ block: 'nearest' });
}

function closePalette() {
  $('slash-pop').hidden = true;
  palette.open = false;
  palette.active = 0;
  h.input().setAttribute('aria-expanded', 'false');
  h.input().removeAttribute('aria-activedescendant');
}

function choose(i) {
  const c = palette.items[i];
  if (!c) return;
  closePalette();
  if (c.web) {
    h.setComposer('');
    c.run();
  } else {
    h.setComposer(`/${c.name} `);
  }
}

function onKeydown(e) {
  if (!palette.open || e.isComposing || e.keyCode === 229) return;
  const n = palette.items.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!n) return;
    palette.active = (palette.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    updatePalette();
  } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
    if (!n) return;
    choose(palette.active);
  } else if (e.key === 'Escape') {
    closePalette();
  } else {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}

/* ================= "+" menu ================= */

export function openPlusMenu(anchor) {
  h.openMenu(anchor, [
    { icon: 'file', label: '上传文件或图片', run: () => h.pickFiles() },
    { icon: 'slash', label: '指令', run: () => h.setComposer('/') },
    { icon: 'globe', label: '浏览器', run: () => h.openBrowser() },
    { icon: 'clock', label: '定时任务', run: () => openTasks() },
    { icon: 'collapse', label: '上下文与花费', run: () => openStatus() },
    { icon: 'gauge', label: '用量与设置', run: () => openSettings() },
  ]);
}

/* ================= wiring ================= */

export function initExtras(hooks) {
  h = hooks;
  const input = h.input();
  input.setAttribute('aria-controls', 'slash-pop');
  input.setAttribute('aria-autocomplete', 'list');
  input.addEventListener('input', () => { palette.active = 0; updatePalette(); });
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) closePalette(); }, 150));
  // Capture on the form so the palette sees Enter before the composer's send handler.
  input.form.addEventListener('keydown', onKeydown, true);
  const viewer = $('image-viewer');
  // Tap anywhere except the bar's links closes the viewer.
  viewer.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || !e.target.closest('.viewer-bar')) viewer.close();
  });
  viewer.addEventListener('close', () => { $('viewer-img').removeAttribute('src'); });
  for (const id of ['settings-dialog', 'tasks-dialog', 'status-dialog']) {
    const dlg = $(id);
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]') || e.target === dlg) dlg.close();
    });
    dlg.addEventListener('close', () => { if (id === 'tasks-dialog') clearInterval(tasks.poll); });
  }
}
