---
name: pr-flow
description: Use when the user asks in words to look at, review or check a Forgejo pull request («посмотри PR 140», «что там по 134 пра», «есть что ревьюить?») without typing /pr. Not for own fixes.
---

# pr-flow

Call `review_start` with `pr` = the PR number the user named (omit it when they named none). Show its answer to the
user as is. If the answer tells you to use a review-kit skill (`review-kit:pr-review-run`, `review-kit:pr-recheck-run`, `review-kit:pr-feedback-run`, `review-kit:pr-fix-run`), use that skill next. Do not switch branches, call
Forgejo or ask the user anything yourself — the tool does that. `review_start` unavailable → «мод review-kit не
загружен», stop.
