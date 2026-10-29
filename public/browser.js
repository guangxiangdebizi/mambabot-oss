// Live view of the agent's real browser (noVNC over an authenticated WebSocket), with the
// hand-off states: agent working, waiting for the owner, owner in control, handed back.
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);
const ui = {
  panel: $('browser-panel'), chip: $('browser-btn'), dot: $('browser-dot'), back: $('bp-back'), close: $('bp-close'),
  status: $('bp-status'), fit: $('bp-fit'), power: $('bp-power'), help: $('bp-help'), helpReason: $('bp-help-reason'),
  helpDetails: $('bp-help-details'), screen: $('bp-screen'), canvas: $('bp-canvas'), overlay: $('bp-overlay'),
  overlayText: $('bp-overlay-text'), overlayBtn: $('bp-overlay-btn'), typebar: $('bp-typebar'), type: $('bp-type'),
  typeSend: $('bp-type-send'), keyEnter: $('bp-key-enter'), keyBack: $('bp-key-back'), footText: $('bp-foot-text'),
  action: $('bp-action'),
};

const KIND = { login: '登录', captcha: '人机验证', approval: '确认操作', other: '人工操作' };
export const helpKindLabel = (k) => KIND[k] || KIND.other;

let hooks = {};
let snap = { state: 'off', mode: 'idle', help: null };
let es = null;
let rfb = null;
let RFB = null;
let connState = 'idle'; // idle | connecting | connected | failed
// Phones default to 1:1 with drag, or a QR code would be too small to scan.
let fit = !window.matchMedia('(max-width: 767px)').matches;
let wantOpen = false;
let lastHelpKey = null;

export function browserSnapshot() { return snap; }

async function post(path) {
  return hooks.api(path, { method: 'POST', body: {} });
}

/* ---------- state stream ---------- */

export function startBrowserEvents(h) {
  hooks = h;
  stopBrowserEvents();
  es = new EventSource('/api/browser/events');
  es.onmessage = (e) => {
    try { onSnapshot(JSON.parse(e.data)); } catch { /* ignore */ }
  };
  es.onerror = () => {
    if (es?.readyState === EventSource.CLOSED) {
      es = null;
      setTimeout(() => { if (!es && hooks.isAuthed?.()) startBrowserEvents(hooks); }, 3000);
    }
  };
}

export function stopBrowserEvents() {
  es?.close();
  es = null;
  disconnect();
}

function onSnapshot(next) {
  const prev = snap;
  snap = next;
  const key = next.help ? `${next.help.sid}:${next.help.since}` : null;
  if (key && key !== lastHelpKey) {
    lastHelpKey = key;
    hooks.onHelp?.(next.help);
    if (next.help.convId === hooks.currentConvId?.()) open();
  }
  if (!key) lastHelpKey = null;
  if (prev.state !== 'ready' && next.state === 'ready' && isOpen()) connect();
  if (next.state !== 'ready') disconnect();
  if (rfb) rfb.viewOnly = next.mode !== 'human';
  render();
  hooks.onChange?.(next, prev);
}

/* ---------- panel ---------- */

export function isOpen() { return !ui.panel.hidden; }

export function open() {
  wantOpen = true;
  ui.panel.hidden = false;
  document.body.classList.add('bp-open');
  ui.chip.setAttribute('aria-expanded', 'true');
  if (snap.state === 'ready') connect();
  render();
  if (window.matchMedia('(max-width: 767px)').matches) ui.back.focus();
}

export function close() {
  wantOpen = false;
  ui.panel.hidden = true;
  document.body.classList.remove('bp-open');
  ui.chip.setAttribute('aria-expanded', 'false');
  // Stop streaming frames when nobody is looking; the browser itself keeps running.
  disconnect();
  ui.chip.focus();
}

