# MambaBot: architecture notes

How the pieces fit, for people changing the code. The [README](../README.md) covers setup.

## How it works

- **Models**: the picker lists exactly what the CLI's `initialize` response reports for this
  account (`/api/models`, cached in `models.json`, refreshed by every run), with each
  model's supported effort levels. The choice is stored per chat and as the default, sent
  as `--model`/`--effort`, and the runtime-reported model is stored on every reply; a
  mismatch is shown, never hidden.
- **Branches**: conversations are message trees. Editing a message or regenerating a reply
  starts Claude with `--resume <session> --resume-session-at <uuid> --fork-session`, so the
  new branch has exactly the earlier context; old branches stay switchable (`‹ 1/2 ›`).
- **Attachments**: `POST /api/uploads` streams files (≤20 MB) to `<claude cwd>/uploads/`;
  images go to Claude as image blocks, other files are named for the Read tool.
- **Browser** (optional, `AW_BROWSER_BIN`): one BrowserOS (profile `AW_BROWSER_PROFILE`) on a
  private Xvfb display `:99`, started on the
  first real browser tool call or from the panel, kept across server restarts, stopped after
  30 idle minutes (never during a hand-off). Claude runs reach it through
  `/internal/mcp/browseros` (loopback only, per-run token, never proxied by nginx). The owner
  sees the same display through x11vnc on a Unix socket bridged to `/api/browser/vnc`
  (cookie + Origin + Host checked); input passes only after "接管/开始操作". Hand-off uses
  BrowserOS's `request_human_help` / `await_human_help`; "交还给助理" resolves that session.
  BrowserOS binds 9010/9011 on all interfaces, so the app adds (and requires) iptables rules
  limiting them to loopback; the rules are not persistent and are re-added on browser start.
  All chats share this one browser and profile, so logins and cookies are shared too.
- **Usage & account** (`用量与设置`, `/api/account`): the CLI's own `initialize` (account,
  plan, version) and `get_usage` (5-hour / weekly limits, reset times, usage credits) control
  requests, in a short-lived process with `--no-session-persistence`. No model call, so it
  costs no quota; cached 60 s, manual refresh at most every 10 s.
- **`/` commands**: typing `/` lists the CLI's slash commands (from `initialize`, via
  `/api/commands`). Session settings that would not outlive a one-reply process (`/model`,
  `/effort`, `/usage`, `/clear`, `/rename`) are handled by the page instead; terminal-only
  ones (`/color`, `/loop`, `/mcp`, …) are hidden; `/compact` is passed through to the CLI. The `+` button opens upload, commands,
  browser, scheduled tasks and usage.
