import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ensurePrivateDir, readJson, writeJsonAtomic } from './fsutil.js';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64 };

export const SECRET_FILE = 'initial-login-secret';
export const AUTH_FILE = 'auth.json';

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024,
  });
  return {
    algo: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    salt: salt.toString('base64'), hash: hash.toString('base64'),
    createdAt: new Date().toISOString(),
  };
}

export async function verifyPassword(password, record) {
  if (!record || record.algo !== 'scrypt' || typeof password !== 'string') return false;
  const expected = Buffer.from(record.hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(record.salt, 'base64'), expected.length, {
    N: record.N, r: record.r, p: record.p, maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(actual, expected);
}

/**
 * Creates the login secret on first start. The plaintext goes only into a mode-600 file
 * in the config dir; the server keeps just the scrypt hash. Returns the secret path.
 */
export async function ensureCredentials(configDir, log) {
  await ensurePrivateDir(configDir);
  const authPath = join(configDir, AUTH_FILE);
  const secretPath = join(configDir, SECRET_FILE);
  if (await readJson(authPath)) return secretPath;
  const secret = randomBytes(24).toString('base64url');
  await writeFile(secretPath, `${secret}\n`, { mode: 0o600 });
  await chmod(secretPath, 0o600);
  await writeJsonAtomic(authPath, await hashPassword(secret));
  log.info(`已生成初始登录密钥，保存在 ${secretPath}`);
  return secretPath;
}

export function readAuthRecord(configDir) {
  return readJson(join(configDir, AUTH_FILE));
}

const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

/** Server-side sessions; only SHA-256 hashes of the cookie tokens are stored on disk. */
export class SessionStore {
  constructor(path, ttlMs) {
    this.path = path;
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  async load() {
    const saved = await readJson(this.path, {});
    const now = Date.now();
    for (const [hash, s] of Object.entries(saved)) {
      if (s.expiresAt > now) this.sessions.set(hash, s);
    }
  }

  persist() {
    return writeJsonAtomic(this.path, Object.fromEntries(this.sessions));
  }

  async create() {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions.set(tokenHash(token), { createdAt: now, expiresAt: now + this.ttlMs });
    await this.persist();
    return token;
  }

  validate(token) {
    if (!token) return false;
    const s = this.sessions.get(tokenHash(token));
    if (!s) return false;
    if (s.expiresAt <= Date.now()) {
      this.sessions.delete(tokenHash(token));
      return false;
    }
    return true;
  }

  async destroy(token) {
    if (token && this.sessions.delete(tokenHash(token))) await this.persist();
  }
}

/**
 * Failed-login limiter: per client address, plus a global ceiling because behind an SSH
 * forward or reverse proxy every client may look like 127.0.0.1.
 */
export class LoginLimiter {
  constructor({ perKey = 5, global = 20, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
    Object.assign(this, { perKey, global, windowMs, now });
    this.failures = new Map();
  }

  recent(key) {
    const cutoff = this.now() - this.windowMs;
    const list = (this.failures.get(key) || []).filter((t) => t > cutoff);
    this.failures.set(key, list);
    return list;
  }

  check(key) {
    for (const [k, limit] of [[key, this.perKey], ['*', this.global]]) {
      const list = this.recent(k);
      if (list.length >= limit) {
        return { allowed: false, retryAfterSec: Math.ceil((list[0] + this.windowMs - this.now()) / 1000) };
      }
    }
    return { allowed: true };
  }

  fail(key) {
    this.recent(key).push(this.now());
    this.recent('*').push(this.now());
  }

  succeed(key) {
    this.failures.delete(key);
  }
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

/** Host allowlist; blocks DNS-rebinding pages that point a foreign name at 127.0.0.1. */
export function checkHost(hostHeader, allowedHosts) {
  return allowedHosts.includes(hostnameOf(hostHeader));
}

/** Mutations must come from a page served by this same host. */
export function checkOrigin(headers) {
  const site = headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  if (!headers.origin || !headers.host) return false;
  try {
    return new URL(headers.origin).host.toLowerCase() === headers.host.toLowerCase();
  } catch {
    return false;
  }
}
