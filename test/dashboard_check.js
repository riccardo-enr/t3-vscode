// Self-check for dashboard.js board(). Run: node test/dashboard_check.js
const assert = require("assert");
const { board } = require("../dashboard.js");
const t = (id, status, o = {}) => ({ threadId: id, status, updatedAt: "2026-01-01T00:00:00Z", ...o });

const b = board([t("done", "completed"), t("fail", "failed"), t("run", "running"), t("ask", "waiting"), t("idle", "idle")]);
assert.deepStrictEqual(b.cards.slice(0, 3).map((c) => c.threadId), ["ask", "run", "fail"]);
assert.deepStrictEqual(b.counts, { waiting: 1, running: 1, failed: 1 });

const c = board([t("parent", "completed"), t("kid", "waiting", { parentThreadId: "parent" }), t("other", "running"), t("orphan", "completed", { parentThreadId: "gone" })]);
assert.deepStrictEqual(c.cards.slice(0, 2).map((x) => x.threadId), ["parent", "other"]); // parent inherits the child's "waiting"
assert.strictEqual(c.cards[0].children[0].threadId, "kid");
assert.ok(c.cards.some((x) => x.threadId === "orphan")); // missing parent: top level
assert.strictEqual(c.cards.length, 3);
console.log("dashboard_check ok");
