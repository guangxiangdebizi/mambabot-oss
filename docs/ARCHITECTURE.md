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
- **Attachments**: `POST /api/uploads` streams files (≤50 MB) to `<claude cwd>/uploads/`;
  images go to Claude as image blocks, other files are named for the Read tool.
  `GET /api/uploads/<id>` streams the file with byte ranges; it is inline only for types that
  cannot script (raster images, audio, video; SVG under a sandbox CSP), whatever type the
  uploading browser declared. `…/<id>/preview` and `…/<id>/part` feed the reader.
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
- **Claude accounts** (`AW_CLAUDE_ACCOUNTS`, `/api/claude-accounts`): several of the owner's
  own Claude Code config directories, each signed in with `claude`'s own `/login`. The one
  picked in Settings (`prefs.claudeAccount`) is passed as `CLAUDE_CONFIG_DIR` to every CLI child
  (replies, tasks, probes); the default `~/.claude` runs with it unset, since setting it moves
  `.claude.json`. Usage is cached per account. Chats resume sessions by id, so accounts are
  expected to share `~/.claude/projects` (a symlink); one that does not is flagged in Settings.
  MambaBot never reads or copies the credentials themselves.
- **`/` commands**: typing `/` lists the CLI's slash commands (from `initialize`, via
  `/api/commands`). Session settings that would not outlive a one-reply process (`/model`,
  `/effort`, `/usage`, `/clear`, `/rename`) are handled by the page instead; terminal-only
  ones (`/color`, `/loop`, `/mcp`, …) are hidden; `/compact` is passed through to the CLI. The `+` button opens upload, commands,
  files, terminal, browser, scheduled tasks and usage.
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
- **Projects and the file panel** (`src/projects.js`, `public/files.js`): a project is a
  name and a directory (`projects.json` in the data dir); by default a new folder
  `<claude cwd>/projects/<name>`, or an existing absolute path. Neither may contain or sit
  inside the config dir, the data dir, `~/.ssh` or `~/.claude`. A chat created in a project
  stores `projectId` and `cwd`; every run (and the `/status` probe, the session cost lookup
  and relative `show_file` paths) uses the chat's `cwd`, because Claude Code keeps sessions
  per working directory. The directory therefore never changes for a chat: deleting a project
  only ungroups its chats (they keep their `cwd`) and leaves the folder on disk. The handoff
  tells Claude the project's name and directory. The sidebar lists projects above the
  ungrouped chats (`GET /api/conversations?project=<id>|none`). The file panel shares the
  browser panel's slot and reads `GET /api/projects/<id|default>/{tree,file,raw}?path=`:
  paths are relative to the root or absolute inside it, resolved with `realpath` and refused
  outside the root (no symlink escapes); `.git`, `.ssh`, `.env*`, private keys and the like
  are neither listed nor served. `file` returns up to 512 KB of text (Markdown or plain,
  NUL-sniffed for binaries), `raw` serves images inline (SVG under a sandbox CSP) and
  everything else as a download (now via the reader, below). The panel reloads after a reply's
  file-changing tool calls and at the end of a run.
