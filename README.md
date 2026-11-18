# T3 Code Bridge for VS Code

A small VS Code extension that brings [T3 Code](https://t3.codes) threads into the editor. You can read and
chat with your agent threads in the sidebar, and send code from the editor to a thread.

Plain JavaScript, no build step, no dependencies. It talks to T3 Code through the `t3` CLI.

## Features

- **Threads view** (T3 Code icon in the activity bar)
  - Lists the open threads of the current workspace. Settled and snoozed threads are hidden.
  - Child agent threads are nested under the thread that started them.
  - Icons show status: spinning while running, bell when waiting for you, check when completed,
    error when failed, pause when interrupted, slash when cancelled.
  - Each row shows the status and the model.
  - Right-click a thread to open it in the T3 Code app, send the current selection to it, or show
    the changes of its last turn.
- **Status bar**: shows how many threads of the workspace are running (hidden when none). Click it
  to show the T3 Code view. When a thread finishes (completed, failed, interrupted or cancelled) a
  notification offers "Open chat", except for the thread already visible in the Chat view.
- **Chat view** (under Threads)
  - Click a thread to read its whole history and reply. Enter sends, Shift+Enter adds a new line.
  - Markdown rendering, code blocks, and citation quote cards with a "jump" link to the quoted reply.
  - File links and path-like code spans (`src/foo.js:42`) open in a VS Code editor at that line.
    Web links open in the browser.
  - A badge shows the thread's model (for example "Opus 5.5"). Click it to open the thread in the
    T3 Code app, where model and effort are changed (the CLI cannot change them).
  - Title-bar buttons: refresh, open in the app, show the last turn's changes, and (for threads
    that run in a git worktree) open that worktree in Source Control.
- **Last turn changes** (`T3 Code: Show changes of last turn`, see the caveat under Limits)
  - Opens the files the thread's last turn changed in VS Code's diff editor (multi-file diff on
    recent VS Code, else a file picker and one diff per file).
  - Files changed in the open chat thread's last turn get a "T3" badge in the Explorer.
  - Reopens your last thread when VS Code starts, if that thread is not settled or snoozed.
- **Editor commands** (right-click a selection)
  - `T3 Code: Send selection (draft)`: opens a new T3 Code draft with the file path, line range,
    selected code and any diagnostics. Nothing is sent until you send it in the app.
  - `T3 Code: Send selection to thread`: pick a thread, add an instruction, and send it.
    This starts an agent turn right away.
- **Quick fix**: on any diagnostic (red or yellow squiggle), the light bulb offers `Ask T3 to fix`.
  It selects the affected lines and opens a T3 Code draft, like `Send selection (draft)`.

## Keybindings

| Keys (macOS: Cmd instead of Ctrl) | Command |
| --- | --- |
| Ctrl+Alt+Shift+D (with a selection) | Send selection (draft) |
| Ctrl+Alt+Shift+S (with a selection) | Send selection to thread (sends right away) |
| Ctrl+Alt+Shift+T | Focus the Chat view |

Change them in Keyboard Shortcuts (search for "T3 Code").

## Requirements

- The T3 Code desktop app, running, with the workspace folder added as a T3 Code project.
- The `t3` CLI on your `PATH`, version 0.1.10 or later (`t3 --version`).
- VS Code 1.85 or later.
- A trusted workspace (the extension is disabled in Restricted Mode, since it runs `t3` and `git`).
  In remote windows it runs on the remote side, next to the `t3` CLI.
- Opening links in the app uses `xdg-open` on Linux. On macOS, Windows and remote windows it uses
  VS Code's `openExternal`, which is less tested.

## Install

Try it without installing, in an Extension Development Host:

```sh
code --extensionDevelopmentPath=$HOME/code/t3-vscode /path/to/your/project
```

Install it for everyday use by linking it into your extensions folder, then restart VS Code:

```sh
ln -s $HOME/code/t3-vscode ~/.vscode/extensions/local.t3-vscode
```

## How it works

| What | `t3` command |
| --- | --- |
| Thread list | `t3 thread list --project <workspace> --json` |
| Chat history | `t3 thread show --messages 1000 --json <thread>` |
| Sending a message | `t3 thread send <thread> -` (message on stdin) |
| Draft from selection | `t3code://new?prompt=...&repo=...` deep link |
| Open in app | `t3code://threads/<environment>/<thread>` deep link |
| Status bar, notifications | `t3 thread list` every 15 s (skipped if the tree just listed) |
| Last turn changes | `git diff` / `git show` on T3's checkpoint refs |

The chat polls for updates. It polls every second while the thread is running, or for 30 seconds
after you open a thread or send a message. Otherwise it polls every 10 seconds. It never polls
while the view is hidden. Each `t3` call costs about one second of CPU, which is why it does not
poll faster.

Before each timed poll the extension checks the modification time of T3's state database
(`$T3CODE_HOME/userdata/statev2.sqlite-wal`, default `~/.t3`). If it has not changed since the last
good poll, the `t3` call is skipped. Opening a thread, sending, or refreshing always polls. The file
changes every few seconds while any T3 thread runs, so this saves CPU mainly when T3 is idle.

## Limits

- The sidebar covers the current workspace only (`t3 thread list` is per project, and the CLI has
  no command to list projects).
- No live streaming: replies appear on the next poll.
- The effort level (for example "Medium") is not shown, because the CLI does not report it.
- Subagents started inside a turn (not as T3 threads) do not appear in the tree.
- **Last turn changes and the "T3" file badges rely on T3 internals.** They read the git refs T3
  keeps per turn (`refs/t3/orchestration-v2/checkpoints/<hash of thread id>/ordinal/<N>`), which
  are not a public API and may change in any T3 update. They need the workspace to be a git
  repository. A turn that only chatted shows "changed no files".
- "Open worktree in Source Control" is untested: no worktree thread existed when it was written.

## Development

```sh
node --check extension.js && node --check media/chat.js
node test/chat_check.js   # markdown, escaping, citation, file-link, state stamp and checkpoint-ref checks
```

Reload the Extension Development Host window with Ctrl+R after a change.

Files:

- [extension.js](extension.js): commands, Threads tree, Chat view provider, `t3` CLI calls.
- [media/chat.js](media/chat.js), [media/chat.css](media/chat.css): the Chat webview (strict CSP,
  all message text escaped before rendering).
- [package.json](package.json): views, commands, menus.
- [test/chat_check.js](test/chat_check.js): self-check for the webview rendering.
