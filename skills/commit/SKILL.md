---
name: commit
description: Commit this session's work with a generated message. Only the user invokes it, by typing /commit [all] [text].
argument-hint: "[all] [текст сообщения]"
disable-model-invocation: true
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*), Bash(git rev-parse:*)
---

# commit

The user typed `/commit` themselves — that is their confirmation. Ask nothing: no AskUserQuestion, no Plan Mode, no
"shall I commit?". Never push, never `--amend`, `--no-verify` or `-a`.

Arguments: `$ARGUMENTS`. First word `all` → scope «all», the rest is the message basis; otherwise scope «session» and
the whole text is the basis. No text → no basis.

1. `git rev-parse --show-toplevel` fails → «Не git-репозиторий», stop. `git status` says a merge, rebase, cherry-pick
   or revert is in progress → «Идёт merge/rebase — закоммить вручную», stop.
2. Paths.
   - «all»: `git add -A`; paths = `git diff --cached --name-only`. Empty → «Нечего коммитить», stop.
   - «session»: candidates = the «Session files» list at the end of this skill plus every file you yourself created,
     changed, moved or deleted this session through Bash (sed, heredoc, mv, rm). Keep only those that appear in
     `git status --porcelain --untracked-files=all` (compare as repo-relative paths; for a move keep both sides).
     Empty → «В этой сессии файлы не менялись — `/commit all`, чтобы закоммитить всё», stop.
     `git add -- <paths>`.
3. Message. Read `git diff --cached -- <paths>` and `git log --oneline -10`. Write the subject in the language and format
   the log uses; add a body only when the subject cannot carry the change. With a basis, keep its meaning and wording
   where the diff agrees, and correct or complete it from the diff. Add the attribution trailer your session instructions
   require for commits.
4. Commit: «session» — `git commit -m "<subject>" [-m "<paragraph>" …] -- <paths>` (only these paths, whatever else is
   staged); «all» — the same without `-- <paths>`. One `-m` per paragraph, no heredoc.
   The pre-commit hook fails → show its output and «Коммит не сделан», stop; do not retry or bypass it.
5. Report one line: `git log -1 --format='%h %s'` and «— <n> файлов».
