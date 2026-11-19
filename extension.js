const vscode = require("vscode");
const { execFile } = require("child_process");
const { fetchUsage, summarize } = require("./usage.js");
const { T3Client } = require("./t3Client.js");
const { board } = require("./dashboard.js");

// T3 Code rejects (does not truncate) link prompts over 8000 chars; stay under it.
// Also applied to CLI sends for simplicity.
const MAX_PROMPT = 7500;
const WEB_PREFIX = "https://app.t3.codes/";

function githubRepo(cwd) {
  return new Promise((resolve) => {
    execFile("git", ["remote", "get-url", "origin"], { cwd }, (err, out) => {
      const m = !err && /github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(out);
      resolve(m ? m[1] : undefined);
    });
  });
}

function buildPrompt(editor) {
  const doc = editor.document;
  const sel = editor.selection;
  const rel = vscode.workspace.asRelativePath(doc.uri);
  const start = sel.start.line + 1;
  const end = sel.end.line + 1;
  const range = start === end ? `line ${start}` : `lines ${start}-${end}`;

  const diags = vscode.languages
    .getDiagnostics(doc.uri)
    .filter((d) => d.range.intersection(sel))
    .map((d) => `- line ${d.range.start.line + 1}: ${d.message}`);

  const head = `${rel}, ${range}`;
  const tail = diags.length ? `\n\nDiagnostics:\n${diags.join("\n")}` : "";
  const fence = "```" + doc.languageId + "\n";
  const budget = MAX_PROMPT - head.length - tail.length - fence.length - 40;
  let code = doc.getText(sel);
  if (code.length > budget) code = code.slice(0, Math.max(budget, 0)) + "\n... [truncated]";

  return `${head}\n\n${fence}${code}\n\`\`\`${tail}\n\n`;
}

// Composer context: 1-based [start, end] of a selection, or undefined when it is empty.
// A selection ending at column 0 of a later line does not include that line.
function selLines(sel) {
  if (!sel || sel.isEmpty) return undefined;
  const end = sel.end.line + (sel.end.character === 0 && sel.end.line > sel.start.line ? 0 : 1);
  return [sel.start.line + 1, end];
}
// c = { abs, rel, lines }: the chip label and the line appended to a sent message.
function ctxLabel(c) {
  const l = c.lines;
  return c.rel + (!l ? "" : l[0] === l[1] ? ":" + l[0] : `:${l[0]}-${l[1]}`);
}
function ctxRef(c) {
  const tag = c.lines ? "selected" : "open file";
  // A markdown link renders compactly in the chat; paths md() cannot link stay plain.
  if (/[\s()[\]]/.test(c.abs)) return `Context: ${c.abs}${ctxLabel(c).slice(c.rel.length)} (${tag})`;
  return `Context: [${ctxLabel(c)}](${c.abs}${c.lines ? ":" + c.lines[0] : ""}) (${tag})`;
}

// "T3 Code" output channel, created on first use.
let channel;
function log(msg) {
  if (!channel) channel = vscode.window.createOutputChannel("T3 Code");
  channel.appendLine(new Date().toISOString().slice(11, 19) + " " + msg);
}

// openExternal re-encodes the query (%23 -> %2523) and thread ids (%3A), so on a
// local Linux window hand the raw URL to xdg-open instead.
// ponytail: macOS/Windows/remote still use openExternal and may double-encode; fix when needed.
async function openLink(url) {
  if (process.platform === "linux" && !vscode.env.remoteName) {
    // The extension host runs with ELECTRON_RUN_AS_NODE=1. Inherited, it makes the T3 Code app
    // (also Electron) start as plain Node and crash on the URL, while xdg-open still exits 0.
    // Drop every ELECTRON_* var (also ELECTRON_NO_ASAR, which would stop the app loading its app.asar).
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ELECTRON_")));
    log("xdg-open " + url);
    execFile("xdg-open", [url], { env }, (err, out, stderr) => {
      if (stderr) log("xdg-open stderr: " + stderr.trim());
      if (err) vscode.window.showErrorMessage("T3 Code: xdg-open failed: " + err.message);
    });
    return;
  }
  const ok = await vscode.env.openExternal(vscode.Uri.parse(url, true));
  if (!ok) vscode.window.showErrorMessage("T3 Code: could not open the link. Is the desktop app installed?");
}

// Change stamp of T3's state DB ($T3CODE_HOME or ~/.t3, then userdata/statev2.sqlite[-wal]).
// Every T3 write touches one of them, so an unchanged stamp means no thread changed and a poll can be
// skipped. undefined when neither file exists: callers then poll as usual.
// ponytail: the WAL moves every few seconds while any thread anywhere runs, so this only saves CPU when T3 is idle.
function stateStamp() {
  const fs = require("fs"), path = require("path");
  const dir = path.join(process.env.T3CODE_HOME || path.join(require("os").homedir(), ".t3"), "userdata");
  const s = ["statev2.sqlite-wal", "statev2.sqlite"].map((f) => {
    try {
      return fs.statSync(path.join(dir, f)).mtimeMs;
    } catch (e) {
      return "";
    }
  }).join();
  return s === "," ? undefined : s;
}

// ---- Turn changes. RELIES ON T3 INTERNALS, not a public API: may break on a T3 update. ----
// T3 snapshots the project repo after each turn as refs/t3/orchestration-v2/checkpoints/<H>/ordinal/<N>
// (N = 0 is the state before the first turn). <H> is base64 (no '=' padding) of the first 32 hex chars of
// sha256("checkpoint-scope:thread:<threadId>:name:root"); verified against real refs on 2026-11-18.
// Pasted images go to /tmp, which this system empties at boot and after 30 days, so no cleanup code.
const IMAGE_DIR = require("path").join(require("os").tmpdir(), "t3-vscode-images");
const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
function saveImage(dataUrl, dir = IMAGE_DIR) {
  const fs = require("fs"), path = require("path");
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m || !IMAGE_EXT[m[1]]) throw new Error("only png, jpeg, gif or webp");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 20e6) throw new Error("larger than 20 MB");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `paste-${stamp}-${require("crypto").randomBytes(3).toString("hex")}.${IMAGE_EXT[m[1]]}`);
  fs.writeFileSync(file, buf, { mode: 0o600, flag: "wx" });
  return file;
}

