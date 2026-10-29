import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil.js';

// The model list comes from the Claude CLI itself: its `initialize` control response lists
// exactly the models this account and runtime accept, with their supported effort levels.
// Nothing here is hard-coded, so the picker never offers a model the CLI would refuse.

const PROBE_TIMEOUT_MS = 20000;
const REFRESH_MS = 6 * 60 * 60 * 1000;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function normalizeModels(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && typeof m.value === 'string' && m.value)
    .map((m) => ({
      value: m.value,
      resolvedModel: String(m.resolvedModel || m.value),
      displayName: String(m.displayName || m.value),
      description: String(m.description || ''),
      efforts: m.supportsEffort && Array.isArray(m.supportedEffortLevels)
        ? m.supportedEffortLevels.filter((e) => EFFORTS.includes(e)) : [],
    }));
}

export class ModelCatalog {
  constructor({ cfg, log = console, spawnImpl = spawn }) {
    Object.assign(this, { cfg, log, spawnImpl });
    this.path = join(cfg.dataDir, 'models.json');
    this.models = [];
    this.fetchedAt = null;
    this.probing = null;
  }

  async load() {
    const saved = await readJson(this.path, null);
    if (saved?.models?.length) {
      this.models = saved.models;
      this.fetchedAt = saved.fetchedAt;
    }
    if (!this.models.length || Date.now() - Date.parse(this.fetchedAt || 0) > REFRESH_MS) {
      this.refresh().catch((err) => this.log.warn('读取模型列表失败', err.message));
    }
  }

  /** Called with every run's initialize response, so the list stays current for free. */
  update(rawModels) {
    const models = normalizeModels(rawModels);
    if (!models.length) return;
    const changed = JSON.stringify(models) !== JSON.stringify(this.models);
    this.models = models;
    this.fetchedAt = new Date().toISOString();
    if (changed || !this.savedRecently) {
      this.savedRecently = true;
      setTimeout(() => { this.savedRecently = false; }, 60000).unref?.();
      writeJsonAtomic(this.path, { models, fetchedAt: this.fetchedAt }).catch(() => {});
    }
  }

  find(value) {
    return this.models.find((m) => m.value === value) || null;
  }

  /** Throws a user-facing message when the selection cannot be honoured. */
  validate(model, effort) {
    if (!this.models.length) throw new Error('模型列表尚未加载，请稍后重试');
    const m = this.find(model);
    if (!m) throw new Error('所选模型当前不可用，请重新选择');
    if (effort && !m.efforts.includes(effort)) throw new Error(`${m.displayName} 不支持这个推理强度`);
    return m;
  }

  publicList() {
    return { models: this.models, fetchedAt: this.fetchedAt };
  }

  /** Starts a CLI just long enough to answer `initialize`; no model call is made. */
  refresh() {
    if (this.probing) return this.probing;
    this.probing = new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.cfg.claudeBin, [
        ...this.cfg.claudePrefixArgs,
        '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--no-session-persistence', '--permission-mode', 'manual', '--permission-prompt-tool', 'stdio',
      ], { cwd: this.cfg.claudeCwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
      let buf = '';
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.stdin.end();
        child.kill('SIGTERM');
        if (err) reject(err); else resolve(this.publicList());
      };
      const timer = setTimeout(() => finish(new Error('探测超时')), PROBE_TIMEOUT_MS);
      child.on('error', finish);
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
          if (m.type === 'control_response' && m.response?.request_id === 'models_probe') {
            this.update(m.response.response?.models);
            finish(this.models.length ? null : new Error('CLI 没有返回模型列表'));
          }
        }
      });
      child.on('close', () => finish(new Error('CLI 提前退出')));
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'models_probe', request: { subtype: 'initialize', hooks: null } })}\n`);
    }).finally(() => { this.probing = null; });
    return this.probing;
  }
}
