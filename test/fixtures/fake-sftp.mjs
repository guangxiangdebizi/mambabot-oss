// Stand-in for `sftp -q -b - <host>`: runs batch commands (cd, pwd, ls -lna, get) against the
// local folder FAKE_SFTP_ROOT as if it were the remote file system, printing what OpenSSH's
// sftp prints. Host `offline-pc` fails to connect like a machine that is switched off.
import { copyFileSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { posix, relative, sep } from 'node:path';

const args = process.argv.slice(2);
const host = args[args.length - 1];
const ROOT = realpathSync(process.env.FAKE_SFTP_ROOT);
if (host === 'offline-pc') {
  process.stderr.write('ssh: connect to host 127.0.0.1 port 23662: Connection refused\r\nConnection closed\r\n');
  process.exit(255);
}

const local = (remote) => ROOT + remote;
const remoteOf = (real) => {
  const rel = relative(ROOT, real).split(sep).join('/');
  return rel.startsWith('..') ? `/outside-root/${rel}` : `/${rel}`.replace(/\/$/, '') || '/';
};
let cwd = '/';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

function argv(line) {
  const out = [];
  let cur = null;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) { cur = (cur || '') + line[i + 1]; i += 1; } else if (ch === '"') { quoted = !quoted; cur = cur || ''; } else if (ch === ' ' && !quoted) { if (cur !== null) out.push(cur); cur = null; } else cur = (cur || '') + ch;
  }
  if (cur !== null) out.push(cur);
  return out;
}

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function lsLine(name, st) {
  const mode = st.isSymbolicLink() ? 'lrwxrwxrwx' : st.isDirectory() ? 'drwxr-xr-x' : '-rw-r--r--';
  const d = st.mtime;
  return `${mode}    ? 1000     1000     ${String(st.size).padStart(8)} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${pad(d.getHours())}:${pad(d.getMinutes())} ${name}`;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  for (const line of input.split('\n').filter(Boolean)) {
    process.stdout.write(`sftp> ${line}\n`);
    const [cmd, ...rest] = argv(line);
    if (cmd === 'cd') {
      const target = posix.resolve(cwd, rest[0] || '/');
      let real;
      try { real = realpathSync(local(target)); } catch { fail(`Couldn't canonicalize: No such file or directory`); }
      if (!statSync(real).isDirectory()) fail(`Can't change directory: "${target}" is not a directory`);
      cwd = remoteOf(real);
    } else if (cmd === 'pwd') {
      process.stdout.write(`Remote working directory: ${cwd}\n`);
    } else if (cmd === 'ls') {
      const dir = local(cwd);
      process.stdout.write(`${lsLine('.', lstatSync(dir))}\n${lsLine('..', lstatSync(dir))}\n`);
      for (const name of readdirSync(dir)) process.stdout.write(`${lsLine(name, lstatSync(`${dir}/${name}`))}\n`);
    } else if (cmd === 'get') {
      const src = posix.resolve(cwd, rest[0]);
      try { copyFileSync(realpathSync(local(src)), rest[1]); } catch { fail(`File "${src}" not found.`); }
    } else fail(`Invalid command.`);
  }
  process.exit(0);
});