function checkpointScope(threadId) {
  const hex = require("crypto").createHash("sha256").update(`checkpoint-scope:thread:${threadId}:name:root`).digest("hex");
  return Buffer.from(hex.slice(0, 32)).toString("base64").replace(/=+$/, "");
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, out, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(out)
    );
  });
}

// Files changed by the thread's last turn: { root, from, to, n, files: [{ status, path }] }, paths relative to root.
async function turnChanges(threadId) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) throw new Error("open a folder first.");
  let root;
  try {
    root = (await git(folder.uri.fsPath, ["rev-parse", "--show-toplevel"])).trim();
  } catch (e) {
    throw new Error("this workspace is not a git repository, so T3 keeps no turn checkpoints for it.");
  }
  const base = `refs/t3/orchestration-v2/checkpoints/${checkpointScope(threadId)}/ordinal/`;
  const ords = (await git(root, ["for-each-ref", "--format=%(refname)", base]))
    .split("\n")
    .filter(Boolean)
    .map((r) => Number(r.slice(base.length)))
    .filter((n) => Number.isInteger(n) && n >= 0);
  if (!ords.length) throw new Error("no T3 checkpoints for this thread in this repository.");
  const n = Math.max(...ords); // refs sort as text (1, 10, 2), so take the numeric max
  if (n === 0 || !ords.includes(n - 1)) throw new Error("this thread has no finished turn with a checkpoint yet.");
  const from = base + (n - 1), to = base + n;
  const out = (await git(root, ["diff", "--no-renames", "--name-status", "-z", from, to])).split("\0");
  const files = [];
  for (let i = 0; i + 1 < out.length; i += 2) files.push({ status: out[i], path: out[i + 1] });
  return { root, from, to, n, files };
}

// Read-only file contents at a checkpoint: t3-turn:/abs/path?{"root":..,"ref":..}. Missing files read as "".
const turnContent = {
  provideTextDocumentContent(uri) {
    const { root, ref } = JSON.parse(uri.query);
    const rel = require("path").relative(root, uri.fsPath).split(require("path").sep).join("/");
    return git(root, ["show", `${ref}:${rel}`]).catch(() => "");
  },
};

// "T3" badge on files changed in the open chat thread's last turn (same T3-internal checkpoints as above).
class TurnBadges {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._emitter.event;
    this.files = new Set(); // absolute paths
  }
  provideFileDecoration(uri) {
    if (uri.scheme === "file" && this.files.has(uri.fsPath))
      return { badge: "T3", tooltip: "Changed in the last turn of the open T3 Code thread" };
  }
  // Recompute for a thread (or clear with none). Errors (no git, no checkpoints) just clear the badges.
  async update(t) {
    const id = t && t.threadId;
    this.for = id;
    let next = new Set();
    if (id) {
      try {
        const c = await turnChanges(id);
        if (this.for !== id) return; // the chat moved to another thread meanwhile
        const path = require("path");
        next = new Set(c.files.filter((f) => f.status !== "D").map((f) => path.join(c.root, f.path)));
      } catch (e) {}
    }
    const touched = [...this.files, ...next].map((p) => vscode.Uri.file(p));
    this.files = next;
    this._emitter.fire(touched);
  }
}

// Untested against real worktree threads (none existed when written): guarded for a missing path or git extension.
async function openWorktree(p) {
  if (!p) return vscode.window.showWarningMessage("T3 Code: this thread has no worktree.");
  try {
    await vscode.commands.executeCommand("git.openRepository", p);
    await vscode.commands.executeCommand("workbench.view.scm");
  } catch (e) {
    vscode.window.showErrorMessage("T3 Code: could not open the worktree " + p + ": " + e.message);
  }
}

async function showTurnChanges(t) {
  if (!t || !t.threadId) return vscode.window.showWarningMessage("T3 Code: open a thread first.");
  let c;
  try {
    c = await turnChanges(t.threadId);
  } catch (e) {
    return vscode.window.showWarningMessage("T3 Code: " + e.message);
  }
  if (!c.files.length) return vscode.window.showInformationMessage(`T3 Code: the last turn (${c.n}) changed no files.`);
  const path = require("path");
  const side = (ref, rel) =>
    vscode.Uri.file(path.join(c.root, rel)).with({ scheme: "t3-turn", query: JSON.stringify({ root: c.root, ref }) });
  const title = `T3 turn ${c.n}: ${t.title || t.threadId}`;
  const rows = c.files.map((f) => [vscode.Uri.file(path.join(c.root, f.path)), side(c.from, f.path), side(c.to, f.path)]);
  try {
    await vscode.commands.executeCommand("vscode.changes", title, rows); // multi-file diff, newer VS Code only
  } catch (e) {
    log("vscode.changes unavailable (" + e.message + "), falling back to one diff per file");
    const pick =
      rows.length === 1
        ? { r: rows[0] }
        : await vscode.window.showQuickPick(
            c.files.map((f, i) => ({ label: f.path, description: f.status, r: rows[i] })),
            { placeHolder: `${title}: ${rows.length} files changed` }
          );
    if (pick) await vscode.commands.executeCommand("vscode.diff", pick.r[1], pick.r[2], `${path.basename(pick.r[0].fsPath)} (${title})`);
  }
}

