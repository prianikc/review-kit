---
name: pr-flow
description: Use when the user asks in words to look at, review or check a pull request («посмотри PR 140», «что там по 134 пра», «есть что ревьюить?») without typing /pr. Not for own fixes.
---

# pr-flow

Several PRs named at once («открой 1 и 3 на ревью», «посмотри 140, 141») or a review asked for in the background («запусти
ревью 140 в фоне») → call `review_worktree` with `prs` = those numbers and show its `text` as is; for
the first PR of `here` call `review_start` with it and go on as below.

Otherwise call `review_start` with `pr` = the PR number the user named (omit it when they named none). Show its answer as is.
If the answer tells you to use a review-kit skill, use that skill next. Do not switch branches, call the hosting or ask
the user anything yourself — the tool does that. `review_start` unavailable → «мод review-kit не загружен», stop.
