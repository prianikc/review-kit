---
name: pr-review-run
description: Use when the review-kit mod or review_start has opened a run for a Forgejo PR (.review-kit/run/<N>/context.json exists) and that PR is to be reviewed or its review published in this tab. Not for own fixes.
---

# pr-review-run

The `/pr-review N` command already switched the tree to the PR, asked for the model and opened a run.
Read `.review-kit/run/<N>/context.json`: `number`, `title`, `author`, `isOwn`, `state`, `head`, `base`,
`stash`, `model`. Ask nothing before the review.

No `context.json` → the skill was called directly, not by the mod: tell the user to run `/pr-review <N>` and stop.

## 1. Review — agents funnel

1. Run exactly:
   `python3 ${CLAUDE_PLUGIN_ROOT}/tools/funnel_prep.py --pr <N> --base <base> --head <head> --model <model> --out .review-kit/run/<N>/funnel`
   Exit 4 — the input is too large: tell the user, call `review_finish`, stop. Any other non-zero exit → step 5.
2. Call `Workflow` with `scriptPath: "${CLAUDE_PLUGIN_ROOT}/funnel/review-funnel.js"` and `args` = the JSON
   the script printed, passed as a JSON object (not a string). This skill's instruction is the user's opt-in to the
   workflow. Wait for its completion notification; do nothing else meanwhile.
3. Completed: copy the notification's `<output-file>` exactly:
   `cp <output-file> .review-kit/run/<N>/funnel/raw.json`
4. Run exactly:
   `python3 ${CLAUDE_PLUGIN_ROOT}/tools/funnel_finish.py --raw .review-kit/run/<N>/funnel/raw.json --base <base> --head <head> --out .review-kit/run/<N>/lite`
   It writes `.review-kit/run/<N>/lite/findings.json` — the file the report and the publish step read. Read
   that file only (not `input.md`, not `raw.json`). Exit 6 or any other non-zero exit → step 5.
5. The funnel did not produce a review (the workflow failed or left no output file, `funnel_prep` or
   `funnel_finish` exited non-zero): report «Ревью агентами не состоялось — не проверено» with the stderr line,
   never a verdict; call `review_finish`, stop.

## 2. Report

In Russian, in this order: verdict line (Blocked if any critical, Changes requested if any important,
Approved with comments if only minor, Approved if none); then each finding numbered as its `id` with
`file:line`, level, problem, failure scenario or rule; then «Не проверялось» with every `notChecked`
entry and, if any, the count of dropped findings by reason.

Levels: **critical** — breaks the product, loses data, or is exploitable → Blocked; **important** — a measurable
regression, a concrete risk, or a project-rule violation a reviewer would send back → Changes requested; **minor** —
style, naming, preference. Only minor → Approved with comments; nothing → Approved. «Не проверялось» is always present.
A finding states the problem, not the author. A rule quote stays in the report, never in the published comment.
Approved and Approved with comments are published as `APPROVED` only after the second confirmation question,
otherwise as a comment; Changes requested and Blocked — as request changes with a non-empty body.

After the agents funnel the file has more: a finding with `mark` carries it after the level («средняя
вероятность», «не проверено»). When `belowBar` is not empty, after the findings comes «Подтверждено, ниже порога» —
one line each, `<file>:<line> — <problem> · <level> · <confidence>%`, plus ` · <mark>` when the entry has one
(«C не проверил»); these are never published. «Не проверялось» counts `dropped` by reason (`refuted`,
`duplicate-of`, `below-threshold`, `quote-not-found`, …).

`baseFallback: true` in `context.json` → one more «Не проверялось» line: «база ревью взята от main: базовая ветка PR
удалена — в diff могут попасть чужие коммиты».

Foreign open PR, empty `findings` → end with «Апрувим?»; nothing else is asked about publishing.

Own PR (`isOwn`) or closed PR (`state: closed`): the report is the result. Call `review_finish` and stop.

## 3. Publish — only when the user asks

### 3B. Bare approve