function render() {
  const { state, mode, help } = snap;
  const mine = help && help.convId === hooks.currentConvId?.();
  ui.chip.classList.toggle('waiting', Boolean(help) && mode !== 'human');
  ui.dot.hidden = !(state === 'ready' || help);
  ui.dot.classList.toggle('warn', Boolean(help) && mode !== 'human');
  ui.chip.title = help ? '浏览器：等待你操作' : (state === 'ready' ? '浏览器运行中' : '打开浏览器面板');

  let tone = 'off';
  let label = '未启动';
  if (state === 'starting') { label = '正在启动…'; tone = 'agent'; }
  else if (state === 'stopping') label = '正在关闭…';
  else if (state === 'error') { label = '启动失败'; tone = 'error'; }
  else if (state === 'ready') {
    if (mode === 'human') { label = '你正在操作'; tone = 'human'; }
    else if (mode === 'waiting') { label = '等待你操作'; tone = 'waiting'; }
    else if (mode === 'agent') { label = '助理操作中'; tone = 'agent'; }
    else { label = '空闲'; tone = 'off'; }
    if (connState === 'failed') { label = '画面已断开'; tone = 'error'; }
  }
  ui.status.textContent = label;
  ui.status.dataset.tone = tone;

  ui.help.hidden = !help;
  if (help) {
    ui.helpReason.textContent = `${helpKindLabel(help.kind)}：${help.reason}`;
    ui.helpDetails.textContent = [help.details, help.resumeHint && `完成后助理会：${help.resumeHint}`,
      fit && help.kind === 'login' ? '二维码太小时，点右上角“原始大小”。' : ''].filter(Boolean).join('　');
  }

  // Overlay over the screen
  let text = '';
  let btn = null;
  if (state === 'off') { text = '浏览器没有运行。助理用到浏览器时会自动启动，你也可以现在启动它（约占 500 MB 内存）。'; btn = ['启动浏览器', 'start']; }
  else if (state === 'starting') text = '正在启动浏览器…';
  else if (state === 'stopping') text = '正在关闭浏览器…';
  else if (state === 'error') { text = `浏览器启动失败：${snap.error || '未知原因'}`; btn = ['重试', 'start']; }
  else if (connState === 'connecting') text = '正在连接浏览器画面…';
  else if (connState === 'failed') { text = '浏览器画面连接已断开。'; btn = ['重新连接', 'reconnect']; }
  ui.overlay.hidden = !text;
  ui.overlayText.textContent = text;
  ui.overlayBtn.hidden = !btn;
  if (btn) { ui.overlayBtn.textContent = btn[0]; ui.overlayBtn.dataset.act = btn[1]; }

  ui.screen.classList.toggle('human', mode === 'human');
  ui.typebar.hidden = !(state === 'ready' && mode === 'human');
  ui.power.disabled = state !== 'ready';
  ui.fit.replaceChildren(icon(fit ? 'expand' : 'collapse'));
  ui.fit.setAttribute('aria-label', fit ? '原始大小' : '适应窗口');
  ui.fit.title = fit ? '原始大小（可拖动查看）' : '适应窗口';

  // Footer: what is happening and the one relevant action
  let foot = '';
  let action = null;
  if (state !== 'ready') {
    foot = '这是助理在服务器上使用的真实浏览器。';
  } else if (mode === 'human') {
    foot = help ? '你正在操作。完成扫码或登录后点“交还给助理”，助理会核实登录状态后继续。' : '你正在操作，助理的浏览器动作已暂停，直到你交还。';
    action = ['交还给助理', 'handback'];
  } else if (mode === 'waiting') {
    foot = mine || !help ? '助理已暂停，等待你在浏览器中完成上面的操作。' : '另一个对话的助理在等待你操作。';
    action = ['开始操作', 'takeover'];
  } else {
    foot = mode === 'agent' ? '助理正在使用浏览器，你可以实时观看。' : '浏览器空闲。';
    action = ['接管控制', 'takeover'];
  }
  ui.footText.textContent = foot;
  ui.action.hidden = !action;
  if (action) { ui.action.textContent = action[0]; ui.action.dataset.act = action[1]; }
}

/* ---------- live view ---------- */

