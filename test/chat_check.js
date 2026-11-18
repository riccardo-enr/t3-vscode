// Self-check for media/chat.js: markdown output, HTML escaping, and T3 citation cards.
// Run: node test/chat_check.js
const fs = require("fs"), vm = require("vm"), path = require("path"), assert = require("assert");

class N {
  constructor(tag) {
    Object.assign(this, { tag, kids: [], className: "", textContent: "", innerHTML: "", style: {} });
    this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
  }
  append(...k) { this.kids.push(...k); }
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
vm.runInContext(fs.readFileSync(path.join(__dirname, "../media/chat.js"), "utf8") + "\n;this.md=md;this.body=body;this.prettyModel=prettyModel;", ctx);
const { md, body, prettyModel } = ctx;

assert.strictEqual(prettyModel("claude-opus-5-5"), "Opus 5.5");
assert.strictEqual(prettyModel("gpt-5.4"), "gpt-5.4");

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
  "<h1>T</h1><ul><li>a</li><li>b</li></ul><ol><li>x</li></ol><pre><code>if (a&lt;b) {}</code></pre><p>text</p>"
);

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

console.log("chat_check ok");
