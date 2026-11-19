// Self-check for t3Client.js pure helpers. Run: node test/t3client_check.js
const assert = require("assert");
const { toCli, applyShell, backoff } = require("../t3Client.js");

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
console.log("t3client_check ok");
