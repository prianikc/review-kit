---
name: pr-publish-run
description: Use when review-kit:pr-review-run reported a foreign open PR and the review is to be published (or not) — the way the user picks.
user-invocable: false
---

# pr-publish-run

The report of review-kit:pr-review-run is already shown; `.review-kit/run/<N>/findings.json` holds the findings
(`findings`, `belowBar`, `unconfirmed`). Ask nothing before the question below.

## Publish

AskUserQuestion «Как публикуем ревью PR <N>?» — «Сразу», «Не публиковать», then the extensions: every skill among your
skills whose description starts with `review-kit extension: publish — <Name>.` adds the option `<Name>`. At most two,
the first by skill name in alphabetical order; when more exist, say «Расширения не поместились: <names>» before the
question. «Не публиковать» → «Finish» with nothing published.

Texts: `.review-kit/run/<N>/texts.json` = `{"comments": {"<id>": "<comment>"}}` — no summary: the review has no general
comment. In Russian, no failure scenario, no rule quote, no level, no greeting or thanks. A blocking comment — one or two
short sentences: what is wrong and what to change. A non-blocking comment — one sentence, the text of the future TODO;
the tool prefixes it with «TODO: » itself, never write the prefix.

An extension option → write `texts.json` with a comment for every finding of the three groups (do not show the drafts in
chat), then use that skill (Skill tool) for PR <N>. This skill ends there: the extension continues at «Finish» after
its `review_publish`, or at «Directly» when it fails. Those two headings are the extensions' entry points.

## Directly

1. List every finding of the three groups, one line each: `<id> · <подтверждена | ниже порога | не подтверждена> ·
   <блокирует: <category> | не блокирует> · <file>:<line> — <problem>`. Ask in text «Какие публикуем? Номера через запятую или «все»» and end the turn.
   No findings at all → skip the list, `ids: []`. The user's answer to «Как публикуем?» or to this list may already name
   the verdict and the ids («апрувим без комментариев» → approve, `ids: []`; «запросить изменения по A-1» → request
   changes, `ids: ["A-1"]`) — then skip the list.
2. Write `texts.json` with a comment for each chosen id. No ids chosen → no `texts.json`: the approval goes out bare —
   no body and no comments anywhere.
3. `review_publish` with `pr`, `ids`, and `verdict` (`approve` | `request-changes`) whenever the user named one — it
   overrides the computed verdict. Without it the tool picks the verdict itself: a blocking finding, an open blocking
   follow-up of an earlier thread → request changes, otherwise approve —
   but request changes only when something goes to the author (chosen findings or replies); with nothing chosen it
   approves. An explicit request-changes with nothing chosen is refused (`not published: запрос изменений без
   комментариев …`) — ask the user to pick findings or approve. It shows the review and asks the user
   itself → «Finish». An approval without chosen findings is published without any text, whatever `texts.json` says.
   Never tell the user what verdict went out before the tool's answer names it.

## Finish

`published: <url> (вердикт …)` → report the URL and that verdict. An error with «статус публикации неизвестен» → tell the
user to check the PR before anything else; never publish again. Then `review_finish`.

`not published: пользователь отказал (вердикт <V>)` or `not published: окно подтверждения не открылось — … (вердикт <V>)`
→ the run stays open: say which verdict the dialog offered, then AskUserQuestion «Что делаем с ревью PR <N>?» —
«Одобрить» (`verdict: "approve"`), «Запросить изменения» (`verdict: "request-changes"`), «Изменить выбор находок» (back to
«Directly» step 1), «Не публиковать». A verdict option → `review_publish` again with the same `ids`, the same `source` (when the
refused call had one) and that `verdict`, then this section again. «Изменить выбор находок» after a call with `source` →
choose among the findings of `.review-kit/run/<N>/<source>/findings.json` and keep `source`. «Не публиковать» → `review_finish`. `not published: PR обновился после снимка: …` → show it, then
AskUserQuestion «PR изменился во время прогона — что делаем?» — «Перезапустить» (`review_finish`, then `review_start`
with `pr` and follow its answer), «Остановить» (`review_finish`, stop). Any other `not published: …` → show the reason,
then `review_finish`.

The user does not want to publish → `review_finish`. Every stop of this skill ends with `review_finish`. Never call curl
or the hosting API; publishing goes only through `review_publish`.

`review_finish` answers with a `worktree … удалён` line when the review ran in its own review worktree: show that line as
the last thing and call no tools after it — the tree is gone. A `worktree … оставлен` line → show it.
