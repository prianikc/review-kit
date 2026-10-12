---
name: pr-tab
description: Use when the user asks to review a Forgejo PR in a separate tab or worktree, to run several PR reviews in parallel («открой ревью 156 во вкладке», «запусти ревью 156, 157, 158 параллельно»), or to remove such a review worktree («убери вкладку 156»).
---

# pr-tab

Optional, and the only part of review-kit that uses Orca: it opens a terminal tab in the current Orca project.
`/pr-review N` reviews in the current tree; this skill gives each PR its own git worktree — with the local layer,
stack skills and the project's memory linked in — and a tab where `/pr-review N` runs as usual.

## Open

For each number the user named, in their order:

1. Run exactly:
   `python3 .claude/skills/review-kit/tools/forgejo.py get /pulls/<N> | python3 -c 'import json,sys; p=json.load(sys.stdin); print(p["state"], p["merged"], p["head"]["ref"], p["head"]["sha"])'`
   Not `open`, or merged `True` → «PR <N> закрыт — вкладку не открываю», next number.
2. Run exactly: `bash .claude/skills/review-kit/tools/open-pr-tab --number <N> --head-ref <ref> --head-sha <sha>`
3. Exit 0 → tab opened (`created: false` — the worktree existed). Exit 8 → the worktree is ready but no tab (no Orca,
   or it refused): print `cd "<worktree>" && claude --permission-mode auto "/pr-review <N>"` for the user to run in a
   terminal of their own. Any other exit → show the stderr line. Lines `слой: нет …`, `битая ссылка: …`,
   `памяти нет: …` → name them in the report: the review in that tab runs without those files.

Report one line per PR: opened / reused / manual / failed, and the worktree path; results appear in that tab;
«убери вкладку N» removes the worktree; a closed tab keeps its worktree, and `/pr cleanup` in the main tree offers
to remove finished ones. Then stop: do not poll the tabs.

## Remove

1. `git worktree list --porcelain` → the worktree whose path ends in `/.claude/worktrees/pr-<N>-<branch>`. None → say so, stop.
2. `git -C <W> status --porcelain --ignore-submodules=all` not empty → AskUserQuestion «В worktree есть изменения —
   удалить вместе с ними?» (Удалить / Оставить); Оставить → stop.
3. `git worktree remove --force <W>` (`--force`: an initialised submodule). Branches stay — `/pr cleanup` offers them.
4. Remove only the memory link of that worktree (a symlink — never the memory it points to):
   `L="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(printf '%s' "<W>" | sed 's/[^A-Za-z0-9]/-/g')/memory"; [ -L "$L" ] && rm "$L"`
