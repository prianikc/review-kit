---
name: pr-fix-run
description: Use when review-kit opened a fix run for the user's own PR, or review-kit:pr-feedback-run handed its triaged items over for fixing — plan, edit, check, commit and push the round.
user-invocable: false
---

# pr-fix-run

Read `.review-kit/run/<N>/context.json`. Items to fix: the `valid` entries without `fixed` of `.review-kit/run/<N>/triage.json`,
or every blocking entry of `.review-kit/run/<N>/findings.json` after a review of the own PR. Items to move to TODO: the
`todo` entries of `triage.json`, or every non-blocking entry of `findings.json`.
The reviewer never writes files into this branch — the TODOs and the roadmap are written and pushed here, by the PR's author. Neither file → do section 1 of
review-kit:pr-feedback-run first.

The round needs a fresher base of a PR stack → the user merges and pushes it before the round. A merge inside the run
is allowed, but `commit_push` refuses until it is pushed («не продолжает базу раунда одним коммитом»).

1. Run: `git status --porcelain --ignore-submodules=all > .review-kit/run/<N>/status-before.txt`
2. Enter Plan Mode. The plan lists, per item: the file and the change to make, or — for a TODO item — the TODO line and
   the roadmap entry below. Exit Plan Mode, wait for approval, edit. A TODO item: above the commented place, a comment
   in the file's own syntax `TODO(review #<N>): <the comment's text after «TODO: », or its gist in one sentence> —
   <roadmap>`, `roadmap` from `context.json`; then the roadmap file gets the item — create it with the heading
   `# PR <N> — ревью-фиксы` when absent, add `- [ ] <file>:<line> — <text> (замечание: <author>, <place>)`, skip an
   item whose `<file>:<line>` is already listed. The user may move a TODO item to «чиним сейчас». The roadmap is one of
   the round's paths.
3. The round's paths = paths in `git status --porcelain --ignore-submodules=all` that are not in `status-before.txt`.
   The kit runs no checks: the project's pre-commit hook runs them at commit time.
4. AskUserQuestion «Прогнать агентов по diff правок?» — yes → `review_prepare` with `pr`, `kind: "fix-check"`,
   `paths` = the round's paths; `Workflow` with its `scriptPath`/`args`; `review_collect` with `id: "fix-check"`. The agents
   see the PR's threads too and check each fix against the reviewer's comment and our reply in that thread; a finding with
   `thread` names it — «<thread>: ответили одно, сделали другое». Report the findings; fix what the user picks, then recompute the round's paths (step 3) and ask this question again. A failure here →
   «Ревью агентами не состоялось — не проверено» with the line, go on to step 5 — never `review_finish` from this step.
5. Show the round's diff: `git diff -- <paths>` for tracked paths, `git diff --no-index /dev/null <file>` for new ones.
   AskUserQuestion «Правки PR <N> перед push» — «Пушим» → step 7; «Есть замечания» → the user's text becomes new items,
   back to step 2; «Остановить» → «Раунд остановлен, правки в дереве», stop without `review_finish` (the run stays open:
   a new run would stash the round's edits; `/pr <N>` in this session continues it — never `/pr stop` first). Extensions: a skill among your skills whose
   description starts with `review-kit extension: fix review — <Name>.` adds the option `<Name>` — at most one, the first
   by skill name in alphabetical order; when more exist, say «Расширения не поместились: <names>» before the question.
   That option → use that skill (Skill tool) for PR <N> with the round's paths; this skill ends there and the extension
   comes back at step 6.
6. The extension's result (this step is the extensions' entry point): `approved` → step 7; `annotated` with a feedback
   file → read it as new items, back to step 2; `dismissed` or `failed` → show the reason, stop without `review_finish`.
7. Commit and push. Message `[<ticket>] fix(<scope>): <суть раунда>` — one line, past tense, Russian, no `#N`, ticket from the
   branch name. `commit_push` with `pr`, `message`, `paths` = the round's paths; the tool asks the user itself.
   - `pushed: …` → step 8.
   - `not done: … коммита нет — <hook output>` → show it, fix what it reports, recompute the round's paths (step 3), `commit_push` again.
   - `not done: изменены файлы вне списка …` → add those paths to the round or revert them, `commit_push` again.
   - `not pushed: ветка на origin ушла вперёд …` → ask the user to run `! git pull --rebase` themselves, or `git pull --rebase`
     in their own terminal if `!` is refused, then
     `commit_push` again with the same message.
   - `not pushed: push не прошёл …` → offer `commit_push` again; it only pushes.
8. Use the review-kit:pr-replies-run skill for PR <N>.

Every stop ends with `review_finish`, except the stops of steps 5–6.
Never call curl, never `git commit`/`git push`/`git rebase` yourself, never `--force`.
