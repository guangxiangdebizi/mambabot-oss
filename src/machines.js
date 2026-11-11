import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, posix } from 'node:path';
import { ensurePrivateDir, readJson, writeJsonAtomic } from './fsutil.js';
import { HIDDEN_DIRS, SECRET_FILE } from './hostfiles.js';
import { buildPreview, previewPart, typeOf } from './preview.js';

// The owner's own computers (远程机器), reached with an SSH alias that already exists in this
// server's ~/.ssh/config, e.g. a home PC over Tailscale or a reverse tunnel. Browsing is
// read-only and goes through the system `sftp` in batch mode: SFTP works the same against
// Windows OpenSSH and Linux, whatever the remote shell is (cmd, PowerShell, bash). MambaBot
// keeps no passwords and makes no keys; it only uses the server's existing SSH setup.
//
// Every request first canonicalises the allowed root and the target directory on the remote
// side (`cd` + `pwd`, which resolves `..` and symlinks), and refuses anything outside the root.
// Symbolic links are not listed, secret files and folders are hidden as on this host (plus the
// usual Windows credential locations), and files are copied into a small local cache before
// the reader sees them, with a size limit so a large file cannot clog a slow tunnel.

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ENTRIES = 1000;
const LIST_TTL_MS = 10 * 1000;
const STATUS_TTL_MS = 30 * 1000;
const LIST_TIMEOUT_MS = 25 * 1000;
const CACHE_MAX_BYTES = 300 * 1024 * 1024;
const MAX_MACHINES = 20;
const MAX_ROOTS = 10;
// Windows keeps browser profiles, credentials and app tokens under these.
const REMOTE_HIDDEN = new Set([...HIDDEN_DIRS, 'AppData', 'Application Data', 'Local Settings', 'Cookies', '$Recycle.Bin', 'System Volume Information', '.claude']);
const REMOTE_SECRET = /^(ntuser\.(dat|ini|pol).*|.*\.ppk|.*\.ovpn|.*\.rdp|.*\.kdb)$/i;
// sftp prints `ls -l` lines as: mode links owner group size month day time|year name.
const LS_LINE = /^([-dlpscb])\S{9,10}\s+\S+\s+(.*?)\s+(\d+)\s+([A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4}))\s(.+)$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export class MachineError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Host aliases (no wildcards) from an ssh_config file. `Include` is not followed. */
export function sshHosts(text) {
  const hosts = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*Host(?:\s*=\s*|\s+)(.+)$/i);
    if (!m) continue;
    for (const h of m[1].split(/\s+/)) {
      if (h && ALIAS_RE.test(h) && !hosts.includes(h)) hosts.push(h);
    }
  }
  return hosts;
}

/**
 * A remote path as the owner typed it (`D:\Projects`, `/home/me/work`) in the form SFTP uses:
 * forward slashes, absolute, Windows drives as `/D:/…`. Quotes and control characters are
 * refused (they cannot be passed through an sftp batch line safely).
 */
