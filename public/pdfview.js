// PDF reader for the file panel, on the vendored pdf.js (public/vendor/pdfjs). Loaded only
// when a PDF is opened. Pages render when they come near the viewport and are released when
// far away, so long documents stay within a phone's canvas memory. Text stays selectable.

const PDFJS = '/vendor/pdfjs/6.5.438/';
const KEEP = 3; // pages kept rendered on each side of the visible ones
const MAX_PIXELS = 12e6; // per canvas; iOS refuses larger ones

let libPromise = null;
function loadLib() {
  libPromise ||= import(`${PDFJS}pdf.min.mjs`).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.mjs`;
    return lib;
  }).catch((err) => {
    libPromise = null;
    throw err;
  });
  return libPromise;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const abs = (p) => new URL(p, location.href).href;

/**
 * Renders the PDF at `url` into `box`; `scroller` is the element that scrolls.
 * Returns { destroy() }.
 */
export function renderPdf(box, url, { scroller, name = '' } = {}) {
  let destroyed = false;
  let doc = null;
  let task = null;
  let zoom = 1; // relative to fit-width
  const pages = []; // { n, wrap, canvas, text, base: {w,h}, rendered: scale|null, job }
  const visible = new Set();
  let observer = null;
  let resizeObs = null;
  let lastWidth = 0;

  const bar = el('div', 'pdf-bar');
  const pageInfo = el('span', 'pdf-page', '加载中…');
  const zoomOut = el('button', 'icon-btn pdf-zoom', '−');
  const zoomIn = el('button', 'icon-btn pdf-zoom', '+');
  const fit = el('button', 'btn btn-ghost btn-sm', '适合宽度');
  zoomOut.type = zoomIn.type = fit.type = 'button';
  zoomOut.setAttribute('aria-label', '缩小');
  zoomIn.setAttribute('aria-label', '放大');
  const zoomText = el('span', 'pdf-zoom-text', '100%');
  bar.append(pageInfo, el('span', 'pdf-spacer'), zoomOut, zoomText, zoomIn, fit);
  const pagesBox = el('div', 'pdf-pages');
  const status = el('p', 'fp-note pdf-status', '正在打开 PDF…');
  box.append(bar, status, pagesBox);

  const width = () => Math.max(200, (scroller?.clientWidth || box.clientWidth) - 24);

  function scaleFor(p) {
    return (width() / p.base.w) * zoom;
  }

  function layout() {
    for (const p of pages) {
      const s = scaleFor(p);
      p.wrap.style.width = `${Math.floor(p.base.w * s)}px`;
      p.wrap.style.height = `${Math.floor(p.base.h * s)}px`;
      if (p.rendered && Math.abs(p.rendered - s) > 0.01) release(p);
    }
    zoomText.textContent = `${Math.round(zoom * 100)}%`;
    renderVisible();
  }

  function release(p) {
    p.job?.cancel();
    p.job = null;
    p.canvas.width = 0;
    p.canvas.height = 0;
    p.canvas.remove();
    p.text.replaceChildren();
    p.rendered = null;
  }

  async function draw(p) {
    if (destroyed || p.rendered || p.job) return;
    const page = await doc.getPage(p.n);
    if (destroyed) return;
    const s = scaleFor(p);
    const viewport = page.getViewport({ scale: s });
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (viewport.width * viewport.height * dpr * dpr > MAX_PIXELS) dpr = Math.max(1, Math.sqrt(MAX_PIXELS / (viewport.width * viewport.height)));
    const canvas = p.canvas;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    p.wrap.prepend(canvas);
    const job = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
    p.job = job;
    try {
      await job.promise;
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') p.wrap.classList.add('pdf-failed');
      return;
    } finally {
      if (p.job === job) p.job = null;
    }
    if (destroyed) return;
    p.rendered = s;
    // Selectable text over the canvas.
    try {
      const lib = await loadLib();
      p.text.replaceChildren();
      p.wrap.style.setProperty('--total-scale-factor', String(s));
      await new lib.TextLayer({ textContentSource: page.streamTextContent(), container: p.text, viewport }).render();
    } catch { /* text layer is optional */ }
  }

  function renderVisible() {
    if (!pages.length) return;
    const nums = [...visible].sort((a, b) => a - b);
    const first = nums[0] ?? 1;
    const last = nums[nums.length - 1] ?? 1;
    for (const p of pages) {
      if (p.n >= first - KEEP && p.n <= last + KEEP) draw(p).catch(() => {});
      else if (p.rendered || p.job) release(p);
    }
    pageInfo.textContent = `${first} / ${pages.length} 页`;
  }

  function setZoom(z) {
    const top = scroller ? scroller.scrollTop / Math.max(1, scroller.scrollHeight) : 0;
    zoom = Math.min(4, Math.max(0.5, z));
    layout();
    if (scroller) scroller.scrollTop = top * scroller.scrollHeight;
  }
  zoomIn.addEventListener('click', () => setZoom(zoom * 1.25));
  zoomOut.addEventListener('click', () => setZoom(zoom / 1.25));
  fit.addEventListener('click', () => setZoom(1));

  function askPassword(updatePassword, retry) {
    status.replaceChildren();
    const form = el('form', 'pdf-password');
    form.append(el('span', '', retry ? '密码不正确，请重试：' : '这个 PDF 有密码保护：'));
    const input = el('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'PDF 密码');
    const ok = el('button', 'btn btn-primary btn-sm', '打开');
    ok.type = 'submit';
    form.append(input, ok);
    form.addEventListener('submit', (e) => { e.preventDefault(); status.textContent = '正在打开 PDF…'; updatePassword(input.value); });
    status.append(form);
    input.focus();
  }

  (async () => {
    let lib;
    try {
      lib = await loadLib();
    } catch {
      status.textContent = 'PDF 阅读组件加载失败，请刷新页面重试，或直接下载。';
      return;
    }
    if (destroyed) return;
    task = lib.getDocument({
      url,
      cMapUrl: abs(`${PDFJS}cmaps/`),
      cMapPacked: true,
      standardFontDataUrl: abs(`${PDFJS}standard_fonts/`),
      wasmUrl: abs(`${PDFJS}wasm/`),
      iccUrl: abs(`${PDFJS}iccs/`),
      isEvalSupported: false,
      enableXfa: false,
    });
    task.onPassword = (update, reason) => askPassword(update, reason === lib.PasswordResponses.INCORRECT_PASSWORD);
    try {
      doc = await task.promise;
    } catch (err) {
      if (destroyed) return;
      status.textContent = err?.name === 'InvalidPDFException' ? '文件已损坏或不是有效的 PDF。' : `无法打开这个 PDF：${err?.message || err}`;
      return;
    }
    if (destroyed) { doc.destroy(); return; }
    status.remove();
    // Page sizes: the first page's for all, corrected as each page is fetched.
    const first = await doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    for (let n = 1; n <= doc.numPages; n += 1) {
      const wrap = el('div', 'pdf-page-box');
      wrap.dataset.n = n;
      const text = el('div', 'textLayer');
      wrap.append(text);
      pagesBox.append(wrap);
      pages.push({ n, wrap, canvas: el('canvas'), text, base: { w: vp.width, h: vp.height }, rendered: null, job: null });
    }
    // Real sizes in the background (mixed portrait/landscape documents).
    (async () => {
      for (const p of pages.slice(1)) {
        if (destroyed) return;
        const v = (await doc.getPage(p.n)).getViewport({ scale: 1 });
        if (Math.abs(v.width - p.base.w) > 1 || Math.abs(v.height - p.base.h) > 1) { p.base = { w: v.width, h: v.height }; layout(); }
      }
    })().catch(() => {});
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const n = Number(e.target.dataset.n);
        if (e.isIntersecting) visible.add(n); else visible.delete(n);
      }
      renderVisible();
    }, { root: scroller || null, rootMargin: '200px 0px' });
    for (const p of pages) observer.observe(p.wrap);
    lastWidth = width();
    resizeObs = new ResizeObserver(() => {
      const w = width();
      if (Math.abs(w - lastWidth) < 8) return;
      lastWidth = w;
      clearTimeout(resizeObs.timer);
      resizeObs.timer = setTimeout(layout, 150);
    });
    if (scroller) resizeObs.observe(scroller);
    layout();
    if (name) pageInfo.title = name;
  })();

  return {
    destroy() {
      destroyed = true;
      observer?.disconnect();
      resizeObs?.disconnect();
      for (const p of pages) release(p);
      task?.destroy();
    },
  };
}
