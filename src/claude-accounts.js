import { realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

// Several Claude accounts of the same owner on one host: each one is a Claude Code config
// directory (CLAUDE_CONFIG_DIR) that was signed in with `claude`'s own /login. MambaBot only
// points the CLI at one of them; it never reads or moves their credentials.

/**
 * `Name|~/.claude,Other|~/.claude-other` -> [{ id, name, dir }]. `dir` is null for the CLI's
 * default directory (~/.claude), which must run with CLAUDE_CONFIG_DIR unset: setting it, even
 * to ~/.claude, moves `.claude.json` and so loses the default account's MCP and project state.
 */
export function parseClaudeAccounts(value, home) {
  const accounts = [];
  const seen = new Set();
  for (const item of (value || '').split(',')) {
    const sep = item.indexOf('|');
    if (sep < 0) continue;
    const name = item.slice(0, sep).trim();
    let path = item.slice(sep + 1).trim();
    if (path === '~' || path.startsWith('~/')) path = join(home, path.slice(1));
    if (!name || !path || !isAbsolute(path)) continue;
    path = resolve(path);
    if (seen.has(path)) continue;
    seen.add(path);
    accounts.push({ id: path, name, dir: path === join(home, '.claude') ? null : path });
  }
  return accounts;
}

/**
 * Environment for a Claude CLI child. `dir` undefined leaves the server's own environment
 * alone (no accounts configured); null selects the default directory.
 */
export function claudeEnv(dir, extra = {}) {
  const env = { ...process.env, NO_COLOR: '1', ...extra };
  if (dir === null) delete env.CLAUDE_CONFIG_DIR;
  else if (dir) env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

/**
 * Whether an account's sessions live in the shared projects directory. Chats resume Claude
 * sessions by id, so switching accounts only keeps old chats going when they share it.
 */
export async function sharesProjects(account, home, defaultProjectsDir) {
  const own = join(account.dir || join(home, '.claude'), 'projects');
  try {
    return (await realpath(own)) === (await realpath(defaultProjectsDir));
  } catch {
    return false;
  }
}