- **`/compact` and `/status`**: `/compact [要保留的重点]` is sent to the CLI as the next turn of
  the branch (it runs its own compaction in that session); the reply shows a compaction note
  with the CLI's before/after token counts, and its replayed "Compacted" entry becomes the
  reply's fork point. Automatic compaction during a normal reply shows the same note.
  `/status` (also `/context`, `/cost`, the "+" menu and a chat's menu) opens 上下文与花费:
  `GET /api/conversations/<id>/status` asks the CLI for `get_context_usage` on a throwaway
  fork of the branch (`--fork-session --no-session-persistence`, no model call; cached 20 s)
  for used / max context and a breakdown, and reports spend: every reply now stores the
  `total_cost_usd` and tokens of its `result` (`msg.usage`), and the chat total sums the CLI's
  own cumulative `cost-state` entry of each session file (forks start at zero), so replies
  from before this feature are counted too. Amounts are API list-price equivalents.
- **Showing files** (`src/media.js`): every run gets an `assistant-media` MCP server
  (`/internal/mcp/media`, loopback only, per-run token, pre-approved) with one tool,
  `show_file(path, caption?)`. The file (≤ 20 MB, ≤ 20 per reply) is copied into the upload
  store and added to the reply as a `file` part: png/jpg/gif/webp inline with a full-screen
  viewer (tap to close, "原图" opens it), anything else (svg included) as a download card.
  Paths under the config dir, `~/.ssh` and the CLI's credentials file are refused. Shares stay
  text-only.
- **Reminders**: while the page is in the background, a finished/failed reply or a pending
  approval marks the tab title with ●; 用量与设置 → 提醒 also turns on system notifications
  (per device, needs browser permission).
- **Search & export**: sidebar search matches titles and the text of every message (all
  branches) and shows an excerpt; a chat's menu exports its current branch as Markdown.
- **Scheduled tasks** (`定时任务`, `/api/tasks`, `src/schedule.js`): Claude Code's CronCreate
  dies with its one-reply process, so the app owns the schedule: 5-field cron in server
  local time (`TZ=Asia/Shanghai` in `serve.sh`), stored in `tasks.json`, checked every 20 s.
  A due task sends its prompt as a new message, to a new chat or always the same chat. A busy
  server delays a run for up to 30 minutes; runs missed while the server was down are
  skipped. Claude manages tasks through the `assistant-tasks` MCP tools
  (`/internal/mcp/tasks`, loopback only, per-run token); every change is an ordinary approval
  card, and listing is pre-approved. CronCreate/CronDelete/CronList/ScheduleWakeup are
  disallowed in web runs. Unattended runs keep the normal approval rules: a tool that needs
  approval waits in that chat for the owner. Each task can pin a model and an effort level
  (independently; `null` follows the owner's default, and the card shows what that resolves
  to). `list_scheduled_tasks` also returns the defaults and every model's effort levels.
- **Sharing** (`src/shares.js`, `shares.json`): "分享" in a chat's menu stores a snapshot of
  its current branch (message text only: no attachment files, tool inputs/outputs, approval
  details or session ids) under an 18-byte random token. `/s/<token>` (`share.html`) and
  `/api/share/<token>` are the only unauthenticated content routes (`noindex`). Refreshing
  keeps the link; revoking, or deleting the chat, ends it for good.
- **Permission mode** (用量与设置 → 权限, `prefs.permissionMode`): 逐条确认 (`manual`),
  自动允许改文件 (`acceptEdits`), 自动判断 (`auto`, default for a new install) or 完全放行
  (`bypassPermissions`), passed to every run as `--permission-mode`; the composer chip shows
  the current mode. Prompts that still occur are relayed as approval cards in every mode. The
  run's handoff states the mode; under 完全放行 Claude is told to confirm irreversible actions
  (deleting data, changing system/service config, sending/paying) in its reply first.
- **Concurrency** (用量与设置 → 同时进行的回复, `prefs.maxRuns`, 1–6, default 2): extra messages
  get a 429 asking to retry, due scheduled tasks wait (up to 30 minutes). The page shows host
  memory from `/proc/meminfo` (`/api/system`) and a suggestion at ~400 MB per running reply.
- **Lazy loading**: a chat renders its newest 30 messages and adds 30 more each time the
  reader scrolls near the top (position kept). The sidebar loads 40 chats per page
  (`/api/conversations?limit=&before=updatedAt|id`) and more on scrolling; search runs on the
  server (`q=`) so unloaded chats are found too.
- **Layout**: on wide screens the sidebar (200–420 px) and the browser panel (≥ 320 px) can
  be resized by dragging their edge or with ←/→ on the focused handle; the chat column
  always keeps ≥ 380 px, widths are remembered per device, double-click resets.

Web sessions run from their own directory (`AW_CLAUDE_CWD`, default `~/assistant-home`), so
`claude --continue` in any other directory never picks up a web session as its most recent one.

## Security model

- Every chat, history, task and approval API needs a session from `/api/login`. Only
  `/healthz` and the static page are public. nginx serves the app over HTTPS only; port 80
  answers ACME challenges and redirects everything else.
- Sessions: random token in an `HttpOnly; SameSite=Strict; Secure` cookie; only its SHA-256
  is stored. Mutations require a same-host `Origin`, JSON content type, and an allowlisted
  `Host` (blocks DNS rebinding). Failed logins are limited per client (real IP from nginx)
  and globally, and at most two password checks (scrypt) run at once.
- Model output is rendered by building DOM nodes from text, never as HTML; links are
  limited to http, https and mailto; a strict CSP blocks inline script.
- Tool permissions follow the owner's permission mode (see above). In every mode that still
  prompts, the prompt becomes an approval card with the full command or content; this server
  never approves a prompt by itself.
- Claude runs as the service user with that user's rights. If you give that user passwordless
  sudo, then under 逐条确认 every `sudo -n …` command needs its own approval card, but under
  完全放行 it runs directly: a stolen web session is then root on the host with no confirmation
  step. Guard the login secret, and think twice before combining sudo with 完全放行.
