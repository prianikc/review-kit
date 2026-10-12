---
name: pr-feedback-run
description: Use when the review-kit mod or review_start opened a feedback run for the user's own Forgejo PR (.review-kit/run/<N>/context.json with scenario feedback exists).
---

# pr-feedback-run

Read `.review-kit/run/<N>/context.json` (`head`, `base`, `model`, `mode`, `scenario`) and `.review-kit/run/<N>/intake.json`.
No `context.json` → tell the user to run `/pr-feedback <N>` and stop. Empty `items` → «Замечаний нет», call `review_finish`, stop.

## 1. Triage

`mode: "agents"`:
1. Run exactly:
   `python3 .claude/skills/review-kit/tools/triage_prep.py --pr <N> --mode feedback --items .review-kit/run/<N>/intake.json --base <base> --head <head> --model <model> --out .review-kit/run/<N>/triage`
2. Call `Workflow` with `scriptPath: ".claude/skills/review-kit/funnel/triage.js"` and `args` = the JSON the script printed, passed as an object.
   This instruction is the user's opt-in to the workflow. Wait for its completion notification; do nothing else meanwhile.
3. Run exactly: `cp <output-file> .review-kit/run/<N>/triage/raw.json`, then
   `python3 .claude/skills/review-kit/tools/triage_finish.py --raw .review-kit/run/<N>/triage/raw.json --items .review-kit/run/<N>/intake.json --mode feedback --out .review-kit/run/<N>`
4. Any step fails → say «Разбор агентом не состоялся» with the stderr line and triage yourself (below).

`mode: "lite"` — triage yourself: for each item read the quoted place at `head` and write
`.review-kit/run/<N>/triage.json` = `{"items": [{"id", "class", "reason", "fixed"?}]}` with the classes and rules of `agents/triage.md`
(valid / invalid / question / out-of-scope; a `stale` item already changed as asked is `valid` with `"fixed": true` and a reason saying where).

## 2. Summary

In Russian, grouped by class: each item as `<path>:<position>` (or «общий») — the substance of the comment in words — `reason`.
Items with `disagree` first, marked «ревьюер не согласен»; `valid` items with `fixed` marked «уже исправлено». No Forgejo ids anywhere the user reads.

Then AskUserQuestion «Что делаем?» with «Чиним (ответы на остальное — в конце)» and «Только ответить».
- «Чиним» → follow review-kit:pr-fix-run from its step 1; the run stays open. Every `valid` item has `fixed` → nothing to fix: go straight to
  the «Replies» section of review-kit:pr-fix-run.
- «Только ответить» → the «Replies» section of review-kit:pr-fix-run, then `review_finish`.
