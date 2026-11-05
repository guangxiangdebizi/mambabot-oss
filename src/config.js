import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeAccounts } from './claude-accounts.js';

const DAY = 24 * 60 * 60 * 1000;

function list(value) {
  return (value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Other MambaBot sites of this owner, for the "switch account" list:
 * `Name|https://host,Other name|https://other`. Anything but a plain http(s) origin is dropped.
 */
export function parseAccountLinks(value) {
  const links = [];
  for (const item of (value || '').split(',')) {
    const sep = item.indexOf('|');
    if (sep < 0) continue;
    const name = item.slice(0, sep).trim();
    let url;
    try { url = new URL(item.slice(sep + 1).trim()); } catch { continue; }
    if (!name || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    links.push({ name, url: url.origin });
  }
  return links;
}

export function loadConfig(overrides = {}) {
  const env = process.env;
  const home = homedir();
  return {
    host: env.AW_HOST || '127.0.0.1',
    port: Number(env.AW_PORT || 3400),
    // Credentials (password hash, initial secret) live apart from user data and source.
    configDir: env.AW_CONFIG_DIR || join(home, '.config/assistant-web'),
    dataDir: env.AW_DATA_DIR || join(home, '.local/share/assistant-web'),
    claudeBin: env.AW_CLAUDE_BIN || join(home, '.local/bin/claude'),
    claudePrefixArgs: [],
    // A directory of its own: `claude --continue` elsewhere must never pick up a web session
    // as its "most recent" one.
    claudeCwd: env.AW_CLAUDE_CWD || join(home, 'assistant-home'),
    // Where the CLI keeps session transcripts (read only, for the session's /cost total).
    claudeProjectsDir: env.AW_CLAUDE_PROJECTS_DIR || join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects'),
    maxRuns: Number(env.AW_MAX_RUNS || 2),
    accountLinks: parseAccountLinks(env.AW_ACCOUNT_LINKS),
    // The owner's Claude accounts on this host, switchable in Settings; empty = the CLI's own.
    claudeAccounts: parseClaudeAccounts(env.AW_CLAUDE_ACCOUNTS, home),
    allowedHosts: ['localhost', '127.0.0.1', '[::1]', ...list(env.AW_ALLOWED_HOSTS)],
    trustProxy: env.AW_TRUST_PROXY === '1',
    cookieSecure: env.AW_COOKIE_SECURE === '1',
    sessionTtlMs: 30 * DAY,
    maxLoginInFlight: 2,
    approvalTimeoutMs: Number(env.AW_APPROVAL_TIMEOUT_MS || 30 * 60 * 1000),
    stopGraceMs: 2500,
    // The live browser panel needs BrowserOS (AppImage AppRun or binary); off when unset.
    browserBin: env.AW_BROWSER_BIN || '',
    browserProfile: env.AW_BROWSER_PROFILE || join(env.AW_DATA_DIR || join(home, '.local/share/assistant-web'), 'browser-profile'),
    browserDisplay: Number(env.AW_BROWSER_DISPLAY || 99),
    browserWidth: 1280,
    browserHeight: 800,
    browserSkipFirewall: false,
    browserEnabled: env.AW_BROWSER !== '0' && Boolean(env.AW_BROWSER_BIN),
    ...overrides,
  };
}
