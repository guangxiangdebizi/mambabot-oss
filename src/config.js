import { homedir } from 'node:os';
import { join } from 'node:path';

const DAY = 24 * 60 * 60 * 1000;

function list(value) {
  return (value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
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
