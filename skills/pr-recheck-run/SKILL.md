---
name: pr-recheck-run
description: Use when review-kit opened a recheck run for a PR the user reviewed before (.review-kit/run/<N>/context.json with scenario recheck exists).
---

# pr-recheck-run

Read `.review-kit/run/<N>/context.json` (`status`) and `.review-kit/run/<N>/recheck.json` (`mode` — `delta` since my last
review or `full` with `note`; `prior` — my earlier comments). No `context.json` → tell the user to run `/pr-recheck <N>`
and stop. Ask nothing before the report, except the author's answers of step 4.

1. `review_prepare` with `pr`, `kind: "recheck"` → two workflows, `statuses` and `delta`. An answer `review-kit: …` →
   report it, `review_finish`, stop. Do not review the changes yourself, give no verdict and offer no publishing — unless the user asks for it in a new message.
2. `Workflow` for both (they may run together; this instruction is the user's opt-in). They run in the background.
3. While the agents work, show the guide: say «Агенты перепроверяют PR <N> — пока гайд по изменениям после вашего
   ревью:» and follow the `review-kit:guide` skill (Skill tool) with target `<N>` — inside the run it covers the delta
   since my review (in mode `full` — the whole PR, with the note). Its failure does not stop the recheck — show its
   `review-kit: …` line. Then end the turn with «Отчёт придёт, когда агенты закончат.» and do nothing else until both
   notifications arrive; a notification that arrives before the guide is done waits for it. Then `review_collect` for
   each with its `id` and `<output-file>`.
   - `statuses` failed → «Статусы агентом не проверены», then do them yourself: for each `prior` item read the place at the
     PR head and write `.review-kit/run/<N>/statuses.json` = `{"items": [{"id", "class": "closed"|"open"|"partial"|"answered", "reason"}]}`
     (`answered` — the code is not fixed, but the item's `replies` hold the author's answer on substance).
   - `delta` failed → the report has «Дельта не проверена — <line>» instead of findings and no verdict.
4. The author's answers. Every `answered` item of `statuses.json` waits for the user before any verdict. For each — in
   AskUserQuestion, up to 4 questions per call — the question «<path>:<line> — принимаем ответ автора?» with my comment,
   the author's replies from the item's `replies` in `recheck.json` and the agent's `reason` in the question text; options
   «Принять», «Не принять», «Не принять и написать автору». Then rewrite that item in `statuses.json` with Write, keeping
   the others: «Принять» → `"class": "accepted"`, `reason` — the author's argument in a few words; «Не принять» →
   `"class": "open"`, `reason` — «ответ автора не принят» plus the user's note if any; «Не принять и написать автору» →
   ask in text «Что написать автору?», end the turn, then `"class": "open"`, `reason` — «ответ автора не принят», and
   `"message"` — the user's words; `review_publish` posts them as a reply in that comment's thread. `review_publish` refuses while any `answered` is left.
5. Report in Russian (the guide is not repeated): `Статус: <status>`; «Режим: дельта после моего ревью» (with `note` → «… — <note>») or «Режим: проверено всё — <note>»;
   «Прошлые замечания» — each `prior` item as `<path>:<line>` (or «общее») — закрыто / закрыто — принят ответ автора / не
   закрыто / частично / не проверено — reason; then «Подтверждённые», «Обсуждение PR», «Подтверждено, ниже порога», «Не подтверждено» and «Не проверялось» as in section 2 of review-kit:pr-review-run. Verdict:
   Blocked if any critical; Changes requested if any important finding, any `open`/`partial` earlier comment or any thread
   in `discussion.open` of `findings.json` that is not an earlier comment closed or accepted above; otherwise Approved.
6. Publish: sections 3 and 4 of review-kit:pr-review-run; the statuses stay in the report — the review body does not
   repeat them; `review_publish` counts open or partial earlier comments as reasons to request changes — the user's own verdict
   («апрувим») goes in as `verdict` and overrides that. A refusal keeps the run open as section 4 says.
7. `review_finish` once publishing is done or declined. Every stop of this skill ends with `review_finish`. Its `worktree …` line is handled as in section 4
   of review-kit:pr-review-run.