- **Reader** (`src/preview.js`, `src/office.js`, `src/zip.js`, `src/xml.js`, `public/reader.js`,
  `public/pdfview.js`): one viewer for three sources, each with the same three endpoints:
  project files (`/api/projects/<id|default>/{file,raw,part}?path=`), any host path a reply names
  (`/api/files/{file,raw,part}?path=&conv=`, relative to the chat's `cwd`), and attachments
  (`/api/uploads/<id>[/preview|/part]`). `file`/`preview` return the kind and content as plain
  JSON: text (512 KB, UTF-8 / UTF-16 BOM / GB18030 detected), CSV/TSV tables (1000 rows), Jupyter
  cells (PNG/JPEG outputs as `data:` URLs), and Office Open XML converted on the server without
  dependencies: a ZIP central-directory reader with capped `inflateRawSync`, a DTD-less XML
  reader (no entity expansion), then docx → paragraph/run/table blocks (styles for headings,
  numbering.xml for list labels, gridSpan/vMerge), xlsx → one sheet at a time (`sheet=`, 1000 ×
  60 cells, shared strings, number/date formats, merges), pptx → slides (title, text levels,
  pictures, tables, notes). Converted results are cached (16, keyed by path, size and mtime).
  Embedded images stay in the archive and are served one by one by `part?entry=` (raster types
  only). The page renders everything with DOM text nodes; links are http(s)/mailto only. PDFs
  use the vendored pdf.js legacy build (`public/vendor/pdfjs/<version>/`, Apache-2.0, loaded on
  first use, CJK cmaps and standard fonts included) fetching `raw` with range requests; pages
  render near the viewport and are released when far (canvas memory on phones). `raw` serves
  media with ranges (video seeking on iOS needs 206s); `raw?render=html` serves an HTML file for
  the reader's `<iframe sandbox="allow-same-origin">` with `CSP: sandbox allow-same-origin;
  default-src 'none'` and `X-Frame-Options: SAMEORIGIN`: no script, no network. Host paths go
  through `src/hostfiles.js`: real path, then refused if any part is a secret file or hidden
  folder (as in projects) or it lies under the config or data dir, `~/.ssh`, `~/.claude`, the
  Claude account dirs, browser profiles, `~/.config/gh`, `/proc`, `/sys`, `/dev`, `/run`, `/root`.
- **Images in replies** (`public/markdown.js`, `replyMarkdownOptions` in `public/app.js`):
  `![alt](src "title")` renders inline (a paragraph of only images becomes a figure row with
  captions; every image opens the swipeable viewer). `src` resolves to the reply's saved copy
  (`msg.media[src]`), a `data:image/…;base64` URL, the web proxy for http(s), or
  `/api/files/raw?path=&conv=` for host paths. When a reply ends, `runs.beforeSave` copies every
  host image its text references (≤ 30, ≤ 50 MB, credential rules above) into the upload store
  as `msg.media` and sends it as a `meta` event, so the reply survives the file's deletion.
  `[label](path)` and inline code that looks like a path open the reader. Image nodes are
  reused across streaming re-renders so they do not reload. Markdown files in the reader
  resolve relative images against their own folder. Shares stay text-only (images become
  `[图片：…]`).
- **Web images** (`src/remote.js`, `GET /api/media/remote?url=`): fetched by the server, never
  by the page (CSP stays `img-src 'self'`). Only http(s) without credentials; DNS is resolved
  first and every address must be public (`net.BlockList` of loopback, private, CGNAT,
  link-local incl. 169.254.169.254, multicast, documentation, mapped/NAT64 forms), then the
  socket connects to that checked address (no rebinding); ≤ 4 redirects, each checked again;
  ≤ 15 MB, 15 s; the body must sniff (or be declared) as an image. Cached on disk
  (`<data>/remote-images`, LRU, 300 MB / 3000 files). `AW_REMOTE_IMAGES_FAKE_IP=1` also allows
  198.18.0.0/15 for hosts behind a fake-ip DNS proxy. 用量与设置 → 外链图片 (`prefs.remoteImages`,
  `auto` or `click`) decides whether the page loads them right away or after a tap.
- **Static files**: ETag (size + mtime) with 304s, gzip for text (cached per version),
  `Cache-Control: immutable` under `vendor/`. The pdf.js worker alone gets
  `script-src 'self' 'wasm-unsafe-eval'` for its image decoders; the page's CSP is unchanged.
- **Terminal panel** (`src/terminal.js`, `public/terminal.js`): the owner's command line per
  root (a project or `default`), `POST /api/terminal/<root>/{run,input,stop,clear}` and
  `GET /api/terminal/<root>[/events]` (SSE: a snapshot, then `start` / `out` / `end`). One
  command at a time, each a `bash -c` in its own process group, started in the root's
  current directory; an EXIT trap reports the final `pwd` on fd 3, so `cd` carries over.
  stdin is a pipe (typing while a command runs answers its prompts), stop sends SIGINT to
  the group, then SIGTERM and SIGKILL. No pty: `TERM=dumb`, `NO_COLOR`, pagers off; the page
  strips escape sequences and applies carriage returns. Output is kept in memory (512 KB
  tail per command, last 50 commands per root) and lost on restart. Claude's Bash calls are
  listed alongside: the stream translator now keeps a Bash result's text on its tool part
  (`output`, head and tail of 16 KB) with a start time (`at`); shares still carry no tool
  data.
- **Showing files** (`src/media.js`): every run gets an `assistant-media` MCP server
  (`/internal/mcp/media`, loopback only, per-run token, pre-approved) with one tool,
  `show_file(path, caption?)`, now meant for delivering files (illustrations use Markdown
  images, above). The file (≤ 50 MB, ≤ 20 per reply) is copied into the upload store and added
  to the reply as a `file` part: png/jpg/gif/webp inline with the viewer, anything else as a
  card that opens the reader. Paths follow the host-file rules above. Shares stay text-only.
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
  limited to http, https and mailto; a strict CSP blocks inline script. Documents in the reader
  follow the same rule (Office files are converted to plain data on the server); HTML files are
  only shown in a script-less, network-less sandboxed frame.
- Reading files: the web login can already run commands (terminal panel), so the reader adds no
  power, but credential locations are refused everywhere (tree, reader, reply images,
  `show_file`) so they never end up on a page by accident or by a model-chosen path.
- Web images are fetched by the server from public addresses only (see above), so a reply
  cannot make the server reach localhost, the LAN or the cloud metadata service. A
  prompt-injected reply could still put data into an image URL; 外链图片 → 点击后显示 makes
  that need a tap.
- Tool permissions follow the owner's permission mode (see above). In every mode that still
  prompts, the prompt becomes an approval card with the full command or content; this server
  never approves a prompt by itself.
- Claude runs as the service user with that user's rights. If you give that user passwordless
  sudo, then under 逐条确认 every `sudo -n …` command needs its own approval card, but under
  完全放行 it runs directly: a stolen web session is then root on the host with no confirmation
  step. Guard the login secret, and think twice before combining sudo with 完全放行.
