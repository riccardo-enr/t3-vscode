// Self-check for t3Client.js pure helpers. Run: node test/t3client_check.js
const assert = require("assert");
const { T3Client, toCli, applyShell, applyThread, exchangeForm, backoff, SCOPES } = require("../t3Client.js");

const th = (id, o = {}) => ({ id, projectId: "p", title: id, status: "idle", activityRunStatus: null, modelSelection: { model: "m", options: [{ id: "effort", value: "high" }] },
  lineage: { parentThreadId: null }, settledAt: null, snoozedUntil: null, pinnedAt: null, pendingRuntimeRequest: null, ...o });

assert.strictEqual(toCli(th("a", { status: "queued", activityRunStatus: "running" }), "E").status, "running");
assert.strictEqual(toCli(th("a", { pendingRuntimeRequest: { id: 1 } })).status, "waiting");
assert.strictEqual(toCli(th("a")).effort, "high");
assert.strictEqual(toCli(th("a/b"), "E").link, "https://app.t3.codes/threads/E/a%2Fb");
assert.strictEqual(toCli(th("a", { settledAt: "x" })).settled, true);
assert.strictEqual(toCli(th("a", { snoozedUntil: "2000-01-01T00:00:00Z" }), "E", Date.parse("2001-01-01")).snoozed, false);

const s = { threads: new Map(), projects: new Map() };
applyShell(s, { kind: "snapshot", snapshot: { threads: [th("a"), th("b")], projects: [] } });
applyShell(s, { kind: "snapshot", snapshot: { threads: [], projects: [{ id: "p", workspaceRoot: "/x" }] } }); // chunks merge
assert.deepStrictEqual([...s.threads.keys()], ["a", "b"]);
assert.strictEqual(s.projects.size, 1);
applyShell(s, { kind: "thread.updated", location: "active", thread: th("a", { title: "new" }) });
assert.strictEqual(s.threads.get("a").title, "new");
applyShell(s, { kind: "thread.updated", location: "archived", thread: th("b") });
applyShell(s, { kind: "thread.removed", threadId: "a" });
assert.strictEqual(s.threads.size, 0);
assert.strictEqual(applyShell(s, { kind: "other" }), false);

assert.deepStrictEqual([0, 1, 2, 5, 9].map(backoff), [1000, 2000, 4000, 30000, 30000]);

// send: freshContext (the app's /clear) only when asked; a busy thread queues.
{
  const c = Object.create(T3Client.prototype);
  c.threads = new Map([["a", th("a", { activityRunStatus: "running" })]]);
  c.request = (_, p) => p;
  assert.strictEqual("freshContext" in c.send("a", "hi"), false);
  const p = c.send("a", "hi", true);
  assert.strictEqual(p.freshContext, true);
  assert.strictEqual(p.createdBy, "user");
  assert.strictEqual(p.dispatchMode.type, "queue_after_active");
}

// Thread messages: the snapshot replaces, message.updated upserts by id (streamed text grows in place).
{
  const m = new Map();
  applyThread(m, { kind: "snapshot", projection: { messages: [{ id: "u1", role: "user", text: "hi" }] } });
  assert(applyThread(m, { kind: "event", event: { type: "message.updated", payload: { id: "a1", role: "assistant", text: "po" } } }));
  applyThread(m, { kind: "event", event: { type: "message.updated", payload: { id: "a1", role: "assistant", text: "pong" } } });
  assert.deepStrictEqual([...m.values()].map((x) => x.text), ["hi", "pong"]);
  assert.strictEqual(applyThread(m, { kind: "event", event: { type: "run.updated", payload: {} } }), false);
  applyThread(m, { kind: "snapshot", projection: { messages: [] } });
  assert.strictEqual(m.size, 0);
}

// Pairing form: token exchange of the code, with exactly our scopes.
{
  const f = new URLSearchParams(exchangeForm("  ABCD1234EFGH \n"));
  assert.strictEqual(f.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
  assert.strictEqual(f.get("subject_token"), "ABCD1234EFGH");
  assert.strictEqual(f.get("subject_token_type"), "urn:t3:params:oauth:token-type:environment-bootstrap");
  assert.strictEqual(f.get("scope"), SCOPES.join(" "));
}

// Connection states: no saved login -> unpaired; a login the server refuses (401) -> forgotten, unpaired.
(async () => {
  const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3home-"));
  const old = process.env.T3CODE_HOME;
  process.env.T3CODE_HOME = home;
  const srv = http.createServer((q, r) => r.writeHead(q.url === "/api/auth/websocket-ticket" ? 401 : 404).end()).listen(0);
  await new Promise((r) => srv.once("listening", r));
  fs.mkdirSync(path.join(home, "userdata"));
  fs.writeFileSync(path.join(home, "userdata", "server-runtime.json"), JSON.stringify({ origin: "http://127.0.0.1:" + srv.address().port, serverVersion: "test" }));
  const settle = (c) => new Promise((r) => c.once("state", (s) => r(s)));

  let tok;
  const c1 = new T3Client({ get: async () => tok, set: async (t) => (tok = t), delete: async () => (tok = undefined) });
  c1.start();
  assert.strictEqual(await settle(c1), "unpaired");

  tok = "revoked";
  const c2 = new T3Client({ get: async () => tok, set: async (t) => (tok = t), delete: async () => (tok = undefined) });
  c2.start();
  assert.strictEqual(await settle(c2), "unpaired");
  assert.strictEqual(tok, undefined);

  srv.close();
  fs.rmSync(home, { recursive: true });
  if (old === undefined) delete process.env.T3CODE_HOME;
  else process.env.T3CODE_HOME = old;
  console.log("t3client_check ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
