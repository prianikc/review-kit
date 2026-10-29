---
name: pr-fix-run
description: Use when review-kit opened a fix run for the user's own PR, or pr-feedback-run handed its triaged items over for fixing.
---

# pr-fix-run

Read `.review-kit/run/<N>/context.json`. Items to fix: the `valid` entries without `fixed` of `.review-kit/run/<N>/triage.json`,
or every blocking entry of `.review-kit/run/<N>/findings.json` after a review of the own PR. Items to move to TODO: the
`todo` entries of `triage.json`, or every non-blocking entry of `findings.json`.
The reviewer never writes files into this branch — the TODOs and the roadmap are written and pushed here, by the PR's author. Neither file → do section 1 of
review-kit:pr-feedback-run first.

0. Dependencies, before any edit: `superpowers:writing-plans` is not among your skills → «Для раунда правок нужен плагин
   superpowers», `review_finish`, stop. `plannotator: false` in `context.json` → «Для раунда правок нужен Plannotator
   (проверка правок перед push)», `review_finish`, stop.
   The round needs a fresher base of a PR stack → the user merges and pushes it before the round. A merge inside the run
   is allowed, but `commit_push` refuses until it is pushed («не продолжает базу раунда одним коммитом»).
1. Run: `git status --porcelain --ignore-submodules=all > .review-kit/run/<N>/status-before.txt`
2. Enter Plan Mode, plan the fixes and the TODOs of exactly these items with superpowers:writing-plans, exit Plan Mode,
   wait for approval, edit. A TODO item: above the commented place, a comment in the file's own syntax
   `TODO(review #<N>): <the comment's text after «TODO: », or its gist in one sentence> — <roadmap>`, `roadmap` from
   `context.json`; then the roadmap file gets the item — create it with the heading `# PR <N> — ревью-фиксы` when absent,
   add `- [ ] <file>:<line> — <text> (замечание: <author>, <place>)`, skip an item whose `<file>:<line>` is already
   listed. The user may move a TODO item to «чиним сейчас». The roadmap is one of the round's paths.
3. The round's paths = paths in `git status --porcelain --ignore-submodules=all` that are not in `status-before.txt`.
   The kit runs no checks: the project's pre-commit hook runs them at commit time.
4. AskUserQuestion «Прогнать агентов по diff правок?» — yes → `review_prepare` with `pr`, `kind: "fix-check"`,
   `paths` = the round's paths; `Workflow` with its `scriptPath`/`args`; `review_collect` with `id: "fix-check"`. The agents
   see the PR's threads too and check each fix against the reviewer's comment and our reply in that thread; a finding with
   `thread` names it — «<thread>: ответили одно, сделали другое». Report the findings; fix what the user picks, then recompute the round's paths (step 3) and ask this question again. A failure here →
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

For every item write a draft to `.review-kit/run/<N>/replies.json` = `{"replies": {"<id>": "<text>"}}`: fixed in this round
or earlier (`fixed`) — exactly «Исправлено»; moved to TODO — «Перенесено в TODO: <file>:<line>»; invalid, question, out-of-scope — «Не исправлено: <one sentence: the reason, the
answer to the question, or where it went>». No sha, no retelling of the change. Without a reply the thread stays open and the PR keeps the status
«есть замечания». Show every draft as `<path>:<position>` (or «общий») — text and apply the
user's edits. Then `replies_publish` with `pr` (it asks the user itself): `published: <n>` → report; `not published: …` →
show the reason.

Every stop ends with `review_finish`, except the Plannotator `unavailable`/`dismissed`/`failed` stops of steps 5–6.
Never call curl, never `git commit`/`git push`/`git rebase` yourself, never `--force`.
