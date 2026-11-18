// Self-check for media/chat.js (markdown, HTML escaping, T3 citation cards) and the pure helpers of extension.js.
// Run: node test/chat_check.js
const fs = require("fs"), vm = require("vm"), path = require("path"), assert = require("assert");

class N {
  constructor(tag) {
    Object.assign(this, { tag, kids: [], className: "", textContent: "", innerHTML: "", style: {} });
    this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
  }
  append(...k) { this.kids.push(...k); }
  setAttribute(k, v) { this[k] = v; }
  addEventListener() {}
  replaceChildren() { this.kids = []; }
  get children() { return this.kids; }
}
const ctx = {
  acquireVsCodeApi: () => ({ postMessage() {} }),
  document: { createElement: (t) => new N(t), getElementById: (id) => new N(id) },
  addEventListener() {}, setTimeout, URLSearchParams,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../media/chat.js"), "utf8") + "\n;this.md=md;this.body=body;this.collapse=collapse;", ctx);
const { md, body, collapse } = ctx;

// extension.js only touches `vscode` inside functions, so an empty stub is enough to load it.
const Module = require("module"), load = Module._load;
Module._load = (req, ...a) => (req === "vscode" ? {} : load(req, ...a));
const { prettyModel, ago, stateStamp, checkpointScope } = require("../extension.js");
Module._load = load;

assert.strictEqual(prettyModel("claude-opus-5-5"), "Opus 5.5");
assert.strictEqual(prettyModel("gpt-5.4"), "gpt-5.4");
assert.strictEqual(prettyModel(undefined), "");

// Checkpoint ref scope: value read from real refs in a T3 project repo (2026-11-18).
assert.strictEqual(checkpointScope("35a78732-e5e2-4256-986f-33c7c0c8584c"), "MjQyMWFiNDJkMDk3Yjg3NTg3NDYwMTc2ZDQ1Yzk5ZDM");

// State stamp: changes when the T3 state file changes; undefined (poll as usual) when it is missing.
{
  const os = require("os"), home = fs.mkdtempSync(path.join(os.tmpdir(), "t3home-")), old = process.env.T3CODE_HOME;
  process.env.T3CODE_HOME = home;
  assert.strictEqual(stateStamp(), undefined);
  fs.mkdirSync(path.join(home, "userdata"));
  const wal = path.join(home, "userdata", "statev2.sqlite-wal");
  fs.writeFileSync(wal, "");
  fs.utimesSync(wal, 1000, 1000);
  const s1 = stateStamp();
  assert(s1 && s1 === stateStamp());
  fs.utimesSync(wal, 2000, 2000);
  assert.notStrictEqual(stateStamp(), s1);
  fs.rmSync(home, { recursive: true });
  if (old === undefined) delete process.env.T3CODE_HOME;
  else process.env.T3CODE_HOME = old;
}

const now = Date.parse("2026-11-18T12:00:00Z");
const before = (s) => new Date(now - s * 1000).toISOString();
assert.strictEqual(ago(before(5), now), "now");
assert.strictEqual(ago(before(-10), now), "now"); // small clock skew
assert.strictEqual(ago(before(59), now), "now");
assert.strictEqual(ago(before(60), now), "1m ago");
assert.strictEqual(ago(before(3 * 3600 + 59), now), "3h ago");
assert.strictEqual(ago(before(2 * 86400), now), "2d ago");
assert.strictEqual(ago(before(15 * 86400), now), "2w ago");
assert.strictEqual(ago(before(400 * 86400), now), "1y ago");
assert.strictEqual(ago(undefined, now), "");
assert.strictEqual(ago("garbage", now), "");

// Escaping: no raw tag survives; only http(s) links become anchors.
const x = md("<script>alert(1)</script> **b** `<i>` [ok](https://a.b/c?d=1&e=2) [bad](javascript:alert(1))");
assert(!x.includes("<script>") && !x.includes("<i>"), "unescaped HTML: " + x);
assert(x.includes('<a data-url="https://a.b/c?d=1&amp;e=2">ok</a>'), "https link missing: " + x);
assert(!x.includes("javascript:alert(1)\""), "javascript link rendered");

// File links: absolute markdown links and path-like code spans open in VS Code; other code stays code.
const f = md("[chat.js](/home/u/x/media/chat.js:42) and `media/chat.css:12` but not `e.g. this` or `npm run`");
assert(f.includes('<a data-file="/home/u/x/media/chat.js:42">chat.js</a>'), f);
assert(f.includes('<a data-file="media/chat.css:12"><code>media/chat.css:12</code></a>'), f);
assert(f.includes("<code>e.g. this</code>") && f.includes("<code>npm run</code>"), f);
assert(!md('[x](/a" onclick="y)').includes('" onclick'), "attribute injection");
assert(x.includes("<strong>b</strong>") && x.includes("<code>&lt;i&gt;</code>"));

// Block structure.
assert.strictEqual(
  md("# T\n- a\n- b\n\n1. x\n\n```js\nif (a<b) {}\n```\ntext"),
  "<h1>T</h1><ul><li>a</li><li>b</li></ul><ol><li>x</li></ol>" +
    '<div class="code"><div class="ch"><span>js</span><button class="copy">Copy</button></div>' +
    "<pre><code>if (a&lt;b) {}</code></pre></div><p>text</p>"
);
// A fence without a language is labelled "text"; a hostile language tag cannot inject markup.
assert(md("```\nx\n```").includes("<span>text</span>"));
assert(!md('```"><img src=x>\nx\n```').includes("<img"), "fence language injection");

// Citation and image link forms as T3 sends them.
const cite =
  "[Assistant quote](t3-citation://v1/env/thread/message%3Aabc?text=Is+that+OK%2C+or+1+second%3F&start=1&end=2&comment=Efficient+CPU+please)";
const b = body(cite);
const card = b.kids.find((k) => k.className === "cite");
assert(card, "no citation card");
assert.strictEqual(card.kids[1].textContent, "Is that OK, or 1 second?");
assert.strictEqual(b.kids[b.kids.indexOf(card) + 1].innerHTML, "<p>Efficient CPU please</p>");
assert(!b.kids.some((k) => (k.innerHTML || "").includes("t3-citation")), "raw citation URL leaked");

const img = body("look\n![shot.png](t3-context://v1/image/image_1)");
assert(img.kids.some((k) => k.className === "chip" && k.textContent === "image: shot.png"));

// Run grouping: each run keeps its user message(s) and only its last assistant message;
// the earlier assistant messages of that run fold into one item placed just before it.
const u = (r, x) => ({ role: "user", runId: r, text: x }), a = (r, x) => ({ role: "assistant", runId: r, text: x });
const shape = (items) => JSON.parse(JSON.stringify(items)).map((m) => (m.fold ? "fold:" + m.fold.map((f) => f.text).join(",") : m.text));
assert.deepStrictEqual(
  shape(collapse([u("r1", "q1"), a("r1", "a1"), a("r1", "a2"), a("r1", "a3"), u("r2", "q2"), a("r2", "b1")])),
  ["q1", "fold:a1,a2", "a3", "q2", "b1"]
);
// A running run shows only its latest assistant message; messages without a runId never fold.
assert.deepStrictEqual(shape(collapse([u("r1", "q"), a("r1", "x"), a("r1", "y")])), ["q", "fold:x", "y"]);
assert.deepStrictEqual(shape(collapse([a(undefined, "s"), a(undefined, "t")])), ["s", "t"]);
assert.deepStrictEqual(shape(collapse([])), []);
// A user message sent mid-run stays in place; the fold still sits right before the run's last reply.
assert.deepStrictEqual(shape(collapse([u("r", "q"), a("r", "x"), u("r", "more"), a("r", "y")])), ["q", "more", "fold:x", "y"]);

console.log("chat_check ok");
