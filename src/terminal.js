import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';

// The owner's command line in the web page: one command at a time per root (a project or the
// default directory), each in its own bash process and process group. No terminal emulation:
// output is plain text (colours off, pagers off), stdin is a pipe the owner can type into, and
// the working directory carries over between commands like in a shell (`cd` works).

const MAX_OUTPUT = 512 * 1024;
const KEEP_ENTRIES = 50;
const KILL_AFTER_MS = 3000;
// fd 3 reports where the command left the shell, even if it ran `exit`.
const SCRIPT = 'trap \'pwd >&3\' EXIT; cd -- "$1" || exit 1; eval "$2"';

export class TerminalManager extends EventEmitter {
  constructor({ cfg, log = console, spawnImpl = spawn }) {
    super();
    Object.assign(this, { cfg, log, spawnImpl });
    this.roots = new Map(); // key -> { cwd, entries, running }
  }

  root(key, dir) {
    let r = this.roots.get(key);
    if (!r) {
      r = { key, cwd: dir, entries: [], running: null };
      this.roots.set(key, r);
    }
    return r;
  }

  snapshot(key, dir) {
    const r = this.root(key, dir);
    return { cwd: r.cwd, entries: r.entries.map(view) };
  }

  async run(key, dir, command) {
    const r = this.root(key, dir);
    if (r.running) throw new Error('上一条命令还在运行，先等它结束或停止');
    const cwd = (await stat(r.cwd).then((s) => s.isDirectory(), () => false)) ? r.cwd : dir;
    const entry = {
      id: randomUUID(), command, cwd, startedAt: new Date().toISOString(), status: 'running', exitCode: null,
      output: '', clipped: false, endedAt: null,
    };
    r.entries.push(entry);
    if (r.entries.length > KEEP_ENTRIES) r.entries.splice(0, r.entries.length - KEEP_ENTRIES);
    r.running = entry;
    this.emit('event', key, { type: 'start', entry: view(entry) });

    const child = this.spawnImpl('bash', ['-c', SCRIPT, 'mambabot', cwd, command], {
      cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', SYSTEMD_PAGER: '' },
    });
    entry.child = child;
    child.stdin.on('error', () => {});
    const out = (chunk) => {
      const data = chunk.toString('utf8');
      entry.output += data;
      if (entry.output.length > MAX_OUTPUT) {
        entry.output = entry.output.slice(-MAX_OUTPUT);
        entry.clipped = true;
      }
      this.emit('event', key, { type: 'out', id: entry.id, data });
    };
    child.stdout.on('data', out);
    child.stderr.on('data', out);
    let endCwd = '';
    child.stdio[3].on('data', (chunk) => { endCwd += chunk.toString('utf8'); });
    const done = (code, signal, error) => {
      if (entry.status !== 'running') return;
      clearTimeout(entry.killTimer);
      entry.status = entry.stopRequested ? 'stopped' : (code === 0 ? 'done' : 'error');
      entry.exitCode = code ?? null;
      entry.signal = signal || null;
      entry.endedAt = new Date().toISOString();
      if (error) out(Buffer.from(`\n无法运行：${error.message}\n`));
      const next = endCwd.trim().split('\n').pop();
      if (next && next.startsWith('/')) r.cwd = next;
      delete entry.child;
      r.running = null;
      this.emit('event', key, { type: 'end', entry: view(entry), cwd: r.cwd });
    };
    child.on('error', (err) => done(null, null, err));
    child.on('close', (code, signal) => done(code, signal));
    return view(entry);
  }

  /** A line typed while the command runs (e.g. answering a y/n prompt). */
  input(key, text) {
    const entry = this.roots.get(key)?.running;
    if (!entry?.child?.stdin?.writable) return false;
    entry.child.stdin.write(`${text}\n`);
    this.emit('event', key, { type: 'out', id: entry.id, data: `${text}\n`, echo: true });
    entry.output += `${text}\n`;
    return true;
  }

  /** Ctrl-C to the whole process group, then harder if it does not end. */
  stop(key) {
    const entry = this.roots.get(key)?.running;
    if (!entry?.child) return false;
    entry.stopRequested = true;
    const pid = entry.child.pid;
    const signal = (sig) => { try { process.kill(-pid, sig); } catch { /* already gone */ } };
    signal('SIGINT');
    entry.killTimer = setTimeout(() => {
      signal('SIGTERM');
      entry.killTimer = setTimeout(() => signal('SIGKILL'), KILL_AFTER_MS);
    }, KILL_AFTER_MS);
    return true;
  }

  clear(key) {
    const r = this.roots.get(key);
    if (r) r.entries = r.entries.filter((e) => e === r.running);
  }

  shutdown() {
    for (const r of this.roots.values()) {
      if (r.running?.child) try { process.kill(-r.running.child.pid, 'SIGTERM'); } catch { /* gone */ }
    }
  }
}

function view(e) {
  return {
    id: e.id, command: e.command, cwd: e.cwd, startedAt: e.startedAt, endedAt: e.endedAt, status: e.status,
    exitCode: e.exitCode, signal: e.signal || null, output: e.output, clipped: e.clipped,
  };
}
