// Generates a new login secret, replaces the stored hash and signs out every session.
// Usage (as the service user): node scripts/reset-login.mjs, then restart the server.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { AUTH_FILE, ensureCredentials } from '../src/auth.js';

const cfg = loadConfig();
await rm(join(cfg.configDir, AUTH_FILE), { force: true });
await rm(join(cfg.dataDir, 'sessions.json'), { force: true });
await ensureCredentials(cfg.configDir, console);
