// One long-lived WebSocket to the local T3 server: the only way the extension talks to T3 (no CLI).
// No `vscode` import, so test/t3client_check.js can load it.
// Login: a pairing code (`t3 auth pairing create`, or the app) is exchanged once at /oauth/token for a
// 30-day bearer token, kept by the caller (VS Code SecretStorage) through `secrets` = {get, set, delete}.
// Wire names were read from T3's web bundle and binary and run on a separate server, 2026-11-19 (0.1.10).
// ponytail: internal, unversioned protocol; a T3 update can break it. Errors then name the server version.
const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCOPES = ["orchestration:read", "orchestration:operate", "diagnostics:read"];

// Server thread -> the flat shape the tree, chat and dashboard use (once the `t3 thread list --json` shape).
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

// Apply one subscribeThread value to a Map of message id -> message. Returns true if anything changed.
// A snapshot replaces everything; a message.updated event carries the whole message, so it is an upsert.
function applyThread(msgs, v) {
  if (v.kind === "snapshot") {
    msgs.clear();
    for (const m of v.projection.messages || []) msgs.set(m.id, m);
    return true;
  }
  if (v.kind === "event" && v.event.type === "message.updated" && v.event.payload) {
    msgs.set(v.event.payload.id, v.event.payload);
    return true;
  }
  return false;
}

// Form body for POST /oauth/token: pairing code -> bearer (OAuth token exchange, RFC 8693).
function exchangeForm(code) {
  return new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: code.trim(),
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: SCOPES.join(" "),
    client_label: "VS Code",
    client_device_type: "desktop",
  }).toString();
}

const backoff = (n) => Math.min(30000, 1000 * 2 ** Math.min(n, 5)); // 1s, 2s, 4s ... 30s

function runtime() {
  const home = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
  const file = path.join(home, "userdata", "server-runtime.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error("T3 server not running (no " + file + ")");
  }
}

