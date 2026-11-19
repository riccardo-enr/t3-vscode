// Usage panel. The extension host sends {kind:"data"|"error"|"loading"}; this only draws it.
// Tab and provider changes redraw from the last data; the range and Refresh ask the host again.
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const usd = (n) => "$" + n.toFixed(n >= 100 ? 0 : 2);
const tok = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
const fmt = { cost: usd, tokens: tok };
const left = (ms) => {
  const m = Math.max(0, Math.round(ms / 6e4));
  return m >= 1440 ? Math.floor(m / 1440) + "d " + Math.floor((m % 1440) / 60) + "h" : m >= 60 ? Math.floor(m / 60) + "h " + (m % 60) + "m" : m + "m";
};

let data, days = 7;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const tab = () => document.querySelector("#tabs input:checked").value;

function drawUsage(a, metric) {
  const tiles = $("tiles");
  tiles.replaceChildren();
  for (const [label, val] of [["Cost", usd(a.cost)], ["Tokens", tok(a.tokens)], ["Cache savings", usd(a.saved)]]) {
    const t = el("div", "tile");
    t.append(el("div", "v", val), el("div", "l", label));
    tiles.append(t);
  }
  const f = fmt[metric];
  const max = Math.max(...a.days.map((x) => x[metric]), 0.01);
  const chart = $("chart");
  chart.replaceChildren();
  for (const x of a.days) {
    const col = el("div", "col");
    col.title = x.day + ": " + f(x[metric]);
    const bar = el("div", "bar");
    bar.style.height = (x[metric] / max) * 100 + "%";
    col.append(bar, el("div", "d", x.day.slice(5)));
    chart.append(col);
  }
  $("mh").textContent = metric === "cost" ? "Cost" : "Tokens";
  const rows = $("rows");
  rows.replaceChildren();
  for (const m of [...a.models].sort((p, q) => q[metric] - p[metric])) {
    const r = el("tr");
    const unp = metric === "cost" && m.unpriced >= m.tokens;
    const cell = el("td", "n", unp ? "unpriced" : f(m[metric]));
    if (metric === "cost" && m.unpriced && !unp) cell.title = tok(m.unpriced) + " tokens have no price";
    r.append(el("td", "", m.model), el("td", "dim", m.provider), cell);
    rows.append(r);
  }
  $("note").textContent = metric === "cost" && a.unpriced ? tok(a.unpriced) + " tokens have no price and are not in the cost." : "";
}

function drawLimits(limits) {
  const box = $("limits");
  box.replaceChildren();
  if (!limits.length) box.append(el("div", "dim", "No provider reports usage limits."));
  const now = Date.now();
  for (const p of limits) {
    const h = el("h2", "", p.name);
    box.append(h);
    for (const w of p.windows) {
      const card = el("div", "card");
      const l = el("div", "lab");
      l.append(el("div", "", w.label), el("div", "big", Math.round(w.left) + "%"), el("span", "dim", "left"));
      const track = el("div", "track");
      const fill = el("div", "fill " + (p.driver === "claudeAgent" ? "claude" : "other"));
      fill.style.width = w.left + "%";
      track.append(fill);
      let chip = "";
      if (w.resetsAt) {
        const ms = Date.parse(w.resetsAt) - now;
        chip = "resets in " + left(ms);
        if (w.durationMins) {
          // The fill shows quota left, so the tick shows time left: where the fill would end at an even pace.
          // A fill ending right of the tick means you are under pace.
          const tick = el("div", "tick");
          tick.style.left = Math.min(100, Math.max(0, (ms / (w.durationMins * 6e4)) * 100)) + "%";
          track.append(tick);
        }
      }
      if (chip) track.append(el("span", "chip", chip));
      card.append(l, track);
      box.append(card);
    }
  }
}

function render() {
  if (!data) return;
  const t = tab();
  $("usage").hidden = t === "limits";
  $("limits").hidden = t !== "limits";
  $("range").hidden = t === "limits";
  $("prov").hidden = t === "limits";
  if (t === "limits") drawLimits(data.limits);
  else drawUsage(data.by[$("prov").value] || data.by.all, t);
}

function show(msg, err) {
  const s = $("st");
  s.textContent = msg;
  s.className = err ? "err" : "";
}

window.addEventListener("message", (e) => {
  const m = e.data;
  if (m.kind === "loading") show("Scanning usage...");
  else if (m.kind === "error") show(m.message, true);
  else if (m.kind === "data") {
    show("");
    days = m.days;
    $("r" + days).checked = true;
    data = m.data;
    const sel = $("prov"), keep = sel.value;
    sel.replaceChildren(new Option("All providers", "all"), ...data.providers.map((p) => new Option(p, p)));
    sel.value = data.by[keep] ? keep : "all";
    render();
  }
});

for (const n of [7, 30]) $("r" + n).addEventListener("change", () => vscode.postMessage({ days: n }));
for (const i of document.querySelectorAll("#tabs input")) i.addEventListener("change", render);
$("prov").addEventListener("change", render);
$("refresh").addEventListener("click", () => vscode.postMessage({ days }));
vscode.postMessage({ ready: true });
