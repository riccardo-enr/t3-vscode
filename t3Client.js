// One long-lived WebSocket to the local T3 server. No `vscode` import, so test/t3client_check.js can load it.
// Holds the live thread list (orchestration.subscribeShell) and sends commands (orchestration.dispatchCommand).
// Wire names were read from T3's web bundle and live frames on 2026-11-19 (server 0.1.10).
// ponytail: internal, unversioned protocol; on any surprise the client goes to state "down" and the
// extension falls back to the CLI polling path. Credential = 5 min CLI-minted token per connect.
const { execFile } = require("child_process");
const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCOPES = ["orchestration:read", "orchestration:operate", "diagnostics:read"];

// Server thread -> the shape `t3 thread list --json` returns, so the tree and status bar stay unchanged.
function toCli(t, envId, now = Date.now()) {
  const asked = !!t.pendingRuntimeRequest;
  return {
    threadId: t.id,
    projectId: t.projectId,
    title: t.title,
    link: envId ? `https://app.t3.codes/threads/${envId}/${encodeURIComponent(t.id)}` : undefined,
    status: asked ? "waiting" : t.activityRunStatus === "running" ? "running" : t.status,
    model: t.modelSelection && t.modelSelection.model,
    effort: ((t.modelSelection && t.modelSelection.options) || []).filter((o) => o.id === "effort").map((o) => o.value)[0],
    worktreePath: t.worktreePath,
    settled: !!t.settledAt,
    snoozed: !!t.snoozedUntil && Date.parse(t.snoozedUntil) > now,
    pinned: !!t.pinnedAt,
    pendingBackgroundTasks: t.pendingBackgroundTasks || [],
    pendingRequest: t.pendingRuntimeRequest || null,
    parentThreadId: t.lineage && t.lineage.parentThreadId,
    relationshipToParent: t.lineage && t.lineage.relationshipToParent,
    latestMessage: t.latestVisibleMessage || null,
    updatedAt: t.updatedAt,
    createdAt: t.createdAt,
  };
}

// Apply one subscribeShell value to {threads: Map, projects: Map}. Returns true if anything changed.
function applyShell(s, v) {
  switch (v.kind) {
    case "snapshot":
      for (const t of v.snapshot.threads || []) s.threads.set(t.id, t);
      for (const p of v.snapshot.projects || []) s.projects.set(p.id, p);
      return true;
    case "thread.updated":
      if (v.location === "active") s.threads.set(v.thread.id, v.thread);
      else s.threads.delete(v.thread.id);
      return true;
    case "thread.removed":
      return s.threads.delete(v.threadId);
    case "project.updated":
      s.projects.set(v.project.id, v.project);
      return true;
    case "project.removed":
      return s.projects.delete(v.projectId);
    default:
      return false;
  }
}

const backoff = (n) => Math.min(30000, 1000 * 2 ** Math.min(n, 5)); // 1s, 2s, 4s ... 30s

function runtime() {
  const home = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
  return { home, ...JSON.parse(fs.readFileSync(path.join(home, "userdata", "server-runtime.json"), "utf8")) };
}

function mintToken(home) {
  return new Promise((resolve, reject) => {
    const args = ["auth", "session", "issue", "--ttl", "5m", "--label", "vscode-bridge", "--token-only", "--base-dir", home];
    for (const s of SCOPES) args.push("--scope", s);
    execFile("t3", args, { timeout: 15000 }, (err, out, stderr) => {
      if (err) return reject(new Error(err.code === "ENOENT" ? "t3 not found on PATH" : (stderr || err.message).trim()));
      resolve(out.trim().split("\n").pop());
    });
  });
}

