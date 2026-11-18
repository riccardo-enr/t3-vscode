const vscode = require("vscode");
const { execFile } = require("child_process");

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

async function listThreads() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) return [];
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
    item.contextValue = "thread";
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
      if (typeof m.text !== "string" || !m.text.trim()) return; // only an explicit composer send reaches `t3 thread send`
      // The webview keeps the typed text until it gets {sent}, so a failed send loses nothing.
      if (!this.thread) return view.webview.postMessage({ sendError: "click a thread first" });
      try {
        await t3(["thread", "send", this.thread.threadId, "-"], m.text);
        view.webview.postMessage({ sent: true });
        this.hurry();
        this.poll(true, true);
      } catch (e) {
        view.webview.postMessage({ sendError: e.message.split("\n")[0] });
      }
    });
    view.onDidChangeVisibility(() => this.poll(true));
    view.onDidDispose(() => (this.view = undefined));
    if (this.thread) this.paint(this.thread);
    else this.restore();
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
    if (!this.view || !this.view.visible) await vscode.commands.executeCommand("t3code.chat.focus");
    if (this.view) this.view.description = t.title || t.threadId;
    this.hurry();
    this.paint(t);
  }
  // Paint the cached chat (or a light loading state) right away, then fetch the fresh one.
  paint(t) {
    const c = this.cache.get(t.threadId);
    if (this.view) this.view.webview.postMessage(c ? { ...c, jump: true } : { loading: true, threadId: t.threadId, status: t.status, model: t.model, modelName: prettyModel(t.model) });
    this.last = c ? JSON.stringify([t.threadId, c.status, c.messages]) : "";
    this.poll(true, !c);
  }
  // force: run even if a poll is in flight; jump: scroll to the bottom after painting.
  async poll(force, jump) {
    const v = this.view;
    if (!v || !v.visible) return;
    if (!this.thread) return v.webview.postMessage({ empty: true });
    if (this.busy && !force) return; // skip a tick while the previous `t3 thread show` is still running
    this.busy = true;
    const id = this.thread.threadId;
    const seq = (this.seq = (this.seq || 0) + 1);
    try {
      const out = JSON.parse(await t3(["thread", "show", id, "--messages", "1000", "--json"]));
      if (seq !== this.seq) return; // a newer poll started (thread switch or send): drop this stale result
      if (this.status && this.status !== out.thread.status && this.onStatus) this.onStatus(); // refresh tree icons
      this.status = out.thread.status;
      const s = JSON.stringify([id, out.thread.status, out.messages]);
      if (s !== this.last || jump) {
        this.last = s;
        const msg = {
          threadId: id,
          status: out.thread.status,
          model: out.thread.model,
          modelName: prettyModel(out.thread.model),
          messages: out.messages,
        };
        this.cache.delete(id); // re-insert so the Map keeps the most recent threads last
        this.cache.set(id, msg);
        if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
        v.webview.postMessage({ ...msg, jump: !!jump });
      }
    } catch (e) {
      this.last = ""; // so the next good poll repaints and clears the error
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
<div id="work" hidden><i></i><i></i><i></i><span>Working</span></div>
</div>
<div id="bar"><textarea id="t" rows="1" aria-label="Message" placeholder="Message the agent"></textarea>
<div id="row"><span id="model" title="Model of this thread"></span><button id="b" title="Send (Enter)">Send</button></div></div>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
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

function activate(context) {
  const provider = new Threads();
  const chat = new Chat(context.extensionUri, context.workspaceState);
  chat.onStatus = () => provider.refresh();
  context.subscriptions.push(chat);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("t3code.threads", provider),
    // Keep "3m ago" honest without calling the CLI: re-render the cached list once a minute.
    { dispose: clearInterval.bind(null, setInterval(() => provider.refresh(true), 60000)) },
    vscode.commands.registerCommand("t3code.sendSelection", sendSelection),
    vscode.commands.registerCommand("t3code.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("t3code.openThread", (arg) => openThread(arg && arg.thread ? arg.thread : arg)),
    vscode.window.registerWebviewViewProvider("t3code.chat", chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("t3code.openChat", (t) => chat.open(t)),
    vscode.commands.registerCommand("t3code.chatRefresh", () => chat.poll(true)),
    vscode.commands.registerCommand("t3code.chatOpenInApp", () => openThread(chat.thread)),
    vscode.commands.registerCommand("t3code.sendToThread", (arg) => sendToThread(provider, arg))
  );
}

module.exports = { activate, ago, prettyModel };
