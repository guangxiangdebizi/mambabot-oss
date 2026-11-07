import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Images a reply links from the web (`![](https://…)`) are fetched by the server and served
// from this origin: the page's CSP stays `img-src 'self'`, the owner's phone never contacts
// third parties directly (and sees hosts it could not reach itself), and nothing but public
// addresses can be fetched (no SSRF into localhost, the cloud metadata service or the LAN).

const MAX_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 4;
const CACHE_MAX_BYTES = 300 * 1024 * 1024;
const CACHE_MAX_FILES = 3000;
const MAX_PARALLEL = 4;

export class RemoteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['2002::', 16],
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32],
]) blocked.addSubnet(net, bits, 'ipv6');

const fakeIps = new BlockList();
fakeIps.addSubnet('198.18.0.0', 15, 'ipv4');

/** False for loopback, private, link-local, multicast, documentation and mapped addresses of those. */
export function isPublicAddress(address) {
  const family = isIP(address);
  if (!family) return false;
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^::ffff:/i.test(address)) return false;
  }
  return !blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

// Magic numbers of the formats a page can show, for servers that send no useful type.
function sniffImage(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.toString('latin1', 4, 12).startsWith('ftypavi')) return 'image/avif';
  if (buf.length >= 2 && buf.toString('latin1', 0, 2) === 'BM') return 'image/bmp';
  return null;
}
const SHOWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon']);

