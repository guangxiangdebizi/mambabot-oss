import { spawn } from 'node:child_process';

// Account, plan usage and the slash-command list, all straight from the Claude CLI's own
// control channel (`initialize` + `get_usage`). No model call is made, so this costs nothing
// against the plan limits it reports.

const PROBE_TIMEOUT_MS = 25000;
const FRESH_MS = 60 * 1000;
const MIN_FORCE_GAP_MS = 10 * 1000;

const isoOrNull = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const pct = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : null);

/** Reduces the CLI's `get_usage` payload to what the page shows. */
export function normalizeUsage(raw) {
  const rl = raw?.rate_limits || {};
  let limits = Array.isArray(rl.limits) ? rl.limits.map((l) => ({
    kind: String(l.kind || ''), group: String(l.group || ''), scope: l.scope ? String(l.scope) : null,
    percent: pct(l.percent), severity: String(l.severity || 'normal'), resetsAt: isoOrNull(l.resets_at),
  })) : [];
  if (!limits.length) {
    const legacy = [['five_hour', 'session', 'session'], ['seven_day', 'weekly_all', 'weekly'],
      ['seven_day_opus', 'weekly_opus', 'weekly'], ['seven_day_sonnet', 'weekly_sonnet', 'weekly']];
    limits = legacy.filter(([key]) => rl[key]).map(([key, kind, group]) => ({
      kind, group, scope: null, percent: pct(rl[key].utilization), severity: 'normal', resetsAt: isoOrNull(rl[key].resets_at),
    }));
  }
  const xu = rl.extra_usage || {};
  return {
    available: raw?.rate_limits_available !== false && limits.length > 0,
    plan: raw?.subscription_type ? String(raw.subscription_type) : null,
    limits,
    extraUsage: {
      enabled: Boolean(xu.is_enabled),
      utilization: pct(xu.utilization),
      spendLimitReached: Boolean(xu.spend_limit_reached),
    },
  };
}

export function normalizeCommands(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && typeof c.name === 'string' && /^[\w:.-]+$/.test(c.name) && !c.name.startsWith('__'))
    .map((c) => ({ name: c.name, description: String(c.description || ''), argumentHint: String(c.argumentHint || '') }));
}

export class AccountService {
  constructor({ cfg, log = console, spawnImpl = spawn, catalog = null }) {
    Object.assign(this, { cfg, log, spawnImpl, catalog });
    this.data = null;
    this.probing = null;
    this.lastForced = 0;
  }

  /** Cached for a minute; `force` refetches (at most every 10 s). */
  async get({ force = false } = {}) {
    const age = this.data ? Date.now() - Date.parse(this.data.fetchedAt) : Infinity;
    const canForce = Date.now() - this.lastForced > MIN_FORCE_GAP_MS;
    if (this.data && age < FRESH_MS && !(force && canForce)) return this.data;
    if (force) this.lastForced = Date.now();
    return this.probe();
  }

  commands() {
    return this.data?.commands || [];
  }

  probe() {
    if (this.probing) return this.probing;
    this.probing = new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.cfg.claudeBin, [
        ...this.cfg.claudePrefixArgs,
        '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--no-session-persistence', '--permission-mode', 'manual', '--permission-prompt-tool', 'stdio',
      ], { cwd: this.cfg.claudeCwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
      const send = (id, subtype) => child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } })}\n`);
      let init = null;
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
      const timer = setTimeout(() => finish(new Error('读取账号信息超时')), PROBE_TIMEOUT_MS);
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
          if (m.type !== 'control_response') continue;
          const r = m.response || {};
          if (r.request_id === 'acct_init') {
            if (r.subtype !== 'success') return finish(new Error(r.error || 'initialize 失败'));
            init = r.response || {};
            this.catalog?.update(init.models);
            send('acct_usage', 'get_usage');
          } else if (r.request_id === 'acct_usage') {
            const acct = init.account || {};
            this.data = {
              account: {
                email: acct.email ? String(acct.email) : null,
                organization: acct.organization ? String(acct.organization) : null,
                plan: acct.subscriptionType ? String(acct.subscriptionType) : null,
                provider: acct.apiProvider ? String(acct.apiProvider) : null,
              },
              version: init.claude_code_version ? String(init.claude_code_version) : null,
              usage: r.subtype === 'success' ? normalizeUsage(r.response) : { available: false, limits: [], extraUsage: { enabled: false } },
              commands: normalizeCommands(init.commands),
              fetchedAt: new Date().toISOString(),
            };
            finish(null, this.data);
          }
        }
        return undefined;
      });
      send('acct_init', 'initialize');
    }).finally(() => { this.probing = null; });
    return this.probing;
  }
}
