import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeEnv, parseClaudeAccounts } from '../src/claude-accounts.js';
import { login, makeDirs, readEvents, request, startApp, textOf } from './helpers.js';

test('claude accounts: names and absolute dirs; the default dir runs without CLAUDE_CONFIG_DIR', () => {
  assert.deepEqual(parseClaudeAccounts('主账号|~/.claude, 第二个 | ~/.claude-2 ,bad,|/x,rel|claude-3,dup|/home/u/.claude-2', '/home/u'), [
    { id: '/home/u/.claude', name: '主账号', dir: null },
    { id: '/home/u/.claude-2', name: '第二个', dir: '/home/u/.claude-2' },
  ]);
  assert.deepEqual(parseClaudeAccounts(undefined, '/home/u'), []);

  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/elsewhere';
  try {
    assert.equal(claudeEnv(undefined).CLAUDE_CONFIG_DIR, '/elsewhere', 'no accounts: environment untouched');
    assert.equal('CLAUDE_CONFIG_DIR' in claudeEnv(null), false);
    assert.equal(claudeEnv('/home/u/.claude-2').CLAUDE_CONFIG_DIR, '/home/u/.claude-2');
    assert.equal(claudeEnv(null).NO_COLOR, '1');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

let dirs;
let ctx;
let cookie;
let main;
let second;

before(async () => {
  dirs = await makeDirs();
  const projects = join(dirs.root, 'projects-shared');
  main = join(dirs.root, 'acct-main');
  second = join(dirs.root, 'acct-second');
  await mkdir(projects);
  await mkdir(main);
  await mkdir(second);
  await symlink(projects, join(main, 'projects'));
  ctx = await startApp(dirs, {
    claudeProjectsDir: projects,
    claudeAccounts: parseClaudeAccounts(`主账号|${main},第二个|${second}`, '/nonexistent-home'),
  });
  cookie = await login(ctx.port, ctx.password);
});
after(async () => {
  await ctx.app.close();
  await dirs.cleanup();
});

const api = (method, path, body) => request(ctx.port, method, path, { body, cookie });

async function whoami() {
  const conv = (await api('POST', '/api/conversations', {})).json.conversation.id;
  const sent = await api('POST', `/api/conversations/${conv}/messages`, { text: 'whoami?' });
  assert.equal(sent.status, 201, sent.text);
  const { events } = await readEvents(ctx.port, `/api/conversations/${conv}/events?run=${sent.json.run.id}&after=0`, cookie);
  return textOf(events);
}

test('switching the Claude account moves replies and usage to it', async () => {
  assert.equal((await request(ctx.port, 'GET', '/api/claude-accounts')).status, 401);
  let list = (await api('GET', '/api/claude-accounts')).json.accounts;
  assert.deepEqual(list.map((a) => [a.name, a.active, a.sharedHistory]), [['主账号', true, true], ['第二个', false, false]]);
  assert.equal(await whoami(), `config=${main}`);
  assert.equal((await api('GET', '/api/account')).json.account.email, 'acct-main@example.test');

  assert.equal((await api('PUT', '/api/prefs', { claudeAccount: '/nope' })).status, 400);
  const put = await api('PUT', '/api/prefs', { claudeAccount: second });
  assert.equal(put.status, 200, put.text);
  list = (await api('GET', '/api/claude-accounts')).json.accounts;
  assert.deepEqual(list.map((a) => a.active), [false, true]);
  assert.equal(await whoami(), `config=${second}`);
  const acct = (await api('GET', '/api/account')).json;
  assert.equal(acct.account.email, 'acct-second@example.test');
  assert.equal(acct.claudeAccount, second);
});
