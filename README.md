# T3 Code Bridge for VS Code

A small VS Code extension that brings [T3 Code](https://t3.codes) threads into the editor. You can read and
chat with your agent threads in the sidebar, and send code from the editor to a thread.

Plain JavaScript, no build step, no dependencies. It talks to T3 Code through the `t3` CLI.

## Features

- **Threads view** (T3 Code icon in the activity bar)
  - Lists the open threads of the current workspace. Settled and snoozed threads are hidden.
  - Child agent threads are nested under the thread that started them.
  - Icons show status: spinning while running, bell when waiting for you.
  - Each row shows the status and the model.
  - Right-click a thread to open it in the T3 Code app, or to send the current selection to it.
- **Chat view** (under Threads)
  - Click a thread to read its whole history and reply. Enter sends, Shift+Enter adds a new line.
  - Markdown rendering, code blocks, and citation quote cards with a "jump" link to the quoted reply.
  - File links and path-like code spans (`src/foo.js:42`) open in a VS Code editor at that line.
    Web links open in the browser.
  - A badge shows the thread's model (for example "Opus 5.5").
  - Reopens your last thread when VS Code starts, if that thread is not settled or snoozed.
- **Editor commands** (right-click a selection)
  - `T3 Code: Send selection (draft)`: opens a new T3 Code draft with the file path, line range,
    selected code and any diagnostics. Nothing is sent until you send it in the app.
  - `T3 Code: Send selection to thread`: pick a thread, add an instruction, and send it.
    This starts an agent turn right away.

## Requirements

- The T3 Code desktop app, running, with the workspace folder added as a T3 Code project.
- The `t3` CLI on your `PATH`, version 0.1.10 or later (`t3 --version`).
- VS Code 1.85 or later.
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

The chat polls for updates. It polls every second while the thread is running, or for 30 seconds
after you open a thread or send a message. Otherwise it polls every 10 seconds. It never polls
while the view is hidden. Each `t3` call costs about one second of CPU, which is why it does not
poll faster.

## Limits

- The sidebar covers the current workspace only (`t3 thread list` is per project, and the CLI has
  no command to list projects).
- No live streaming: replies appear on the next poll.
- The effort level (for example "Medium") is not shown, because the CLI does not report it.
- Subagents started inside a turn (not as T3 threads) do not appear in the tree.

## Development

```sh
node --check extension.js && node --check media/chat.js
node test/chat_check.js   # markdown, escaping, citation and file-link checks
```

Reload the Extension Development Host window with Ctrl+R after a change.

Files:

- [extension.js](extension.js): commands, Threads tree, Chat view provider, `t3` CLI calls.
- [media/chat.js](media/chat.js), [media/chat.css](media/chat.css): the Chat webview (strict CSP,
  all message text escaped before rendering).
- [package.json](package.json): views, commands, menus.
- [test/chat_check.js](test/chat_check.js): self-check for the webview rendering.
