// Self-check for usage.js summarize(). Run: node test/usage_check.js
const assert = require("assert");
const { summarize } = require("../usage.js");

const t = (u, c, o) => ({ uncachedInputTokens: u, cachedInputTokens: c, cacheCreationTokens: 0, outputTokens: o, reasoningTokens: 0 });
const out = summarize({
  config: { providers: [
    { driver: "claudeAgent", enabled: true, usageLimits: { windows: [{ label: "Session", kind: "session", usedPercent: 27, windowDurationMins: 300 }] } },
    { driver: "opencode", enabled: true, usageLimits: { windows: [] } },
    { driver: "cursor", enabled: false, usageLimits: null },
  ] },
  since: "2026-11-16",
  until: "2026-11-18",
  summary: {
    buckets: [
      { day: "2026-11-16", provider: "claude", model: "a", totals: t(10, 20, 5), costUsd: 1.5, cacheSavingsUsd: 3 },
      { day: "2026-11-16", provider: "claude", model: "b", totals: t(1, 0, 1), costUsd: 0.5, cacheSavingsUsd: 0 },
      { day: "2026-11-18", provider: "codex", model: "a", totals: t(100, 0, 0), costUsd: 0, cacheSavingsUsd: 0, unpricedTokens: 100 },
    ],
  },
});
const r = out.by.all;
assert.deepStrictEqual(r.days.map((d) => [d.day, d.cost, d.tokens]), [["2026-11-16", 2, 37], ["2026-11-17", 0, 0], ["2026-11-18", 0, 100]]);
assert.strictEqual(r.cost, 2);
assert.strictEqual(r.saved, 3);
assert.strictEqual(r.tokens, 137);
assert.strictEqual(r.unpriced, 100);
assert.deepStrictEqual(r.models.map((m) => m.provider + "/" + m.model), ["claude/a", "claude/b", "codex/a"]);
assert.deepStrictEqual(out.providers, ["claude", "codex"]);
assert.strictEqual(out.by.claude.cost, 2);
assert.strictEqual(out.by.codex.tokens, 100);
assert.deepStrictEqual(out.limits, [{ name: "Claude", driver: "claudeAgent", windows: [{ label: "Session", kind: "session", left: 73, resetsAt: undefined, durationMins: 300 }] }]);
console.log("usage_check ok");
