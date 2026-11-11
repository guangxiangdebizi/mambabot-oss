// Remote machines (远程机器): the owner's own computers, reached from the server with an SSH
// alias in its ~/.ssh/config and browsed read-only over SFTP (see src/machines.js). This module
// keeps the list, renders the settings section and the folder picker of the project dialog.
import { icon } from './icons.js';

let h = null;
const cache = { machines: [], sshHosts: [], loaded: false, loading: null };
const listeners = new Set();

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};
const enc = encodeURIComponent;

export function initMachines(hooks) { h = hooks; }
export const machines = () => cache.machines;
export const findMachine = (id) => cache.machines.find((m) => m.id === id) || null;
export function onMachinesChange(fn) { listeners.add(fn); }
function changed() { for (const fn of listeners) fn(cache.machines); }

export async function loadMachines(force = false) {
  if (cache.loaded && !force) return cache.machines;
  if (cache.loading) return cache.loading;
  cache.loading = h.api('/api/machines').then((d) => {
    Object.assign(cache, { machines: d.machines, sshHosts: d.sshHosts, loaded: true });
    changed();
    return cache.machines;
  }).catch((err) => {
    if (err.status !== 401) cache.loaded = true;
    return cache.machines;
  }).finally(() => { cache.loading = null; });
  return cache.loading;
}

const checked = new Map();
/** Online state of a machine, checked at most once a minute from this page. */
export async function checkMachine(id, force = false) {
  if (!force && Date.now() - (checked.get(id) || 0) < 60000) return findMachine(id);
  checked.set(id, Date.now());
  try {
    const { machine } = await h.api(`/api/machines/${enc(id)}/status${force ? '?force=1' : ''}`);
    const i = cache.machines.findIndex((m) => m.id === id);
    if (i >= 0) cache.machines[i] = machine; else cache.machines.push(machine);
    changed();
    return machine;
  } catch {
    return findMachine(id);
  }
}

export const onlineText = (m) => (m.online === true ? '在线' : m.online === false ? '离线' : '未检查');

/* ---------------- settings: 远程机器 ---------------- */

/** The settings section: list, add, edit, remove, check. `section(title)` builds the frame. */
export function machinesSection(section) {
  const sec = section('远程机器');
  const body = el('div', 'mc-body');
  sec.append(body);
  let editing = null; // null | 'new' | machine id
  let error = '';

  const render = () => {
    body.replaceChildren();
    if (!cache.loaded) { body.append(el('p', 'sheet-muted', '正在读取…')); return; }
    if (editing) { body.append(form(editing === 'new' ? null : findMachine(editing))); return; }
    if (!cache.machines.length) body.append(el('p', 'sheet-muted', '还没有添加。添加后，文件面板可以切换到这台电脑的目录，新建项目时也可以选它上面的文件夹。'));
    const list = el('ul', 'mc-list');
    for (const m of cache.machines) {
      const li = el('li', 'mc-item');
      const top = el('div', 'mc-top');
      const name = el('span', 'mc-name');
      name.append(icon('monitor', 16), el('span', '', `${m.name} · ${m.host}`));
      const badge = el('span', `mc-state ${m.online === true ? 'on' : m.online === false ? 'off' : ''}`, onlineText(m));
      if (m.error) badge.title = m.error;
      top.append(name, badge);
      const roots = el('div', 'mc-roots');
      for (const r of m.roots) roots.append(el('code', '', r.display));
      const actions = el('div', 'mc-actions');
      const btn = (text, fn, cls = 'link-btn') => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; };
      actions.append(
        btn('检查连接', async (e) => { e.target.disabled = true; e.target.textContent = '检查中…'; await checkMachine(m.id, true); render(); }),
        btn('编辑', () => { editing = m.id; error = ''; render(); }),
        btn('删除', async () => {
          if (!(await h.confirm('删除远程机器？', `将删除“${m.name}”的配置（不会动那台电脑上的任何文件）。`))) return;
          try {
            const d = await h.api(`/api/machines/${enc(m.id)}`, { method: 'DELETE' });
            Object.assign(cache, { machines: d.machines, sshHosts: d.sshHosts });
            changed();
          } catch (err) { if (err.status !== 401) h.toast(err.message); }
          render();
        }, 'link-btn danger'),
      );
      li.append(top, roots, actions);
      if (m.online === false && m.error) li.append(el('p', 'sheet-muted', `上次连接失败：${m.error}`));
      list.append(li);
    }
    if (cache.machines.length) body.append(list);
    const add = el('button', 'btn btn-ghost btn-sm', '添加远程机器');
    add.type = 'button';
    add.prepend(icon('plus', 16));
    add.addEventListener('click', () => { editing = 'new'; error = ''; render(); });
    body.append(add, el('p', 'sheet-muted', '用服务器上已经配置好的 SSH 别名（~/.ssh/config 里的 Host）连接你的电脑，通过 sftp 只读浏览下面列出的目录：可以预览和下载，不能修改或删除。MambaBot 不保存密码，也不生成或导出密钥；.ssh、私钥、.env、AppData 等位置不会显示。'));
  };

  const form = (m) => {
    const f = el('form', 'mc-form');
    f.noValidate = true;
    const field = (label, control, id, hint) => {
      const wrap = el('div', 'field');
      const l = el('label', 'field-label', label);
      l.htmlFor = id;
      control.id = id;
      wrap.append(l, control);
      if (hint) wrap.append(el('p', 'sheet-muted', hint));
      return wrap;
    };
    const name = el('input');
    name.maxLength = 40;
    name.value = m?.name || '';
    name.placeholder = '例如：我的电脑';
    const host = el('select');
    const hosts = [...new Set([...(cache.sshHosts || []), ...(m ? [m.host] : [])])];
    for (const x of hosts) {
      const o = el('option', '', x);
      o.value = x;
      host.append(o);
    }
    if (m) host.value = m.host;
    const roots = el('textarea');
    roots.rows = 3;
    roots.spellcheck = false;
    roots.placeholder = 'D:\\Projects\n/home/me/work';
    roots.value = m ? m.roots.map((r) => r.display).join('\n') : '';
    f.append(field('名称', name, 'mc-name'));
    if (!hosts.length) {
      f.append(el('p', 'sheet-error', '服务器的 ~/.ssh/config 里还没有可用的 Host 别名。先在服务器上配置好 SSH（能用 ssh 别名 免密登录），再回来添加。'));
    } else {
      f.append(field('SSH 主机别名', host, 'mc-host', '来自服务器的 ~/.ssh/config。'));
    }
    f.append(field('允许浏览的目录（每行一个）', roots, 'mc-roots', 'Windows 写 D:\\Projects，Linux/macOS 写 /home/me/work。不能是整个磁盘。'));
    if (error) f.append(el('p', 'sheet-error', error));
    const actions = el('div', 'dialog-actions');
    const cancel = el('button', 'btn btn-ghost btn-sm', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { editing = null; error = ''; render(); });
    const save = el('button', 'btn btn-primary btn-sm', '保存');
    save.type = 'submit';
    save.disabled = !hosts.length;
    actions.append(cancel, save);
    f.append(actions);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      const body = { name: name.value, host: host.value, roots: roots.value.split('\n') };
      try {
        const d = await h.api(m ? `/api/machines/${enc(m.id)}` : '/api/machines', { method: m ? 'PATCH' : 'POST', body });
        Object.assign(cache, { machines: d.machines, sshHosts: d.sshHosts });
        const id = m ? m.id : d.machine.id;
        editing = null;
        error = '';
        changed();
        render();
        h.toast('已保存，正在检查连接…');
        await checkMachine(id, true);
        render();
      } catch (err) {
        if (err.status === 401) return;
        error = err.message;
        render();
      }
    });
    requestAnimationFrame(() => name.focus());
    return f;
  };

  render();
  loadMachines(true).then(render);
  return sec;
}