async function connect() {
  if (rfb || !wantOpen || snap.state !== 'ready') return;
  connState = 'connecting';
  render();
  try {
    RFB ||= (await import('/vendor/novnc/core/rfb.js')).default;
  } catch {
    connState = 'failed';
    render();
    return;
  }
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/browser/vnc`;
  const r = new RFB(ui.canvas, url, { shared: true });
  rfb = r;
  r.viewOnly = snap.mode !== 'human';
  r.scaleViewport = fit;
  r.clipViewport = !fit;
  r.dragViewport = !fit;
  r.resizeSession = false;
  r.focusOnClick = true;
  r.qualityLevel = 6;
  r.compressionLevel = 6;
  r.background = '#1b1b1b';
  r.addEventListener('connect', () => {
    if (rfb !== r) return;
    connState = 'connected';
    render();
    setTimeout(centerViewport, 400);
  });
  r.addEventListener('disconnect', () => {
    if (rfb !== r) return;
    rfb = null;
    connState = wantOpen && snap.state === 'ready' ? 'failed' : 'idle';
    render();
  });
}

function disconnect() {
  const r = rfb;
  rfb = null;
  connState = 'idle';
  try { r?.disconnect(); } catch { /* already closed */ }
}

function setFit(next) {
  fit = next;
  if (rfb) {
    rfb.scaleViewport = fit;
    rfb.clipViewport = !fit;
    rfb.dragViewport = !fit;
    setTimeout(centerViewport, 100);
  }
  render();
}

// At 1:1 the viewport starts at the top-left (the browser's tab list). Centre it horizontally,
// where login forms and QR codes usually are. Uses noVNC 1.4's Display (no public API for this).
function centerViewport() {
  const d = rfb?._display;
  if (fit || !d?.viewportChangePos || !d.width) return;
  const vp = d._viewportLoc;
  if (!vp) return;
  d.viewportChangePos((d.width - vp.w) / 2 - vp.x, 0);
}

// X keysyms: Latin-1 maps directly, everything else uses the Unicode range.
const keysymOf = (ch) => {
  const cp = ch.codePointAt(0);
  return cp < 0x100 ? cp : 0x01000000 + cp;
};

function typeText(text) {
  if (!rfb || snap.mode !== 'human') return;
  for (const ch of text) rfb.sendKey(keysymOf(ch), null);
}

/* ---------- actions ---------- */

async function act(kind) {
  try {
    if (kind === 'start') await post('/api/browser/start');
    else if (kind === 'reconnect') { disconnect(); connect(); }
    else if (kind === 'takeover') {
      if (snap.mode === 'agent' && !snap.help && !(await hooks.confirm('接管浏览器？', '接管后，助理的浏览器操作会暂停，直到你点“交还给助理”。'))) return;
      await hooks.api('/api/browser/takeover', { method: 'POST', body: { convId: snap.help?.convId || hooks.currentConvId?.() || null } });
      setTimeout(() => ui.canvas.querySelector('canvas')?.focus(), 50);
    } else if (kind === 'handback') {
      const r = await post('/api/browser/handback');
      hooks.toast?.(r.resolved ? '已交还，助理会核实状态后继续' : '已交还控制');
    } else if (kind === 'stop') {
      const busy = snap.help || snap.mode === 'human';
      if (!(await hooks.confirm('关闭浏览器？', busy ? '有未完成的人工操作，关闭后助理的等待会被取消。登录状态保存在浏览器配置里，不会丢失。' : '关闭后释放内存。登录状态保存在浏览器配置里，下次启动仍然有效。', '关闭'))) return;
      await post('/api/browser/stop');
    }
  } catch (err) {
    if (err.status !== 401) hooks.toast?.(err.message);
  }
}

ui.chip.addEventListener('click', () => (isOpen() ? close() : open()));
ui.close.addEventListener('click', close);
ui.back.addEventListener('click', close);
ui.fit.addEventListener('click', () => setFit(!fit));
ui.power.addEventListener('click', () => act('stop'));
ui.overlayBtn.addEventListener('click', () => act(ui.overlayBtn.dataset.act));
ui.action.addEventListener('click', () => act(ui.action.dataset.act));
ui.typeSend.addEventListener('click', () => { typeText(ui.type.value); ui.type.value = ''; ui.type.focus(); });
ui.type.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    typeText(ui.type.value);
    ui.type.value = '';
  }
});
ui.keyEnter.addEventListener('click', () => rfb && snap.mode === 'human' && rfb.sendKey(0xff0d, 'Enter'));
ui.keyBack.addEventListener('click', () => rfb && snap.mode === 'human' && rfb.sendKey(0xff08, 'Backspace'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isOpen() && window.matchMedia('(max-width: 767px)').matches && !ui.panel.contains(document.activeElement?.closest('canvas'))) close();
});