`findings` is empty and the user asks to approve or publish → no texts question, no summary, no drafts:
write `.review-kit/run/<N>/texts.json` = `{"summary": "", "comments": {}}`, run step 3 of «In chat» with `--ids "" --approve`,
then its steps 4–6. The mod asks the one question «Одобрить PR <N> без комментариев?» itself.

Otherwise, first ask with AskUserQuestion «Где разбираем тексты ревью?» — options «В чате», «В Plannotator». «В чате» → steps 1–6 below. «В Plannotator» → 3P.

### 3P. Through Plannotator

1. Write `.review-kit/run/<N>/texts.json` for **every** entry of `findings` (not `belowBar`): `{"summary": "<2–4 sentences, problem not author; never mentions `belowBar` entries>", "comments": {"<id>": "<comment text in Russian>"}}`; rule quotes stay out of comment texts. Do not show the drafts in chat — the human reads them in Plannotator.
2. Call `review_plannotator` with `pr`. `unavailable: …` → show the reason and ask «Разобрать в чате?»; yes → steps 1–6 below; no → `review_finish`, stop.
3. `started: …` → tell the user the URL and that when rewriting a comment they should keep its first line `[id · …]` — it ties the comment to its finding; then end the turn. Do nothing until a message «Plannotator result for PR <N>: …» arrives.
4. On that message: `failed` → show the reason, ask «Разобрать в чате?» as in 3P.2. Otherwise read `.review-kit/run/<N>/plannotator/result.json`:
   - `dismissed` → «Ревью не публикуется: Plannotator закрыт без решения.» → `review_finish`, stop.
   - `approved` / `annotated` with empty `ids` and an empty `summary` in `plannotator/texts.json` → «Публиковать нечего.» → `review_finish`, stop.
   - otherwise show the summary and every comment of `plannotator/texts.json` in chat (`id`, `file:line`, text; `h…` ids are the human's own), then step 3 below with `--findings .review-kit/run/<N>/plannotator/findings.json --texts .review-kit/run/<N>/plannotator/texts.json --ids <ids from result.json>`, then steps 4–6. Do not edit the human's texts; a change the user asks for in chat goes into `plannotator/texts.json` before step 3.

### In chat

1. The user names the findings to publish — entries of `findings` (or «все»). Write `.review-kit/run/<N>/texts.json`:
   `{"summary": "<2–4 sentences, problem not author; never mentions `belowBar` entries>", "comments": {"<id>": "<comment text in Russian>"}}`,
   one comment per selected id; rule quotes stay out of comment texts.
2. Show the summary and every comment draft in chat (`id`, `file:line`, text) and apply the user's edits to
   `texts.json` until they say it is ready.
3. Build (after 3P the paths are the `plannotator/` ones):
   `python3 ${CLAUDE_PLUGIN_ROOT}/tools/review_payload.py build --findings .review-kit/run/<N>/lite/findings.json --texts .review-kit/run/<N>/texts.json --base <base> --head <head> --ids <ids> > .review-kit/run/<N>/payload.json`
   — add `--approve` only if the verdict is Approved or Approved with comments and the user wants to approve.
4. Call `review_confirm` with `action: "publish-review"`, `pr`, `payloadPath: ".review-kit/run/<N>/payload.json"`, `summary`.
   Not `confirmed` → do not publish; show the reason.
5. `confirmed` → run exactly:
   `python3 ${CLAUDE_PLUGIN_ROOT}/tools/forgejo.py post-review <N> --payload .review-kit/run/<N>/payload.json`
   Report the review URL it prints. Exit 5 → show the error; if it says «статус публикации неизвестен», tell the user to check the PR before anything else and never re-run the command; the text stays in chat; call `review_finish`.
6. Call `review_finish`.

If the user does not want to publish, call `review_finish`. Every stop of this skill ends with `review_finish`: an open run blocks plain commits in this session.

Never call curl, never edit `payload.json` after `review_confirm`, never publish an own or closed PR.
