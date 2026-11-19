// Chat webview for the T3 Code sidebar. All message text is escaped before any HTML is built.
const vs = acquireVsCodeApi();
const log = document.getElementById("log");
const st = document.getElementById("st");
const work = document.getElementById("work");
const ask = document.getElementById("ask");
ask.onclick = () => vs.postMessage({ openInApp: true });
const cardEl = document.getElementById("card");
let cardId = "", cardLock = () => {};
const t = document.getElementById("t");
const btn = document.getElementById("b");
const modelEl = document.getElementById("model");
const emptyEl = document.getElementById("empty");
const skel = document.getElementById("skel");
const emptyTxt = document.getElementById("emptytxt");
const ctxEl = document.getElementById("ctx");
const ctxL = document.getElementById("ctxl");

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
    if (/^(\/|~\/|file:\/\/)/.test(target) || PATHLIKE.test(target)) return `<a data-file="${target}">${label}</a>`;
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
    if ((m = /^\s*```\s*([\w+#.-]*)/.exec(l))) {
      flushP(); flushL();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(
        `<div class="code"><div class="ch"><span>${esc(m[1] || "text")}</span><button class="copy">Copy</button></div>` +
          "<pre><code>" + esc(code.join("\n")) + "</code></pre></div>"
      );
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
  let hit = [...log.children].find((n) => (n.classList.contains("assistant") || n.classList.contains("fold")) && n._t.includes(key));
  if (hit && hit.classList.contains("fold")) {
    if (!hit.classList.contains("open")) hit.firstChild.click();
    hit = [...hit.lastChild.children].find((n) => n._t.includes(key)) || hit;
  }
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

// ---- rendering: only changed items are rebuilt, so selections survive polling ----
// Each run shows its user message(s) and only its LAST assistant message. The run's earlier
// assistant messages (in-progress narration) fold into one {fold, runId} item just before it.
function collapse(msgs) {
  const last = new Map(), held = new Map(), out = [];
  msgs.forEach((m, i) => m.role === "assistant" && m.runId && last.set(m.runId, i));
  msgs.forEach((m, i) => {
    if (m.role !== "assistant" || !m.runId) return out.push(m);
    if (last.get(m.runId) !== i) return (held.get(m.runId) || held.set(m.runId, []).get(m.runId)).push(m);
    if (held.has(m.runId)) out.push({ fold: held.get(m.runId), runId: m.runId });
    out.push(m);
  });
  return out;
}
const PICK = "Pick a thread in the Threads view to see its chat here.";
// pend: the optimistic user bubble, kept after the real messages until a poll brings the real one.
// opened: runIds whose fold the user expanded; kept across polls.
let shown = [], count = 0, thread = "", pend = null, opened = new Set();
function node(m, pending) {
  const n = el("div", "m " + m.role + (pending ? " pending" : ""));
  n._t = m.text || "";
  n._id = m.id;
  n.setAttribute("aria-label", m.role === "user" ? "You" : "Assistant");
  n.append(body(n._t));
  return n;
}
// The folded messages are only built when first expanded.
function foldNode(f) {
  const k = f.fold.length;
  const n = el("div", "fold"), b = el("button", "ft", `${k} earlier update${k > 1 ? "s" : ""}`), inner = el("div", "fb");
  n._t = f.fold.map((m) => m.text || "").join("\n");
  const set = (on) => {
    if (on && !inner.children.length) inner.append(...f.fold.map((m) => node(m)));
    inner.hidden = !on;
    n.classList.toggle("open", on);
    b.setAttribute("aria-expanded", String(on));
    on ? opened.add(f.runId) : opened.delete(f.runId);
  };
  b.onclick = () => set(inner.hidden);
  n.append(b, inner);
  set(opened.has(f.runId));
  return n;
}
// Placeholders use the hidden attribute, so they stay correct even with a stale stylesheet.
function mode(m) {
  emptyEl.hidden = m !== "empty";
  skel.hidden = m !== "loading";
}
function switchTo(id) {
  if (id === thread) return;
  thread = id;
  shown = [];
  count = 0;
  pend = null;
  opened = new Set();
  log.replaceChildren();
}
// Card for a pending question or approval. All text goes in through textContent (agent text is untrusted).
// Returns {node, lock(on)}; the buttons post {answer}, {decide} or {dismiss} to the extension.
function askCard(a) {
  const node = el("div", "askcard"), ctl = [];
  const lock = (on) => ctl.forEach((c) => (c.disabled = on));
  const button = (label, fn) => {
    const b = el("button", "askbtn", label);
    b.onclick = fn;
    ctl.push(b);
    return b;
  };
  const fail = (m) => { st.className = "err"; st.textContent = m; };
  if (a.kind === "approval") {
    node.append(el("div", "qh", "Approval needed"));
    if (a.prompt) node.append(el("pre", "qq", a.prompt));
    if (a.reason) node.append(el("div", "qd", a.reason));
    const row = el("div", "qrow");
    for (const d of a.decisions)
      row.append(button(d === "accept" ? "Accept" : d === "decline" ? "Decline" : "Cancel", () => { lock(true); vs.postMessage({ decide: { requestId: a.id, decision: d } }); }));
    node.append(row);
    return { node, lock };
  }
  const reads = [];
  for (const q of a.questions) {
    const box = el("div", "q");
    box.append(el("div", "qh", q.header), el("div", "qq", q.question));
    const picks = [];
    for (const o of q.options) {
      const lab = el("label", "qo"), inp = el("input");
      inp.type = q.multiSelect ? "checkbox" : "radio";
      inp.name = q.id;
      ctl.push(inp);
      picks.push([inp, o.label]);
      lab.append(inp, el("span", "", o.label));
      if (o.description) lab.append(el("div", "qd", o.description));
      box.append(lab);
    }
    let other;
    if (q.allowCustomAnswer) {
      other = el("input", "qother");
      other.type = "text";
      other.placeholder = "Other answer";
      ctl.push(other);
      box.append(other);
    }
    reads.push(() => {
      const custom = other && other.value.trim();
      const v = picks.filter(([i]) => i.checked).map(([, l]) => l);
      return [q.id, custom ? (q.multiSelect ? v.concat(custom) : [custom]) : v];
    });
    node.append(box);
  }
  const row = el("div", "qrow");
  row.append(
    button("Submit", () => {
      const answers = {};
      for (const r of reads) { const [id, v] = r(); answers[id] = v; }
      if (Object.values(answers).some((v) => !v.length)) return fail("answer every question first");
      lock(true);
      vs.postMessage({ answer: { requestId: a.id, answers } });
    }),
    button("Skip", () => { lock(true); vs.postMessage({ dismiss: { requestId: a.id } }); })
  );
  node.append(row);
  return { node, lock };
}
function header(d) {
  st.className = "";
  st.dataset.s = d.status || "";
  st.textContent = d.status || "";
  modelEl.textContent = d.modelName || d.model || "";
  modelEl.title = (d.model || "") + " (click to change model or effort in the T3 Code app)";
  work.hidden = d.status !== "running";
  // d.ask: an object (question or approval with its text), 1 (waiting, text not fetched yet), or 0.
  const card = d.ask && typeof d.ask === "object" ? d.ask : null;
  ask.hidden = !d.ask || !!card;
  ask.textContent = d.ask && !card ? "Waiting for your answer. Click to answer in T3 Code" : "";
  cardEl.hidden = !card;
  if (!card) cardId = "";
  else if (card.id !== cardId) {
    cardId = card.id;
    const c = askCard(card);
    cardLock = c.lock;
    cardEl.replaceChildren(c.node);
  }
}
function render(d) {
  switchTo(d.threadId);
  if (pend) pend.node.remove();
  const bottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
  const items = collapse(d.messages);
  items.forEach((m, i) => {
    const key = m.fold ? "fold\u0001" + m.runId + "\u0001" + m.fold.length : m.role + "\u0001" + m.text;
    if (shown[i] === key) return;
    const n = m.fold ? foldNode(m) : node(m);
    if (log.children[i]) log.replaceChild(n, log.children[i]);
    else log.append(n);
    shown[i] = key;
  });
  while (log.children.length > items.length) log.lastChild.remove();
  shown.length = items.length;
  if (pend && d.messages.slice(pend.after).some((m) => m.role === "user")) pend = null;
  count = d.messages.length;
  if (pend) log.append(pend.node);
  if (!log.children.length) emptyTxt.textContent = "No messages yet. Write the first one below.";
  mode(log.children.length ? "" : "empty");
  header(d);
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
// The bubble shows at once; the text stays in the (locked) box until the extension confirms with {sent}.
function send() {
  const x = t.value.trim();
  if ((!x && !cites.length) || btn.disabled) return;
  if (thread && x[0] === "/" && runBuiltin(x.slice(1).toLowerCase())) return;
  lock(true);
  if (thread) {
    pend = { node: node({ role: "user", text: x || cites.map((c) => c.q.text.trim()).join("\n") }, true), after: count };
    log.append(pend.node);
    mode("");
    log.scrollTop = log.scrollHeight;
  }
  vs.postMessage({ cites: cites.map((c) => c.q), text: x, ctx: !ctxEl.hidden && !ctxEl.classList.contains("off") });
}
// Links never navigate the webview: the extension opens files in an editor and web links in the browser.
log.addEventListener("click", (e) => {
  const c = e.target.closest && e.target.closest("button.copy");
  if (c) {
    vs.postMessage({ copy: c.closest(".code").querySelector("code").textContent });
    c.textContent = "Copied";
    setTimeout(() => (c.textContent = "Copy"), 1200);
    return;
  }
  const a = e.target.closest && e.target.closest("a[data-file],a[data-url]");
  if (!a) return;
  e.preventDefault();
  vs.postMessage(a.dataset.file ? { open: a.dataset.file } : { url: a.dataset.url });
});

// ---- cite: select text in an assistant reply, click Cite, and it goes with the next message ----
const citesEl = document.getElementById("cites");
const cites = []; // { q: {id, text, start, prefix, suffix} }
const citeBtn = el("button", "citebtn", "Cite");
citeBtn.hidden = true;
document.body.append(citeBtn);
function drawCites() {
  citesEl.replaceChildren(...cites.map((c, i) => {
    const row = el("div", "cq"), x = el("button", null, "x");
    x.title = "Remove this quote";
    x.onclick = () => (cites.splice(i, 1), drawCites());
    row.append(el("span", null, c.q.text.trim() + (c.q.comment ? "\n> " + c.q.comment : "")), x);
    return row;
  }));
}
let pending = null;
document.addEventListener("selectionchange", () => {
  const s = getSelection(), r = s && s.rangeCount && !s.isCollapsed ? s.getRangeAt(0) : null;
  const a = r && (r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement);
  if (!pop.hidden) return; // typing a comment moves the selection into the box
  const m = a && a.closest(".m.assistant");
  const text = r ? s.toString() : "";
  if (!m || !m._id || !text.trim()) { pending = null; citeBtn.hidden = true; return; }
  const full = m._t, i = full.indexOf(text.trim());
  const start = Math.max(0, i), end = start + text.trim().length;
  pending = { id: m._id, text, start, prefix: i < 0 ? "" : full.slice(Math.max(0, start - 32), start), suffix: i < 0 ? "" : full.slice(end, end + 32) };
  const b = r.getBoundingClientRect();
  citeBtn.hidden = false;
  citeBtn.style.top = Math.max(4, b.top - 30) + "px";
  citeBtn.style.left = Math.max(4, Math.min(b.left, innerWidth - 60)) + "px";
});
citeBtn.onmousedown = (e) => e.preventDefault(); // keep the selection until the click lands
// Like the T3 app: Cite opens a box for an optional comment; Enter adds the quote, Escape cancels.
const pop = el("div", "citepop"), pin = el("textarea"), pok = el("button", null, "Cite"), pno = el("button", "ghost", "Cancel");
pop.hidden = true;
pin.rows = 2;
pin.placeholder = "Add an optional comment...";
pin.maxLength = 1000;
const pb = el("div", "pb");
pb.append(pno, pok);
pop.append(pin, pb);
document.body.append(pop);
let held = null;
function closePop() {
  pop.hidden = true;
  held = null;
}
citeBtn.onclick = () => {
  if (!pending) return;
  held = pending;
  pop.style.top = citeBtn.style.top;
  pop.style.left = citeBtn.style.left;
  pin.value = "";
  pop.hidden = false;
  citeBtn.hidden = true;
  pin.focus();
};
pok.onclick = () => {
  if (held) cites.push({ q: { ...held, comment: pin.value.trim() } });
  closePop();
  getSelection().removeAllRanges();
  drawCites();
  t.focus();
};
pno.onclick = closePop;
pin.onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), pok.onclick());
  else if (e.key === "Escape") closePop();
};
btn.onclick = send;
// The chip (active file and selection) is on by default; a click leaves it out until it changes.
function ctxOff(off) {
  ctxEl.classList.toggle("off", off);
  ctxEl.title = off ? "Not attached. Click to attach to the next message" : "Attached to the next message as a path reference. Click to leave it out";
}
ctxEl.onclick = () => ctxOff(!ctxEl.classList.contains("off"));
modelEl.onclick = () => vs.postMessage({ pickModel: true });
modelEl.onkeydown = (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    vs.postMessage({ pickModel: true });
  }
};
// ---- slash commands ----
// App commands send nothing: /clear opens a new thread, /model opens the picker.
// Provider commands (/compact, /review, skills) go through as text, as the app does.
const BUILTIN = [
  { name: "clear", desc: "Start a new chat (new thread in this project)", msg: { newThread: true } },
  { name: "model", desc: "Switch response model for this thread", msg: { pickModel: true } },
  { name: "effort", desc: "Change the reasoning effort of the current model", msg: { pickEffort: true } },
  { name: "settle", desc: "Settle this thread (hides it from the list)", msg: { settle: true } },
];
const menu = document.getElementById("menu");
let provCmds = [], items = [], sel = 0, muted = false, fetchedFor = null;
function runBuiltin(name) {
  const b = BUILTIN.find((c) => c.name === name);
  if (!b) return false;
  vs.postMessage(b.msg);
  t.value = "";
  grow();
  updateMenu();
  return true;
}
// The menu shows while the box holds only "/word" (no space yet) and a thread is open.
// An "@word" before the caret opens the same menu with threads and files; picking replaces the word.
let mentions = [], atTok = null;
function updateMenu() {
  const m = thread && /^\/(\S*)$/.exec(t.value);
  atTok = !m && /(^|\s)@(\S*)$/.exec(t.value.slice(0, t.selectionStart));
  if (!m && !atTok) muted = false;
  if ((!m && !atTok) || muted) return (menu.hidden = true);
  const q = (m ? m[1] : atTok[2]).toLowerCase();
  const all = m ? BUILTIN.concat(provCmds.filter((c) => !BUILTIN.some((b) => b.name === c.name))) : mentions;
  items = all
    .filter((c) => c.name.toLowerCase().includes(q))
    .sort((a, b) => !a.name.toLowerCase().startsWith(q) - !b.name.toLowerCase().startsWith(q))
    .slice(0, 60);
  sel = Math.min(sel, Math.max(items.length - 1, 0));
  menu.replaceChildren(
    ...items.map((c, i) => {
      const d = el("div", i === sel ? "sel" : "");
      d.setAttribute("role", "option");
      d.setAttribute("aria-selected", i === sel);
      d.append(el("span", "name", (c.ins ? "" : "/") + c.name), el("span", "desc", c.desc));
      d.onmousedown = (e) => (e.preventDefault(), pick(i));
      return d;
    })
  );
  menu.hidden = !items.length;
  if (menu.children[sel]) menu.children[sel].scrollIntoView({ block: "nearest" });
}
function pick(i) {
  const c = items[i];
  if (c && c.ins && atTok) {
    const end = t.selectionStart, from = end - atTok[2].length - 1;
    t.value = t.value.slice(0, from) + c.ins + " " + t.value.slice(end);
    t.selectionStart = t.selectionEnd = from + c.ins.length + 1;
    grow();
    updateMenu();
    t.focus();
    return;
  }
  if (!c || runBuiltin(c.name)) return;
  t.value = "/" + c.name + " ";
  t.selectionStart = t.selectionEnd = t.value.length;
  grow();
  updateMenu();
  t.focus();
}
// Returns true when the key was used by the menu.
function menuKey(e) {
  if (menu.hidden || !items.length) return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") pick(sel);
  else if (e.key === "Escape") (muted = true), (menu.hidden = true);
  else return false;
  e.preventDefault();
  if (!menu.hidden) updateMenu();
  return true;
}
t.oninput = () => {
  grow();
  sel = 0;
  // Ask for the provider's list when a "/" is typed first, and after a thread switch (the provider may differ).
  if (thread && /^\/\S*$/.test(t.value) && (t.value === "/" || fetchedFor !== thread)) {
    fetchedFor = thread;
    vs.postMessage({ slash: true });
  }
  // Refresh the @ list each time an "@" is typed (threads and files change).
  if (t.value[t.selectionStart - 1] === "@") vs.postMessage({ mentions: true });
  updateMenu();
};
t.onblur = () => (menu.hidden = true);
// A pasted image is saved to a file by the extension; its path goes into the message (the CLI has no attachments).
const waiting = [], thumbsEl = document.getElementById("thumbs");
function addThumb(path) {
  const box = el("div", "thumb"), img = document.createElement("img"), x = el("button", null, "x");
  img.src = waiting.shift() || "";
  img.title = path;
  x.title = "Remove this image";
  x.onclick = () => { t.value = t.value.replace(path, "").replace(/ {2,}/g, " "); box.remove(); grow(); };
  box.append(img, x);
  thumbsEl.append(box);
}
t.onpaste = (e) => {
  const f = [...((e.clipboardData && e.clipboardData.files) || [])].find((x) => x.type.startsWith("image/"));
  if (!f) return;
  e.preventDefault();
  const r = new FileReader();
  r.onload = () => { waiting.push(r.result); vs.postMessage({ image: r.result }); };
  r.readAsDataURL(f);
};
function insert(s) {
  const a = t.selectionStart, b = t.selectionEnd, pad = a && !/\s$/.test(t.value.slice(0, a)) ? " " : "";
  t.value = t.value.slice(0, a) + pad + s + " " + t.value.slice(b);
  t.selectionStart = t.selectionEnd = a + pad.length + s.length + 1;
  grow();
  t.focus();
}
t.onkeydown = (e) => {
  if (menuKey(e) || e.isComposing) return;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
};

addEventListener("message", (e) => {
  const d = e.data;
  if (d.error) { st.className = "err"; st.textContent = "error: " + d.error; if (!skel.hidden) mode(""); return; }
  if (d.empty) { switchTo(""); emptyTxt.textContent = PICK; mode("empty"); st.textContent = ""; modelEl.textContent = ""; work.hidden = true; return; }
  if (d.loading) { switchTo(d.threadId); mode(log.children.length ? "" : "loading"); header(d); return; }
  if (d.imagePath) return addThumb(d.imagePath), insert(d.imagePath);
  if (Array.isArray(d.mentions)) {
    mentions = d.mentions;
    if (document.activeElement === t) updateMenu();
    return;
  }
  if (Array.isArray(d.commands)) {
    provCmds = d.commands;
    if (document.activeElement === t) updateMenu();
    return;
  }
  if (typeof d.ctx === "string") {
    if (d.ctx !== ctxL.textContent) ctxOff(false);
    ctxL.textContent = d.ctx;
    ctxEl.hidden = false;
    return;
  }
  if (d.imageError) { waiting.shift(); st.className = "err"; st.textContent = "image not saved: " + d.imageError; return; }
  if (d.sent) {
    if (pend) pend.node.classList.remove("pending");
    t.value = "";
    thumbsEl.replaceChildren();
    cites.length = 0;
    drawCites();
    grow();
    lock(false);
    t.focus();
    return;
  }
  if (d.askError) { cardLock(false); st.className = "err"; st.textContent = "not answered: " + d.askError; return; }
  if (d.sendError) {
    if (pend) { pend.node.remove(); pend = null; }
    if (!log.children.length) mode("empty");
    lock(false);
    t.focus();
    st.className = "err";
    st.textContent = "not sent: " + d.sendError;
    return;
  }
  if (d.messages) render(d);
});
