import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

// Context-window usage of one chat branch, from the CLI's own `get_context_usage` control
// request (what the terminal's /context shows). The session is opened as a throwaway fork
// with no persistence, so nothing is written and no model call is made.

const PROBE_TIMEOUT_MS = 25000;
const FRESH_MS = 20 * 1000;

const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

export function normalizeContext(raw) {
  const categories = (Array.isArray(raw?.categories) ? raw.categories : [])
    .filter((c) => c && typeof c.name === 'string')
    .map((c) => ({ id: String(c.id || ''), name: c.name, tokens: int(c.tokens) || 0, kind: String(c.kind || 'used') }));
  return {
    totalTokens: int(raw?.totalTokens),
    maxTokens: int(raw?.maxTokens),
    percentage: int(raw?.percentage),
    model: raw?.model ? String(raw.model) : null,
    categories,
  };
}

export class ContextProbe {
  constructor({ cfg, spawnImpl = spawn }) {
    Object.assign(this, { cfg, spawnImpl });
    this.cache = new Map();
    this.inflight = new Map();
  }

  /** @param resume { sessionId, at? } or null for a chat with no Claude session yet */
  get({ resume = null, model = '' } = {}) {
    const key = `${resume?.sessionId || '-'}|${resume?.at || ''}|${model}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < FRESH_MS) return Promise.resolve(hit.value);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = this.probe(resume, model).then((value) => {
      this.cache.set(key, { at: Date.now(), value });
      if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value);
      return value;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  probe(resume, model) {
    return new Promise((resolve, reject) => {
      const args = [
        ...this.cfg.claudePrefixArgs,
        '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--no-session-persistence', '--permission-mode', 'manual', '--permission-prompt-tool', 'stdio',
      ];
      if (resume?.sessionId) {
        args.push('--resume', resume.sessionId, '--fork-session');
        if (resume.at) args.push('--resume-session-at', resume.at);
      }
      if (model) args.push('--model', model);
      const child = this.spawnImpl(this.cfg.claudeBin, args, {
        cwd: this.cfg.claudeCwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'ignore'],
      });
      let buf = '';
      let done = false;
      const finish = (err, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.stdin.end();
        child.kill('SIGTERM');
        if (err) reject(err); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('读取上下文超时')), PROBE_TIMEOUT_MS);
      child.on('error', (err) => finish(err));
      child.on('close', () => finish(new Error('CLI 提前退出')));
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          if (m.type !== 'control_response' || m.response?.request_id !== 'ctx') continue;
          if (m.response.subtype !== 'success') return finish(new Error(m.response.error || 'get_context_usage 失败'));
          return finish(null, normalizeContext(m.response.response));
        }
        return undefined;
      });
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'ctx', request: { subtype: 'get_context_usage' } })}\n`);
    });
  }
}

const TAIL_BYTES = 256 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/**
 * The CLI's own running total for one session (what the terminal's /cost shows): it appends a
 * cumulative `cost-state` entry to the session file after every reply; a fork starts from zero.
 * Null when absent.
 */
export async function sessionCost(cfg, sessionId) {
  if (!/^[0-9a-f-]{36}$/.test(sessionId || '')) return null;
  const file = join(cfg.claudeProjectsDir, cfg.claudeCwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
  let fh;
  try {
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    const read = async (start) => {
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      return buf.toString('utf8');
    };
    let text = await read(Math.max(0, size - TAIL_BYTES));
    let i = text.lastIndexOf('{"type":"cost-state"');
    if (i < 0 && size > TAIL_BYTES && size <= MAX_SCAN_BYTES) {
      text = await read(0);
      i = text.lastIndexOf('{"type":"cost-state"');
    }
    if (i < 0) return null;
    const end = text.indexOf('\n', i);
    const entry = JSON.parse(text.slice(i, end < 0 ? undefined : end));
    const cost = Number(entry.totalCostUSD);
    return Number.isFinite(cost) ? { costUsd: Math.round(cost * 1e6) / 1e6, sessionId } : null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}
