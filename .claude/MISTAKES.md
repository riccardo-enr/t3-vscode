# Mistakes

## 2026-11-18 - t3-vscode
- What went wrong: told the user no T3 Code VS Code extension exists. Several do (T3 VSCode by hungtienhuang, Open Thread for T3 Code by Ezequiel Barrera).
- Root cause: one web search returned generic marketplace pages; I read "no result" as "does not exist" and never searched the marketplace itself.
- Rule: before saying a tool or extension does not exist, search its own registry (marketplace, npm, GitHub) directly, and say how thorough the check was.

## 2026-11-18 - t3-vscode
- What went wrong: a commit was rejected by the global commitlint hook because its subject started with "T3" (subject-case rule).
- Root cause: wrote the subject in title case after the product name instead of checking the hook's rules.
- Rule: Conventional Commit subjects start lower-case, even with a product name ("add t3 code bridge", not "T3 Code bridge").

## 2026-11-18 - t3-vscode
- What went wrong: claimed the xdg-open link path worked (drafts, open thread in app). From VS Code it never reached the app; the user found nothing opened.
- Root cause: tested xdg-open only from my shell. The VS Code extension host sets ELECTRON_RUN_AS_NODE=1; inherited by xdg-open, it makes the Electron app run as plain Node and crash, and xdg-open still exits 0.
- Rule: test a spawned command in the environment that really runs it (here, the extension host env), and confirm the effect at the receiver (the app's log), not the launcher's exit code.

## 2026-11-18 - t3-vscode
- What went wrong: committed a duplicated pair of CSS rules (f9dac03). My index-only staging helper treated "new text present" as "already applied", but the new text contained the old anchor, so the edit was applied twice.
- Root cause: idempotency check that only works when the replacement does not contain its anchor; also two other sessions were editing the same files uncommitted, which is why staging had to bypass the working tree.
- Rule: after any scripted edit, grep the committed blob (`git show :file`) for duplicates of the added lines; and never run parallel sessions on the same files (AGENTS.md: disjoint files only).

## 2026-11-19 - t3-vscode
- What went wrong: shipped t3Client.js with a reconnect guard (`this.lost === this.ws`) that stopped all retries after the first failed reconnect; also let the status bar depend on the tree's getChildren, which VS Code calls only while the view is visible. Both found in my own review, after I had reported the work as done.
- Root cause: tested only the first connect and only with the tree visible; did not walk the failure path (connected -> server down -> retry fails -> retry again).
- Rule: for any reconnect or retry loop, test at least two failures in a row and a recovery (kill and restart the server); for VS Code views, do not drive non-view state from a provider callback.

## 2026-11-19 - t3-vscode
- What went wrong: `pkill -f "t3-spike"` killed my own shell, because the shell's command line contained the pattern; the rest of that command never ran.
- Rule: never pkill -f with a pattern that appears in the same command; use a timeout on the started process, or kill by the pid it wrote.

## 2026-11-19 - t3-vscode
- What went wrong: the plan left send and new thread on the `t3` CLI. Every message sent from VS Code is stored as `createdBy: "agent"`, `creationSource: "mcp"`, so the app shows the user's own messages as agent messages.
- Root cause: treated "send" as a plain read/write pair and never checked how the CLI marks the message author; it runs the send as an MCP tool call.
- Rule: when moving a write path off the CLI, check what identity and metadata the CLI attaches (author, source) and send the same command over the socket with the right ones.

## 2026-11-19 - t3-vscode
- What went wrong: the spike wrote "no acknowledgement needed" for subscriptions, and the committed client never sent an Ack. The server (Effect RPC) stops streaming after about 20 chunks without one, so the shell subscription could freeze silently on a busy server; found only when the chat watch missed later replies.
- Root cause: the spike watched only a few frames and took "it worked" as proof of the protocol rule.
- Rule: prove a streaming protocol over more messages than any buffer could hold (here 50+ chunks), and read the framework's flow-control rule instead of inferring it from a short run.

## 2026-11-19 - t3-vscode
- What went wrong: a `sed s/join(",")/join('|')/` meant for one new test line also rewrote an existing `join(",")` in the fold test, which then failed.
- Root cause: an unanchored sed substitution on a pattern that already appeared elsewhere in the file.
- Rule: before a sed replace, grep the pattern and confirm it matches only the intended line; otherwise use an exact Edit.

## 2026-11-19 - t3-vscode
- What went wrong: answered an issue triage with a markdown table that had long cells; it did not render for the user.
- Rule: in chat replies use short headed bullet lists, not tables, especially when cells hold more than a few words.
