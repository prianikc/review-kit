---
name: pr-confl
description: Use when the user's own PR conflicts with its base and the base has to be merged into it (/pr-confl N, «PR 140 в конфликте», «влей базу в мой PR»). Only the own PR; conflicts already in the tree outside a review-kit run are not this skill's job.
argument-hint: "<номер PR>"
---

# pr-confl

Arguments: `$ARGUMENTS` — the PR number. None → ask in text «Какой PR?» and end the turn.

## Resolving a file

For every conflicted file: read the whole file and both sides — `git diff` of the file, `git log --oneline -5` of each side
for it (`HEAD` and `MERGE_HEAD`/`REBASE_HEAD`/`CHERRY_PICK_HEAD`). Keep the intent of both sides: combine changes, take
the newer API, drop only what one side deliberately removed. Remove every `<<<<<<<`, `=======`, `>>>>>>>` line, then
`git add -- <file>`. A deleted-vs-modified conflict or a choice you cannot justify from the code → AskUserQuestion with
the concrete options (in Russian) and follow the answer. Never take `--ours`/`--theirs` for a whole file without reading it.

## Merging the base

1. `conflict_start` with `pr`; it asks the user itself. Show its first line. Then by the ending:
   - `not started: …` → show the reason, stop.
   - `review-kit: …` → show it, `review_finish` with `pr`, stop.
   - `clean: …` → «Конфликтов с базой нет», stop (the mod closed the run).
   - `merged: … «<subject>» …` → step 3 with message = `<subject>`, paths = `[]` (the merge is committed, only push is left).
   - `resolved: …` → step 3, paths = the files you resolved in this conversation; unknown → `git diff --cached --name-only`.
   - `conflicts:` + files → step 2.
2. Resolve each listed file (section above).
3. `commit_push` with `pr`, `message` = `Merge <base> into <branch>` (from `.review-kit/run/<N>/context.json`: `baseRef`,
   `headRef`), `paths` = the resolved files. The tool asks the user itself.
   - `pushed: …` → report the sha, step 4.
   - `not done: … маркеры конфликта …` / `не разрешены …` → fix those files, `commit_push` again.
   - `not done: … коммита нет — <hook output>` → show it, fix what it reports, `commit_push` again.
   - `not done: пользователь отказал` → «Слияние в дереве, не запушено — /pr-confl <N> продолжит», step 4.
   - `not pushed: …` → show it as is, step 4.
4. `review_finish` with `pr`. Report in Russian: resolved files, one line each — what was kept from each side.

Push only through `commit_push`. Never `--abort` unless the user asks, never `--force`, `reset --hard` or `checkout -- <file>`.
