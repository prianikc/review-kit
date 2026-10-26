---
name: pr-review-run
description: Use when review-kit opened a review run for a PR (.review-kit/run/<N>/context.json exists, scenario review) — review it with the agents, report and publish the way the user picks. Not for own fixes.
---

# pr-review-run

The mod already switched the tree to the PR, asked for the model and opened the run. Read `.review-kit/run/<N>/context.json`:
`number`, `title`, `author`, `isOwn`, `state`, `status`, `baseFallback`. Ask nothing before the review.
No `context.json` → tell the user to run `/pr-review <N>` and stop.

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
5. The workflow failed, left no output file, or `review_collect` answered `review-kit: …` → report «Ревью агентами не
   состоялось — не проверено» with that line, never a verdict; `review_finish`, stop. Do not review the changes yourself, give no verdict and offer no publishing — unless the user asks for it in a new message.

## 2. Report

The guide was shown in section 1; do not repeat it.

`findings.json` holds `findings` (confirmed), `belowBar` (confirmed, below the bar), `unconfirmed` (refuted or dropped by
a check; `mark` says why, `evidence` has C's argument), `dropped` (ids with reasons), `notChecked` and `discussion` — the
PR's threads before this run (`threads`: `id`, `place`, `status`, `last` — whose word is last, `lastAuthorReply`), `open` —
ids of the open threads, `questions` — questions with no answer. Every finding has `thread` (`T<n>` or `null`); a
follow-up to a thread also has `followUp`. In Russian, in this order:
1. `Вердикт: <verdict>` with one line of reason, from `findings` and the open threads: Blocked if any critical, Changes
   requested if any important or any thread in `discussion.open`, Approved with comments if only minor, Approved if none.
2. `Статус: <status>` from `context.json`.
3. «Подтверждённые» — each of `findings`: `<id> · <level>[ · <mark>][ · <thread>] · <file>:<lines>` — the problem; its
   failure scenario or the rule it breaks; with `followUp` also «follow-up к <thread>: <followUp>».
   Then «Обсуждение PR» — the open threads of `discussion.open` as `<id> · <place> · последнее слово: <last>`, the author's
   answers (`lastAuthorReply`, quoted), and every `questions` entry; nothing of that → «обсуждения нет».
4. «Подтверждено, ниже порога» — each of `belowBar` in the same form plus `<confidence>%`.
5. «Не подтверждено» — each of `unconfirmed` in the same form plus the reason: «опровергнуто: <evidence>» or the `mark`.
6. «Не проверялось» — every `notChecked` entry, duplicates from `dropped` as «<id> — дубль <id>», and, when `baseFallback`
   is true, «база ревью взята от main: базовая ветка PR удалена — в diff могут попасть чужие коммиты». A finding
   dropped as a repeat of a thread sits in «Не подтверждено» with its `mark` («повтор T1, автор ответил: …» or «закрыто в
   обсуждении»).
A section with no entries is left out, except «Не проверялось».

Levels: **critical** — breaks the product, loses data, or is exploitable; **important** — a measurable regression, a
concrete risk, or a project-rule violation a reviewer would send back; **minor** — style, naming, preference. A finding
states the problem, not the author. A rule quote stays in the report, never in a published comment.

Own PR (`isOwn`) or closed PR: the report is the result — `review_finish`, stop.

## 3. Publish

A foreign open PR: right after the report, AskUserQuestion «Как публикуем ревью PR <N>?» — «Сразу, без Plannotator»,
«Открыть с аннотациями в Plannotator», «Не публиковать». When `.review-kit/run/<N>/hotspots.json` has items (the guide's
narrow places), the Plannotator option splits in two: «Plannotator: только находки» and «Plannotator: находки и узкие
места гайда». A prompt saying the user typed `/pr-view` skips the question → «Plannotator» with findings only.
«Не публиковать» → section 4.

Texts: `.review-kit/run/<N>/texts.json` = `{"summary": "<2–4 sentences about the problem, not the author>", "comments":
{"<id>": "<comment in Russian>"}}`.

### Directly

1. List every finding of the three groups, one line each: `<id> · <подтверждена | ниже порога | не подтверждена> · <level>
   · <file>:<line> — <problem>`. Ask in text «Какие публикуем? Номера через запятую или «все»» and end the turn.
   No findings at all → skip the list, `ids: []`. The user's answer to «Как публикуем?» or to this list may already name
   the verdict and the ids («апрувим без комментариев» → approve, `ids: []`; «запросить изменения по A-1» → request
   changes, `ids: ["A-1"]`) — then skip the list.
2. Write `texts.json` with a comment for each chosen id. No ids chosen → no `texts.json`: the approval goes out bare —
   no body and no comments anywhere.
3. `review_publish` with `pr`, `ids`, and `verdict` (`approve` | `request-changes`) whenever the user named one — it
   overrides the computed verdict. Without it the tool picks the verdict itself: critical or important findings, an
   open thread of the PR, or in a recheck an open or partial earlier comment → request changes, otherwise approve. It shows the review and asks the user
   itself → section 4. An approval without chosen findings is published without any text, whatever `texts.json` says.
   Never tell the user what verdict went out before the tool's answer names it.

### Plannotator

1. Write `texts.json` with a comment for every finding of the three groups; do not show the drafts in chat.
2. `review_plannotator` with `pr`, and `hotspots: true` when the user chose the narrow places too. `unavailable: …` → show
   it and go to «Directly».
3. `started: …` → tell the user the URL: «Отправить аннотации» — запросить изменения с ними, «Approve» — одобрить (оставшиеся
   аннотации уйдут комментариями), a rewritten comment keeps its first line `[id · …]`. With narrow places also: they are
   hints for reading, headed `[gN · узкое место гайда]`, and never published while that line stays — to publish one as
   your own comment, delete that line. End the turn and do nothing until a message «Plannotator result for PR <N>: …»
   arrives. The user asks meanwhile to add the guide's narrow places → `review_plannotator` with `pr`, `hotspots: true`
   (it adds them to the open session), show its line, end the turn again.
4. On it: `failed` → show the reason and go to «Directly». `dismissed` → «Ревью не публикуется: Plannotator закрыт без
   решения» → section 4. Otherwise `review_publish` with `pr`, `ids` from `.review-kit/run/<N>/plannotator/result.json`
   (read it with Read; never `cd` into the run folder), `from: "plannotator"` — it publishes without asking → section 4.

## 4. Finish

`published: <url> (вердикт …)` → report the URL and that verdict. An error with «статус публикации неизвестен» → tell the
user to check the PR before anything else; never publish again. Then `review_finish`.

`not published: пользователь отказал (вердикт <V>)` or `not published: окно подтверждения не открылось — … (вердикт <V>)`
→ the run stays open: say which verdict the dialog offered, then AskUserQuestion «Что делаем с ревью PR <N>?» —
«Одобрить» (`verdict: "approve"`), «Запросить изменения» (`verdict: "request-changes"`), «Изменить выбор находок» (back to
«Directly» step 1), «Не публиковать». A verdict option → `review_publish` again with the same `ids` and that `verdict`, then
this section again. «Не публиковать» → `review_finish`. Any other `not published: …` → show the reason, then `review_finish`.

The user does not want to publish → `review_finish`. Every stop of this skill ends with `review_finish`. Never call curl
or the hosting API; publishing goes only through `review_publish`.

`review_finish` answers with a `worktree … удалён` line when the review ran in its own worktree (a `/pr all` tab): show
that line as the last thing and call no tools after it — the tab's tree is gone. A `worktree … оставлен` line → show it.
