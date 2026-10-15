---
name: confl
description: Use when git conflicts need resolving — a merge, rebase, cherry-pick, revert or stash pop stopped on conflicts in the tree, or the user's own PR conflicts with its base (/confl, /confl N, «разреши конфликты», «PR 140 в конфликте»).
argument-hint: "[номер PR]"
---

# confl

Arguments: `$ARGUMENTS`. A PR number → section «Own PR». Nothing → section «Tree».

## Resolving a file

For every conflicted file: read the whole file and both sides — `git diff` of the file, `git log --oneline -5` of each side
for it (`HEAD` and `MERGE_HEAD`/`REBASE_HEAD`/`CHERRY_PICK_HEAD`). Keep the intent of both sides: combine changes, take
the newer API, drop only what one side deliberately removed. Remove every `<<<<<<<`, `=======`, `>>>>>>>` line, then
`git add -- <file>`. A deleted-vs-modified conflict or a choice you cannot justify from the code → AskUserQuestion with
the concrete options (in Russian) and follow the answer. Never take `--ours`/`--theirs` for a whole file without reading it.

## Own PR

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
   - `not done: пользователь отказал` → «Слияние в дереве, не запушено — /confl <N> продолжит», step 4.
   - `not pushed: …` → show it as is, step 4.
4. `review_finish` with `pr`. Report in Russian: resolved files, one line each — what was kept from each side.

## Tree

1. `git status`. No unmerged paths → «Конфликтов нет», stop. Note the operation: merge, rebase, cherry-pick, revert, or
   none (a stash pop/apply).
2. Resolve each unmerged file (section above).
3. Continue: merge → `git commit --no-edit`; rebase / cherry-pick / revert → `GIT_EDITOR=true git <op> --continue`; a
   rebase that stops on the next commit's conflicts → repeat from step 1. A stash → do not drop it: say the stash is kept.
   The review-kit guard refuses the command (an active run) → stop here: «Конфликты разрешены и проиндексированы —
   продолжите <op> сами», the calling skill or the user continues.
4. Report in Russian: the operation, resolved files with one line each, and where it stopped.

Never push, never `--abort` unless the user asks, never `--force`, `reset --hard` or `checkout -- <file>`.
