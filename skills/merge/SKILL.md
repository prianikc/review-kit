---
name: merge
description: Use when the current branch needs the fresh default branch merged into it (/merge, «влей main в ветку», «подтяни main») — fetches origin and merges it with a merge commit, conflicts go to review-kit:confl. Never pushes.
argument-hint: "[ветка, по умолчанию main]"
---

# merge

Arguments: `$ARGUMENTS` — the branch to merge in; empty → the default branch: `git symbolic-ref --short
refs/remotes/origin/HEAD` without `origin/` (fails → `main`).

1. `git rev-parse --show-toplevel` fails → «Не git-репозиторий», stop. `git branch --show-current` is empty → «HEAD
   отсоединён», stop. The current branch is the one to merge in → «Вы на <branch> — обновить её: /gsync», stop.
2. `git status --porcelain --untracked-files=no` is not empty, or a merge/rebase is in progress → «В дереве есть
   незакоммиченные изменения — сначала /commit (или закончите merge/rebase)», stop.
3. `git fetch origin <branch>`. Fails → show git's output, stop.
4. `git merge --no-edit origin/<branch>`.
   - «Already up to date» → «<branch> уже в ветке», stop.
   - Conflicts → use the review-kit:confl skill without arguments; it resolves them and finishes the merge.
   - Other failure → show git's output; a merge left half-done → `git merge --abort`, stop.
5. Report in Russian: `git log --oneline -1`, how many commits came in (`git rev-list --count ORIG_HEAD..HEAD`), and that
   nothing was pushed — `/push` when ready.

Never push, never rebase, never `--force`, `reset --hard` or `--squash`.
