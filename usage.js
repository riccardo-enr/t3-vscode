// Usage data for the dashboard panel. No `vscode` import, so test/usage_check.js can load it.
// Two RPCs on the shared T3 connection (t3Client.js), the way the desktop dashboard reads them:
//   server.getUsageSummary (cost and tokens) and server.getConfig (provider limits).
// ponytail: internal API (contractVersion 6); if T3 changes it the panel shows the error, update then.
const day = (d) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD in the local zone
const NAMES = { claudeAgent: "Claude", claude: "Claude", codex: "Codex", opencode: "OpenCode", antigravity: "Antigravity", cursor: "Cursor", grok: "Grok", pi: "Pi", muse: "Muse" };

// Resolves with {summary, config, since, until}. client: a connected T3Client.
async function fetchUsage(client, days) {
  const until = new Date();
  const since = new Date(until.getTime() - (days - 1) * 864e5);
  const summaryIn = {
    sinceDay: day(since),
    untilDay: day(until),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    awaitRefresh: true,
  };
  let timer;
  const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("usage scan timed out")), 90000)));
  try {
    const [summary, config] = await Promise.race([
      Promise.all([client.request("server.getUsageSummary", summaryIn), client.request("server.getConfig", {})]),
      late,
    ]);
    return { summary, config, since: summaryIn.sinceDay, until: summaryIn.untilDay };
  } finally {
    clearTimeout(timer);
  }
}

// Aggregate buckets (optionally one provider). Every day in the window appears, even with no spend.
function aggregate(buckets, since, until, provider) {
  const days = new Map();
  for (let t = new Date(since + "T12:00:00"); day(t) <= until; t = new Date(t.getTime() + 864e5)) days.set(day(t), { cost: 0, tokens: 0 });
  const models = new Map();
  let cost = 0, saved = 0, tokens = 0, unpriced = 0;
  for (const b of buckets) {
    if (provider && b.provider !== provider) continue;
    const n = b.totals.uncachedInputTokens + b.totals.cachedInputTokens + b.totals.cacheCreationTokens + b.totals.outputTokens;
    cost += b.costUsd; saved += b.cacheSavingsUsd; tokens += n; unpriced += b.unpricedTokens || 0;
    const d = days.get(b.day) || { cost: 0, tokens: 0 };
    d.cost += b.costUsd; d.tokens += n;
    days.set(b.day, d);
    const k = b.provider + "/" + b.model;
    const m = models.get(k) || { provider: b.provider, model: b.model, cost: 0, tokens: 0, unpriced: 0 };
    m.cost += b.costUsd; m.tokens += n; m.unpriced += b.unpricedTokens || 0;
    models.set(k, m);
  }
  return {
    cost, saved, tokens, unpriced,
    days: [...days].map(([d, v]) => ({ day: d, ...v })),
    models: [...models.values()],
  };
}

// Raw reply -> what the panel draws: one aggregate per provider filter plus the limit windows.
function summarize({ summary, config, since, until }) {
  const providers = [...new Set(summary.buckets.map((b) => b.provider))].sort();
  const by = { all: aggregate(summary.buckets, since, until) };
  for (const p of providers) by[p] = aggregate(summary.buckets, since, until, p);
  const limits = ((config && config.providers) || [])
    .filter((p) => p.enabled && p.usageLimits && p.usageLimits.windows.length)
    .map((p) => ({
      name: NAMES[p.driver] || p.driver,
      driver: p.driver,
      windows: p.usageLimits.windows.map((w) => ({
        label: w.label, kind: w.kind, left: 100 - w.usedPercent, resetsAt: w.resetsAt, durationMins: w.windowDurationMins,
      })),
    }));
  return { providers, by, limits };
}

module.exports = { fetchUsage, summarize };
