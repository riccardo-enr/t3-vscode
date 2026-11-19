// Spike: read-only probe of the live T3 server. node test/spike_direct.js <tag> [json payload] [seconds]
// Prints every frame received (truncated). Throwaway; findings go into docs/plan.
const { execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const home = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
const base = JSON.parse(fs.readFileSync(path.join(home, "userdata", "server-runtime.json"), "utf8")).origin;
const scopes = (process.env.SCOPES || "orchestration:read").split(",").flatMap((s) => ["--scope", s]);
const tok = execFileSync("t3", ["auth", "session", "issue", ...scopes, "--ttl", "5m", "--label", "spike", "--token-only", "--base-dir", home], { encoding: "utf8" }).trim().split("\n").pop();
(async () => {
  const r = await fetch(base + "/api/auth/websocket-ticket", { method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: "{}" });
  const { ticket } = await r.json();
  const ws = new WebSocket(base.replace(/^http/, "ws") + `/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`);
  const [tag, payload, secs] = [process.argv[2], JSON.parse(process.argv[3] || "{}"), +(process.argv[4] || 4)];
  ws.onopen = () => ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
  ws.onmessage = (e) => console.log(String(e.data).slice(0, +(process.env.MAX || 1500)));
  ws.onerror = () => console.log("ws error");
  setTimeout(() => process.exit(0), secs * 1000);
})();
