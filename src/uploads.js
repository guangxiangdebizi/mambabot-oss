import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { readJson, writeJsonAtomic } from './fsutil.js';

// Attachments are saved under Claude's working directory, so the Read tool can open them
// (text, code, PDF, images) without an extra approval. Images are also sent inline as image
// content blocks so the model sees them directly.

export const MAX_UPLOAD = 20 * 1024 * 1024;
export const MAX_INLINE_IMAGE = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Type of a file Claude shows from disk, by extension; unknown types download as binary.
const EXT_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.json': 'application/json', '.html': 'text/html', '.log': 'text/plain', '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
};

export function safeName(name) {
  const base = String(name || '').split(/[/\\]/).pop().replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  const cleaned = base.replace(/^\.+/, '').slice(-120);
  return cleaned || 'file';
}

class LimitError extends Error {}

export class UploadStore {
  constructor({ dataDir, claudeCwd }) {
    this.index = join(dataDir, 'uploads.json');
    this.root = join(claudeCwd, 'uploads');
    this.items = new Map();
  }

  async load() {
    for (const u of (await readJson(this.index, [])) || []) this.items.set(u.id, u);
  }

  persist() {
    return writeJsonAtomic(this.index, [...this.items.values()]);
  }

  get(id) {
    return this.items.get(id) || null;
  }

  /** Streams the request body to disk; rejects bodies over MAX_UPLOAD. */
  async save(req, { name, type }) {
    const id = randomUUID();
    const dir = join(this.root, id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, safeName(name));
    let size = 0;
    try {
      await pipeline(req, async function* limit(source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > MAX_UPLOAD) throw new LimitError();
          yield chunk;
        }
      }, createWriteStream(file, { mode: 0o600 }));
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      if (err instanceof LimitError) return { error: `文件超过 ${MAX_UPLOAD / 1024 / 1024} MB 上限` };
      throw err;
    }
    if (!size) {
      await rm(dir, { recursive: true, force: true });
      return { error: '文件是空的' };
    }
    const item = {
      id, name: safeName(name), type: String(type || 'application/octet-stream').split(';')[0].trim().toLowerCase(),
      size, path: file, createdAt: new Date().toISOString(),
    };
    this.items.set(id, item);
    await this.persist();
    return { item };
  }

  /** Copies a file from this host into the store (for files Claude shows the owner). */
  async importFile(src) {
    const id = randomUUID();
    const dir = join(this.root, id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const name = safeName(basename(src));
    const file = join(dir, name);
    try {
      await copyFile(src, file);
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
    const { size } = await stat(file);
    const item = {
      id, name, type: EXT_TYPES[extname(name).toLowerCase()] || 'application/octet-stream',
      size, path: file, createdAt: new Date().toISOString(), source: 'claude',
    };
    this.items.set(id, item);
    await this.persist();
    return item;
  }

  publicView(u) {
    return { id: u.id, name: u.name, type: u.type, size: u.size, image: INLINE_IMAGE_TYPES.has(u.type) };
  }

  async exists(u) {
    try { return (await stat(u.path)).isFile(); } catch { return false; }
  }

  /** Builds the user turn: text plus inline images, with saved paths named for Read. */
  async buildContent(text, uploads) {
    if (!uploads.length) return text;
    const blocks = [];
    const notes = [];
    for (const u of uploads) {
      if (INLINE_IMAGE_TYPES.has(u.type) && u.size <= MAX_INLINE_IMAGE) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: u.type, data: (await readFile(u.path)).toString('base64') } });
        notes.push(`- 图片 ${u.name}（已随消息附上，原文件：${u.path}）`);
      } else {
        notes.push(`- ${u.name}（${u.type}，${u.size} 字节）：${u.path}`);
      }
    }
    const note = `\n\n[所有者上传了附件，可以用 Read 工具读取]\n${notes.join('\n')}`;
    blocks.push({ type: 'text', text: `${text || '（请查看附件）'}${note}` });
    return blocks;
  }
}
