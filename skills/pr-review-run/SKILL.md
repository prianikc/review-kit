---
name: pr-review-run
description: Use when review-kit opened a review run for a PR (.review-kit/run/<N>/context.json exists, scenario review) — review it with the agents and publish when the user asks. Not for own fixes.
---

# pr-review-run

The mod already switched the tree to the PR, asked for the model and opened the run. Read `.review-kit/run/<N>/context.json`:
`number`, `title`, `author`, `isOwn`, `state`, `status`, `baseFallback`. Ask nothing before the review.
No `context.json` → tell the user to run `/pr-review <N>` and stop.

## 1. Review

1. `review_prepare` with `pr`, `kind: "review"`. An answer starting with `review-kit:` → report it, `review_finish`, stop.
2. `Workflow` with the workflow's `scriptPath` and `args` (a JSON object). This instruction is the user's opt-in to the
   workflow. Wait for its completion notification; do nothing else meanwhile.
3. `review_collect` with `pr`, `id: "funnel"`, `outputFile` = the notification's `<output-file>`.
4. The workflow failed, left no output file, or `review_collect` answered `review-kit: …` → report «Ревью агентами не
   состоялось — не проверено» with that line, never a verdict; `review_finish`, stop.

## 2. Report

In Russian, in this order:
1. `Статус: <status>` from `context.json`.
2. The verdict with one line of reason: Blocked if any critical, Changes requested if any important, Approved with comments
   if only minor, Approved if none.
3. Each finding: its `id`, `file:line`, level (and its `mark`, if any), the problem, its failure scenario or the rule it breaks.
4. «Подтверждено, ниже порога», when `belowBar` is not empty: one line each, `<file>:<line> — <problem> · <level> · <confidence>%`
   (plus ` · <mark>`). These are never published.
5. «Не проверялось» — always: every `notChecked` entry, the count of `dropped` by reason, and, when `baseFallback` is true,
   «база ревью взята от main: базовая ветка PR удалена — в diff могут попасть чужие коммиты».

Levels: **critical** — breaks the product, loses data, or is exploitable; **important** — a measurable regression, a
concrete risk, or a project-rule violation a reviewer would send back; **minor** — style, naming, preference. A finding
states the problem, not the author. A rule quote stays in the report, never in a published comment.

Own PR (`isOwn`) or closed PR: the report is the result — `review_finish`, stop. A foreign open PR with no findings →
end with «Апрувим?».

## 3. Publish — only when the user asks

No findings and the user approves → `review_publish` with `pr`, `ids: []`, `approve: true` (the mod asks «Одобрить PR <N>
без комментариев?» itself) → section 4.

Otherwise AskUserQuestion «Где разбираем тексты ревью?» — «В чате», «В Plannotator». A prompt saying the user typed `/pr-view`
skips the question → «In Plannotator».

### In chat

1. The user names the findings to publish (or «все»). Write `.review-kit/run/<N>/texts.json` =
   `{"summary": "<2–4 sentences about the problem, not the author; never mentions belowBar>", "comments": {"<id>": "<comment in Russian>"}}`,
   one comment per selected id.
2. Show the summary and every draft (`id`, `file:line`, text); apply the user's edits to `texts.json` until they say it is ready.
3. `review_publish` with `pr`, `ids`, and `approve: true` only if the verdict is Approved or Approved with comments and the
   user wants to approve. The tool shows the review and asks the user itself → section 4.

### In Plannotator

1. Write `texts.json` as in «In chat» step 1 for **every** finding; do not show the drafts in chat.
2. `review_plannotator` with `pr`. `unavailable: …` → show it and ask «Разобрать в чате?»; yes → «In chat»; no →
   `review_finish`, stop.
3. `started: …` → tell the user the URL, and that a rewritten comment must keep its first line `[id · …]`. End the turn and
   do nothing until a message «Plannotator result for PR <N>: …» arrives.
4. On it: `failed` → as step 2 `unavailable`. Read `.review-kit/run/<N>/plannotator/result.json` with Read (never `cd` into the
   run folder: `review_finish` deletes it):
   - `dismissed` → «Ревью не публикуется: Plannotator закрыт без решения» → `review_finish`, stop;
   - empty `ids` and an empty `summary` in `plannotator/texts.json` → «Публиковать нечего» → `review_finish`, stop;
   - otherwise show the summary and every comment of `plannotator/texts.json` (`h…` ids are the human's own; edits the user
     asks for go into that file first), then `review_publish` with `pr`, `ids` from result.json, `from: "plannotator"` → section 4.

## 4. Finish

`published: <url>` → report the URL. `not published: …` → show the reason. An error with «статус публикации неизвестен» →
tell the user to check the PR before anything else; never publish again. Then `review_finish`.

The user does not want to publish → `review_finish`. Every stop of this skill ends with `review_finish`. Never call curl
or the hosting API; publishing goes only through `review_publish`.
