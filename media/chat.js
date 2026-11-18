// Chat webview for the T3 Code sidebar. All message text is escaped before any HTML is built.
const vs = acquireVsCodeApi();
const log = document.getElementById("log");
const st = document.getElementById("st");
const work = document.getElementById("work");
const t = document.getElementById("t");
const btn = document.getElementById("b");
const modelEl = document.getElementById("model");

// "claude-opus-5-5" -> "Opus 5.5"; anything else is shown as is.
function prettyModel(id) {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id || "");
  return m ? m[1][0].toUpperCase() + m[1].slice(1) + " " + m[2] + "." + m[3] : id || "unknown model";
}

function el(tag, cls, txt) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}

// ---- minimal markdown: fenced code, headings, lists, paragraphs, `code`, **bold**, [text](https://...) ----
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// A code span that looks like a file path (has an extension, optional :line[:col]) becomes a link that opens in VS Code.
const PATHLIKE = /^(~|\.{0,2}\/)?[\w@.+-]+(\/[\w@.+-]+)*\.[A-Za-z][A-Za-z0-9]*(:\d+){0,2}$/;
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => "\u0000" + (codes.push(c) - 1) + "\u0000");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (all, label, target) => {
    if (/^https?:\/\//.test(target)) return `<a data-url="${target}">${label}</a>`;
    if (/^(\/|~\/|file:\/\/)/.test(target)) return `<a data-file="${target}">${label}</a>`;
    return all; // unknown scheme (javascript:, t3-*, ...): leave as text
  });
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const c = codes[i];
    return PATHLIKE.test(c) ? `<a data-file="${c}"><code>${c}</code></a>` : "<code>" + c + "</code>";
  });
}
function md(src) {
  const out = [], lines = src.split("\n");
  let i = 0, para = [], list = null;
  const flushP = () => { if (para.length) out.push("<p>" + inline(esc(para.join("\n"))) + "</p>"); para = []; };
  const flushL = () => {
    if (list) out.push(`<${list.t}>` + list.items.map((x) => "<li>" + inline(esc(x)) + "</li>").join("") + `</${list.t}>`);
    list = null;
  };
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (/^\s*```/.test(l)) {
      flushP(); flushL();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>");
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) {
      flushP(); flushL();
      const h = Math.min(m[1].length, 4);
      out.push(`<h${h}>` + inline(esc(m[2])) + `</h${h}>`);
      i++;
    } else if ((m = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(l))) {
      flushP();
      const kind = /\d/.test(m[1]) ? "ol" : "ul";
      if (list && list.t !== kind) flushL();
      if (!list) list = { t: kind, items: [] };
      list.items.push(m[2]);
      i++;
    } else if (!l.trim()) {
      flushP(); flushL();
      i++;
    } else if (list && /^\s+\S/.test(l)) {
      list.items[list.items.length - 1] += " " + l.trim(); // indented continuation of a list item
      i++;
    } else {
      flushL();
      para.push(l);
      i++;
    }
  }
  flushP(); flushL();
  return out.join("");
}

// ---- citations and attachments ----
// T3 inlines citations as [label](t3-citation://v1/env/thread/msg?text=..&comment=..) and images as ![name](t3-context://v1/image/id).
const RE = /(!?)\[([^\]]*)\]\((t3-(?:citation|context):\/\/[^)\s]+)\)/g;
function jump(q) {
  const key = q.trim().slice(0, 80);
  if (!key) return;
  const hit = [...log.children].find((n) => n.classList.contains("assistant") && n._t.includes(key));
  if (!hit) return;
  hit.scrollIntoView({ block: "center" });
  hit.classList.add("flash");
  setTimeout(() => hit.classList.remove("flash"), 1500);
}
function body(text) {
  const b = el("div");
  let i = 0, m;
  const put = (s) => {
    if (!s.trim()) return;
    const d = el("div", "md");
    d.innerHTML = md(s.replace(/^\s*\n/, "").replace(/\n\s*$/, "")); // md() escapes everything it emits
    b.append(d);
  };
  RE.lastIndex = 0;
  while ((m = RE.exec(text))) {
    put(text.slice(i, m.index));
    i = RE.lastIndex;
    if (m[3].startsWith("t3-context")) {
      b.append(el("span", "chip", "image: " + m[2]));
      continue;
    }
    const p = new URLSearchParams(m[3].split("?")[1] || "");
    const q = p.get("text") || "", c = p.get("comment");
    const card = el("div", "cite"), h = el("div", "h", m[2] || "Quote"), a = el("a", null, "jump");
    a.onclick = () => jump(q);
    h.append(a);
    const qt = el("div", "q", q.trim());
    qt.onclick = () => card.classList.toggle("open");
    card.append(h, qt);
    b.append(card);
    if (c) put(c);
  }
  put(text.slice(i));
  return b;
}

// ---- rendering: only changed messages are rebuilt, so selections survive polling ----
let shown = [], thread = "";
function node(m, pending) {
  const n = el("div", "m " + m.role + (pending ? " pending" : ""));
  n._t = m.text || "";
  n.append(el("div", "r", m.role === "user" ? "You" : "Assistant"), body(n._t));
  return n;
}
function render(d) {
  if (d.threadId !== thread) { thread = d.threadId; shown = []; log.replaceChildren(); }
  const bottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
  d.messages.forEach((m, i) => {
    const key = m.role + "\u0001" + m.text;
    if (shown[i] === key) return;
    const n = node(m);
    if (log.children[i]) log.replaceChild(n, log.children[i]);
    else log.append(n);
    shown[i] = key;
  });
  while (log.children.length > d.messages.length) log.lastChild.remove();
  shown.length = d.messages.length;
  st.className = "";
  st.textContent = d.status;
  modelEl.textContent = prettyModel(d.model);
  modelEl.title = d.model || "";
  work.classList.toggle("on", d.status === "running");
  if (bottom || d.jump) log.scrollTop = log.scrollHeight;
}

// ---- composer ----
function grow() {
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 200) + "px";
}
function lock(on) {
  t.disabled = on;
  btn.disabled = on;
}
function send() {
  const x = t.value.trim();
  if (!x || btn.disabled) return;
  lock(true);
  vs.postMessage({ text: x });
}
// Links never navigate the webview: the extension opens files in an editor and web links in the browser.
log.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a[data-file],a[data-url]");
  if (!a) return;
  e.preventDefault();
  vs.postMessage(a.dataset.file ? { open: a.dataset.file } : { url: a.dataset.url });
});
btn.onclick = send;
t.oninput = grow;
t.onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
};

addEventListener("message", (e) => {
  const d = e.data;
  if (d.error) { st.className = "err"; st.textContent = "error: " + d.error; return; }
  if (d.empty) { st.className = ""; st.textContent = "Click a thread above to show its chat."; return; }
  if (d.sent) {
    log.append(node({ role: "user", text: t.value.trim() }, true)); // shown until the next poll brings the real one
    log.scrollTop = log.scrollHeight;
    t.value = "";
    grow();
    lock(false);
    t.focus();
    return;
  }
  if (d.sendError) { lock(false); st.className = "err"; st.textContent = "not sent: " + d.sendError; return; }
  if (d.messages) render(d);
});
