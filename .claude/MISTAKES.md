# Mistakes

## 2026-11-18 - t3-vscode
- What went wrong: told the user no T3 Code VS Code extension exists. Several do (T3 VSCode by hungtienhuang, Open Thread for T3 Code by Ezequiel Barrera).
- Root cause: one web search returned generic marketplace pages; I read "no result" as "does not exist" and never searched the marketplace itself.
- Rule: before saying a tool or extension does not exist, search its own registry (marketplace, npm, GitHub) directly, and say how thorough the check was.

## 2026-11-18 - t3-vscode
- What went wrong: a commit was rejected by the global commitlint hook because its subject started with "T3" (subject-case rule).
- Root cause: wrote the subject in title case after the product name instead of checking the hook's rules.
- Rule: Conventional Commit subjects start lower-case, even with a product name ("add t3 code bridge", not "T3 Code bridge").
