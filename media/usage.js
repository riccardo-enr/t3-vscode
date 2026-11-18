// Usage panel. The extension host sends {kind:"data"|"error"|"loading"}; this only draws it.
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const usd = (n) => "$" + n.toFixed(n >= 100 ? 0 : 2);
const tok = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function draw(d) {
  const tiles = $("tiles");
  tiles.replaceChildren();
  for (const [label, val] of [["Cost", usd(d.cost)], ["Tokens", tok(d.tokens)], ["Cache savings", usd(d.saved)]]) {
    const t = el("div", "tile");
    t.append(el("div", "v", val), el("div", "l", label));
    tiles.append(t);
  }
  const max = Math.max(...d.days.map((x) => x.cost), 0.01);
  const chart = $("chart");
  chart.replaceChildren();
  for (const x of d.days) {
    const col = el("div", "col");
    col.title = x.day + ": " + usd(x.cost);
    const bar = el("div", "bar");
    bar.style.height = (x.cost / max) * 100 + "%";
    col.append(bar, el("div", "d", x.day.slice(5)));
    chart.append(col);
  }
  const rows = $("rows");
  rows.replaceChildren();
  for (const m of d.models) {
    const r = el("tr");
    const cost = el("td", "n", m.unpriced >= m.tokens ? "unpriced" : usd(m.cost));
    if (m.unpriced && m.unpriced < m.tokens) cost.title = tok(m.unpriced) + " tokens have no price";
    r.append(el("td", "", m.model), el("td", "dim", m.provider), el("td", "n", tok(m.tokens)), cost);
    rows.append(r);
  }
  $("note").textContent = d.unpriced ? tok(d.unpriced) + " tokens have no price and are not in the cost." : "";
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
    $("r" + m.days).checked = true;
    draw(m.data);
  }
});

for (const n of [7, 30]) $("r" + n).addEventListener("change", () => vscode.postMessage({ days: n }));
$("refresh").addEventListener("click", () => vscode.postMessage({ days: document.querySelector("input:checked").value | 0 }));
vscode.postMessage({ ready: true });