export function remotePath(raw) {
  let p = String(raw ?? '').trim().replace(/\\/g, '/');
  if (!p || /[\0-\x1f"]/.test(p)) throw new MachineError(400, '路径格式不正确');
  if (/^[A-Za-z]:(\/|$)/.test(p)) p = `/${p}`;
  if (!p.startsWith('/')) throw new MachineError(400, '请填写绝对路径，例如 D:\\Projects 或 /home/me/work');
  p = posix.normalize(p);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (/^\/[A-Za-z]:$/.test(p)) p += '/';
  return p;
}

/** How the owner reads a remote path: `D:\Projects\x` on Windows, as is elsewhere. */
export function displayPath(p) {
  const m = String(p).match(/^\/([A-Za-z]):(\/.*)?$/);
  if (!m) return p;
  return `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`;
}

const isWindowsPath = (p) => /^\/[A-Za-z]:(\/|$)/.test(p);
const fold = (p) => (isWindowsPath(p) ? p.toLowerCase() : p);
export function remoteWithin(p, root) {
  const a = fold(p);
  const r = fold(root);
  return a === r || a.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/** sftp writes non-printable bytes of names as \ooo (and \\ for a backslash) in some locales. */
export function unescapeSftp(text) {
  if (!text.includes('\\')) return text;
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\' && /^[0-7]{3}$/.test(text.slice(i + 1, i + 4))) {
      bytes.push(parseInt(text.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (ch === '\\' && text[i + 1] === '\\') {
      bytes.push(0x5c);
      i += 1;
    } else {
      bytes.push(...Buffer.from(ch, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** One `ls -l` line from sftp, or null. */
export function parseLsLine(line, now = new Date()) {
  const m = String(line).match(LS_LINE);
  if (!m) return null;
  const [, mode, , size, date, rawName] = m;
  const name = unescapeSftp(rawName);
  const type = mode === 'd' ? 'dir' : mode === '-' ? 'file' : mode === 'l' ? 'link' : 'other';
  return { type, name, size: Number(size), date: date.replace(/\s+/g, ' '), mtime: lsDate(date, now) };
}

/** `Nov 7 01:29` (within the last ~6 months, year omitted) or `Nov 7 2025`. */
function lsDate(text, now) {
  const [mon, day, t] = text.split(/\s+/);
  const month = MONTHS.indexOf(mon);
  if (month < 0) return null;
  let d;
  if (t.includes(':')) {
    const [h, min] = t.split(':').map(Number);
    d = new Date(now.getFullYear(), month, Number(day), h, min);
    if (d.getTime() - now.getTime() > 2 * 24 * 3600 * 1000) d.setFullYear(d.getFullYear() - 1);
  } else {
    d = new Date(Number(t), month, Number(day));
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const quote = (p) => `"${String(p).replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
const joinRemote = (dir, rel) => (rel ? posix.join(dir, rel) : dir);
const hiddenName = (name, type) => (type === 'dir' ? REMOTE_HIDDEN.has(name) : SECRET_FILE.test(name) || REMOTE_SECRET.test(name));

/** A relative path inside a root: forward slashes, no `..`, no empty or secret segments. */
function relParts(raw) {
  const text = String(raw ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!text) return [];
  if (/[\0-\x1f"]/.test(text)) throw new MachineError(400, '路径格式不正确');
  const parts = text.split('/').filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) throw new MachineError(403, '只能查看允许的目录里的文件');
  return parts;
}

export class MachineStore {
  constructor(cfg, log = console) {
    this.cfg = cfg;
    this.log = log;
    this.file = join(cfg.dataDir, 'machines.json');
    this.cacheDir = join(cfg.dataDir, 'machine-cache');
    this.ctlDir = join(cfg.dataDir, 'ssh-ctl');
    this.sshConfigPath = cfg.sshConfigPath || join(homedir(), '.ssh', 'config');
    this.sftpBin = cfg.sftpBin || 'sftp';
    this.sftpPrefixArgs = cfg.sftpPrefixArgs || [];
    this.maxFile = cfg.remoteMaxBytes || 20 * 1024 * 1024;
    this.items = [];
    this.lists = new Map();
    this.status = new Map();
  }

  async load() {
    const data = await readJson(this.file, {});
    this.items = Array.isArray(data.machines) ? data.machines.filter((m) => m && m.id && m.host && Array.isArray(m.roots)) : [];
    await ensurePrivateDir(this.cacheDir);
    await ensurePrivateDir(this.ctlDir);
  }

  save() {
    return writeJsonAtomic(this.file, { machines: this.items });
  }

  list() {
    return this.items.map((m) => this.view(m));
  }

  get(id) {
    return this.items.find((m) => m.id === id) || null;
  }

  view(m) {
    const s = this.status.get(m.id);
    return {
      id: m.id, name: m.name, host: m.host,
      roots: m.roots.map((p) => ({ path: p, display: displayPath(p) })),
      online: s ? s.online : null, error: s?.online === false ? s.error : null, checkedAt: s ? new Date(s.at).toISOString() : null,
    };
  }

  async hosts() {
    try {
      return sshHosts(await readFile(this.sshConfigPath, 'utf8'));
    } catch {
      return [];
    }
  }

  async validate(body, current = null) {
    const name = String(body.name ?? current?.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 40) throw new MachineError(400, '名称需要 1–40 个字');
    const host = String(body.host ?? current?.host ?? '').trim();
    if (!ALIAS_RE.test(host)) throw new MachineError(400, '请填写 ~/.ssh/config 里的 Host 别名');
    if (!(await this.hosts()).includes(host)) throw new MachineError(400, `~/.ssh/config 里没有 Host ${host}，请先在服务器上配置好 SSH`);
    const rawRoots = body.roots === undefined ? current?.roots : body.roots;
    const roots = [...new Set((Array.isArray(rawRoots) ? rawRoots : String(rawRoots || '').split('\n')).map((r) => String(r).trim()).filter(Boolean).map(remotePath))];
    if (!roots.length) throw new MachineError(400, '至少填写一个允许浏览的目录');
    if (roots.length > MAX_ROOTS) throw new MachineError(400, `最多 ${MAX_ROOTS} 个目录`);
    for (const r of roots) {
      if (r === '/' || /^\/[A-Za-z]:\/$/.test(r)) throw new MachineError(400, '不能把整个磁盘设为允许浏览的目录，请选一个具体的文件夹');
      if (r.split('/').some((s) => REMOTE_HIDDEN.has(s))) throw new MachineError(400, `${displayPath(r)} 位于含有凭据的位置，不能浏览`);
    }
    return { name, host, roots };
  }

  async create(body) {
    if (this.items.length >= MAX_MACHINES) throw new MachineError(400, `最多 ${MAX_MACHINES} 台远程机器`);
    const v = await this.validate(body);
    const m = { id: randomUUID(), ...v, createdAt: new Date().toISOString() };
    this.items.push(m);
    await this.save();
    return m;
  }

  async update(id, body) {
    const m = this.get(id);
    if (!m) throw new MachineError(404, '远程机器不存在');
    Object.assign(m, await this.validate(body, m));
    this.lists.clear();
    this.status.delete(id);
    await this.save();
    return m;
  }

  async remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((m) => m.id !== id);
    if (this.items.length === before) return false;
    this.status.delete(id);
    await this.save();
    return true;
  }

  /** Runs one sftp batch; resolves with its output split per command. */
  sftp(m, commands, timeoutMs = LIST_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const args = [
        ...this.sftpPrefixArgs, '-q', '-b', '-',
        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
        // Reuse one connection for the requests that follow (folders opened one after another).
        '-o', 'ControlMaster=auto', '-o', `ControlPath=${join(this.ctlDir, '%C')}`, '-o', 'ControlPersist=120',
        '--', m.host,
      ];
      let child;
      try {
        child = spawn(this.sftpBin, args, { env: { ...process.env, LC_ALL: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ code: -1, stdout: '', stderr: err.message });
        return;
      }
      let stdout = '';
      let stderr = '';
      let done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut: code === 'timeout' });
      };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish('timeout'); }, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => { if (stdout.length < 4 * 1024 * 1024) stdout += c; });
      child.stderr.on('data', (c) => { if (stderr.length < 64 * 1024) stderr += c; });
      child.on('error', (err) => { stderr += err.message; finish(-1); });
      child.on('close', (code) => finish(code));
      child.stdin.on('error', () => {});
      child.stdin.end(`${commands.join('\n')}\n`);
    });
  }

  /** Output lines of each command of a batch (sftp echoes every command as `sftp> …`). */
  static sections(stdout) {
    const out = [];
    for (const line of stdout.split('\n')) {
      if (line.startsWith('sftp> ')) out.push({ cmd: line.slice(6), lines: [] });
      else if (out.length && line) out[out.length - 1].lines.push(line.replace(/\r$/, ''));
    }
    return out;
  }

  fail(m, res) {
    const msg = (res.stderr || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const first = msg[0] || '';
    const offline = res.timedOut || res.code === 255 || res.code === -1
      || /ssh:|connection (refused|closed|timed out|reset)|could not resolve|no route|network is unreachable|host key verification|permission denied \(|banner exchange|kex_exchange/i.test(res.stderr);
    if (offline) {
      this.status.set(m.id, { online: false, error: res.timedOut ? '连接超时' : first.slice(0, 200), at: Date.now() });
      return new MachineError(503, `${m.name} 离线或无法连接${first && !res.timedOut ? `（${first.slice(0, 160)}）` : res.timedOut ? '（连接超时）' : ''}`, { offline: true });
    }
    this.status.set(m.id, { online: true, at: Date.now() });
    if (/not found|no such file|couldn't canonicali[sz]e|can't change directory/i.test(res.stderr)) return new MachineError(404, '文件或目录不存在');
    if (/permission denied/i.test(res.stderr)) return new MachineError(403, '远程机器上没有权限读取这个位置');
    return new MachineError(502, `读取远程机器失败${first ? `：${first.slice(0, 160)}` : ''}`);
  }

  /**
   * Where a request browses: `rootPath` is an allowed root, or a folder inside one (a remote
   * project's directory). Returns the allowed root it falls under and the folder itself.
   */
  scope(m, rootPath) {
    const base = remotePath(rootPath);
    const allowed = m.roots.find((r) => remoteWithin(base, r));
    if (!allowed) throw new MachineError(403, '这个目录不在允许浏览的范围内');
    if (base.slice(allowed.length).split('/').some((s) => REMOTE_HIDDEN.has(s))) throw new MachineError(403, '这个位置可能含有凭据，不能在网页上查看');
    return { allowed, base };
  }

  /**
   * Canonical allowed root, browse root and directory (`cd` + `pwd` on the remote side resolve
   * `..` and symlinks), then the directory's entries. `dirParts` is relative to the browse root.
   */
  async listCanonical(m, { allowed, base }, dirParts) {
    const target = joinRemote(base, dirParts.join('/'));
    const res = await this.sftp(m, [`cd ${quote(allowed)}`, 'pwd', `cd ${quote(base)}`, 'pwd', `cd ${quote(target)}`, 'pwd', 'ls -lna']);
    const secs = MachineStore.sections(res.stdout);
    if (res.code !== 0) throw this.fail(m, res);
    this.status.set(m.id, { online: true, at: Date.now() });
    const pwd = (s) => unescapeSftp((s?.lines.find((l) => l.startsWith('Remote working directory: ')) || '').slice('Remote working directory: '.length));
    const allowedReal = pwd(secs[1]);
    const rootReal = pwd(secs[3]);
    const dirReal = pwd(secs[5]);
    if (!allowedReal || !rootReal || !dirReal) throw new MachineError(502, '远程机器的回应无法识别');
    if (!remoteWithin(rootReal, allowedReal) || !remoteWithin(dirReal, rootReal)) throw new MachineError(403, '只能查看允许的目录里的文件');
    const entries = [];
    for (const line of secs[6]?.lines || []) {
      const e = parseLsLine(line);
      if (!e || e.name === '.' || e.name === '..' || e.name.includes('/')) continue;
      entries.push(e);
    }
    return { rootReal, dirReal, entries };
  }

  async listDir(id, rootPath, raw = '') {
    const m = this.get(id);
    if (!m) throw new MachineError(404, '远程机器不存在');
    const scope = this.scope(m, rootPath);
    const parts = relParts(raw);
    if (parts.some((p) => REMOTE_HIDDEN.has(p))) throw new MachineError(403, '这个位置可能含有凭据，不能在网页上查看');
    const key = `${id}|${scope.base}|${parts.join('/')}`;
    const hit = this.lists.get(key);
    if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.value;
    const { dirReal, entries } = await this.listCanonical(m, scope, parts);
    const shown = entries
      .filter((e) => (e.type === 'dir' || e.type === 'file') && !hiddenName(e.name, e.type))
      .map((e) => ({ name: e.name, type: e.type, size: e.type === 'file' ? e.size : null, mtime: e.mtime }));
    shown.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : (a.type === 'dir' ? -1 : 1)));
    const value = {
      machine: { id: m.id, name: m.name, host: m.host }, root: scope.base, rootDisplay: displayPath(scope.base), dir: dirReal, dirDisplay: displayPath(dirReal),
      path: parts.join('/'), entries: shown.slice(0, MAX_ENTRIES), truncated: shown.length > MAX_ENTRIES,
    };
    this.lists.set(key, { at: Date.now(), value });
    if (this.lists.size > 200) this.lists.delete(this.lists.keys().next().value);
    return value;
  }

  /** Online check: the first root can be opened. Cached for a short while. */
  async check(id, { force = false } = {}) {
    const m = this.get(id);
    if (!m) throw new MachineError(404, '远程机器不存在');
    const s = this.status.get(id);
    if (!force && s && Date.now() - s.at < STATUS_TTL_MS) return this.view(m);
    const res = await this.sftp(m, [`cd ${quote(m.roots[0])}`, 'pwd'], 15000);
    if (res.code === 0) this.status.set(id, { online: true, at: Date.now() });
    else this.fail(m, res);
    return this.view(m);
  }

  /**
   * A regular file inside a root, copied into the local cache (keyed by path, size and date, so
   * an unchanged file is fetched once). Returns { path (local), name, size, display }.
   */
  async fetch(id, rootPath, raw) {
    const m = this.get(id);
    if (!m) throw new MachineError(404, '远程机器不存在');
    const scope = this.scope(m, rootPath);
    const parts = relParts(raw);
    if (!parts.length) throw new MachineError(400, '缺少文件路径');
    const name = parts[parts.length - 1];
    if (parts.slice(0, -1).some((p) => REMOTE_HIDDEN.has(p)) || hiddenName(name, 'file')) {
      throw new MachineError(403, '这个文件可能含有凭据，不能在网页上查看');
    }
    const { dirReal, entries } = await this.listCanonical(m, scope, parts.slice(0, -1));
    const entry = entries.find((e) => e.name === name);
    if (!entry) throw new MachineError(404, '文件不存在');
    if (entry.type === 'dir') return { dir: true, display: displayPath(joinRemote(dirReal, name)), path: parts.join('/') };
    if (entry.type !== 'file') throw new MachineError(403, '只能查看普通文件（不跟随符号链接）');
    if (entry.size > this.maxFile) {
      throw new MachineError(413, `文件有 ${(entry.size / 1048576).toFixed(1)} MB，超过远程预览上限 ${Math.round(this.maxFile / 1048576)} MB。可以让 Claude 转换或压缩后再看。`);
    }
    const remote = joinRemote(dirReal, name);
    const key = createHash('sha256').update(`${m.host}\0${fold(remote)}\0${entry.size}\0${entry.date}`).digest('hex').slice(0, 40);
    const local = join(this.cacheDir, `${key}${extname(name).toLowerCase().replace(/[^.\w]/g, '')}`);
    const have = await stat(local).catch(() => null);
    if (!have || have.size !== entry.size) {
      const tmp = `${local}.part`;
      const res = await this.sftp(m, [`get ${quote(remote)} ${quote(tmp)}`], Math.max(60000, Math.ceil(entry.size / (64 * 1024)) * 1000));
      if (res.code !== 0) {
        await rm(tmp, { force: true });
        throw this.fail(m, res);
      }
      await rename(tmp, local);
      this.prune().catch(() => {});
    } else {
      const now = new Date();
      await utimes(local, now, now).catch(() => {});
    }
    return { path: local, name, size: entry.size, display: displayPath(remote), mtime: entry.mtime };
  }

  async preview(id, rootPath, raw, { sheet = 0 } = {}) {
    const f = await this.fetch(id, rootPath, raw);
    if (f.dir) return { path: f.path, kind: 'dir', display: f.display };
    const file = await buildPreview(f.path, { display: relParts(raw).join('/'), name: f.name, sheet });
    return { ...file, mtime: f.mtime || file.mtime, remote: f.display };
  }

  async raw(id, rootPath, raw) {
    const f = await this.fetch(id, rootPath, raw);
    if (f.dir) throw new MachineError(400, '这不是文件');
    return { path: f.path, name: f.name, size: f.size, type: typeOf(f.name) };
  }

  async part(id, rootPath, raw, entry) {
    const f = await this.fetch(id, rootPath, raw);
    if (f.dir) throw new MachineError(400, '这不是文件');
    return previewPart(f.path, entry);
  }

  /** Keeps the local copies under a size budget, least recently used first. */
  async prune() {
    const names = await readdir(this.cacheDir).catch(() => []);
    const files = [];
    for (const n of names) {
      const st = await stat(join(this.cacheDir, n)).catch(() => null);
      if (st?.isFile()) files.push({ n, size: st.size, t: st.mtimeMs });
    }
    let total = files.reduce((a, f) => a + f.size, 0);
    files.sort((a, b) => a.t - b.t);
    for (const f of files) {
      if (total <= CACHE_MAX_BYTES) break;
      await rm(join(this.cacheDir, f.n), { force: true });
      total -= f.size;
    }
  }
}
