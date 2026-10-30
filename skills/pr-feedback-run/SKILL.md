---
name: pr-feedback-run
description: Use when review-kit opened a feedback run for the user's own PR (.review-kit/run/<N>/context.json with scenario feedback exists) — triage the reviewers' comments.
user-invocable: false
---

# pr-feedback-run

Read `.review-kit/run/<N>/context.json` (`status`) and `.review-kit/run/<N>/intake.json`. No `context.json`
→ tell the user to run `/pr <N> feedback` and stop. Empty `items` → «Замечаний нет», `review_finish`, stop.

## 1. Triage

1. `review_prepare` with `pr`, `kind: "feedback"` → one workflow `triage` and `overview`.
2. `Workflow` with its `scriptPath` and `args` (an object). This instruction is the user's opt-in. It runs in the
   background.
3. While the agent works, show the whole picture of the PR's comments: «Агент разбирает замечания к PR <N> — пока все
   замечания:» and `overview` exactly as given (numbered items to triage with the whole conversation, then closed threads
   and threads waiting for the reviewer). No `overview` → skip it. Then end the turn with «Итог придёт, когда агент
   закончит.» and do nothing else until the workflow's notification arrives.
4. `review_collect` with `pr`, `id: "triage"`, the notification's `<output-file>`. It writes `.review-kit/run/<N>/triage.json`
   and answers the summary: the same numbers as the overview, each with the verdict and its reason.
5. Any step failed → «Разбор агентом не состоялся» with the line, then triage yourself: for each item read the quoted
   place at the PR head and write `.review-kit/run/<N>/triage.json` = `{"items": [{"id", "class", "reason", "fixed"?}]}` with
   the classes of `${CLAUDE_PLUGIN_ROOT}/agents/triage.md` (valid / todo / invalid / question / out-of-scope; a `stale` item already
   changed as asked is `valid` with `"fixed": true` and a reason saying where). Write the summary yourself in the form of
   section 2.

## 2. Summary

`Статус: <status>`, then the summary of `review_collect` exactly as given: «Итог разбора PR <N>: исправим A, в TODO T, уже
исправлено B, не согласны C, вопросы D, вне задачи E.» and every item, numbered as in the overview —
`<n>. <place> — <author>: <first line>` and `→ <согласны — исправим | не блокирует — в TODO | уже исправлено | не согласны — отклоняем | вопрос —
нужен ответ | вне задачи>: <reason>`. No hosting ids anywhere the user reads.

AskUserQuestion «Что делаем?» — «Чиним (ответы на остальное — в конце)», «Только ответить».
- «Чиним» → review-kit:pr-fix-run from its step 1; the run stays open. Every `valid` item has `fixed` and there is no
  `todo` → nothing to change: go straight to review-kit:pr-replies-run.
- «Только ответить» → review-kit:pr-replies-run.