// Run the t3 CLI. Resolves with stdout only (log lines can land on stderr).
function t3(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "t3",
      args,
      { maxBuffer: 16 * 1024 * 1024, timeout: 15000 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        reject(new Error(err.code === "ENOENT" ? "t3 not found on PATH" : (stderr || stdout || err.message).trim()));
      }
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

// Live connection to the T3 server (t3Client.js); listThreads() uses it when up, else the CLI path below.
const client = new T3Client();

async function listThreads() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) return [];
  if (client.state === "connected") return client.list(folder.uri.fsPath);
  const out = await t3(["thread", "list", "--project", folder.uri.fsPath, "--json"]);
  let list;
  try {
    list = JSON.parse(out);
  } catch (e) {
    throw new Error("t3 returned unreadable output");
  }
  if (!Array.isArray(list)) throw new Error("t3 returned unexpected output");
  // Open sessions only, like T3 Code's own sidebar (settled/snoozed are grouped away there).
  return list.filter((t) => !t.settled && !t.snoozed);
}

// "claude-opus-5-5" -> "Opus 5.5"; anything else is shown as is.
function prettyModel(id) {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id || "");
  return m ? m[1][0].toUpperCase() + m[1].slice(1) + " " + m[2] + "." + m[3] : id || "";
}

// ISO time -> "now", "5m ago", "3h ago", "2d ago", ...; "" for a missing or bad date.
function ago(iso, now = Date.now()) {
  const s = (now - Date.parse(iso)) / 1000;
  if (!(s >= -60)) return ""; // NaN, or clearly in the future
  if (s < 60) return "now";
  for (const [n, u] of [[31536000, "y"], [2592000, "mo"], [604800, "w"], [86400, "d"], [3600, "h"], [60, "m"]])
    if (s >= n) return Math.floor(s / n) + u + " ago";
}

// Status -> [codicon, theme color]. Anything unknown (e.g. "idle") falls back to a plain chat icon.
const STATUS_ICON = {
  running: ["loading~spin", "charts.blue"],
  waiting: ["bell", "charts.yellow"],
  completed: ["check", undefined],
  failed: ["error", "errorForeground"],
  error: ["error", "errorForeground"],
  interrupted: ["debug-pause", "charts.orange"],
  cancelled: ["circle-slash", undefined],
};

class Threads {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.kids = new Map();
    this.onDidChangeTreeData = this._emitter.event;
  }
  // soft: re-render from the last list (fresh "3m ago") without calling the CLI.
  // A pending hard refresh stays hard even if a soft one fires before it runs.
  refresh(soft) {
    if (soft !== true) this.hard = true;
    this._emitter.fire();
  }
  getTreeItem(item) {
    return item;
  }
  item(t) {
    const kids = this.kids.get(t.threadId);
    const item = new vscode.TreeItem(
      t.title || t.threadId,
      kids ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    );
    item.id = t.threadId;
    item.thread = t;
    const bg = (t.pendingBackgroundTasks || []).length;
    const when = ago(t.updatedAt);
    item.description = [
      prettyModel(t.model),
      when,
      kids && `${kids.length} agent${kids.length > 1 ? "s" : ""}`,
    ].filter(Boolean).join("  |  ");
    // appendText escapes markdown, so titles and task names render literally.
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown("**").appendText(t.title || t.threadId).appendMarkdown("**\n\n");
    tip.appendText([t.status, prettyModel(t.model), when && "updated " + when].filter(Boolean).join("  |  "));
    if (t.relationshipToParent) tip.appendMarkdown("\n\n").appendText(t.relationshipToParent);
    if (bg) tip.appendMarkdown("\n\n").appendText(`Waiting on ${bg} background task${bg > 1 ? "s" : ""}:`);
    for (const k of t.pendingBackgroundTasks || []) tip.appendMarkdown("\n- ").appendText(k.description || k.kind || "task");
    item.tooltip = tip;
    item.accessibilityInformation = { label: `${t.title || t.threadId}, ${t.status}${when ? ", " + when : ""}` };
    item.contextValue = t.status === "running" || t.status === "waiting" ? "threadRunning" : "thread";
    const [icon, color] = STATUS_ICON[t.status] || [t.pinned ? "pin" : "comment-discussion"];
    item.iconPath = new vscode.ThemeIcon(icon, color && new vscode.ThemeColor(color));
    item.command = { command: "t3code.openChat", title: "Open chat", arguments: [t] };
    return item;
  }
  // Child agent threads nest under their parent; a child whose parent is hidden (settled/snoozed) shows at the top.
  async getChildren(element) {
    if (element) return (this.kids.get(element.thread.threadId) || []).map((t) => this.item(t));
    try {
      const hard = this.hard || !this.list;
      this.hard = false;
      const list = hard ? await listThreads() : this.list;
      this.list = list;
      if (hard) {
        this.listedAt = Date.now();
        if (this.onList) this.onList(list);
      }
      const ids = new Set(list.map((t) => t.threadId));
      this.kids = new Map();
      for (const t of list) {
        if (!t.parentThreadId || !ids.has(t.parentThreadId)) continue;
        if (!this.kids.has(t.parentThreadId)) this.kids.set(t.parentThreadId, []);
        this.kids.get(t.parentThreadId).push(t);
      }
      return list.filter((t) => !t.parentThreadId || !ids.has(t.parentThreadId)).map((t) => this.item(t));
    } catch (e) {
      this.list = undefined; // never show a stale list under an error
      const item = new vscode.TreeItem(e.message.split("\n")[0]);
      item.iconPath = new vscode.ThemeIcon("error");
      item.tooltip = e.message;
      return [item];
    }
  }
}