class T3Client extends EventEmitter {
  constructor() {
    super();
    this.state = "connecting"; // connecting | connected | down
    this.threads = new Map();
    this.projects = new Map();
    this.pending = new Map(); // request id -> {resolve, reject}
    this.fails = 0;
    this.n = 0;
  }
  start() {
    this.stopped = false;
    this._connect();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.ws) this.ws.close();
  }
  _set(state, why) {
    if (this.state === state && !why) return;
    this.state = state;
    this.emit("state", state, why);
  }
  async _connect() {
    if (typeof WebSocket === "undefined") return this._set("down", "this VS Code's Node has no global WebSocket; using the CLI");
    try {
      const rt = runtime();
      const res = await fetch(rt.origin + "/api/auth/websocket-ticket", {
        method: "POST",
        headers: { authorization: "Bearer " + (await mintToken(rt.home)), "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error("ticket refused (" + res.status + ")");
      const { ticket } = await res.json();
      if (this.stopped) return;
      const ws = (this.ws = new WebSocket(rt.origin.replace(/^http/, "ws") + `/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`));
      this.version = rt.serverVersion;
      ws.onopen = () => {
        this.threads.clear();
        this.projects.clear();
        this._request("server.getConfig", {})
          .then((c) => {
            this.envId = c.environment && c.environment.environmentId; // needed for app links
            if (this.state === "connected") this.emit("changed");
          })
          .catch((e) => this.emit("log", "server.getConfig: " + e.message));
        this._request("orchestration.subscribeShell", {}, (v) => applyShell(this, v) && this._changed()).then(
          () => ws.close(), // the stream ended: reconnect
          (e) => this.emit("log", "shell subscription: " + e.message)
        );
      };
      ws.onmessage = (e) => this._frame(JSON.parse(String(e.data)));
      ws.onclose = () => this._lost("socket closed", ws);
      ws.onerror = () => {};
    } catch (e) {
      this._lost(e.message);
    }
  }
  _changed() {
    if (this.state !== "connected") (this.fails = 0), this._set("connected");
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.emit("changed"), 50); // a snapshot arrives in several chunks
  }
  // ws: the socket that closed (a stale one is ignored); none when connect() failed before a socket existed.
  _lost(why, ws) {
    if (ws && ws !== this.ws) return;
    for (const p of this.pending.values()) p.reject(new Error("connection lost"));
    this.pending.clear();
    if (this.stopped) return;
    this._set("down", why);
    this.timer = setTimeout(() => this._connect(), backoff(this.fails++)); // server-runtime.json is re-read: the port can change
  }
  _frame(m) {
    const p = this.pending.get(m.requestId);
    if (!p) return;
    if (m._tag === "Chunk") return m.values.forEach((v) => p.onValue && p.onValue(v));
    if (m._tag !== "Exit") return;
    this.pending.delete(m.requestId);
    if (m.exit._tag === "Success") p.resolve(m.exit.value);
    else p.reject(new Error(JSON.stringify(m.exit.cause || m.exit).slice(0, 300)));
  }
  _request(tag, payload, onValue) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error("not connected to T3"));
      const id = String(++this.n);
      this.pending.set(id, { resolve, reject, onValue });
      this.ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  }
  // Fire one orchestration command, e.g. command("thread.stop", { threadId }).
  command(type, fields) {
    return this._request("orchestration.dispatchCommand", { type, commandId: crypto.randomUUID(), ...fields });
  }
  stopThread(threadId) {
    return this.command("thread.stop", { threadId });
  }
  settleThread(threadId) {
    return this.command("thread.settle", { threadId });
  }
  getConfig() {
    return this._request("server.getConfig", {});
  }
  setModel(threadId, modelSelection) {
    return this.command("thread.model-selection.set", { threadId, modelSelection });
  }
  // Open threads of one project folder (not settled, not snoozed), newest-first order is the caller's job.
  list(folder) {
    const ids = new Set([...this.projects.values()].filter((p) => p.workspaceRoot === folder).map((p) => p.id));
    return [...this.threads.values()]
      .filter((t) => ids.has(t.projectId))
      .map((t) => toCli(t, this.envId))
      .filter((t) => !t.settled && !t.snoozed);
  }
}

module.exports = { T3Client, toCli, applyShell, backoff };
