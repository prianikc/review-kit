---
name: main
description: Use when the user wants to go to the default branch with its latest state (/main, «переключись на main», «перейди на мейн и обнови») — switches the tree to the default branch and fast-forwards it from origin. Never touches other branches.
---

# main

Switch to the default branch and fast-forward it. Never merge, rebase, reset, stash, delete or push, and never update any
other branch.

1. `git rev-parse --show-toplevel` fails → «Не git-репозиторий», stop. `git status` says a merge, rebase, cherry-pick or
   revert is in progress → «Идёт merge/rebase — закончите его (/confl)», stop.
2. Default branch = `git symbolic-ref --short refs/remotes/origin/HEAD` without `origin/` (fails → `main`).
3. `git fetch origin <default>`. Fails → show git's output, stop.
4. Current branch is not the default → `git switch <default>` (creates it from `origin/<default>` when there is no local
   one; uncommitted changes that do not conflict travel along). Git refuses:
   - local changes would be overwritten → «Изменения в дереве мешают переключению — /commit или уберите их», stop;
   - the branch is checked out in another worktree → «<default> открыта в worktree <path>», stop;
   - anything else → show git's output, stop.
5. `git rev-list --count HEAD..origin/<default>` is not zero → `git merge --ff-only origin/<default>`. Refuses →
   «<default> разошлась с origin (впереди на A, отстаёт на B) — разберитесь вручную», stop.
6. Report in Russian, one or two lines: «На `<default>`», then «обновлена (+N)» or «актуальна», `git log --oneline -1`;
   local commits not on origin → «впереди на N — /push»; uncommitted changes that came along → mention them.
