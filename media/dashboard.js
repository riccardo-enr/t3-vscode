// Agent dashboard webview. All server text goes in through textContent, never innerHTML.
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const btn = (label, msg, id, confirm) => {
  const b = el("button", "", label);
  b.onclick = () => vscode.postMessage({ act: msg, id, confirm });
  return b;
};

function card(c, kid) {
  const d = el("div", "card r" + c.rank + (kid ? " kid" : ""));
  const top = el("div", "top");
  const title = el("span", "title", c.title);
  title.title = c.title;
  title.tabIndex = 0;
  title.onclick = () => vscode.postMessage({ act: "chat", id: c.id });
  title.onkeydown = (e) => e.key === "Enter" && title.click();
  top.append(title, el("span", "badge", c.ask ? "waiting for you" : c.status));
  const meta = el("div", "meta dim", [c.model, c.effort, c.when, c.agents && c.agents + " agent" + (c.agents > 1 ? "s" : "")].filter(Boolean).join("  |  "));
  d.append(top, meta);
  if (c.snippet) {
    const s = el("div", "snip", c.snippet);
    s.title = c.snippet;
    d.append(s);
  }
  const acts = el("div", "acts");
  acts.append(btn("Open chat", "chat", c.id), btn("Open in app", "app", c.id), btn("Changes", "changes", c.id));
  if (c.live) acts.append(btn("Stop", "stop", c.id, true));
  if (c.status !== "running") acts.append(btn("Settle", "settle", c.id));
  d.append(acts);
  for (const k of c.children || []) d.append(card(k, true));
  return d;
}

addEventListener("message", (e) => {
  const m = e.data;
  $("st").textContent = m.error
    ? "Could not read threads: " + m.error
    : m.state === "connected" ? "" : "Not connected to the T3 server (" + m.state + "): using the CLI, updates once a minute.";
  if (!m.board) return;
  const c = $("counts");
  c.replaceChildren(
    ...[["Waiting", m.board.counts.waiting], ["Running", m.board.counts.running], ["Failed", m.board.counts.failed]].map(([l, v]) => {
      const t = el("div", "tile");
      t.append(el("div", "v", String(v)), el("div", "dim", l));
      return t;
    })
  );
  $("cards").replaceChildren(...(m.board.cards.length ? m.board.cards.map((x) => card(x)) : [el("div", "dim", "No open threads in this workspace.")]));
});
vscode.postMessage({ ready: true });
