// Usage data for the dashboard panel. No `vscode` import, so test/usage_check.js can load it.
// Talks to the running T3 server the way the desktop dashboard does: a 5-minute read-only token from
// the CLI, a one-time websocket ticket, then one `server.getUsageSummary` RPC over /ws.
// ponytail: internal API (contractVersion 6); if T3 changes it the panel shows the error, update then.
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const day = (d) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD in the local zone

function origin() {
  const home = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
  const rt = JSON.parse(fs.readFileSync(path.join(home, "userdata", "server-runtime.json"), "utf8"));
  return rt.origin;
}

function token() {
  return new Promise((resolve, reject) => {
    execFile(
      "t3",
      ["auth", "session", "issue", "--scope", "diagnostics:read", "--ttl", "5m", "--label", "vscode-usage", "--token-only"],
      { timeout: 15000 },
      (err, out, stderr) => {
        if (err) return reject(new Error(err.code === "ENOENT" ? "t3 not found on PATH" : (stderr || err.message).trim()));
        resolve(out.trim().split("\n").pop()); // the CLI may print shell noise first; the token is last
      }
    );
  });
}

async function fetchSummary(days) {
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
  const payload = {
    sinceDay: day(since),
    untilDay: day(until),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    awaitRefresh: true,
  };
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + `/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`);
    const timer = setTimeout(() => (ws.close(), reject(new Error("usage scan timed out"))), 90000);
    const done = (fn, v) => (clearTimeout(timer), ws.close(), fn(v));
    ws.onopen = () => ws.send(JSON.stringify({ _tag: "Request", id: "1", tag: "server.getUsageSummary", payload, headers: [] }));
    ws.onerror = () => done(reject, new Error("could not connect to the T3 server"));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m._tag !== "Exit") return;
      if (m.exit._tag === "Success") return done(resolve, { summary: m.exit.value, since: payload.sinceDay, until: payload.untilDay });
      done(reject, new Error("usage read failed: " + JSON.stringify(m.exit.cause || m.exit).slice(0, 200)));
    };
  });
}

// Buckets -> what the panel draws. Every day in the window appears, even with no spend.
function summarize({ summary, since, until }) {
  const days = new Map();
  for (let t = new Date(since + "T12:00:00"); day(t) <= until; t = new Date(t.getTime() + 864e5)) days.set(day(t), 0);
  const models = new Map();
  let cost = 0, saved = 0, tokens = 0, unpriced = 0;
  for (const b of summary.buckets) {
    const n = b.totals.uncachedInputTokens + b.totals.cachedInputTokens + b.totals.cacheCreationTokens + b.totals.outputTokens;
    cost += b.costUsd; saved += b.cacheSavingsUsd; tokens += n; unpriced += b.unpricedTokens || 0;
    days.set(b.day, (days.get(b.day) || 0) + b.costUsd);
    const k = b.provider + "/" + b.model;
    const m = models.get(k) || { provider: b.provider, model: b.model, cost: 0, tokens: 0, unpriced: 0 };
    m.cost += b.costUsd; m.tokens += n; m.unpriced += b.unpricedTokens || 0;
    models.set(k, m);
  }
  return {
    cost, saved, tokens, unpriced,
    days: [...days].map(([d, c]) => ({ day: d, cost: c })),
    models: [...models.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
  };
}

module.exports = { fetchSummary, summarize };
