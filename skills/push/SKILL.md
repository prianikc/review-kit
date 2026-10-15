---
name: push
description: Push the current branch and show the pull request link. Only the user invokes it, by typing /push.
disable-model-invocation: true
allowed-tools: Bash(git status:*), Bash(git branch:*), Bash(git rev-parse:*), Bash(git symbolic-ref:*), Bash(git log:*), Bash(git push:*)
---

# push

The user typed `/push` themselves — that is their confirmation. Ask nothing. Never `--force`, `--force-with-lease`,
`--delete` or a refspec other than the current branch.

1. `git rev-parse --show-toplevel` fails → «Не git-репозиторий», stop. `git branch --show-current` is empty → «HEAD
   отсоединён — переключитесь на ветку», stop.
2. Default branch = `git symbolic-ref --short refs/remotes/origin/HEAD` without `origin/` (fails → `main`). The current
   branch is the default one → «Пуш в <branch> — только вручную», stop.
3. `git status` says a merge, rebase, cherry-pick or revert is in progress → «Идёт merge/rebase — закончите его (/confl)»,
   stop. Uncommitted changes are fine: only commits are pushed; mention them in the report.
4. `git push -u origin HEAD`.
   - Refused by the review-kit guard → «Идёт прогон review-kit — push идёт через его раунд», stop.
   - Rejected as non-fast-forward → «Ветка на origin ушла вперёд — /gsync, затем /merge или разберитесь вручную», stop.
   - Any other failure → show git's output, stop.
5. Report in Russian, one or two lines: the branch, `git log --oneline -1`, and the PR link from the push output (the
   `remote:` lines «Create a new pull request …» or «Visit the existing pull request …» — take the URL as is). No link in
   the output → say the server gave no PR link.
