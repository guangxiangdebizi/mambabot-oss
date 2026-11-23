// Side-question panel (提问, like /btw in the Claude Code terminal): questions about the chat or
// the running task, answered right away by a separate read-only Claude (src/sidequestion.js).
// They live beside the transcript in the right-hand panel slot, with their own input, so they
// never interleave with the main conversation. Each chat keeps its own unsent question.
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { highlight } from './highlight.js';
import { Drafts } from './drafts.js';

const $ = (id) => document.getElementById(id);
const ui = {
  panel: $('side-panel'), chip: $('side-btn'), dot: $('side-dot'), back: $('sd-back'), close: $('sd-close'),
  feed: $('sd-feed'), form: $('sd-form'), input: $('sd-input'), send: $('sd-send'), error: $('sd-error'),
};
const narrow = window.matchMedia('(max-width: 767px)');
const coarse = window.matchMedia('(pointer: coarse)');

let hooks = {};
const drafts = new Drafts('aw.sideDrafts');
const polls = new Map(); // btw id -> timer
const unread = new Set(); // answered while the panel was closed
const st = { convId: null, sending: false, stick: true };

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const localId = () => `local-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const list = () => hooks.conv()?.btw || [];
const setError = (text) => { ui.error.textContent = text || ''; ui.error.hidden = !text; };

export function isSideOpen() { return !ui.panel.hidden; }

export function openSide() {
  hooks.closeOthers?.();
  ui.panel.hidden = false;
  document.body.classList.add('bp-open');
  ui.chip.setAttribute('aria-expanded', 'true');
  syncSide();
  for (const b of list()) unread.delete(b.id);
  renderFeed(true);
  if (!coarse.matches && !ui.input.disabled) ui.input.focus();
  else if (narrow.matches) ui.back.focus();
}

export function closeSide({ focus = true } = {}) {
  if (ui.panel.hidden) return;
  ui.panel.hidden = true;
  document.body.classList.remove('bp-open');
  ui.chip.setAttribute('aria-expanded', 'false');
  if (focus) ui.chip.focus();
}

/** Why a question cannot be sent now, or '' when it can. */
function blocked() {
  const why = hooks.blockedReason?.();
  if (why) return why;
  if (list().some((b) => b.status === 'running')) return '上一个问题还在回答，稍等一下';
  return '';
}

/**
 * Follows the shown chat: keeps each chat's unsent question apart, redraws its questions and
 * resumes polling the unanswered ones. Cheap enough to call on every full render.
 */
export function syncSide() {
  const id = hooks.conv()?.id || null;
  if (id !== st.convId) {
    if (st.convId) drafts.set(st.convId, ui.input.value);
    st.convId = id;
    ui.input.value = (id && drafts.get(id)?.text) || '';
    autosize();
    setError('');
    st.stick = true;
  }
  for (const b of list()) if (b.status === 'running' && !b.id.startsWith('local-')) poll(b.id);
  if (isSideOpen()) { for (const b of list()) unread.delete(b.id); renderFeed(); } else renderChrome();
}

/**
 * Asks a side question (from this panel, or from the main composer's 提问 mode / `/btw`).
 * Opens the panel; if the question cannot be asked it lands in the panel's input with the reason.
 */
export async function askSide(question) {
  if (!isSideOpen()) openSide();
  const conv = hooks.conv();
  const why = blocked();
  if (why || st.sending) {
    if (!ui.input.value.trim()) { ui.input.value = question; autosize(); }
    setError(why || '正在提交上一个问题');
    return;
  }
  setError('');
  const temp = { id: localId(), question, answer: '', status: 'running', createdAt: new Date().toISOString() };
  conv.btw = [...(conv.btw || []), temp];
  st.sending = true;
  st.stick = true;
  renderFeed(true);
  try {
    const { btw } = await hooks.api(`/api/conversations/${conv.id}/btw`, { method: 'POST', body: { text: question } });
    // A reload may have replaced the chat object meanwhile; the same chat is matched by id.
    const cur = hooks.conv();
    if (cur?.id === conv.id) {
      cur.btw = (cur.btw || []).filter((b) => b !== temp && b.id !== btw.id).concat(btw);
      renderFeed();
      poll(btw.id);
    }
  } catch (err) {
    const cur = hooks.conv();
    for (const c of [conv, cur]) if (c?.btw) c.btw = c.btw.filter((b) => b !== temp);
    if (cur?.id !== conv.id) {
      // Moved to another chat meanwhile: keep the question as that chat's draft.
      if (!drafts.get(conv.id)) drafts.set(conv.id, question);
      return;
    }
    const restored = !ui.input.value.trim();
    if (restored) { ui.input.value = question; autosize(); }
    renderFeed();
    if (err.status !== 401) setError(`${err.message}${restored ? '（问题已放回输入框）' : ''}`);
  } finally {
    st.sending = false;
    renderChrome();
  }
}

/** Follows one side question until it is answered (the answer text grows as it streams). */
function poll(id) {
  if (polls.has(id)) return;
  const convId = hooks.conv()?.id;
  const stop = () => { clearTimeout(polls.get(id)); polls.delete(id); };
  const tick = async () => {
    if (hooks.conv()?.id !== convId) { stop(); return; }
    try {
      const { btw } = await hooks.api(`/api/conversations/${convId}/btw/${id}`);
      const items = hooks.conv()?.id === convId ? list() : [];
      const i = items.findIndex((b) => b.id === id);
      if (i < 0) { stop(); return; }
      const changed = items[i].answer !== btw.answer || items[i].status !== btw.status;
      items[i] = btw;
      if (changed) updateCard(btw);
      if (btw.status !== 'running') {
        stop();
        if (!isSideOpen()) {
          unread.add(id);
          if (btw.status === 'done') hooks.toast('旁路提问已回答，点右上角“提问”查看');
        }
        if (btw.status === 'done') hooks.announce('旁路提问已回答');
        renderChrome();
        return;
      }
    } catch (err) {
      if (err.status === 404 || err.status === 401) { stop(); return; }
    }
    polls.set(id, setTimeout(tick, 900));
  };
  polls.set(id, setTimeout(tick, 500));
}

async function remove(id) {
  const conv = hooks.conv();
  try {
    await hooks.api(`/api/conversations/${conv.id}/btw/${id}`, { method: 'DELETE' });
  } catch (err) {
    if (err.status !== 404) { if (err.status !== 401) hooks.toast(err.message); return; }
  }
  conv.btw = (conv.btw || []).filter((b) => b.id !== id);
  unread.delete(id);
  if (hooks.conv() === conv) renderFeed();
}

/* ---------- rendering ---------- */

const clock = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
};

function card(b) {
  const box = el('section', `btw btw-${b.status}`);
  box.dataset.btw = b.id;
  box.setAttribute('aria-label', '旁路提问');
  // Reads like the chat itself: the question as the owner's bubble, the answer as a reply.
  const q = el('div', 'btw-q');
  q.append(el('div', 'bubble', b.question));
  box.append(q);
  const ans = el('div', 'btw-a');
  if (b.answer) {
    const md = el('div', 'md');
    md.append(renderMarkdown(b.answer, document, { highlight: (code, lang) => highlight(document, code, lang) }));
    ans.append(md);
  }
  if (b.status === 'running') {
    const wait = el('p', 'btw-wait');
    const dots = el('span', 'thinking');
    dots.append(el('i'), el('i'), el('i'));
    wait.append(dots, el('span', '', b.answer ? '' : '正在回答…'));
    ans.append(wait);
  } else if (b.status === 'error') ans.append(el('p', 'btw-error', `没有回答：${b.error || '未知错误'}`));
  box.append(ans);
  const foot = el('div', 'btw-foot');
  foot.append(el('span', 'btw-time', clock(b.createdAt)));
  if (b.status === 'done' && b.answer) {
    const bring = el('button', 'link-btn', '带入对话');
    bring.type = 'button';
    bring.dataset.action = 'bring';
    bring.title = '把这条问答放进对话的输入框，作为下一条消息的背景';
    foot.append(bring);
  }
  if (!b.id.startsWith('local-')) {
    const x = el('button', 'icon-btn btw-x');
    x.type = 'button';
    x.dataset.action = 'remove';
    x.setAttribute('aria-label', '删除这条旁路问答');
    x.title = '删除这条旁路问答';
    x.append(icon('trash', 16));
    foot.append(x);
  }
  box.append(foot);
  return box;
}

function updateCard(b) {
  if (!isSideOpen()) return;
  const node = ui.feed.querySelector(`[data-btw="${CSS.escape(b.id)}"]`);
  if (!node) { renderFeed(); return; }
  node.replaceWith(card(b));
  if (st.stick) ui.feed.scrollTop = ui.feed.scrollHeight;
}

function renderFeed(toBottom = false) {
  renderChrome();
  if (!isSideOpen()) return;
  const keep = ui.feed.scrollTop;
  ui.feed.replaceChildren();
  const items = [...list()].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  if (!items.length) {
    const empty = el('div', 'sd-empty');
    empty.append(icon('question', 28),
      el('p', '', hooks.conv()?.id ? '在下面提问，马上得到回答。' : '先在对话里发一条消息，再来这里提问。'),
      el('p', 'sd-meta', '旁路提问由另一个只读的 Claude 回答：带着这个对话和主任务已完成的进度，不打断主任务，也不写进它的上下文；只能查看文件，不会修改文件或运行命令。需要时点“带入对话”，把问答放进对话的输入框。'));
    ui.feed.append(empty);
  }
  for (const b of items) ui.feed.append(card(b));
  if (toBottom || st.stick) ui.feed.scrollTop = ui.feed.scrollHeight;
  else ui.feed.scrollTop = keep;
}

function renderChrome() {
  const items = list();
  const running = items.some((b) => b.status === 'running');
  const fresh = items.some((b) => unread.has(b.id));
  ui.chip.hidden = !hooks.conv()?.id && !isSideOpen();
  ui.dot.hidden = !running && !fresh;
  ui.dot.classList.toggle('pulse', running);
  ui.chip.title = running ? '提问：正在回答' : (fresh ? '提问：有新的回答' : '旁路提问：不打断主任务');
  const noConv = !hooks.conv()?.id;
  ui.input.disabled = noConv;
  const why = noConv ? '' : blocked();
  ui.input.placeholder = noConv ? '先在对话里发一条消息' : (why && running ? '上一个问题回答完后可以继续问' : '问点什么，不打断当前任务');
  ui.send.disabled = noConv || st.sending || Boolean(why) || !ui.input.value.trim();
}

function autosize() {
  ui.input.style.height = 'auto';
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, window.innerHeight * 0.3)}px`;
  renderChrome();
}