/* ---------------- folder picker (new project on a remote machine) ---------------- */

/**
 * Browses one machine's allowed folders for a directory. Calls `onChange(path)` with the
 * folder currently shown (an absolute remote path), or '' when none.
 */
export function folderPicker(machine, onChange) {
  const box = el('div', 'picker');
  const rootSel = el('select', 'picker-root');
  rootSel.setAttribute('aria-label', '允许浏览的目录');
  for (const r of machine.roots) {
    const o = el('option', '', r.display);
    o.value = r.path;
    rootSel.append(o);
  }
  const where = el('p', 'picker-path');
  const list = el('ul', 'picker-list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', '子文件夹');
  box.append(rootSel, where, list);
  let rel = '';
  let seq = 0;

  const full = () => {
    const root = rootSel.value;
    return rel ? `${root.replace(/\/$/, '')}/${rel}` : root;
  };
  const load = async () => {
    const mySeq = ++seq;
    onChange(full());
    where.textContent = '';
    list.replaceChildren(el('li', 'picker-note', '读取中…'));
    try {
      const d = await h.api(`/api/machines/${enc(machine.id)}/tree?root=${enc(rootSel.value)}&path=${enc(rel)}`);
      if (mySeq !== seq) return;
      where.textContent = `已选：${d.dirDisplay}`;
      list.replaceChildren();
      if (rel) {
        const up = el('li', 'picker-item');
        const b = el('button', '', '.. 上一级');
        b.type = 'button';
        b.addEventListener('click', () => { rel = rel.split('/').slice(0, -1).join('/'); load(); });
        up.append(b);
        list.append(up);
      }
      const dirs = d.entries.filter((e) => e.type === 'dir');
      for (const e of dirs) {
        const li = el('li', 'picker-item');
        const b = el('button');
        b.type = 'button';
        b.append(icon('folder', 16), el('span', '', e.name));
        b.addEventListener('click', () => { rel = rel ? `${rel}/${e.name}` : e.name; load(); });
        li.append(b);
        list.append(li);
      }
      if (!dirs.length) list.append(el('li', 'picker-note', '没有子文件夹'));
    } catch (err) {
      if (mySeq !== seq || err.status === 401) return;
      list.replaceChildren(el('li', 'picker-note error', err.message));
      onChange('');
    }
  };
  rootSel.addEventListener('change', () => { rel = ''; load(); });
  load();
  return box;
}
