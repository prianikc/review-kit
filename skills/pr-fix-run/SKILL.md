---
name: pr-fix-run
description: Use when the review-kit mod opened a fix run for the user's own Forgejo PR, or pr-feedback handed its triaged items over for fixing.
---

# pr-fix-run

Read `.review-kit/run/<N>/context.json`. Items to fix: the `valid` entries without `fixed` of `.review-kit/run/<N>/triage.json`, or every entry of
`.review-kit/run/<N>/lite/findings.json` after a review of the own PR. Neither file → do step 1 of review-kit:pr-feedback-run first.

1. Run exactly: `git status --porcelain --ignore-submodules=all > .review-kit/run/<N>/status-before.txt`, then, with the Bash timeout 600000:
   `python3 .claude/skills/review-kit/tools/checks_baseline.py snapshot --out .review-kit/run/<N>/baseline.json`
2. Enter Plan Mode, plan the fixes of exactly these items with superpowers:writing-plans, exit Plan Mode, wait for approval, edit.
3. With the Bash timeout 600000 run exactly:
   `python3 .claude/skills/review-kit/tools/checks_baseline.py compare --baseline .review-kit/run/<N>/baseline.json`
   Exit 1 → fix the listed new errors and repeat step 3; after the 3rd failing round ask «Продолжать или остановиться?».
   Old errors are only mentioned. The round's paths = paths in `git status --porcelain --ignore-submodules=all` that are not in `status-before.txt`.
3a. Once per round, after step 3 first passes: AskUserQuestion «Запустить /simplify по правкам раунда?» — «Да», «Нет». «Нет» → step 4.
   «Да» → invoke the `simplify` skill with: «Review only the uncommitted changes of this round in: <round paths>.
   Findings only: skip Phase 2 — do not edit any file. Return every finding.» Show them as `S-<n>` `file:line` — problem,
   suggestion. AskUserQuestion «Какие применить?» — «Все», «Ни одной» (the user names ids in «Other»). Apply only the chosen
   ones, then step 3 again (they are part of the round). «Ни одной» → step 4.
4. AskUserQuestion «Прогнать агентов по diff правок?» — yes → `bash .claude/skills/review-kit/tools/snapshot -- <round paths>` prints `<snap>`;
   run the agents funnel of review-kit:pr-review-run (steps 1–4) with `--base HEAD --head <snap>` and
   `--out .review-kit/run/<N>/fix-funnel` (its `funnel_finish` `--out` too); report its findings; fix what the user picks, back to step 3.
5. Call `review_plannotator` with `pr` and `mode: "fix"`. `started` → tell the user the URL and end the turn.
   `unavailable` → stop with the reason: Plannotator is required before a push.
6. On «Plannotator result for PR <N> (fix): …»: `approved` → step 7; `annotated` → read `.review-kit/run/<N>/plannotator/feedback.md`
   as new items and go back to step 2; `dismissed` → «Раунд остановлен, правки в дереве», stop without `review_finish`;
   `failed` → show the reason, stop without `review_finish`.
7. Commit and push. Message `[<ticket>] fix(<scope>): <суть раунда>` — one line, past tense, Russian, no `#N`, ticket from the branch name.
   Paths = the round's paths. `baseHead` = `git rev-parse HEAD`. Unpushed commits = `git log --oneline @{u}..`.
   Call `review_confirm` with `action: "commit-push"`, `pr`, `branch`, `baseHead`, `message`, `paths`, `summary` = the unpushed list.
   `confirmed` → run exactly, one line, nothing appended:
   `bash .claude/skills/review-kit/tools/commit-push --branch <branch> --base-head <baseHead> --message "<message>" -- <paths>`
   Non-zero exit → show stderr; never retry with other arguments, never `--force`.
8. Replies (below), then `review_finish`.

## Replies

For every item not fixed in this round (`invalid`, `question`, `out-of-scope`, items marked `disagree`, and `valid` items with `fixed`)
write a draft in Russian to `.review-kit/run/<N>/replies.json` = `{"replies": {"<id>": "<text>"}}`: invalid — the explanation; question —
the answer or a counter-question; out-of-scope — where it went; `fixed` — «Сделано: …» from its `reason`. Items fixed in this round get no reply. Show every draft as `<path>:<position>` (or «общий») — text,
apply the user's edits. Then run exactly:
`python3 .claude/skills/review-kit/tools/replies.py build --items .review-kit/run/<N>/intake.json --replies .review-kit/run/<N>/replies.json > .review-kit/run/<N>/replies-payload.json`
Call `review_confirm` with `action: "publish-replies"`, `pr`, `payloadPath: ".review-kit/run/<N>/replies-payload.json"`, `summary`.
`confirmed` → run exactly: `python3 .claude/skills/review-kit/tools/forgejo.py post-replies <N> --payload .review-kit/run/<N>/replies-payload.json`

Every stop ends with `review_finish`, except the Plannotator `dismissed`/`failed` stops. Never call curl, never `git commit`/`git push` directly.
