import { homedir } from 'node:os';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

// Files a reply points at can live anywhere on the host (/tmp screenshots, another checkout).
// The owner's web login already has a terminal, so reading them adds no new power; what this
// guards against is credentials ending up on a page or in a model-chosen <img>: secret files
// and folders are refused wherever they are, as are this app's own config and data.

// Never listed or served, wherever they appear in a path.
export const HIDDEN_DIRS = new Set(['.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store', 'keyrings']);
export const SECRET_FILE = /^(\.env(\..*)?|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.pgpass|\.credentials\.json|\.claude\.json(\.backup)?|\.[\w-]*_history|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keystore|jks|kdbx))$/i;

export class FileAccessError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const within = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** True when a path (relative parts) names a secret file or passes through a hidden folder. */
export function secretParts(parts) {
  return parts.some((p) => HIDDEN_DIRS.has(p)) || (parts.length > 0 && SECRET_FILE.test(parts[parts.length - 1]));
}

export class HostFiles {
  constructor(cfg) {
    const home = homedir();
    this.cfg = cfg;
    this.denied = [
      cfg.configDir, cfg.dataDir, join(home, '.ssh'), join(home, '.claude'), join(home, '.config', 'gh'),
      join(home, '.config', 'gcloud'), join(home, '.mozilla'), join(home, '.config', 'google-chrome'), join(home, '.config', 'chromium'),
      join(home, '.config', 'BrowserOS'), join(home, '.local', 'share', 'keyrings'),
      ...(cfg.browserProfile ? [cfg.browserProfile] : []),
      // The default account has no dir of its own (it is ~/.claude, already listed).
      ...(cfg.claudeAccounts || []).map((a) => a.dir).filter(Boolean),
      '/proc', '/sys', '/dev', '/run', '/boot', '/root', '/etc/ssh',
    ].filter((d) => typeof d === 'string' && d);
  }

  async deniedReal() {
    this.deniedCache ||= (await Promise.all(this.denied.map(async (d) => {
      const r = await realpath(d).catch(() => resolve(d));
      return r === resolve(d) ? [r] : [r, resolve(d)];
    }))).flat();
    return this.deniedCache;
  }

  /** Refuses credential locations; `real` must already be a real path. */
  async check(real) {
    if (secretParts(real.split(sep).filter(Boolean))) throw new FileAccessError(403, '这个文件可能含有凭据，不能在网页上查看');
    if ((await this.deniedReal()).some((d) => within(real, d))) throw new FileAccessError(403, '这个位置的文件含有凭据或服务数据，不能在网页上查看');
  }

  /**
   * Resolves a path as written in a reply: absolute, `~/…`, `file://…`, or relative to `base`
   * (the chat's working directory). Returns the real path of an existing file or directory.
   */
  async locate(raw, base = this.cfg.claudeCwd) {
    let text = String(raw ?? '').trim();
    if (/^file:\/\//i.test(text)) {
      try { text = decodeURIComponent(new URL(text).pathname); } catch { throw new FileAccessError(400, '路径格式不正确'); }
    }
    text = text.replace(/^~(?=$|\/)/, homedir());
    if (!text || text.includes('\0')) throw new FileAccessError(400, '缺少文件路径');
    const joined = isAbsolute(text) ? resolve(text) : resolve(base, text);
    let real;
    try {
      real = await realpath(joined);
    } catch {
      throw new FileAccessError(404, `文件不存在：${raw}`);
    }
    await this.check(real);
    return real;
  }

  /** Like locate(), but the result must be a regular file. */
  async file(raw, base) {
    const real = await this.locate(raw, base);
    const st = await stat(real);
    if (!st.isFile()) throw new FileAccessError(400, '这不是文件');
    return { real, size: st.size, mtime: st.mtime };
  }
}
