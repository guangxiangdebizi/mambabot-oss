// Drag (or arrow-key) resizing for the sidebar and the browser panel on wide screens.
// Widths are CSS variables on <html>, remembered per device; double-click resets.

const CHAT_MIN = 380;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

function setup({ handle, target, cssVar, key, min, cap = Infinity, otherWidth, grows }) {
  const root = document.documentElement;
  const max = () => Math.max(min, Math.min(cap, window.innerWidth - otherWidth() - CHAT_MIN));
  const clamp = (w) => Math.round(Math.min(max(), Math.max(min, w)));
  const current = () => target.getBoundingClientRect().width;
  const sync = () => {
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(Math.round(max())));
    handle.setAttribute('aria-valuenow', String(Math.round(current())));
  };
  const apply = (w, persist = true) => {
    const v = clamp(w);
    root.style.setProperty(cssVar, `${v}px`);
    if (persist) store.set(key, String(v));
    sync();
  };
  const saved = Number(store.get(key));
  if (saved) apply(saved, false);

  let start = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    start = { x: e.clientX, w: current() };
    document.body.classList.add('resizing');
    handle.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    apply(start.w + (grows === 'right' ? dx : -dx), false);
  });
  const end = () => {
    if (!start) return;
    start = null;
    document.body.classList.remove('resizing');
    handle.classList.remove('dragging');
    apply(current());
    window.dispatchEvent(new Event('resize'));
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => {
    root.style.removeProperty(cssVar);
    store.set(key, null);
    sync();
    window.dispatchEvent(new Event('resize'));
  });
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 64 : 16;
    const toward = grows === 'right' ? 1 : -1;
    let w = null;
    if (e.key === 'ArrowRight') w = current() + step * toward;
    else if (e.key === 'ArrowLeft') w = current() - step * toward;
    else if (e.key === 'Home') w = min;
    else if (e.key === 'End') w = max();
    if (w === null) return;
    e.preventDefault();
    apply(w);
  });
  handle.addEventListener('focus', sync);
  return { reclamp: () => { if (root.style.getPropertyValue(cssVar)) apply(current(), false); else sync(); } };
}

export function initResizers() {
  const sidebar = document.getElementById('sidebar');
  const panel = document.getElementById('browser-panel');
  const visibleWidth = (node) => (node.hidden || getComputedStyle(node).visibility === 'hidden' ? 0 : node.getBoundingClientRect().width);
  const sb = setup({
    handle: document.getElementById('sb-resize'), target: sidebar, cssVar: '--sidebar-w', key: 'aw.sbw',
    min: 200, cap: 420, grows: 'right', otherWidth: () => visibleWidth(panel),
  });
  const bp = setup({
    handle: document.getElementById('bp-resize'), target: panel, cssVar: '--bpanel-w', key: 'aw.bpw',
    min: 320, grows: 'left', otherWidth: () => (document.body.classList.contains('sb-collapsed') ? 0 : visibleWidth(sidebar)),
  });
  let t = null;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => { sb.reclamp(); bp.reclamp(); }, 100);
  });
}
