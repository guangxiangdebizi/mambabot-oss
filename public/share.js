import { renderMarkdown } from './markdown.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function fmt(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function render(data) {
  document.title = `${data.title} · 分享的对话`;
  $('share-title').textContent = data.title;
  $('share-meta').textContent = `分享于 ${fmt(data.updatedAt)} · ${data.messages.length} 条消息`;
  const box = $('share-messages');
  box.replaceChildren();
  for (const m of data.messages) {
    const node = el('article', `msg msg-${m.role}`);
    node.append(el('h2', 'sr-only', m.role === 'user' ? '提问' : '回答'));
    if (m.role === 'user') {
      if (m.attachments.length) node.append(el('p', 'share-note', `附件：${m.attachments.join('、')}`));
      if (m.text) node.append(el('div', 'bubble', m.text));
    } else {
      if (m.tools) node.append(el('p', 'share-note', `使用了 ${m.tools} 个工具`));
      const body = el('div', 'msg-body md');
      body.append(renderMarkdown(m.text));
      node.append(body);
    }
    box.append(node);
  }
}

$('share-messages').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-action="copy-code"]');
  if (!b) return;
  const code = b.closest('.code-block')?.querySelector('code')?.textContent || '';
  try {
    await navigator.clipboard.writeText(code);
    b.textContent = '已复制';
  } catch {
    b.textContent = '复制失败';
  }
  setTimeout(() => { b.textContent = '复制'; }, 1500);
});

(async () => {
  const token = location.pathname.split('/').pop();
  try {
    const res = await fetch(`/api/share/${encodeURIComponent(token)}`, { credentials: 'omit' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '无法打开这个分享');
    render(data);
  } catch (err) {
    $('share-title').textContent = '无法打开这个分享';
    $('share-meta').textContent = err.message;
  }
})();
