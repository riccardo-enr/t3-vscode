// Dashboard data: sort threads by how much they need the user. No `vscode` import (test/dashboard_check.js loads it).
const RANK = { waiting: 0, running: 1, failed: 2, error: 2 }; // everything else: 3
const rank = (t) => (t.status in RANK ? RANK[t.status] : 3);
const byUrgency = (a, b) => a.rank - b.rank || String(b.updatedAt).localeCompare(String(a.updatedAt));

// list (CLI-shaped threads) -> { counts, cards }. A parent takes the most urgent rank of itself and its children.
// A child whose parent is not in the list shows as a top-level card.
function board(list) {
  const ids = new Set(list.map((t) => t.threadId));
  const kids = new Map();
  for (const t of list) {
    if (t.parentThreadId && ids.has(t.parentThreadId)) kids.set(t.parentThreadId, [...(kids.get(t.parentThreadId) || []), t]);
  }
  const card = (t) => ({ ...t, rank: rank(t) });
  const cards = list
    .filter((t) => !t.parentThreadId || !ids.has(t.parentThreadId))
    .map((t) => {
      const children = (kids.get(t.threadId) || []).map(card).sort(byUrgency);
      return { ...card(t), children, rank: Math.min(rank(t), ...children.map((c) => c.rank)) };
    })
    .sort(byUrgency);
  const n = (s) => list.filter((t) => s.includes(t.status)).length;
  return { counts: { waiting: n(["waiting"]), running: n(["running"]), failed: n(["failed", "error"]) }, cards };
}

module.exports = { board };