class T3Client extends EventEmitter {
  // secrets: {get(): Promise<string|undefined>, set(token), delete()}
  constructor(secrets) {
    super();
    this.secrets = secrets;
    this.state = "connecting"; // connecting | connected | down | unpaired
    this.why = "";
    this.threads = new Map();
    this.projects = new Map();
    this.pending = new Map(); // request id -> {resolve, reject, onValue}
    this.watches = new Set(); // open thread subscriptions, re-sent on every reconnect
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
  // Drop the socket and connect again now (after pairing, or a manual refresh).
  reconnect() {
    clearTimeout(this.timer);
    this.fails = 0;
    const ws = this.ws;
    this.ws = undefined;
    if (ws) ws.close();
    this._fail("reconnecting");
    this._set("connecting");
    this._connect();
  }
  _set(state, why = "") {
    if (this.state === state && this.why === why) return;
    this.state = state;
    this.why = why;
    this.emit("state", state, why);
  }
  // Exchange a pairing code for a bearer, store it, and connect with it.
  async pair(code) {
    const res = await fetch(runtime().origin + "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: exchangeForm(code),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new Error(body.error_description || body.error || "pairing refused (" + res.status + ")");
    await this.secrets.set(body.access_token);
    this.reconnect();
  }
  async _connect() {
    if (typeof WebSocket === "undefined") return this._set("down", "this VS Code has no global WebSocket (needs 1.101 or newer)");
    try {
      const token = await this.secrets.get();
      if (!token) return this._set("unpaired", "not paired with the T3 server");
      const rt = runtime();
      this.version = rt.serverVersion;
      const res = await fetch(rt.origin + "/api/auth/websocket-ticket", {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: "{}",
      });
      if (res.status === 401 || res.status === 403) {
        await this.secrets.delete(); // revoked or expired: a retry cannot fix it, pairing again can
        return this._set("unpaired", "the server refused the saved login (" + res.status + ")");
      }
      if (!res.ok) throw new Error("ticket refused (" + res.status + ")");
      const { ticket } = await res.json();
      if (this.stopped) return;
      const ws = (this.ws = new WebSocket(rt.origin.replace(/^http/, "ws") + `/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`));
      ws.onopen = () => {
        this.threads.clear();
        this.projects.clear();
        this.request("server.getConfig", {})
          .then((c) => {
            this.envId = c.environment && c.environment.environmentId; // needed for app links
            if (this.state === "connected") this.emit("changed");
          })
          .catch((e) => this.emit("log", "server.getConfig: " + e.message));
        this.request("orchestration.subscribeShell", {}, (v) => applyShell(this, v) && this._changed()).then(
          () => ws.close(), // the stream ended: reconnect
          (e) => this.emit("log", "shell subscription: " + e.message)
        );
        for (const w of this.watches) this._subscribe(w);
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
  _fail(why) {
    for (const p of this.pending.values()) p.reject(new Error(why));
    this.pending.clear();
  }
  // ws: the socket that closed (a stale one is ignored); none when connect() failed before a socket existed.
  _lost(why, ws) {
    if (ws && ws !== this.ws) return;
    this._fail("connection lost");
    if (this.stopped) return;
    this._set("down", why + (this.version ? " (server " + this.version + ")" : ""));
    this.timer = setTimeout(() => this._connect(), backoff(this.fails++)); // server-runtime.json is re-read: the port can change
  }
  _frame(m) {
    const p = this.pending.get(m.requestId);
    if (!p) return;
    if (m._tag === "Chunk") {
      // Streams are flow-controlled: without an Ack per chunk the server stops sending after a few chunks.
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ _tag: "Ack", requestId: m.requestId }));
      return m.values.forEach((v) => p.onValue && p.onValue(v));
    }
    if (m._tag !== "Exit") return;
    this.pending.delete(m.requestId);
    if (m.exit._tag === "Success") p.resolve(m.exit.value);
    else p.reject(new Error(JSON.stringify(m.exit.cause || m.exit).slice(0, 300)));
  }
  // One RPC; onValue gets every streamed value. The returned promise carries the request id as `.id`.
  request(tag, payload, onValue) {
    const id = String(++this.n);
    const p = new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error("not connected to T3 (" + this.state + ")"));
      this.pending.set(id, { resolve, reject, onValue });
      this.ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
    p.id = id;
    return p;
  }
  _subscribe(w) {
    w.msgs.clear();
    const p = (w.req = this.request("orchestration.subscribeThread", { threadId: w.threadId }, (v) => applyThread(w.msgs, v) && w.onChange([...w.msgs.values()])));
    p.then(
      () => {
        // The server ended the stream on its own: subscribe again while someone still watches.
        this.emit("log", "thread subscription ended: " + w.threadId);
        if (this.watches.has(w) && w.req === p) setTimeout(() => this.watches.has(w) && w.req === p && this._subscribe(w), 500);
      },
      (e) => e.message !== "connection lost" && this.emit("log", "thread subscription: " + e.message)
    );
  }
  // Live messages of one thread: onChange(messages) on the snapshot and on every change, until the
  // returned function is called. Survives reconnects (re-subscribed with a fresh snapshot).
  watch(threadId, onChange) {
    const w = { threadId, onChange, msgs: new Map() };
    this.watches.add(w);
    if (this.ws && this.ws.readyState === 1) this._subscribe(w);
    return () => {
      this.watches.delete(w);
      const id = w.req && w.req.id;
      if (!id || !this.pending.delete(id)) return;
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ _tag: "Interrupt", requestId: id, interruptors: [] }));
    };
  }
  // Fire one orchestration command, e.g. command("thread.stop", { threadId }).
  command(type, fields) {
    return this.request("orchestration.dispatchCommand", { type, commandId: crypto.randomUUID(), ...fields });
  }
  // Send as the user (the CLI's send is stored as an agent message). A busy thread gets it as its next turn.
  // fresh: start a new provider session (the app's /clear); earlier messages stay visible.
  send(threadId, text, fresh) {
    const t = this.threads.get(threadId);
    const busy = t && (t.activityRunStatus === "running" || !!t.activeRunId);
    return this.command("message.dispatch", {
      threadId,
      messageId: crypto.randomUUID(),
      createdBy: "user",
      creationSource: "web",
      text,
      attachments: [],
      ...(fresh ? { freshContext: true } : {}),
      dispatchMode: { type: busy ? "queue_after_active" : "start_immediately" },
    });
  }
  // New thread in the project of `folder` with `text` as its first message. Model and modes come from
  // the project default, else the project's newest thread. Resolves with the new thread id.
  // ponytail: a folder that is not a T3 project yet is refused; add the project in the app first.
  async launch(folder, text) {
    const project = [...this.projects.values()].find((p) => p.workspaceRoot === folder);
    if (!project) throw new Error("this folder is not a T3 Code project yet; add it in the app first");
    const last = [...this.threads.values()]
      .filter((t) => t.projectId === project.id && !(t.lineage && t.lineage.parentThreadId))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    const modelSelection = project.defaultModelSelection || (last && last.modelSelection);
    if (!modelSelection) throw new Error("no model to start with; start one thread in the app first");
    const r = await this.request("orchestration.launchThread", {
      commandId: crypto.randomUUID(),
      creationSource: "web",
      projectId: project.id,
      title: text.trim().split("\n")[0].slice(0, 80) || "New thread",
      generateTitle: true,
      modelSelection,
      runtimeMode: (last && last.runtimeMode) || "full-access",
      interactionMode: (last && last.interactionMode) || "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: crypto.randomUUID(), text, attachments: [] },
    });
    return r.threadId;
  }
  stopThread(threadId) {
    return this.command("thread.stop", { threadId });
  }
  settleThread(threadId) {
    return this.command("thread.settle", { threadId });
  }
  getConfig() {
    return this.request("server.getConfig", {});
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

module.exports = { T3Client, toCli, applyShell, applyThread, exchangeForm, backoff, SCOPES };
