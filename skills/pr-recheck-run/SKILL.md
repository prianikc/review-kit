---
name: pr-recheck-run
description: Use when review-kit opened a recheck run for a PR the user reviewed before (.review-kit/run/<N>/context.json with scenario recheck exists).
---

# pr-recheck-run

Read `.review-kit/run/<N>/context.json` (`status`) and `.review-kit/run/<N>/recheck.json` (`mode` — `delta` since my last
review or `full` with `note`; `prior` — my earlier comments). No `context.json` → tell the user to run `/pr-recheck <N>`
and stop. Ask nothing before the report.

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
     PR head and write `.review-kit/run/<N>/statuses.json` = `{"items": [{"id", "class": "closed"|"open"|"partial", "reason"}]}`.
   - `delta` failed → the report has «Дельта не проверена — <line>» instead of findings and no verdict.
4. Report in Russian (the guide is not repeated): `Статус: <status>`; «Режим: дельта после моего ревью» (with `note` → «… — <note>») or «Режим: проверено всё — <note>»;
   «Прошлые замечания» — each `prior` item as `<path>:<line>` (or «общее») — закрыто / не закрыто / частично / не проверено —
   reason; then «Подтверждённые», «Подтверждено, ниже порога», «Не подтверждено» and «Не проверялось» as in section 2 of review-kit:pr-review-run. Verdict:
   Blocked if any critical; Changes requested if any important finding or any `open`/`partial` earlier comment; otherwise Approved.
5. Publish: section 3 of review-kit:pr-review-run; `review_publish` adds the statuses of
   `statuses.json` to the review body itself.
6. `review_finish`. Every stop of this skill ends with `review_finish`.
