---
name: gsync
description: Use when the current git branch should catch up with origin (/gsync, «синхронизируйся с git», «обнови ветку», «что с ветками») — fetches, fast-forwards only the current branch and shows a table of every local branch's state. Never touches other branches, never merges or rebases.
---

# gsync

Fetch, fast-forward the current branch, report the rest. Never merge, rebase, reset, switch, delete or push, and never
update a branch other than the current one — `/main` switches to the default branch and updates it.

1. `git rev-parse --show-toplevel` fails → «Не git-репозиторий», stop.
2. `git fetch --prune origin`. Fails → show git's output, stop.
3. Default branch = `git symbolic-ref --short refs/remotes/origin/HEAD` without `origin/` (fails → `main`).
4. Current branch (`git branch --show-current`; empty → «HEAD отсоединён», skip to step 5), when it has an upstream and
   `git rev-list --count HEAD..@{u}` is not zero: `git merge --ff-only @{u}`. It refuses (diverged, or uncommitted
   changes in the way) → keep git's reason for the table, go on.
5. States of all local branches: `git for-each-ref --format='%(refname:short)|%(upstream:short)|%(upstream:track)'
   refs/heads`. Other branches only get a state — never fetch into them.
6. Report in Russian as a table `| Ветка | Состояние |`. Rows: the current branch first, marked «(текущая)», then the
   default branch, then the rest — branches with something to do (behind, ahead, diverged, gone) before «актуальна» and
   «без upstream». One state per branch:
   - «обновлена (+N)» — the current branch, fast-forwarded now by N commits;
   - «актуальна»;
   - «отстаёт на N» — behind origin; for the default branch add «— /main»;
   - «впереди на N — /push» — local commits not pushed;
   - «разошлась (+A/−B) — разберитесь вручную» — ahead and behind: someone rewrote one side;
   - «удалена на origin — уберёт /pr cleanup» — track `[gone]`;
   - «без upstream»;
   - «не обновлена: <reason>» — the current branch whose fast-forward git refused.
   For the current branch (when it is not the default) append how it stands against `origin/<default>`
   (`git rev-list --count HEAD..origin/<default>`): zero → «, от <default> не отстаёт»; otherwise «, от <default>
   отстаёт на N — /merge».
   Wrap branch names and commands in backticks. No text after the table except a failed step's reason.
