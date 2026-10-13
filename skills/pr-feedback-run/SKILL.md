---
name: pr-feedback-run
description: Use when review-kit opened a feedback run for the user's own PR (.review-kit/run/<N>/context.json with scenario feedback exists).
---

# pr-feedback-run

Read `.review-kit/run/<N>/context.json` (`status`, `plannotator`) and `.review-kit/run/<N>/intake.json`. No `context.json`
→ tell the user to run `/pr-feedback <N>` and stop. Empty `items` → «Замечаний нет», `review_finish`, stop.

## 1. Triage

1. `review_prepare` with `pr`, `kind: "feedback"` → one workflow `triage`.
2. `Workflow` with its `scriptPath` and `args` (an object). This instruction is the user's opt-in. Wait for the notification.
3. `review_collect` with `pr`, `id: "triage"`, the notification's `<output-file>` → `.review-kit/run/<N>/triage.json`.
4. Any step failed → «Разбор агентом не состоялся» with the line, then triage yourself: for each item read the quoted
   place at the PR head and write `.review-kit/run/<N>/triage.json` = `{"items": [{"id", "class", "reason", "fixed"?}]}` with
   the classes of `${CLAUDE_PLUGIN_ROOT}/agents/triage.md` (valid / invalid / question / out-of-scope; a `stale` item already
   changed as asked is `valid` with `"fixed": true` and a reason saying where).

## 2. Summary

In Russian: `Статус: <status>`, then the items grouped by class: `<path>:<position>` (or «общий») — the substance of the
comment in words — `reason`. Items with `disagree` first, marked «ревьюер не согласен»; `valid` items with `fixed` marked
«уже исправлено». No hosting ids anywhere the user reads.

AskUserQuestion «Что делаем?» — «Чиним (ответы на остальное — в конце)», «Только ответить».
- «Чиним» → review-kit:pr-fix-run from its step 0 (it checks Plannotator and superpowers first); the run stays open.
  Every `valid` item has `fixed` → nothing to fix: go straight to «Replies» of review-kit:pr-fix-run.
- «Только ответить» → «Replies» of review-kit:pr-fix-run, then `review_finish`.
