// Usage data for the dashboard panel. No `vscode` import, so test/usage_check.js can load it.
// Talks to the running T3 server the way the desktop dashboard does: a 5-minute read-only token from
// the CLI, a one-time websocket ticket, then RPCs over one /ws connection:
//   server.getUsageSummary (cost and tokens) and server.getConfig (provider limits).
// ponytail: internal API (contractVersion 6); if T3 changes it the panel shows the error, update then.
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const day = (d) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD in the local zone
const NAMES = { claudeAgent: "Claude", claude: "Claude", codex: "Codex", opencode: "OpenCode", antigravity: "Antigravity", cursor: "Cursor", grok: "Grok", pi: "Pi", muse: "Muse" };

function origin() {
  const home = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
  return JSON.parse(fs.readFileSync(path.join(home, "userdata", "server-runtime.json"), "utf8")).origin;
}

function token() {
  return new Promise((resolve, reject) => {
    execFile(
      "t3",
      ["auth", "session", "issue", "--scope", "diagnostics:read", "--scope", "orchestration:read", "--ttl", "5m", "--label", "vscode-usage", "--token-only"],
      { timeout: 15000 },
      (err, out, stderr) => {
        if (err) return reject(new Error(err.code === "ENOENT" ? "t3 not found on PATH" : (stderr || err.message).trim()));
        resolve(out.trim().split("\n").pop()); // the CLI may print shell noise first; the token is last
      }
    );
  });
}

// Resolves with {summary, config, since, until}.
async function fetchUsage(days) {
  const base = origin();
  const res = await fetch(base + "/api/auth/websocket-ticket", {
    method: "POST",
    headers: { authorization: "Bearer " + (await token()), "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error("T3 refused the ticket request (" + res.status + ")");
  const { ticket } = await res.json();
  const until = new Date();
  const since = new Date(until.getTime() - (days - 1) * 864e5);
  const summaryIn = {
    sinceDay: day(since),
    untilDay: day(until),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    awaitRefresh: true,
  };
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + `/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`);
    const out = { since: summaryIn.sinceDay, until: summaryIn.untilDay };
    const timer = setTimeout(() => (ws.close(), reject(new Error("usage scan timed out"))), 90000);
    const fail = (e) => (clearTimeout(timer), ws.close(), reject(e));
    ws.onopen = () => {
      const send = (id, tag, payload) => ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      send("1", "server.getUsageSummary", summaryIn);
      send("2", "server.getConfig", {});
    };
    ws.onerror = () => fail(new Error("could not connect to the T3 server"));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m._tag !== "Exit") return;
      if (m.exit._tag !== "Success") return fail(new Error("usage read failed: " + JSON.stringify(m.exit.cause || m.exit).slice(0, 200)));
      out[m.requestId === "1" ? "summary" : "config"] = m.exit.value;
      if (out.summary && out.config) (clearTimeout(timer), ws.close(), resolve(out));
    };
  });
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