async function sendSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showWarningMessage("T3 Code: select some code first.");
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  const repo = folder && (await githubRepo(folder.uri.fsPath));

  let url = "t3code://new?prompt=" + encodeURIComponent(buildPrompt(editor));
  if (repo) url += "&repo=" + encodeURIComponent(repo);
  await openLink(url);
}

// Quick fix on diagnostics: select the whole lines they cover, then run the draft flow (nothing is sent).
const askFixProvider = {
  provideCodeActions(doc, range, ctx) {
    if (!ctx.diagnostics.length) return;
    const a = new vscode.CodeAction("Ask T3 to fix", vscode.CodeActionKind.QuickFix);
    a.diagnostics = ctx.diagnostics;
    const r = ctx.diagnostics.map((d) => d.range).reduce((x, y) => x.union(y));
    a.command = { command: "t3code.askFix", title: "Ask T3 to fix", arguments: [doc.uri, r] };
    return [a];
  },
};
async function askFix(uri, r) {
  const editor = await vscode.window.showTextDocument(uri);
  // Diagnostic ranges can be zero-width; whole lines also give the agent context.
  const end = editor.document.lineAt(r.end.line).range.end;
  editor.selection = new vscode.Selection(r.start.line, 0, end.line, end.character);
  return sendSelection();
}

function openThread(t) {
  if (!t || !t.link) {
    log("open in app: no thread link (" + JSON.stringify(t && t.threadId) + ")");
    return vscode.window.showWarningMessage("T3 Code: this thread has no app link.");
  }
  // Never re-encode: the thread id inside the link is already encoded.
  openLink(t.link.startsWith(WEB_PREFIX) ? t.link.replace(WEB_PREFIX, "t3code://") : t.link);
}

// Chat view in the T3 Code sidebar: polls `t3 thread show`; rendering lives in media/chat.js.
// ponytail: refetches the whole history each poll, no streaming; add a server push if the CLI ever offers one.
class Chat {
  constructor(extensionUri, state) {
    this.extensionUri = extensionUri;
    this.state = state; // workspaceState: remembers the last opened thread per workspace
    this.thread = undefined;
    this.view = undefined;
    this.last = "";
    this.fastUntil = 0;
    this.status = "";
    this.cache = new Map(); // threadId -> last payload posted, so switching back paints instantly
    // Each `t3 thread show` costs ~1s of CPU: poll fast only while a turn runs or just after open/send.
    this.loop = async () => {
      clearTimeout(this.timer); // one timer chain only, even if hurry() rescheduled meanwhile
      await this.poll();
      clearTimeout(this.timer);
      const fast = this.status === "running" || Date.now() < this.fastUntil;
      this.timer = setTimeout(this.loop, fast ? 1000 : 10000);
    };
    this.loop();
  }
  dispose() {
    clearTimeout(this.timer);
  }
  hurry() {
    this.fastUntil = Date.now() + 30000;
    clearTimeout(this.timer); // don't wait out a pending 10s idle tick
    this.timer = setTimeout(this.loop, 1000);
  }
  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = chatHtml(view.webview, media);
    this.last = ""; // a fresh webview has nothing painted yet
    view.webview.onDidReceiveMessage(async (m) => {
      if (m.open) return openFileLink(m.open);
      if (m.url) return /^https?:\/\//.test(m.url) && vscode.env.openExternal(vscode.Uri.parse(m.url));
      if (typeof m.copy === "string") return vscode.env.clipboard.writeText(m.copy);
      if (m.openInApp) return openThread(this.thread);
      if (m.pickModel) return client.state === "connected" ? pickModel(this.thread, () => this.poll(true)) : openThread(this.thread);
      if (typeof m.image === "string") {
        try {
          view.webview.postMessage({ imagePath: saveImage(m.image) });
        } catch (e) {
          view.webview.postMessage({ imageError: e.message });
        }
        return;
      }
      if (typeof m.text !== "string" || !m.text.trim()) return; // only an explicit composer send reaches `t3 thread send`
      // The webview keeps the typed text until it gets {sent}, so a failed send loses nothing.
      if (!this.thread) return view.webview.postMessage({ sendError: "click a thread first" });
      try {
        // The reference is built here from the tracked editor, never from webview input.
        const text = m.ctx === true && this.ctx ? m.text + "\n\n" + ctxRef(this.ctx) : m.text;
        await t3(["thread", "send", this.thread.threadId, "-"], text);
        view.webview.postMessage({ sent: true });
        this.hurry();
        this.poll(true, true);
      } catch (e) {
        view.webview.postMessage({ sendError: e.message.split("\n")[0] });
      }
    });
    if (this.ctx) view.webview.postMessage({ ctx: ctxLabel(this.ctx) });
    view.onDidChangeVisibility(() => this.poll(true));
    view.onDidDispose(() => (this.view = undefined));
    if (this.thread) this.paint(this.thread);
    else this.restore();
  }
  // Track the active file editor for the composer chip. Other editors (output, git:, untitled)
  // and focus moving to the webview keep the last file context.
  setContext(editor) {
    const uri = editor && editor.document.uri;
    if (!uri || uri.scheme !== "file") return;
    const rel = vscode.workspace.getWorkspaceFolder(uri) ? vscode.workspace.asRelativePath(uri) : uri.fsPath;
    this.ctx = { abs: uri.fsPath, rel, lines: selLines(editor.selection) };
    if (this.view) this.view.webview.postMessage({ ctx: ctxLabel(this.ctx) });
  }
  // worktreePath comes only from `t3 thread show` (not `thread list`); it drives the title-bar button.
  setWorktree(p) {
    p = typeof p === "string" && p ? p : undefined;
    if (p === this.worktree) return;
    this.worktree = p;
    vscode.commands.executeCommand("setContext", "t3code.chatWorktree", !!p);
  }
  // Reopen the last thread of this workspace if it is still open (not settled/snoozed),
  // else the most recently updated open one. listThreads() already drops settled and snoozed.
  async restore() {
    const last = this.state.get("t3code.lastThread");
    let t;
    try {
      const list = await listThreads();
      t =
        (last && list.find((x) => x.threadId === last.threadId)) ||
        list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    } catch (e) {}
    if (t && !this.thread) this.open(t);
    else this.poll(true);
  }
  async open(t) {
    if (!t || !t.threadId) return;
    this.thread = t;
    this.status = ""; // don't treat the switch itself as a status change
    this.state.update("t3code.lastThread", { threadId: t.threadId, title: t.title, link: t.link });
    if (this.onThread) this.onThread(t);
    this.setWorktree(undefined); // until the first poll of the new thread says otherwise
    if (!this.view || !this.view.visible) await vscode.commands.executeCommand("t3code.chat.focus");
    if (this.view) this.view.description = t.title || t.threadId;
    this.hurry();
    this.paint(t);
  }
  // Paint the cached chat (or a light loading state) right away, then fetch the fresh one.
  paint(t) {
    const c = this.cache.get(t.threadId);
    if (this.view) this.view.webview.postMessage(c ? { ...c, jump: true } : { loading: true, threadId: t.threadId, status: t.status, model: t.model, modelName: modelLabel(t.threadId, t.model) });
    this.last = c ? JSON.stringify([t.threadId, c.status, c.ask, c.messages]) : "";
    this.poll(true, !c);
  }
  // force: run even if a poll is in flight; jump: scroll to the bottom after painting.
  async poll(force, jump) {
    const v = this.view;
    if (!v || !v.visible) return;
    if (!this.thread) return v.webview.postMessage({ empty: true });
    if (this.busy && !force) return; // skip a tick while the previous `t3 thread show` is still running
    const id = this.thread.threadId;
    const stamp = stateStamp(); // taken before the call, so a change during the call is seen next tick
    if (!force && stamp && stamp === this.stamp && id === this.stampId) return; // nothing changed in T3
    this.busy = true;
    const seq = (this.seq = (this.seq || 0) + 1);
    try {
      const out = JSON.parse(await t3(["thread", "show", id, "--messages", "1000", "--json"]));
      if (seq !== this.seq) return; // a newer poll started (thread switch or send): drop this stale result
      this.stamp = stamp; // only after a good poll, so a failed one is retried
      this.stampId = id;
      if (out.thread.settled) {
        // Settled threads vanish from the tree, so empty the pane too (un-settling does not reopen it).
        this.thread = undefined;
        this.last = "";
        this.state.update("t3code.lastThread", undefined);
        this.setWorktree(undefined);
        v.description = undefined;
        if (this.onThread) this.onThread(undefined);
        if (this.onStatus) this.onStatus();
        return v.webview.postMessage({ empty: true });
      }
      if (this.status && this.status !== out.thread.status && this.onStatus) this.onStatus(); // refresh tree icons
      this.status = out.thread.status;
      this.setWorktree(out.thread.worktreePath);
      const ask = out.thread.pendingRequestCount || 0;
      const s = JSON.stringify([id, out.thread.status, ask, modelLabel(id, out.thread.model), out.messages]);
      if (s !== this.last || jump) {
        this.last = s;
        const msg = {
          threadId: id,
          status: out.thread.status,
          model: out.thread.model,
          modelName: modelLabel(id, out.thread.model),
          ask,
          messages: out.messages,
        };
        this.cache.delete(id); // re-insert so the Map keeps the most recent threads last
        this.cache.set(id, msg);
        if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
        v.webview.postMessage({ ...msg, jump: !!jump });
      }
    } catch (e) {
      this.last = ""; // so the next good poll repaints and clears the error
      this.stamp = undefined; // and so the state-file gate cannot skip the retry
      v.webview.postMessage({ error: e.message });
    } finally {
      this.busy = false;
    }
  }
}

