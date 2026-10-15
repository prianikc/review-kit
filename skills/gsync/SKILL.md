---
name: gsync
description: Use when local git branches should catch up with origin (/gsync, «синхронизируйся с git», «обнови ветки», «подтяни main») — fast-forwards the default and the current branch and reports every branch that is behind, diverged or gone. Never merges or rebases.
---

# gsync

Only fast-forwards. Never merge, rebase, reset, delete a branch or push.

1. `git rev-parse --show-toplevel` fails → «Не git-репозиторий», stop.
2. `git fetch --prune origin`. Fails → show git's output, stop.
3. Default branch = `git symbolic-ref --short refs/remotes/origin/HEAD` without `origin/` (fails → `main`).
4. Current branch (`git branch --show-current`), when it has an upstream: `git merge --ff-only @{u}`. It refuses
   (diverged, or uncommitted changes in the way) → note the reason, go on.
5. Every other local branch with an upstream on origin (`git for-each-ref --format='%(refname:short) %(upstream:short)
   %(upstream:track)' refs/heads`), whose track says `behind` and not `ahead`: `git fetch origin <upstream without origin/>:<b>`. A branch checked
   out in another worktree is refused by git — note it, go on.
6. Report in Russian, a table of local branches with one state each:
   - «обновлена» — fast-forwarded now (how many commits);
   - «актуальна»;
   - «впереди на N» — local commits not pushed (`/push`);
   - «разошлась» — ahead and behind (resolve by hand: someone rewrote one side);
   - «удалена на origin» — track `[gone]` (`/pr cleanup` removes review branches);
   - «без upstream».
   For the current branch also show how far it is behind `origin/<default>` (`git rev-list --count HEAD..origin/<default>`)
   when not zero — «отстаёт от <default> на N — /merge».
