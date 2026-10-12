---
name: pr-recheck-run
description: Use when the review-kit mod or review_start opened a recheck run for a Forgejo PR the user reviewed before (.review-kit/run/<N>/context.json with scenario recheck exists).
---

# pr-recheck-run

Read `.review-kit/run/<N>/context.json` (`head`, `baseRef`, `model`, `mode`, `scenario`). No `context.json` → tell the user to run
`/pr-recheck <N>` and stop. Ask nothing before the report.

1. Run exactly: `python3 .claude/skills/review-kit/tools/recheck_prep.py <N> --head <head> --base-ref <baseRef> --out .review-kit/run/<N>`
   It writes `.review-kit/run/<N>/recheck.json`: `base`, `mode` (`delta` — since my last review; `full` — history was rewritten, with `note`),
   `prior` (my earlier comments). Exit 5 → show stderr, `review_finish`, stop.
2. Statuses of my earlier comments.
   - `mode: "agents"` in `context.json`: run exactly
     `python3 .claude/skills/review-kit/tools/triage_prep.py --pr <N> --mode recheck --items .review-kit/run/<N>/recheck.json --base <recheck base> --head <head> --model <model> --out .review-kit/run/<N>/triage`,
     call `Workflow` with `scriptPath: ".claude/skills/review-kit/funnel/triage.js"` and the printed JSON as `args` (this instruction is the
     user's opt-in), wait, `cp <output-file> .review-kit/run/<N>/triage/raw.json`, then run exactly
     `python3 .claude/skills/review-kit/tools/triage_finish.py --raw .review-kit/run/<N>/triage/raw.json --items .review-kit/run/<N>/recheck.json --mode recheck --out .review-kit/run/<N>`
     Any failure → «Статусы агентом не проверены», then do them yourself.
   - `mode: "lite"`: for each `prior` item read the place at `head`, write `.review-kit/run/<N>/statuses.json` =
     `{"items": [{"id", "class": "closed"|"open"|"partial", "reason"}]}`.
3. Review the delta: section 1 of review-kit:pr-review-run with `--base <recheck base>` instead of `<base>`, then run exactly
   `python3 .claude/skills/review-kit/tools/review_payload.py keep --findings .review-kit/run/<N>/lite/findings.json --min-severity important`
   — a recheck reports only Critical and Important.
4. Report in Russian: «Режим: дельта после моего ревью» or «Режим: проверено всё — <note>»; then «Прошлые замечания» — each `prior` item
   as `<path>:<line>` (or «общее») — закрыто / не закрыто / частично / не проверено — reason; then the findings as in section 2 of
   review-kit:pr-review-run; then «Не проверялось». Verdict: Blocked if any critical; Changes requested if any important finding or any
   `open`/`partial` earlier comment; otherwise Approved.
5. Publish only when the user asks: section 3 of review-kit:pr-review-run, with `--statuses .review-kit/run/<N>/statuses.json
   --prior .review-kit/run/<N>/recheck.json` added to its `review_payload.py build` command.
6. `review_finish`. Every stop of this skill ends with `review_finish`.