function submit() {
  const question = ui.input.value.trim();
  if (!question || ui.send.disabled) return;
  ui.input.value = '';
  if (st.convId) drafts.delete(st.convId);
  autosize();
  askSide(question);
}

export function initSide(h) {
  hooks = h;
  ui.chip.addEventListener('click', () => (isSideOpen() ? closeSide() : openSide()));
  ui.close.addEventListener('click', () => closeSide());
  ui.back.addEventListener('click', () => closeSide());
  ui.form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  let saveTimer = null;
  ui.input.addEventListener('input', () => {
    autosize();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (st.convId) drafts.set(st.convId, ui.input.value); }, 400);
  });
  ui.input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229 || coarse.matches) return;
    e.preventDefault();
    submit();
  });
  ui.feed.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    const id = btn?.closest('[data-btw]')?.dataset.btw;
    if (!id) return;
    const b = list().find((x) => x.id === id);
    if (!b) return;
    if (btn.dataset.action === 'bring') {
      if (narrow.matches) closeSide({ focus: false });
      hooks.bring(b);
    } else if (btn.dataset.action === 'remove') remove(id);
  });
  ui.feed.addEventListener('scroll', () => {
    st.stick = ui.feed.scrollHeight - ui.feed.scrollTop - ui.feed.clientHeight < 40;
  }, { passive: true });
  window.addEventListener('pagehide', () => { if (st.convId) drafts.set(st.convId, ui.input.value); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isSideOpen() && narrow.matches && !document.querySelector('dialog[open]')) closeSide();
  });
  renderChrome();
}
