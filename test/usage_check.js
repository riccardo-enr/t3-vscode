// Self-check for usage.js summarize(). Run: node test/usage_check.js
const assert = require("assert");
const { summarize } = require("../usage.js");

const t = (u, c, o) => ({ uncachedInputTokens: u, cachedInputTokens: c, cacheCreationTokens: 0, outputTokens: o, reasoningTokens: 0 });
const r = summarize({
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
assert.deepStrictEqual(r.days, [{ day: "2026-11-16", cost: 2 }, { day: "2026-11-17", cost: 0 }, { day: "2026-11-18", cost: 0 }]);
assert.strictEqual(r.cost, 2);
assert.strictEqual(r.saved, 3);
assert.strictEqual(r.tokens, 137);
assert.strictEqual(r.unpriced, 100);
assert.deepStrictEqual(r.models.map((m) => m.provider + "/" + m.model), ["claude/a", "claude/b", "codex/a"]);
console.log("usage_check ok");
