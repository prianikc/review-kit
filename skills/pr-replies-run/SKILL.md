---
name: pr-replies-run
description: Use when the items of the user's own PR are triaged (and fixed, if they chose to) and the reviewers' threads need answers — after review-kit:pr-fix-run or «Только ответить» of review-kit:pr-feedback-run.
user-invocable: false
---

# pr-replies-run

Items: `.review-kit/run/<N>/triage.json` (or the blocking and non-blocking entries of `findings.json` after a review of
the own PR) and `.review-kit/run/<N>/intake.json`.

For every item write a draft to `.review-kit/run/<N>/replies.json` = `{"replies": {"<id>": "<text>"}}`: fixed in this round
or earlier (`fixed`) — exactly «Исправлено»; moved to TODO — «Перенесено в TODO: <file>:<line>»; invalid, question, out-of-scope — «Не исправлено: <one sentence: the reason, the
answer to the question, or where it went>». No sha, no retelling of the change. Without a reply the thread stays open and the PR keeps the status
«есть замечания». Show every draft as `<path>:<position>` (or «общий») — text and apply the
user's edits. Then `replies_publish` with `pr` (it asks the user itself): `published: <n>` → report; `not published: …` →
show the reason. Then `review_finish`.

Never call curl or the hosting API; replies go only through `replies_publish`.
