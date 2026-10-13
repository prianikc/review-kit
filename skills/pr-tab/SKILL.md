---
name: pr-tab
description: Use when the user asks to review a PR in a separate tab or worktree, to run several PR reviews in parallel («открой ревью 156 во вкладке», «запусти ревью 156, 157, 158 параллельно»), or to remove such a review worktree («убери вкладку 156»).
---

# pr-tab

Optional; the only part of review-kit that uses Orca. Each PR gets its own git worktree in `.claude/worktrees/` and an Orca
tab where `/pr-review N` runs. Nothing from the project is copied into the worktree.

## Open

Call `review_tab` with `prs` = the numbers the user named, in their order. Show its answer as is. Then stop: do not poll
the tabs. A closed tab keeps its worktree; `/pr cleanup` in the main tree offers to remove finished ones.

## Remove

1. `git worktree list --porcelain` → the worktree whose path ends in `/.claude/worktrees/pr-<N>-<branch>`. None → say so, stop.
2. `git -C <W> status --porcelain --ignore-submodules=all` not empty → AskUserQuestion «В worktree есть изменения — удалить
   вместе с ними?» (Удалить / Оставить); Оставить → stop.
3. `git worktree remove --force <W>` (`--force`: an initialised submodule). Branches stay — `/pr cleanup` offers them.
