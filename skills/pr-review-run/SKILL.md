---
name: pr-review-run
description: Use when review-kit opened a review run for a PR (.review-kit/run/<N>/context.json exists, scenario review) — review it with the agents and report. Publishing is review-kit:pr-publish-run. Not for own fixes.
user-invocable: false
---

# pr-review-run

The mod already switched the tree to the PR and opened the run; the agents run on the session's model. Read `.review-kit/run/<N>/context.json`:
`number`, `title`, `author`, `isOwn`, `state`, `status`, `baseFallback`, `baseNote`. Ask nothing before the review.
No `context.json` → tell the user to run `/pr <N> review` and stop.

## 1. Review

1. `review_prepare` with `pr`, `kind: "review"`. An answer starting with `review-kit:` → report it, `review_finish`, stop. Do not review the changes yourself, give no verdict and offer no publishing — unless the user asks for it in a new message.
2. `Workflow` with the workflow's `scriptPath` and `args` (a JSON object). This instruction is the user's opt-in to the
   workflow. It runs in the background.
3. While the agents work, show the guide so the user reads what they are reviewing: say «Агенты проверяют PR <N> —
   пока гайд по изменениям:» and follow the `review-kit:guide` skill (Skill tool) with target `<N>`. Its failure does not
   stop the review — show its `review-kit: …` line. Then end the turn with «Отчёт придёт, когда агенты закончат.» and do
   nothing else until the workflow's completion notification arrives. The notification arrived before the guide was
   done → finish the guide first.
4. `review_collect` with `pr`, `id: "funnel"`, `outputFile` = the notification's `<output-file>`.
   An answer starting with «PR изменился во время прогона:» → show that line, no report, no verdict, no publishing;
   AskUserQuestion «PR изменился во время прогона — что делаем?» — «Перезапустить» (`review_finish`, then `review_start`
   with `pr` and follow its answer), «Остановить» (`review_finish`, stop). An answer starting with «свежесть PR не
   проверена:» → show that line first in the report and go on as usual.
5. The workflow failed, left no output file, or `review_collect` answered `review-kit: …` → report «Ревью агентами не
   состоялось — не проверено» with that line, never a verdict; `review_finish`, stop. Do not review the changes yourself, give no verdict and offer no publishing — unless the user asks for it in a new message.

## 2. Report

The guide was shown in section 1; do not repeat it.

`findings.json` holds `findings` (confirmed), `belowBar` (confirmed, below the bar), `unconfirmed` (refuted or dropped by
a check; `mark` says why, `evidence` has C's argument), `dropped` (ids with reasons), `notChecked` and `discussion` — the
PR's threads before this run (`threads`: `id`, `place`, `status`, `last` — whose word is last, `lastAuthorReply`), `open` —
ids of the open threads, `questions` — questions with no answer. Every finding has `thread` (`T<n>` or `null`); a
follow-up to a thread also has `followUp`. In Russian, in this order:
1. `Вердикт: <verdict>` with one line of reason, from `findings` and the open threads: Changes requested if any blocking
   finding (including a follow-up to an earlier thread), Approved with comments if only non-blocking, Approved if none.
   Open threads alone never decide the verdict — an earlier comment that is still not fixed comes back from the agents
   as a follow-up finding.
2. `Статус: <status>` from `context.json`.
3. «Подтверждённые» — each of `findings`: `<id> · <блокирует: <category> | не блокирует>[ · <mark>][ · <thread>] · <file>:<lines>` — the problem; its
   failure scenario or the rule it breaks; with `followUp` also «follow-up к <thread>: <followUp>».
   Then «Обсуждение PR» — the open threads of `discussion.open` as `<id> · <place> · последнее слово: <last>`, the author's
   answers (`lastAuthorReply`, quoted), and every `questions` entry; nothing of that → «обсуждения нет».
4. «Подтверждено, ниже порога» — each of `belowBar` in the same form plus `<confidence>%`.
5. «Не подтверждено» — each of `unconfirmed` in the same form plus the reason: «опровергнуто: <evidence>» or the `mark`.
6. «Не проверялось» — every `notChecked` entry, duplicates from `dropped` as «<id> — дубль <id>», and, when `baseFallback`
   is true, «база ревью взята от main: базовая ветка PR удалена — в diff могут попасть чужие коммиты»; when `baseNote`
   is present, `baseNote` as is. A finding dropped as a repeat of a thread sits in «Не подтверждено» with its `mark`
   («повтор T1, автор ответил: …» or «закрыто в обсуждении»).
A section with no entries is left out, except «Не проверялось».

Levels: **blocking** — only five categories: `regression` (something that worked before the PR is broken), `goal` (the
task's goal is not reached), `architecture`, `security`, `rule` (a project rule is broken); **non-blocking** — everything
else: a bug in new code that breaks nothing that worked and does not defeat the goal, an edge case, a missing test,
style, naming. Non-blocking findings go to the author as TODOs, fixed in a later PR. A finding states the problem, not
the author. A rule quote stays in the report, never in a published comment.

## 3. Next

Own PR (`isOwn`) or closed PR: the report is the result — `review_finish`, stop. A foreign open PR: use the
review-kit:pr-publish-run skill for PR <N> right after the report.

`review_finish` answers with a `worktree … удалён` line when the review ran in its own review worktree: show that line as
the last thing and call no tools after it — the tree is gone. A `worktree … оставлен` line → show it.