export function checkUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { throw new RemoteError(400, '图片链接格式不正确'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RemoteError(400, '只支持 http/https 图片链接');
  if (url.username || url.password) throw new RemoteError(400, '图片链接不能带账号密码');
  url.hash = '';
  return url;
}

export class RemoteImages {
  /**
   * @param fakeIp  also accept 198.18.0.0/15, where a local proxy's DNS points every name
   * @param allowPrivate  any address (tests only)
   */
  constructor({ dataDir, log = console, lookup = dnsLookup, fakeIp = false, allowPrivate = false }) {
    this.dir = join(dataDir, 'remote-images');
    this.log = log;
    this.lookup = lookup;
    this.fakeIp = fakeIp;
    this.allowPrivate = allowPrivate;
    this.inflight = new Map();
    this.running = 0;
    this.waiting = [];
    this.pruneAt = 0;
  }

  /** { path, type, size } of a cached copy, fetching it first when needed. */
  async get(raw) {
    const url = checkUrl(raw);
    const key = createHash('sha256').update(url.href).digest('hex');
    const file = join(this.dir, `${key}.bin`);
    const metaFile = join(this.dir, `${key}.json`);
    const meta = await readFile(metaFile, 'utf8').then(JSON.parse).catch(() => null);
    if (meta && (await stat(file).catch(() => null))?.size === meta.size) {
      const now = new Date();
      utimes(file, now, now).catch(() => {});
      return { path: file, type: meta.type, size: meta.size };
    }
    if (!this.inflight.has(key)) {
      const job = this.slot(() => this.download(url, file, metaFile)).finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    return this.inflight.get(key);
  }

  async slot(fn) {
    if (this.running >= MAX_PARALLEL) await new Promise((r) => this.waiting.push(r));
    this.running += 1;
    try {
      return await fn();
    } finally {
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }

  async resolvePublic(hostname) {
    const host = hostname.replace(/^\[|\]$/g, '');
    let addrs;
    if (isIP(host)) addrs = [{ address: host, family: isIP(host) }];
    else {
      try { addrs = await this.lookup(host, { all: true, verbatim: true }); } catch { throw new RemoteError(502, `无法解析图片域名 ${host}`); }
    }
    if (!addrs.length) throw new RemoteError(502, `无法解析图片域名 ${host}`);
    const ok = (a) => this.allowPrivate || isPublicAddress(a.address) || (this.fakeIp && isIP(a.address) === 4 && fakeIps.check(a.address, 'ipv4'));
    if (!addrs.every(ok)) throw new RemoteError(403, '不能加载内网或本机地址的图片');
    return addrs[0];
  }

  /** One GET, connecting only to the address that passed the check (no DNS rebinding). */
  async fetchOnce(url) {
    const addr = await this.resolvePublic(url.hostname);
    const mod = url.protocol === 'https:' ? https : http;
    return new Promise((resolvePromise, reject) => {
      const req = mod.get(url, {
        headers: {
          'User-Agent': 'MambaBot-ImageProxy/1.0 (+https://github.com/guangxiangdebizi/mambabot-oss)',
          Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
        },
        lookup: (hostname, opts, cb) => (opts?.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)),
        timeout: TIMEOUT_MS,
      }, (res) => resolvePromise(res));
      req.on('timeout', () => req.destroy(new RemoteError(504, '图片下载超时')));
      req.on('error', (err) => reject(err instanceof RemoteError ? err : new RemoteError(502, `图片下载失败：${err.code || err.message}`)));
    });
  }

  async download(start, file, metaFile) {
    let url = start;
    let res;
    for (let hop = 0; ; hop += 1) {
      res = await this.fetchOnce(url);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hop >= MAX_REDIRECTS) throw new RemoteError(502, '图片链接重定向次数过多');
        url = checkUrl(new URL(res.headers.location, url).href);
        continue;
      }
      break;
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw new RemoteError(502, `图片服务器返回 ${res.statusCode}`);
    }
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      res.destroy();
      throw new RemoteError(413, `图片超过 ${MAX_BYTES / 1024 / 1024} MB`);
    }
    const chunks = [];
    let size = 0;
    const deadline = setTimeout(() => res.destroy(new RemoteError(504, '图片下载超时')), TIMEOUT_MS * 2);
    try {
      for await (const chunk of res) {
        size += chunk.length;
        if (size > MAX_BYTES) { res.destroy(); throw new RemoteError(413, `图片超过 ${MAX_BYTES / 1024 / 1024} MB`); }
        chunks.push(chunk);
      }
    } catch (err) {
      throw err instanceof RemoteError ? err : new RemoteError(502, '图片下载中断');
    } finally {
      clearTimeout(deadline);
    }
    const buf = Buffer.concat(chunks);
    const declaredType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const type = sniffImage(buf) || (declaredType === 'image/svg+xml' || (declaredType === '' && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(buf.toString('utf8', 0, 512))) ? 'image/svg+xml' : (SHOWABLE.has(declaredType) ? declaredType : null));
    if (!type || !buf.length) throw new RemoteError(415, '这个链接不是图片');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, buf, { mode: 0o600 });
    await rename(tmp, file);
    await writeFile(metaFile, JSON.stringify({ url: start.href, type, size: buf.length, fetchedAt: new Date().toISOString() }), { mode: 0o600 });
    this.pruneSoon();
    return { path: file, type, size: buf.length };
  }

  /** Keeps the cache under its size and count limits, least recently used first. */
  pruneSoon() {
    const now = Date.now();
    if (now < this.pruneAt) return;
    this.pruneAt = now + 10 * 60 * 1000;
    this.prune().catch((err) => this.log.warn('清理外链图片缓存失败', err.message));
  }

  async prune() {
    const names = (await readdir(this.dir).catch(() => [])).filter((n) => n.endsWith('.bin'));
    const files = [];
    for (const n of names) {
      const st = await stat(join(this.dir, n)).catch(() => null);
      if (st) files.push({ n, size: st.size, at: st.mtimeMs });
    }
    files.sort((a, b) => b.at - a.at);
    let total = 0;
    for (const [i, f] of files.entries()) {
      total += f.size;
      if (total > CACHE_MAX_BYTES || i >= CACHE_MAX_FILES) {
        await rm(join(this.dir, f.n), { force: true });
        await rm(join(this.dir, f.n.replace(/\.bin$/, '.json')), { force: true });
      }
    }
  }
}
