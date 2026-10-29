import { createHash, randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { MAX_UPLOAD } from './uploads.js';

// Lets a Claude run show the owner a file from this host inside its reply: images inline,
// anything else as a download card. The file is copied into the upload store, so the page
// only ever serves opaque upload ids, never arbitrary paths.

export const MEDIA_SERVER = 'assistant-media';
const MAX_PER_RUN = 20;

const TOOLS = [
  {
    name: 'show_file',
    description: '把服务器上的一个文件展示给所有者，显示在你这条回复里：图片（png/jpg/gif/webp）直接显示，可点开看大图；其他文件（PDF、表格、文档、压缩包、svg 等）显示为可下载的文件卡片。需要所有者“看”的截图、图表、生成的图片或文件都用它，不要只给路径，也不要用 Markdown 图片语法。网上的图片先下载到本机再展示。单个文件最大 20 MB，每条回复最多 20 个。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件的绝对路径（相对路径按你的工作目录解析）' },
        caption: { type: 'string', description: '可选：显示在文件下方的一句说明' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

export class MediaMcp {
  /**
   * @param show (runId, file) => Promise<boolean>  adds the copied upload to that run's reply;
   *   false when the run is gone
   */
  constructor({ cfg, uploads, show }) {
    Object.assign(this, { cfg, uploads, show });
    this.tokens = new Map();
    this.counts = new Map();
    // Credentials never leave the host through this tool, even if a page or file asks for it.
    this.denied = [cfg.configDir, join(homedir(), '.ssh'), join(homedir(), '.claude', '.credentials.json')];
  }

  serverFor(runId) {
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(createHash('sha256').update(token).digest('hex'), runId);
    return { type: 'http', url: `http://127.0.0.1:${this.cfg.port}/internal/mcp/media`, headers: { Authorization: `Bearer ${token}` } };
  }

  runEnded(runId) {
    for (const [hash, id] of this.tokens) if (id === runId) this.tokens.delete(hash);
    this.counts.delete(runId);
  }

  runFor(req) {
    const m = String(req.headers.authorization || '').match(/^Bearer (\S+)$/);
    return (m && this.tokens.get(createHash('sha256').update(m[1]).digest('hex'))) || null;
  }

  authorized(req) {
    return Boolean(this.runFor(req));
  }

  async showFile(runId, args) {
    const raw = String(args.path || '').trim();
    if (!raw) throw new Error('缺少 path');
    let path;
    try {
      path = await realpath(isAbsolute(raw) ? raw : join(this.cfg.claudeCwd, raw));
    } catch {
      throw new Error(`文件不存在：${raw}`);
    }
    if (this.denied.some((d) => path === d || path.startsWith(d + sep))) throw new Error('这个位置的文件含有凭据，不能展示');
    const st = await stat(path);
    if (!st.isFile()) throw new Error('只能展示文件，不能展示目录');
    if (!st.size) throw new Error('文件是空的');
    if (st.size > MAX_UPLOAD) throw new Error(`文件超过 ${MAX_UPLOAD / 1024 / 1024} MB 上限`);
    const n = (this.counts.get(runId) || 0) + 1;
    if (n > MAX_PER_RUN) throw new Error(`每条回复最多展示 ${MAX_PER_RUN} 个文件`);
    const item = await this.uploads.importFile(path);
    const caption = String(args.caption || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!(await this.show(runId, { attachment: this.uploads.publicView(item), caption }))) throw new Error('这条回复已经结束');
    this.counts.set(runId, n);
    return `已展示给所有者：${item.name}（${item.type}，${item.size} 字节）`;
  }

  /** Returns [status, body|null] for one JSON-RPC message from the run that owns `runId`. */
  async handle(msg, runId) {
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    if (msg.id === undefined || msg.id === null) return [202, null];
    switch (msg.method) {
      case 'initialize':
        return [200, reply({
          protocolVersion: msg.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: MEDIA_SERVER, version: '1.0.0' },
          instructions: '把服务器上的图片或文件直接展示在给所有者的回复里。',
        })];
      case 'ping': return [200, reply({})];
      case 'tools/list': return [200, reply({ tools: TOOLS })];
      case 'tools/call':
        try {
          if (msg.params?.name !== 'show_file') throw new Error(`未知工具 ${msg.params?.name}`);
          const text = await this.showFile(runId, msg.params?.arguments || {});
          return [200, reply({ content: [{ type: 'text', text }] })];
        } catch (err) {
          return [200, reply({ content: [{ type: 'text', text: err.message }], isError: true })];
        }
      default: return [200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `不支持的方法 ${msg.method}` } }];
    }
  }
}
