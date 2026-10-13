---
name: pr-fix-run
description: Use when review-kit opened a fix run for the user's own PR, or pr-feedback-run handed its triaged items over for fixing.
---

# pr-fix-run

Read `.review-kit/run/<N>/context.json`. Items to fix: the `valid` entries without `fixed` of `.review-kit/run/<N>/triage.json`,
or every entry of `.review-kit/run/<N>/findings.json` after a review of the own PR. Neither file → do section 1 of
review-kit:pr-feedback-run first.

0. Dependencies, before any edit: `superpowers:writing-plans` is not among your skills → «Для раунда правок нужен плагин
   superpowers», `review_finish`, stop. `plannotator: false` in `context.json` → «Для раунда правок нужен Plannotator
   (проверка правок перед push)», `review_finish`, stop.
1. Run: `git status --porcelain --ignore-submodules=all > .review-kit/run/<N>/status-before.txt`
2. Enter Plan Mode, plan the fixes of exactly these items with superpowers:writing-plans, exit Plan Mode, wait for approval, edit.
3. The round's paths = paths in `git status --porcelain --ignore-submodules=all` that are not in `status-before.txt`.
   The kit runs no checks: the project's pre-commit hook runs them at commit time.
4. AskUserQuestion «Прогнать агентов по diff правок?» — yes → `review_prepare` with `pr`, `kind: "fix-check"`,
   `paths` = the round's paths; `Workflow` with its `scriptPath`/`args`; `review_collect` with `id: "fix-check"`. Report the
   findings; fix what the user picks, then recompute the round's paths (step 3) and ask this question again. A failure here →
   «Ревью агентами не состоялось — не проверено» with the line, go on to step 5 — never `review_finish` from this step.
5. `review_plannotator` with `pr`, `mode: "fix"`. `started` → tell the user the URL and end the turn. `unavailable` → stop
   with the reason (Plannotator is required before a push), without `review_finish`: the edits stay in the tree and the run
   stays open, so `/pr-fix <N>` continues after the cause is fixed.
6. On «Plannotator result for PR <N> (fix): …»: `approved` → step 7; `annotated` → read
   `.review-kit/run/<N>/plannotator/feedback.md` as new items and go back to step 2; `dismissed` → «Раунд остановлен, правки
   в дереве», stop without `review_finish`; `failed` → show the reason, stop without `review_finish`. The next `/pr-fix <N>`
   offers to continue the open run.
7. Commit and push. Message `[<ticket>] fix(<scope>): <суть раунда>` — one line, past tense, Russian, no `#N`, ticket from the
   branch name. `commit_push` with `pr`, `message`, `paths` = the round's paths; the tool asks the user itself.
   - `pushed: …` → step 8.
   - `not done: … коммита нет — <hook output>` → show it, fix what it reports, recompute the round's paths (step 3), `commit_push` again.
   - `not done: изменены файлы вне списка …` → add those paths to the round or revert them, `commit_push` again.
   - `not pushed: ветка на origin ушла вперёд …` → ask the user to run `! git pull --rebase` themselves, or `git pull --rebase`
     in their own terminal if `!` is refused (inside a run the mod refuses `git pull` and `git rebase` from you), then
     `commit_push` again with the same message.
   - `not pushed: push не прошёл …` → offer `commit_push` again; it only pushes.
8. Replies (below), then `review_finish`.

## Replies

For every item write a draft in Russian to `.review-kit/run/<N>/replies.json` = `{"replies": {"<id>": "<text>"}}`: invalid —
the explanation; question — the answer or a counter-question; out-of-scope — where it went; `fixed` — «Сделано: …» from its
`reason`; fixed in this round — «Исправлено в <sha>: …», what changed, with the short sha of the round's commit (from
`pushed: <sha> …`, or `git rev-parse --short HEAD`). Without a reply the thread stays open and the PR keeps the status
«есть замечания». Show every draft as `<path>:<position>` (or «общий») — text and apply the
user's edits. Then `replies_publish` with `pr` (it asks the user itself): `published: <n>` → report; `not published: …` →
show the reason.

Every stop ends with `review_finish`, except the Plannotator `unavailable`/`dismissed`/`failed` stops of steps 5–6.
Never call curl, never `git commit`/`git push`/`git rebase` yourself, never `--force`.
