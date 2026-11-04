import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil.js';

// A project is a directory on the server. Chats created in it run Claude with that directory
// as the working directory, so they share its files, its CLAUDE.md and the CLI's per-directory
// memory. Each chat records the directory it was created with (conv.cwd): Claude sessions are
// stored per working directory, so a chat must keep it for life to stay resumable.

export const DEFAULT_ROOT = 'default';
const MAX_ENTRIES = 1000;
const MAX_TEXT = 512 * 1024;
const SNIFF = 8192;

// Never listed or served, wherever they appear under a project.
const HIDDEN_DIRS = new Set(['.git', '.ssh', '.gnupg', '.aws', '.kube', '.docker', '.password-store']);
const SECRET_FILE = /^(\.env(\..*)?|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.pgpass|\.credentials\.json|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keystore|jks))$/i;
const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
const IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

export class FileError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const within = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** Display name as typed; the default directory name keeps it readable but filesystem-safe. */
export function projectName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 60) throw new FileError(400, '项目名称需要 1–60 个字');
  return name;
}

function dirSlug(name) {
  const slug = name.replace(/[/\\:*?"<>|\0]/g, '-').replace(/^\.+/, '').trim();
  return slug || 'project';
}

export class ProjectStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.file = join(cfg.dataDir, 'projects.json');
    this.items = [];
    // Locations that must never become (or sit inside) a browsable project root.
    this.guarded = [cfg.configDir, cfg.dataDir, join(homedir(), '.ssh'), join(homedir(), '.claude')];
  }

  async load() {
    const data = await readJson(this.file, {});
    this.items = Array.isArray(data.projects) ? data.projects.filter((p) => p && p.id && p.dir) : [];
  }

  save() {
    return writeJsonAtomic(this.file, { projects: this.items });
  }

  list() {
    return this.items.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id) {
    return this.items.find((p) => p.id === id) || null;
  }

  /** `dir` empty: a new folder `<claudeCwd>/projects/<name>`; otherwise an existing directory. */
  async create({ name: rawName, dir: rawDir }) {
    const name = projectName(rawName);
    let dir;
    if (rawDir && String(rawDir).trim()) {
      const given = String(rawDir).trim().replace(/^~(?=$|\/)/, homedir());
      if (!isAbsolute(given)) throw new FileError(400, '已有目录需要填写绝对路径');
      try {
        dir = await realpath(given);
      } catch {
        throw new FileError(400, `目录不存在：${given}`);
      }
      if (!(await stat(dir)).isDirectory()) throw new FileError(400, '这个路径不是目录');
    } else {
      const base = join(this.cfg.claudeCwd, 'projects');
      dir = join(base, dirSlug(name));
      for (let n = 2; this.items.some((p) => p.dir === dir); n += 1) dir = join(base, `${dirSlug(name)}-${n}`);
      await mkdir(dir, { recursive: true });
      dir = await realpath(dir);
    }
    await this.checkRoot(dir);
    if (this.items.some((p) => p.dir === dir)) throw new FileError(409, '已经有项目使用这个目录');
    const project = { id: randomUUID(), name, dir, createdAt: new Date().toISOString() };
    this.items.push(project);
    await this.save();
    return project;
  }

  async guardedReal() {
    this.guardedCache ||= await Promise.all(this.guarded.map((g) => realpath(g).catch(() => resolve(g))));
    return this.guardedCache;
  }

  async checkRoot(dir) {
    if ((await this.guardedReal()).some((g) => within(g, dir) || within(dir, g))) {
      throw new FileError(400, '这个目录包含登录凭据或服务数据，不能作为项目目录');
    }
  }

  async rename(id, rawName) {
    const project = this.get(id);
    if (!project) throw new FileError(404, '项目不存在');
    project.name = projectName(rawName);
    await this.save();
    return project;
  }

  /** The directory itself stays on disk. */
  async remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((p) => p.id !== id);
    if (this.items.length === before) return false;
    await this.save();
    return true;
  }

  /** Directory a file panel browses: a project's, or the default working directory. */
  rootDir(key) {
    if (key === DEFAULT_ROOT) return this.cfg.claudeCwd;
    const project = this.get(key);
    if (!project) throw new FileError(404, '项目不存在');
    return project.dir;
  }

  /**
   * Resolves `raw` (relative to the root, or absolute inside it, or ~/...) to a real path under
   * the root. Symlinks are followed and must stay inside; secret files and folders are refused.
   */
  async locate(key, raw = '') {
    const root = await realpath(this.rootDir(key)).catch(() => { throw new FileError(404, '项目目录不存在'); });
    const text = String(raw || '').trim().replace(/^~(?=$|\/)/, homedir());
    const joined = isAbsolute(text) ? resolve(text) : resolve(root, text);
    if (!within(joined, root)) throw new FileError(403, '只能查看项目目录里的文件');
    let real;
    try {
      real = await realpath(joined);
    } catch {
      throw new FileError(404, '文件不存在');
    }
    if (!within(real, root)) throw new FileError(403, '只能查看项目目录里的文件');
    const rel = relative(root, real);
    const parts = rel ? rel.split(sep) : [];
    if (parts.some((p) => HIDDEN_DIRS.has(p)) || (parts.length && SECRET_FILE.test(parts[parts.length - 1]))) {
      throw new FileError(403, '这个文件可能含有凭据，不能在网页上查看');
    }
    if ((await this.guardedReal()).some((g) => within(real, g))) throw new FileError(403, '这个文件可能含有凭据，不能在网页上查看');
    return { root, real, rel: parts.join('/') };
  }

  async listDir(key, raw) {
    const { real, rel } = await this.locate(key, raw);
    if (!(await stat(real)).isDirectory()) throw new FileError(400, '这不是目录');
    const names = await readdir(real, { withFileTypes: true });
    const entries = [];
    for (const d of names) {
      if (d.isDirectory() ? HIDDEN_DIRS.has(d.name) : SECRET_FILE.test(d.name)) continue;
      let st;
      try { st = await stat(join(real, d.name)); } catch { continue; }
      if (st.isDirectory() && HIDDEN_DIRS.has(d.name)) continue;
      if (!st.isDirectory() && !st.isFile()) continue;
      entries.push({ name: d.name, type: st.isDirectory() ? 'dir' : 'file', size: st.isFile() ? st.size : null, mtime: st.mtime.toISOString() });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : (a.type === 'dir' ? -1 : 1)));
    return { path: rel, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
  }

  /** What the preview needs: text (up to 512 KB) for text files, just metadata otherwise. */
  async preview(key, raw) {
    const { real, rel } = await this.locate(key, raw);
    const st = await stat(real);
    if (st.isDirectory()) return { path: rel, kind: 'dir' };
    const ext = extname(real).toLowerCase();
    const base = { path: rel, name: basename(real), size: st.size, mtime: st.mtime.toISOString() };
    if (IMAGE[ext]) return { ...base, kind: 'image' };
    const fh = await open(real, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, MAX_TEXT));
      await fh.read(buf, 0, buf.length, 0);
      if (buf.subarray(0, SNIFF).includes(0)) return { ...base, kind: 'binary' };
      let text = buf.toString('utf8');
      if (st.size > MAX_TEXT) text = text.replace(/�+$/, '');
      return { ...base, kind: MARKDOWN.has(ext) ? 'markdown' : 'text', text, truncated: st.size > MAX_TEXT };
    } finally {
      await fh.close();
    }
  }

  /** The file itself, for images and downloads. */
  async raw(key, raw) {
    const { real } = await this.locate(key, raw);
    const st = await stat(real);
    if (!st.isFile()) throw new FileError(400, '这不是文件');
    return { path: real, name: basename(real), size: st.size, type: IMAGE[extname(real).toLowerCase()] || null };
  }
}
