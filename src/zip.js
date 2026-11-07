import { inflateRawSync } from 'node:zlib';

// Just enough of the ZIP format to read Office files (docx/xlsx/pptx) for previews: the
// central directory, stored and deflated entries. No zip64, no encryption, no writing.
// Every inflate is capped, so a crafted archive cannot blow up memory.

export class ZipError extends Error {}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Map of entry name -> { name, method, compSize, size, offset, flags }. */
export function readZip(buf, { maxEntries = 10000 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('不是有效的压缩包');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('不是有效的压缩包');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || p === 0xffffffff) throw new ZipError('不支持 zip64 格式');
  if (count > maxEntries) throw new ZipError('压缩包里的文件太多');
  if (p + cdSize > buf.length) throw new ZipError('压缩包已损坏');
  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new ZipError('压缩包已损坏');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    if (!name.endsWith('/')) entries.set(name, { name, method, compSize, size, offset, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The bytes of one entry, at most `maxBytes` once inflated. */
export function entryData(buf, entry, maxBytes = 32 * 1024 * 1024) {
  if (!entry) throw new ZipError('压缩包里没有这个文件');
  if (entry.flags & 1) throw new ZipError('压缩包已加密');
  const p = entry.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL) throw new ZipError('压缩包已损坏');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const end = start + entry.compSize;
  if (end > buf.length) throw new ZipError('压缩包已损坏');
  const raw = buf.subarray(start, end);
  if (entry.method === 0) {
    if (raw.length > maxBytes) throw new ZipError('文件内容过大，无法预览');
    return raw;
  }
  if (entry.method !== 8) throw new ZipError('不支持的压缩方式');
  try {
    return inflateRawSync(raw, { maxOutputLength: maxBytes });
  } catch (err) {
    if (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) throw new ZipError('文件内容过大，无法预览');
    throw new ZipError('压缩包已损坏');
  }
}

/** Text of an entry (UTF-8, BOM stripped), or null when the archive has no such entry. */
export function entryText(buf, entries, name, maxBytes) {
  const e = entries.get(name);
  if (!e) return null;
  return entryData(buf, e, maxBytes).toString('utf8').replace(/^﻿/, '');
}