// Open a chat file link in an editor. Accepts /abs, ~/x, file://..., or a workspace-relative path, with optional :line[:col].
async function openFileLink(raw) {
  let p = raw.replace(/^file:\/\//, "");
  try {
    p = decodeURIComponent(p);
  } catch (e) {}
  const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(p);
  p = m[1].replace(/^~(?=\/)/, require("os").homedir());
  const line = m[2] ? Number(m[2]) - 1 : undefined, col = m[3] ? Number(m[3]) - 1 : 0;
  let uri;
  if (p.startsWith("/")) uri = vscode.Uri.file(p);
  else {
    for (const f of vscode.workspace.workspaceFolders || []) {
      const u = vscode.Uri.joinPath(f.uri, p);
      try {
        await vscode.workspace.fs.stat(u);
        uri = u;
        break;
      } catch (e) {}
    }
    if (!uri) [uri] = await vscode.workspace.findFiles("**/" + p.replace(/^\.\//, ""), "**/node_modules/**", 1);
  }
  try {
    const stat = uri && (await vscode.workspace.fs.stat(uri));
    if (!stat) throw new Error();
    if (stat.type & vscode.FileType.Directory) return vscode.commands.executeCommand("revealInExplorer", uri);
    const pos = line === undefined ? undefined : new vscode.Position(line, col);
    await vscode.window.showTextDocument(uri, pos && { selection: new vscode.Range(pos, pos), preview: true });
  } catch (e) {
    vscode.window.setStatusBarMessage(`T3 Code: file not found: ${raw}`, 4000);
  }
}

// Strict CSP: only our own script (by nonce) and stylesheet load; nothing else, no inline code.
function chatHtml(webview, media) {
  const nonce = require("crypto").randomBytes(16).toString("hex");
  // ?v=nonce: a reloaded extension never pairs a new shell with a cached old chat.css/chat.js.
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css")).with({ query: "v=" + nonce });
  const js = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.js")).with({ query: "v=" + nonce });
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>
<div id="st" role="status"></div>
<div id="main">
<div id="log" role="log" aria-live="polite"></div>
<div id="empty" hidden><div class="logo"></div><div id="emptytxt">Pick a thread in the Threads view to see its chat here.</div></div>
<div id="skel" aria-hidden="true"><i></i><i></i><i></i></div>
<button id="ask" hidden></button>
<div id="work" hidden><i></i><i></i><i></i><span>Working</span></div>
</div>
<div id="bar"><textarea id="t" rows="1" aria-label="Message" placeholder="Message the agent"></textarea>
<div id="row"><span id="model" role="button" tabindex="0" title="Model and effort of this thread. Click to change them"></span><button id="ctx" hidden><span id="ctxl"></span><span aria-hidden="true">x</span></button><button id="b" title="Send (Enter)">Send</button></div></div>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
}

// Usage dashboard: one editor-tab panel, reused if already open.
let usagePanel;
function openUsage(context) {
  if (usagePanel) return usagePanel.reveal();
  const media = vscode.Uri.joinPath(context.extensionUri, "media");
  const panel = (usagePanel = vscode.window.createWebviewPanel("t3code.usage", "T3 Usage", vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [media],
  }));
  panel.onDidDispose(() => (usagePanel = undefined));
  const w = panel.webview;
  const nonce = require("crypto").randomBytes(16).toString("hex");
  const uri = (f) => w.asWebviewUri(vscode.Uri.joinPath(media, f)).with({ query: "v=" + nonce });
  w.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri("usage.css")}"></head><body>
<header><h1>Usage</h1>
<select id="prov" hidden aria-label="Provider"><option value="all">All providers</option></select>
<div class="seg" id="tabs"><input type="radio" name="t" id="tcost" value="cost"><label for="tcost">Cost</label><input type="radio" name="t" id="ttokens" value="tokens"><label for="ttokens">Tokens</label><input type="radio" name="t" id="tlimits" value="limits" checked><label for="tlimits">Limits</label></div>
<div class="seg" id="range" hidden><input type="radio" name="r" id="r7" checked><label for="r7">7 days</label><input type="radio" name="r" id="r30"><label for="r30">30 days</label></div>
<button id="refresh">Refresh</button></header>
<div id="st" role="status"></div>
<div id="usage" hidden><div id="tiles"></div><div id="chart" role="img" aria-label="Per day"></div>
<table><thead><tr><th>Model</th><th>Provider</th><th class="n" id="mh">Cost</th></tr></thead><tbody id="rows"></tbody></table>
<div id="note"></div></div>
<div id="limits"></div>
<script nonce="${nonce}" src="${uri("usage.js")}"></script></body></html>`;
  let seq = 0; // a slow 30-day scan must not overwrite a newer 7-day answer
  const load = async (days) => {
    const mine = ++seq;
    w.postMessage({ kind: "loading" });
    try {
      const data = summarize(await fetchUsage(days));
      if (mine === seq) w.postMessage({ kind: "data", days, data });
    } catch (e) {
      log("usage: " + e.message);
      if (mine === seq) w.postMessage({ kind: "error", message: "Could not read usage: " + e.message });
    }
  };
  w.onDidReceiveMessage((m) => (m.ready ? load(7) : m.days && load(m.days)));
}

// "Sonnet 5.5 | medium": effort comes from the live store (the CLI does not report it).
function modelLabel(threadId, model) {
  const t = client.threads.get(threadId);
  const opt = ((t && t.modelSelection && t.modelSelection.options) || []).find((o) => /effort/i.test(o.id));
  return [prettyModel(model), opt && opt.value].filter(Boolean).join("  |  ");
}

// Quick pick of every enabled provider's models, then that model's effort levels.
// ponytail: other model options (service tier, ...) are dropped on change; add them to the picker if missed.
async function pickModel(thread, done) {
  const raw = thread && client.threads.get(thread.threadId);
  if (!raw || !raw.modelSelection) return vscode.window.showWarningMessage("T3 Code: this thread is not in the live list yet.");
  const cur = raw.modelSelection;
  let config;
  try {
    config = await client.getConfig();
  } catch (e) {
    return vscode.window.showErrorMessage("T3 Code: could not read the model list: " + e.message);
  }
  // Every enabled provider, current one first; picking another provider's model switches the thread to it.
  const provs = (config.providers || [])
    .filter((p) => p.enabled && (p.models || []).length)
    .sort((a, b) => (b.instanceId === cur.instanceId) - (a.instanceId === cur.instanceId));
  if (!provs.length) return vscode.window.showWarningMessage("T3 Code: the server lists no models.");
  const items = [];
  for (const p of provs) {
    items.push({ label: p.displayName || p.instanceId, kind: vscode.QuickPickItemKind.Separator });
    for (const m of p.models) {
      const now = p.instanceId === cur.instanceId && m.slug === cur.model;
      items.push({ label: m.name || m.slug, description: now ? m.slug + "  (current)" : m.slug, m, p });
    }
  }
  const model = await vscode.window.showQuickPick(items, { placeHolder: `Model for "${thread.title || thread.threadId}"`, matchOnDescription: true });
  if (!model) return;
  const same = model.p.instanceId === cur.instanceId;
  const desc = ((model.m.capabilities && model.m.capabilities.optionDescriptors) || []).find((d) => /effort/i.test(d.id) && d.type === "select");
  const options = [];
  if (desc) {
    const now = same && (cur.options || []).find((o) => o.id === desc.id);
    const fallback = now ? now.value : (desc.options.find((o) => o.isDefault) || {}).id;
    const pick = await vscode.window.showQuickPick(
      desc.options.map((o) => ({ label: o.label, description: o.id === fallback ? "current" : o.description, id: o.id })),
      { placeHolder: `${desc.label || "Effort"} for ${model.label}` }
    );
    if (!pick) return;
    options.push({ id: desc.id, value: pick.id });
  }
  try {
    await client.setModel(thread.threadId, { instanceId: model.p.instanceId, model: model.m.slug, ...(options.length ? { options } : {}) });
    log(`model ${thread.threadId}: ${model.m.slug} ${options.map((o) => o.value).join("")}`);
    if (done) done();
  } catch (e) {
    vscode.window.showErrorMessage("T3 Code: could not change the model: " + e.message.split("\n")[0]);
  }
}

// Agent dashboard: one editor-tab panel of cards, sorted by urgency, fed by the live thread list.
let dashPanel;
function openDashboard(context, chat) {
  if (dashPanel) return dashPanel.reveal();
  const media = vscode.Uri.joinPath(context.extensionUri, "media");
  const panel = (dashPanel = vscode.window.createWebviewPanel("t3code.dashboard", "T3 Agents", vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [media],
  }));
  const w = panel.webview;
  const nonce = require("crypto").randomBytes(16).toString("hex");
  const uri = (f) => w.asWebviewUri(vscode.Uri.joinPath(media, f)).with({ query: "v=" + nonce });
  w.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri("dashboard.css")}"></head><body>
<header><h1>Agents</h1></header>
<div id="st" role="status"></div><div id="counts"></div><div id="cards"></div>
<script nonce="${nonce}" src="${uri("dashboard.js")}"></script></body></html>`;
  let byId = new Map();
  const view = (t) => ({
    id: t.threadId, title: t.title || t.threadId, status: t.status, rank: t.rank, ask: t.status === "waiting",
    live: t.status === "running" || t.status === "waiting", model: prettyModel(t.model), effort: t.effort, when: ago(t.updatedAt),
    children: (t.children || []).map(view), agents: (t.children || []).length || undefined,
  });
  const push = async () => {
    try {
      const list = await listThreads();
      byId = new Map(list.map((t) => [t.threadId, t]));
      const b = board(list);
      w.postMessage({ state: client.state, board: { counts: b.counts, cards: b.cards.map(view) } });
    } catch (e) {
      w.postMessage({ state: client.state, error: e.message });
    }
  };
  client.on("changed", push);
  client.on("state", push);
  const timer = setInterval(push, 60000); // fresh "3m ago"; also the refresh path while on the CLI fallback
  panel.onDidDispose(() => {
    dashPanel = undefined;
    clearInterval(timer);
    client.off("changed", push);
    client.off("state", push);
  });
  w.onDidReceiveMessage(async (m) => {
    if (m.ready) return push();
    const t = byId.get(m.id);
    if (!t) return;
    if (m.act === "chat") return chat.open(t);
    if (m.act === "app") return openThread(t);
    if (m.act === "stop" && (await vscode.window.showWarningMessage(`Stop "${t.title || t.threadId}"?`, { modal: true }, "Stop")) !== "Stop") return;
    if (m.act === "stop" || m.act === "settle") return threadAction(m.act, t, chat);
  });
}

async function sendToThread(provider, arg) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showWarningMessage("T3 Code: select some code first.");
    return;
  }
  try {
    let thread = arg && arg.thread; // set when invoked from the tree
    if (!thread) {
      const picks = (await listThreads()).map((t) => ({ label: t.title || t.threadId, description: String(t.status), t }));
      if (!picks.length) return vscode.window.showWarningMessage("T3 Code: no threads in this workspace.");
      const pick = await vscode.window.showQuickPick(picks, { placeHolder: "Send selection to which thread?" });
      thread = pick && pick.t;
    }
    if (!thread) return;
    const note = await vscode.window.showInputBox({
      prompt: "Instruction for the agent. This is sent now, not saved as a draft.",
    });
    if (note === undefined) return;
    await t3(["thread", "send", thread.threadId, "-"], buildPrompt(editor) + note);
    vscode.window.showInformationMessage(`T3 Code: sent to "${thread.title || thread.threadId}".`);
    provider.refresh();
  } catch (e) {
    vscode.window.showErrorMessage("T3 Code: " + e.message);
  }
}

// Start a new thread in this workspace's project from a typed message, then open it in the chat view.
async function newThread(provider, chat) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) return vscode.window.showWarningMessage("T3 Code: open a folder first.");
  const msg = await vscode.window.showInputBox({ prompt: "First message for the new T3 Code thread" });
  if (!msg || !msg.trim()) return;
  try {
    const out = await t3(["thread", "start", folder.uri.fsPath, "-", "--json"], msg);
    let id;
    try {
      const j = JSON.parse(out);
      id = j.threadId || (j.thread && j.thread.threadId) || j.id;
    } catch (e) {
      id = out.trim().split(/\s+/).pop(); // plain-id output
    }
    log("new thread: " + id);
    const t = (await listThreads()).find((x) => x.threadId === id);
    provider.refresh();
    if (t) chat.open(t);
    else vscode.window.showInformationMessage("T3 Code: thread started.");
  } catch (e) {
    vscode.window.showErrorMessage("T3 Code: " + e.message);
  }
}

const FINISHED = new Set(["completed", "failed", "error", "interrupted", "cancelled"]);

// Status bar (count of running threads) and a notification when a thread finishes.
// Fed by every thread list: the tree's own refreshes and a light 15s poll.
function watchThreads(context, provider, chat) {
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.command = "workbench.view.extension.t3code";
  const seen = new Map(); // threadId -> last status; a thread seen for the first time never notifies
  provider.onList = (list) => {
    const n = list.filter((t) => t.status === "running").length;
    bar.text = `$(loading~spin) T3 ${n}`;
    bar.tooltip = `T3 Code: ${n} thread${n > 1 ? "s" : ""} running. Click to show.`;
    n ? bar.show() : bar.hide();
    for (const t of list) {
      const was = seen.get(t.threadId);
      seen.set(t.threadId, t.status);
      if (was !== "running" || !FINISHED.has(t.status)) continue;
      if (chat.view && chat.view.visible && chat.thread && chat.thread.threadId === t.threadId) continue;
      const bad = t.status === "failed" || t.status === "error";
      const show = bad ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      show(`T3 Code: "${t.title || t.threadId}" ${t.status}.`, "Open chat").then((a) => a && chat.open(t));
    }
  };
  let seenStamp; // separate from the chat's, so one poller never hides a change from the other
  const tick = async () => {
    if (client.state === "connected") return; // pushes drive the tree; this poll is the CLI fallback only
    if (Date.now() - (provider.listedAt || 0) < 14000) return; // the tree listed recently: reuse it
    const stamp = stateStamp();
    if (stamp && stamp === seenStamp) return; // T3 state unchanged since the last good list
    try {
      const list = await listThreads();
      seenStamp = stamp;
      provider.listedAt = Date.now();
      provider.list = list;
      provider.onList(list);
      provider.refresh(true); // re-render the tree from this list, no second CLI call
    } catch (e) {
      log("thread poll: " + e.message); // keep the last statuses so a later list still notifies
    }
  };
  tick();
  context.subscriptions.push(bar, { dispose: clearInterval.bind(null, setInterval(tick, 15000)) });
}

// Stop a running turn / settle a thread over the live connection (the CLI has neither).
async function threadAction(verb, arg, chat) {
  const t = arg && arg.thread ? arg.thread : arg && arg.threadId ? arg : chat && chat.thread;
  if (!t) return vscode.window.showWarningMessage("T3 Code: pick a thread first.");
  if (client.state !== "connected") return vscode.window.showWarningMessage("T3 Code: not connected to the T3 server (" + client.state + ").");
  try {
    await (verb === "stop" ? client.stopThread(t.threadId) : client.settleThread(t.threadId));
    log(verb + " " + t.threadId);
  } catch (e) {
    vscode.window.showErrorMessage(`T3 Code: could not ${verb}: ${e.message.split("\n")[0]}`);
  }
}

function activate(context) {
  const provider = new Threads();
  const chat = new Chat(context.extensionUri, context.workspaceState);
  const badges = new TurnBadges();
  chat.onThread = (t) => badges.update(t);
  // A status change (e.g. a turn just finished) refreshes tree icons and the changed-file badges.
  chat.onStatus = () => {
    provider.refresh();
    badges.update(chat.thread);
  };
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(badges));
  context.subscriptions.push(chat);
  watchThreads(context, provider, chat);
  client.on("log", log);
  client.on("state", (s, why) => {
    log("connection: " + s + (why ? " (" + why + ")" : ""));
    provider.refresh(); // connected -> live list; down -> CLI list
  });
  // Feed the status bar and finish notifications directly: getChildren only runs while the tree is visible.
  client.on("changed", async () => {
    const list = await listThreads().catch(() => undefined);
    if (!list) return;
    provider.list = list;
    provider.listedAt = Date.now();
    if (provider.onList) provider.onList(list);
    provider.refresh(true); // re-render from this list, no second read
  });
  client.start();
  context.subscriptions.push({ dispose: () => client.stop() });
  let ctxTimer;
  const track = () => {
    clearTimeout(ctxTimer);
    ctxTimer = setTimeout(() => chat.setContext(vscode.window.activeTextEditor), 150);
  };
  track();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(track),
    vscode.window.onDidChangeTextEditorSelection(track),
    { dispose: () => clearTimeout(ctxTimer) }
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("t3code.threads", provider),
    // Keep "3m ago" honest without calling the CLI: re-render the cached list once a minute.
    { dispose: clearInterval.bind(null, setInterval(() => provider.refresh(true), 60000)) },
    vscode.commands.registerCommand("t3code.sendSelection", sendSelection),
    vscode.commands.registerCommand("t3code.askFix", askFix),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, askFixProvider, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.commands.registerCommand("t3code.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("t3code.openThread", (arg) => openThread(arg && arg.thread ? arg.thread : arg)),
    vscode.window.registerWebviewViewProvider("t3code.chat", chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("t3code.openChat", (t) => chat.open(t)),
    vscode.commands.registerCommand("t3code.chatRefresh", () => chat.poll(true)),
    vscode.commands.registerCommand("t3code.chatOpenInApp", () => openThread(chat.thread)),
    vscode.workspace.registerTextDocumentContentProvider("t3-turn", turnContent),
    vscode.commands.registerCommand("t3code.openWorktree", () => openWorktree(chat.worktree)),
    vscode.commands.registerCommand("t3code.showTurnChanges", (arg) => showTurnChanges(arg && arg.thread ? arg.thread : chat.thread)),
    vscode.commands.registerCommand("t3code.sendToThread", (arg) => sendToThread(provider, arg)),
    vscode.commands.registerCommand("t3code.newThread", () => newThread(provider, chat)),
    vscode.commands.registerCommand("t3code.openUsage", () => openUsage(context)),
    vscode.commands.registerCommand("t3code.openDashboard", () => openDashboard(context, chat)),
    vscode.commands.registerCommand("t3code.stopThread", (arg) => threadAction("stop", arg, chat)),
    vscode.commands.registerCommand("t3code.settleThread", (arg) => threadAction("settle", arg, chat))
  );
}

module.exports = { activate, ago, prettyModel, stateStamp, checkpointScope, saveImage, selLines, ctxLabel, ctxRef };
