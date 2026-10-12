# review-kit 3.0 — этап 1: удаления — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Убрать из review-kit 2.2 всё, что спека 3.0 удаляет на этапе 1 (lite, simplify, проверки, установщик, учёт
расхода, `rules/`, `VERSION`, `pack`), и перенести инструкцию «что искать» в агентов A и B — так, чтобы плагин после
этапа работал (ревью только агентами) и запускался прямо из папки плагина через `--plugin-dir`.

**Architecture:** Только удаления и точечные правки существующих файлов: мод `mod/register.ts`, типы, скиллы,
агенты, `tools/funnel_prep.py`, `tools/review_payload.py`, `tools/plannotator.py`. Новых модулей нет. Python-скрипты,
которые остаются, не переписываются (это этап 3). `stack`, `RULE_PREFIXES` и `AGENTS.md` в манифесте остаются до
этапа 3, чтобы агент B не остался без правил.

**Tech Stack:** TypeScript-мод Claude Code (Node 24, без сборки), Python 3, bash, Markdown-скиллы.

**Spec:** `docs/superpowers/specs/2026-10-12-review-kit-3-design.md`

## Global Constraints

- Всё, что видит пользователь (тексты мода, вопросы, отчёты), — на русском; тексты скиллов и промпты агентов — на английском.
- Стиль TS в `mod/`: без точек с запятой, одинарные кавычки, константы `UPPER_CASE` в начале файла.
- Имя команды мода и имя скилла никогда не совпадают.
- Необратимые действия — только после `review_confirm` (на этапе 1 механизм не меняется).
- Каждая остановка скилла заканчивается `review_finish`, кроме остановок Plannotator `dismissed`/`failed` в `pr-fix-run`.
- Агенты A–D запускаются только своими типами через workflow.
- Функциональность 2.2, которая не названа в «Что удаляется» спеки, сохраняется как была (Plannotator, writing-plans, fallback-разбор вручную при сбое агента D).
- В плане нет шагов `git add`/`git commit`/`git rm`: файлы удаляются обычным `rm`, коммиты — только по просьбе пользователя.
- Проверка синтаксиса TS: `node --check file.ts` типы **не** убирает (на `const a: number = 1` падает с `SyntaxError`), поэтому
  синтаксис мода проверяется скриптом `tscheck.mjs` в scratchpad (без зависимостей, `stripTypeScriptTypes` из `node:module`).
  Создать его один раз перед Task 1 (путь `$S` = scratchpad сессии):

```js
// tscheck.mjs — снимает типы с каждого .ts и проверяет синтаксис результата через node --check
import { stripTypeScriptTypes } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
let failed = 0
for (const file of process.argv.slice(2)) {
  try {
    const out = `${process.env.TMPDIR ?? '/tmp'}/tscheck-${process.pid}.mjs`
    writeFileSync(out, stripTypeScriptTypes(readFileSync(file, 'utf8')))
    execFileSync(process.execPath, ['--check', out], { stdio: 'pipe' })
    console.log(`ok ${file}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${file}: ${String(error.stderr ?? error.message).split('\n').slice(0, 5).join(' | ')}`)
  }
}
process.exit(failed ? 1 : 0)
```

  Запуск: `TMPDIR=$S node $S/tscheck.mjs mod/*.ts 2>&1 | grep -v ExperimentalWarning`. Проверено на текущем коде:
  `ok` для `register.ts`, `policy.ts`, `gate.ts` и `FAIL` для файла с синтаксической ошибкой.

## Review Focus

1. Прогон, открытый в 2.2 до обновления, с `mode: "lite"` в `context.json` → после обновления скиллы игнорируют поле и идут воронкой агентов, ничего не падает (Task 2, проверка чтением скиллов: поле `mode` нигде не читается).
2. Воронка агентов не дала результата → отчёт «Ревью агентами не состоялось — не проверено» без вердикта и `review_finish`; вопроса «Ревью ядром review-lite?» больше нет (Task 2, Step 5 grep).
3. Агент D не ответил при `/pr-feedback` или `/pr-recheck` → разбор вручную по описанию прямо в скилле, без ссылки на удалённый lite-раздел (Task 2, Step 5 grep).
4. Плагин запущен через `--plugin-dir` без установщика → скиллы находят скрипты и workflow в папке плагина, а guard мода по-прежнему узнаёт канонические вызовы `commit-push`/`forgejo.py` (Task 5, Step 6).
5. Агенты A и B без `prompt.md` в манифесте → gate не требует несуществующего файла, а сами агенты знают, что искать (Task 1, Step 4).

---

## Что на этом этапе не делаем

- Не трогаем `stack`, `RULE_PREFIXES`, `AGENTS.md`-floor, `PROTECTED_IN_ROOT` и `accessDenial` — этап 3.
- Не переименовываем `.review-kit/run/<N>/lite/findings.json` (имя папки — только путь; переименование — на этапе 3 вместе с `run.ts`).
- Не удаляем `review_lite_input.py`, `review_lite_check.py` — на них опираются `funnel_prep`, `triage_prep`, `funnel_finish`, `review_payload`.
- Не удаляем `config/settings.example.json` целиком (там `stack` и `forgejo`) — только ключ `checks`.
- Не меняем версию в `plugin.json` (3.0.0 — этап 7), не трогаем `marketplace.json`, README, `PLAN.md`.
- Не убираем слово «Forgejo» из описаний скиллов — этап 4.
- Не убираем из промптов A и B фразу «grep over them is refused» — она уходит на этапе 3 вместе с `accessDenial` (записать в план этапа 3).
- Не пишем юнит-тесты: тестовый каркас появляется на этапе 2; здесь проверка — grep, `node --check`, дымовой запуск `funnel_prep.py` на временном репозитории и `claude plugin validate`.

## Карта файлов

| Файл | Что происходит |
|---|---|
| `agents/correctness.md`, `agents/quality.md` | инструкция из `prompt.md` внутри, без стека и без `.claude/ai-dev-kit` |
| `tools/funnel_prep.py` | манифест больше не включает `prompt.md` |
| `skills/review-lite/`, `tools/review-lite-run`, `tools/review_lite_eval.py` | удаляются |
| `mod/register.ts` | без `MODES`, вопроса о режиме, учёта расхода |
| `types/index.d.ts` | без `usage`, `usageDrain` |
| `skills/pr-review-run/SKILL.md` | без lite, без simplify, пути к плагину, уровни из `rules/code-review-report` |
| `skills/pr-recheck-run/SKILL.md`, `skills/pr-feedback-run/SKILL.md` | без lite-веток, fallback вручную описан на месте, пути к плагину |
| `skills/pr-fix-run/SKILL.md` | без проверок и simplify, пути к плагину |
| `skills/pr-tab/SKILL.md` | пути к плагину |
| `tools/simplify.py`, `tools/checks_baseline.py`, `config/checks.json` | удаляются |
| `tools/commit-push` | без обязательного хука правил коммита ai-dev-kit |
| `docs/superpowers/specs/2026-10-12-review-kit-3-design.md` | «Что удаляется» выровнен с порядком этапов |
| `tools/review_payload.py`, `tools/plannotator.py` | без чтения `doc.simplify` |
| `config/settings.example.json` | без `checks` |
| `tools/setup.py`, `skills/review-setup/`, `tools/usage_summary.py`, `rules/`, `VERSION`, `tools/pack`, `INSTALL.md` | удаляются |
| `CLAUDE.md` | таблица «Устройство» и раздел «Запуск» под новое состояние |

---

### Task 1: Агенты A и B получают инструкцию напрямую

**Files:**
- Modify: `agents/correctness.md` (целиком)
- Modify: `agents/quality.md` (целиком)
- Modify: `tools/funnel_prep.py:6,34`

**Interfaces:**
- Consumes: `input.md` с разделами `## FOCUS`, `## RULES`, `## DIFF`, `## FILES` от `build_input` (`tools/review_lite_input.py`) — без изменений.
- Produces: манифесты `manifest-{correctness,quality,refuter}.txt` без пути к `prompt.md`; JSON-ответ агентов по схеме `FINDINGS` в `funnel/review-funnel.js` — без изменений.

- [ ] **Step 1: Заменить `agents/correctness.md` целиком**

```markdown
---
name: correctness
description: Agent A of review-kit — correctness review of one PR. Dispatched only by the review-kit funnel workflow.
disallowedTools: Edit, Write, NotebookEdit, Agent
---

You are agent A of the review-kit funnel. Your prompt names three paths: the review input (`input.md`),
your manifest, and the PR number.

1. Read every file listed in your manifest with Read, whole — no offset/limit. Your answer is refused
   until they are read; a file read in parts does not count.
2. Read the review input. Its sections:
   - RULES — the project's rule files, each under `=== RULE FILE: <path> ===`;
   - DIFF — the unified diff of the change;
   - FILES — the full text at the PR head of every changed file, each under `=== FILE: <path> ===`;
     a file marked `(не приложен: …)` was not attached.
3. Report only problems the diff introduces or touches: logic errors, unhandled edge cases and error paths,
   data integrity, security, broken contracts between layers or modules, new branching logic without a test.
   You may Read and Grep source code of the repository to confirm a failure scenario. Rules, skills, docs and
   memory are opened with Read, whole — grep over them is refused.
4. Every finding carries `failureScenario` — a concrete input or state and the wrong result it leads to.
   Without it the finding is invalid. Add `rule` only when a rule also applies: `file` is a RULES path exactly
   as written in its header (or a project rule file loaded into your context — `CLAUDE.md`, `AGENTS.md`,
   `.claude/rules/…` — as a path from the repository root), `quote` is copied verbatim from that file, at least
   6 words and 30 characters, in the file's own language, never translated.
5. `file` is the path from the repository root as in the DIFF. `line` is the line number in the changed file
   itself at the PR head: open that file with Read and take the number from that Read. The numbers Read shows
   for `input.md` are positions inside `input.md` — never use them as `line`.
6. Severity: `critical` — breaks the product, loses data, or is exploitable; `important` — a measurable
   regression or a concrete risk; `minor` — style, naming, preference. `confidence` is your probability,
   0–100, that the finding is real and correct.
7. Do not report: what a linter or formatter enforces, generated files, "might be slow" without a concrete
   path, anything outside the diff. One root cause is one finding; name its other places in `problem`.
8. Write `problem`, `failureScenario` and `suggestion` in Russian. Put into `notChecked` every file marked
   `(не приложен: …)` and everything you could not verify. Nothing to report → an empty `findings` list.
9. Answer only through the structured output, matching the schema you were given.
```

- [ ] **Step 2: Заменить `agents/quality.md` целиком**

```markdown
---
name: quality
description: Agent B of review-kit — project-rule violations in one PR. Dispatched only by the review-kit funnel workflow.
disallowedTools: Edit, Write, NotebookEdit, Agent
---

You are agent B of the review-kit funnel. Your prompt names three paths: the review input (`input.md`),
your manifest, and the PR number.

1. Read every file listed in your manifest with Read, whole — no offset/limit. Your answer is refused
   until they are read; a file read in parts does not count.
2. Read the review input. Its sections:
   - RULES — the project's rule files, each under `=== RULE FILE: <path> ===`;
   - DIFF — the unified diff of the change;
   - FILES — the full text at the PR head of every changed file, each under `=== FILE: <path> ===`;
     a file marked `(не приложен: …)` was not attached.
3. Report only violations of the project's rules that the diff introduces or touches: naming, file placement,
   structure, conventions the rule files state. A concern no rule file states is not reported.
   Rules, skills, docs and memory are opened with Read, whole — grep over them is refused.
4. Every finding carries `rule`: `file` is a RULES path exactly as written in its header (or a project rule
   file loaded into your context — `CLAUDE.md`, `AGENTS.md`, `.claude/rules/…` — as a path from the repository
   root), `quote` is copied verbatim from that file, at least 6 words and 30 characters, in the file's own
   language, never translated. Without it the finding is invalid.
5. `file` is the path from the repository root as in the DIFF. `line` is the line number in the changed file
   itself at the PR head: open that file with Read and take the number from that Read. The numbers Read shows
   for `input.md` are positions inside `input.md` — never use them as `line`.
6. Severity: `important` — a rule violation a reviewer would send back; `minor` — a rule about style or
   naming; `critical` only when the violation also breaks the product, loses data, or is exploitable.
   `confidence` is your probability, 0–100, that the finding is real and correct.
7. Do not report: what a linter or formatter enforces, generated files, anything outside the diff. One root
   cause is one finding; name its other places in `problem`.
8. Write `problem` and `suggestion` in Russian. Put into `notChecked` every file marked `(не приложен: …)`.
   RULES empty or nothing to report → an empty `findings` list.
9. Answer only through the structured output, matching the schema you were given.
```

- [ ] **Step 3: Убрать `prompt.md` из манифеста в `tools/funnel_prep.py`**

До:

```python
import argparse, fnmatch, glob, json, os, sys

from forgejo import ForgejoError, kit_config
from review_lite_input import InputError, build_input, changed_files

# путь к инструкции lite, который манифест добавляет агентам A и B
PROMPT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'skills', 'review-lite', 'prompt.md'))
```

```python
# список файлов, которые агент роли обязан прочитать целиком (+ строки-заметки)
def manifest(role: str, repo: str, skills: list[str], note: str | None) -> list[str]:
    wanted = [*FLOOR, *skills]
    present = [p for p in wanted if os.path.isfile(os.path.join(repo, p))]
    notes = [note] if note else [] if skills else ['stack: изменённые пути не подходят ни под один стек']
    notes += [f'нет файла {p}' for p in wanted if p not in present]
    paths = [os.path.join(repo, p) for p in present] + ([PROMPT] if role in FINDERS else [])
    return [*sorted(set(paths)), *(f'# {n}' for n in notes)]
```

После (константа `PROMPT` удалена; `role` остаётся в сигнатуре — её вызывает `triage_prep.py`):

```python
import argparse, fnmatch, glob, json, os, sys

from forgejo import ForgejoError, kit_config
from review_lite_input import InputError, build_input, changed_files
```

```python
# список файлов, которые агент роли обязан прочитать целиком (+ строки-заметки)
def manifest(role: str, repo: str, skills: list[str], note: str | None) -> list[str]:
    wanted = [*FLOOR, *skills]
    present = [p for p in wanted if os.path.isfile(os.path.join(repo, p))]
    notes = [note] if note else [] if skills else ['stack: изменённые пути не подходят ни под один стек']
    notes += [f'нет файла {p}' for p in wanted if p not in present]
    paths = [os.path.join(repo, p) for p in present]
    return [*sorted(set(paths)), *(f'# {n}' for n in notes)]
```

Проверено: `triage_prep.py` вызывает `manifest('triage', repo, skills, note)` (строка 43) — сигнатура не меняется.
Константа `FINDERS` остаётся в использовании: цикл записи манифестов и поле `roles` вывода. Флаг `--repo` у
`funnel_prep.py` есть (по умолчанию `.`).

- [ ] **Step 4: Дымовой запуск `funnel_prep.py` на временном репозитории**

```bash
T=$(mktemp -d) && git -C "$T" init -q && git -C "$T" config user.email t@t && git -C "$T" config user.name t \
 && printf '# Rules\nAll exported functions must have a one-line comment above them.\n' > "$T/AGENTS.md" \
 && printf 'export const a = 1\n' > "$T/a.ts" && git -C "$T" add -A && git -C "$T" commit -qm base \
 && printf 'export const a = 2\nexport function b() { return a }\n' > "$T/a.ts" && git -C "$T" commit -qam head \
 && python3 tools/funnel_prep.py --repo "$T" --pr 1 --base HEAD~1 --head HEAD --model sonnet --out "$T/.review-kit/run/1/funnel" \
 ; echo; for r in correctness quality refuter; do echo "== $r"; cat "$T/.review-kit/run/1/funnel/manifest-$r.txt"; done; grep -c "^## " "$T/.review-kit/run/1/funnel/input.md"
```

Ожидается: JSON с `"roles": ["correctness", "quality"]`; в каждом манифесте строка `<T>/AGENTS.md` и заметка `# stack: …`, нигде нет `prompt.md`; в `input.md` 4 раздела (`FOCUS`, `RULES`, `DIFF`, `FILES`). Если `kit_config` падает без конфига — заметка `# stack: конфиг review-kit недоступен`, это ожидаемо.

- [ ] **Step 5: Проверить, что инструкция не потеряла содержимого**

Run: `grep -c "failureScenario\|verbatim\|notChecked\|linter" agents/correctness.md agents/quality.md`
Expected: в обоих файлах ненулевое число; `grep -n "NestJS\|Angular\|ai-dev-kit\|prompt.md\|review-lite" agents/*.md` — пусто.

---

### Task 2: Удалить lite

**Files:**
- Delete: `skills/review-lite/` (`prompt.md`, `findings.schema.json`), `tools/review-lite-run`, `tools/review_lite_eval.py`
- Modify: `mod/register.ts:30,505-507,517,522,526`
- Modify: `skills/pr-review-run/SKILL.md` (шапка и раздел 1)
- Modify: `skills/pr-feedback-run/SKILL.md` (шапка и раздел 1)
- Modify: `skills/pr-recheck-run/SKILL.md` (шапка и шаг 2–3)

**Interfaces:**
- Consumes: `funnel_prep.py` без `prompt.md` (Task 1).
- Produces: `context.json` без поля `mode`; скиллы не читают `mode`.

- [ ] **Step 1: Убедиться, что схему lite никто не читает, и удалить файлы lite**

Run: `grep -rn "findings.schema\|skills/review-lite\|review-lite-run\|review_lite_eval" tools funnel mod skills agents | grep -v "^tools/review-lite-run\|^tools/review_lite_eval.py"`
Expected: только `tools/funnel_prep.py` (константа `PROMPT`, уже удалена в Task 1, — значит пусто) и `skills/pr-review-run/SKILL.md`
(lite-раздел, переписывается в Step 3). Проверено на 2.2: `findings.schema.json` читает только `tools/review-lite-run`;
`review_lite_check.py` держит схему в коде (`schema_errors`), `funnel/review-funnel.js` — свою константу `FINDINGS`.

```bash
rm -r skills/review-lite tools/review-lite-run tools/review_lite_eval.py
```

- [ ] **Step 2: `mod/register.ts` — убрать режимы**

Удалить константу (строка 30):

```ts
// варианты ответа на вопрос «Как ревьюим PR?» → режим прогона
const MODES = { 'Агенты (A/B → C)': 'agents', 'Ядро review-lite': 'lite' } as const
```

В `startRun` до:

```ts
  // модель для агентов прогона — спрашивается у пользователя
  const model = await $.ui.ask(`Модель для ${reviewing ? 'ревью' : 'разбора замечаний'} PR ${pr}?`, ['opus', 'sonnet', 'haiku'])
  const choice = await $.ui.ask(reviewing ? `Как ревьюим PR ${pr}?` : `Как разбираем PR ${pr}?`, Object.keys(MODES)).catch(() => undefined)
  const mode = choice === undefined ? undefined : MODES[choice as keyof typeof MODES]
  if (!mode) return 'Отменено: дерево не тронуто.'
```

После:

```ts
  // модель для агентов прогона — спрашивается у пользователя
  const model = await $.ui.ask(`Модель для ${reviewing ? 'ревью' : 'разбора замечаний'} PR ${pr}?`, ['opus', 'sonnet', 'haiku']).catch(() => undefined)
  if (!model) return 'Отменено: дерево не тронуто.'
```

До:

```ts
  await $.fs.write(`${dir}/context.json`, JSON.stringify({ ...context, ...switched, stash, model, mode, scenario }))
```

После:

```ts
  await $.fs.write(`${dir}/context.json`, JSON.stringify({ ...context, ...switched, stash, model, scenario }))
```

До:

```ts
    return `PR ${pr} (свой, ${scenario === 'feedback' ? 'замечания' : 'правки'}): дерево на ${context.headRef}${stash ? `, stash «${stash}»` : ''}, модель ${model}, режим ${mode === 'agents' ? 'агенты' : 'сам'}. Прогон открыт до конца раунда; закрыть вручную — /pr-${scenario} stop.${next}`
```

После:

```ts
    return `PR ${pr} (свой, ${scenario === 'feedback' ? 'замечания' : 'правки'}): дерево на ${context.headRef}${stash ? `, stash «${stash}»` : ''}, модель ${model}. Прогон открыт до конца раунда; закрыть вручную — /pr-${scenario} stop.${next}`
```

До:

```ts
  return `PR ${pr} (${who}): дерево на ${switched.detached ? 'коммите PR' : context.headRef}${stash ? `, stash «${stash}»` : ''}, модель ${model}, режим ${mode === 'agents' ? 'агенты' : 'review-lite'}${switched.baseFallback ? `, база ревью — от main: ветка ${context.baseRef} на сервере удалена` : ''}. Прогон открыт до конца ревью; закрыть вручную — /pr-review stop.${next}`
```

После:

```ts
  return `PR ${pr} (${who}): дерево на ${switched.detached ? 'коммите PR' : context.headRef}${stash ? `, stash «${stash}»` : ''}, модель ${model}${switched.baseFallback ? `, база ревью — от main: ветка ${context.baseRef} на сервере удалена` : ''}. Прогон открыт до конца ревью; закрыть вручную — /pr-review stop.${next}`
```

Run: `TMPDIR=$S node $S/tscheck.mjs mod/register.ts 2>&1 | grep -v ExperimentalWarning; grep -n "MODES\|mode ===\|'lite'" mod/register.ts`
Expected: `ok mod/register.ts`; в grep остаются только `mode === 'fix'`/`mode === 'review'` у Plannotator и путь `lite/findings.json`.

- [ ] **Step 3: `skills/pr-review-run/SKILL.md` — только воронка агентов**

Шапка: в списке полей `context.json` убрать `` `mode` ``:

```markdown
Read `.review-kit/run/<N>/context.json`: `number`, `title`, `author`, `isOwn`, `state`, `head`, `base`,
`stash`, `model`. Ask nothing before the review.
```

Раздел 1 целиком (от `## 1. Review` до `## 2. Report`) заменить на (пути `<plugin>` — см. Task 5, здесь пока прежние `.claude/skills/review-kit/...`):

```markdown
## 1. Review — agents funnel

1. Run exactly:
   `python3 .claude/skills/review-kit/tools/funnel_prep.py --pr <N> --base <base> --head <head> --model <model> --out .review-kit/run/<N>/funnel`
   Exit 4 — the input is too large: tell the user, call `review_finish`, stop. Any other non-zero exit → step 5.
2. Call `Workflow` with `scriptPath: ".claude/skills/review-kit/funnel/review-funnel.js"` and `args` = the JSON
   the script printed, passed as a JSON object (not a string). This skill's instruction is the user's opt-in to the
   workflow. Wait for its completion notification; do nothing else meanwhile.
3. Completed: copy the notification's `<output-file>` exactly:
   `cp <output-file> .review-kit/run/<N>/funnel/raw.json`
4. Run exactly:
   `python3 .claude/skills/review-kit/tools/funnel_finish.py --raw .review-kit/run/<N>/funnel/raw.json --base <base> --head <head> --out .review-kit/run/<N>/lite`
   It writes `.review-kit/run/<N>/lite/findings.json` — the file the report and the publish step read. Read
   that file only (not `input.md`, not `raw.json`). Exit 6 or any other non-zero exit → step 5.
5. The funnel did not produce a review (the workflow failed or left no output file, `funnel_prep` or
   `funnel_finish` exited non-zero): report «Ревью агентами не состоялось — не проверено» with the stderr line,
   never a verdict; call `review_finish`, stop.
```

- [ ] **Step 4: `skills/pr-feedback-run/SKILL.md` и `skills/pr-recheck-run/SKILL.md` — без lite-веток**

`pr-feedback-run`: в шапке убрать `` `mode` `` из списка полей; в разделе 1 убрать строку `` `mode: "agents"`: `` (шаги 1–4 становятся безусловными), а абзац `` `mode: "lite"` — triage yourself: … `` заменить на fallback, на который ссылается шаг 4:

```markdown
Triage yourself (only after step 4): for each item read the quoted place at `head` and write
`.review-kit/run/<N>/triage.json` = `{"items": [{"id", "class", "reason", "fixed"?}]}` with the classes and rules of `agents/triage.md`
(valid / invalid / question / out-of-scope; a `stale` item already changed as asked is `valid` with `"fixed": true` and a reason saying where).
```

`pr-recheck-run`: в шапке убрать `` `mode` ``; шаг 2 заменить на:

```markdown
2. Statuses of my earlier comments: run exactly
   `python3 .claude/skills/review-kit/tools/triage_prep.py --pr <N> --mode recheck --items .review-kit/run/<N>/recheck.json --base <recheck base> --head <head> --model <model> --out .review-kit/run/<N>/triage`,
   call `Workflow` with `scriptPath: ".claude/skills/review-kit/funnel/triage.js"` and the printed JSON as `args` (this instruction is the
   user's opt-in), wait, `cp <output-file> .review-kit/run/<N>/triage/raw.json`, then run exactly
   `python3 .claude/skills/review-kit/tools/triage_finish.py --raw .review-kit/run/<N>/triage/raw.json --items .review-kit/run/<N>/recheck.json --mode recheck --out .review-kit/run/<N>`
   Any failure → «Статусы агентом не проверены», then do them yourself: for each `prior` item read the place at `head`, write
   `.review-kit/run/<N>/statuses.json` = `{"items": [{"id", "class": "closed"|"open"|"partial", "reason"}]}`.
```

Шаг 3 оставить, только формулировку «section 1 of review-kit:pr-review-run» не менять — раздел 1 теперь и есть воронка.

- [ ] **Step 5: Проверка**

Run: `grep -rnE "review-lite|\"lite\"|mode: \"agents\"|ядром|\`mode\`," skills mod agents`
Expected: пусто. Допустимы и не ловятся этим шаблоном: путь `lite/findings.json` (до этапа 3), `mode` у `recheck.json` (`delta`/`full`) и у Plannotator (`review`/`fix`).

- [ ] **Step 6: Дымовой запуск `funnel_finish.py` после удаления lite**

На временном репозитории из Task 1 Step 4 (`$T`, манифесты уже лежат в `$T/.review-kit/run/1/funnel`) — рукописный
результат workflow с одной находкой A и подтверждением C:

```bash
F="$T/.review-kit/run/1/funnel" && cat > "$F/raw.json" <<'EOF'
{"findings":[{"id":"A-1","role":"correctness","file":"a.ts","line":2,"severity":"important","confidence":90,
  "problem":"b() читает изменённую константу","failureScenario":"вызов b() после правки a возвращает 2 вместо 1"}],
 "verdicts":[{"id":"A-1","verdict":"confirmed","evidence":"a.ts:2 — b возвращает a","severity":"important","confidence":90}],
 "refuter":"ok","failed":[],"roles":["correctness","quality"],"notChecked":[]}
EOF
python3 tools/funnel_finish.py --repo "$T" --raw "$F/raw.json" --base HEAD~1 --head HEAD --out "$T/.review-kit/run/1/lite"; echo "exit=$?"
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print([f['id'] for f in d['findings']], len(d['dropped']))" "$T/.review-kit/run/1/lite/findings.json"
```

Expected: `exit=0`; `['A-1'] 0` (important, confirmed, 90 ≥ 75 → в отчёт). Если запуск из `--repo` не находит
коммиты `HEAD~1`/`HEAD` — выполнить команду из `cd "$T"` с абсолютным путём к скрипту.

---

### Task 3: Удалить simplify

**Files:**
- Delete: `tools/simplify.py`
- Modify: `skills/pr-review-run/SKILL.md` (раздел 2.5, 3B, 3P.1, «In chat» 1)
- Modify: `skills/pr-fix-run/SKILL.md` (шаг 3a)
- Modify: `tools/review_payload.py:99`, `tools/plannotator.py:179`

**Interfaces:**
- Consumes: —
- Produces: `findings.json` читается без поля `simplify`.

- [ ] **Step 1: Удалить скрипт**

```bash
rm tools/simplify.py
```

- [ ] **Step 2: `skills/pr-review-run/SKILL.md`**

- Строку `Foreign open PR → then §2.5.` заменить на `Foreign open PR, empty `findings` → end with «Апрувим?»; nothing else is asked about publishing.`
- Раздел `## 2.5. Optional /simplify — foreign open PR only` удалить целиком (до `## 3. Publish`).
- В 3B: `` `findings` is empty, no `simplify` entry is chosen, and the user asks… `` → `` `findings` is empty and the user asks… ``.
- В 3P.1: `` for **every** entry of `findings` and `simplify` (not `belowBar`) `` → `` for **every** entry of `findings` (not `belowBar`) ``.
- В «In chat» 1: `` — entries of `findings` and `simplify` (or «все») `` → `` — entries of `findings` (or «все») ``.

- [ ] **Step 3: `skills/pr-fix-run/SKILL.md`** — шаг `3a.` удалить целиком (обе строки и продолжение до шага 4).

- [ ] **Step 4: Python — без `doc.simplify`**

`tools/review_payload.py`, до:

```python
    # находки отчёта вместе с принятыми находками simplify
    findings = [*doc['findings'], *doc.get('simplify', [])]
```

После:

```python
    # находки отчёта
    findings = doc['findings']
```

`tools/plannotator.py`, до:

```python
            # находки для аннотаций вместе с находками simplify
            findings = [*doc['findings'], *doc.get('simplify', [])]
```

После:

```python
            # находки для аннотаций
            findings = doc['findings']
```

- [ ] **Step 5: Проверка**

Run: `grep -rnE "simplify|§2\.5|2\.5\." skills tools mod agents config; python3 -m py_compile tools/review_payload.py tools/plannotator.py && echo ok`
Expected: grep пуст (нет и осиротевших ссылок на удалённый раздел 2.5); `ok`.

---

### Task 4: Удалить проверки и обязательный хук ai-dev-kit в `commit-push`

**Files:**
- Delete: `tools/checks_baseline.py`, `config/checks.json`
- Modify: `skills/pr-fix-run/SKILL.md` (шаги 1 и 3)
- Modify: `config/settings.example.json`
- Modify: `tools/commit-push:19,25,39-42,47`

**Interfaces:**
- Consumes: —
- Produces: «пути раунда» по-прежнему = пути из `git status --porcelain --ignore-submodules=all`, которых нет в `status-before.txt`; `commit-push` с теми же аргументами и кодами выхода, но без хука ai-dev-kit.

Почему здесь, а не на этапе 3: `commit-push` 2.2 требует `.claude/ai-dev-kit/rules/hooks/enforce-commit-rules.js` и при
его отсутствии выходит с кодом 2 (строка 25). В проекте без ai-dev-kit раунд правок не коммитится вовсе — с удалением
собственных проверок плагина это единственная преграда коммиту. `--no-verify` в `commit-push` нет (проверено), значит
`git commit` (строка 83) запускает pre-commit и commit-msg проекта сами. Спека (раздел «Что удаляется») правится в Task 5 Step 8.

- [ ] **Step 1: Удалить файлы**

```bash
rm tools/checks_baseline.py config/checks.json
```

- [ ] **Step 1a: `tools/commit-push` — убрать хук ai-dev-kit**

Удалить строку 19:

```bash
# путь к хуку правил коммита ai-dev-kit (переопределяется RK_COMMIT_RULES_HOOK)
rules_hook="${RK_COMMIT_RULES_HOOK:-$top/.claude/ai-dev-kit/rules/hooks/enforce-commit-rules.js}"
```

Удалить строку 25:

```bash
[ -f "$rules_hook" ] || { echo "commit-push: хук правил коммита не найден: $rules_hook (подмодуль ai-dev-kit не инициализирован?)" >&2; exit 2; }
```

Удалить функцию (строки 39–42):

```bash
# прогоняет сообщение коммита через хук правил ai-dev-kit
check_message() {
  python3 -c 'import json,sys; print(json.dumps({"tool_name":"Bash","tool_input":{"command":"git commit -m \""+sys.argv[1]+"\""}}))' "$message" \
    | node "$rules_hook"
}
```

И её вызов (строка 47):

```bash
  check_message || { echo "commit-push: сообщение не прошло правила коммита" >&2; exit 2; }
```

Если после удаления переменная `top` больше нигде не используется — удалить и её объявление.

Run: `bash -n tools/commit-push && grep -n "rules_hook\|check_message\|ai-dev-kit\|RK_COMMIT" tools/commit-push; grep -n '\btop\b' tools/commit-push`
Expected: `bash -n` без вывода; первый grep пуст; второй показывает либо оставшиеся использования `top`, либо пусто (тогда объявление удалено).

- [ ] **Step 1b: Дымовой запуск `commit-push` в репозитории без ai-dev-kit**

```bash
R=$(mktemp -d) && B=$(mktemp -d) && git init -q --bare "$B" && git -C "$R" init -q -b feat && git -C "$R" config user.email t@t && git -C "$R" config user.name t \
 && git -C "$R" remote add origin "$B" && echo 1 > "$R/a.txt" && git -C "$R" add -A && git -C "$R" commit -qm base && git -C "$R" push -q origin feat \
 && echo 2 > "$R/a.txt" && BASE=$(git -C "$R" rev-parse HEAD) \
 && (cd "$R" && bash /home/prian/projects/review-kit/tools/commit-push --branch feat --base-head "$BASE" --message "fix: правка" -- a.txt); echo "exit=$?"; git -C "$B" log --oneline feat | head -2
```

Expected: в выводе `review-kit:commit-push:ok`, `exit=0`; в bare-репозитории два коммита, верхний `fix: правка`.

- [ ] **Step 2: `skills/pr-fix-run/SKILL.md`**

Шаг 1 заменить на:

```markdown
1. Run exactly: `git status --porcelain --ignore-submodules=all > .review-kit/run/<N>/status-before.txt`
```

Шаг 3 заменить на (проверки больше не запускаются — их делает pre-commit проекта при коммите):

```markdown
3. The round's paths = paths in `git status --porcelain --ignore-submodules=all` that are not in `status-before.txt`.
   The kit runs no checks: the project's pre-commit hook runs them at commit time.
```

В шаге 4 ссылку `back to step 3` оставить (шаг 3 теперь пересчитывает пути раунда). В шаге 7: если `commit-push` упал из-за pre-commit, добавить строку:

```markdown
   A failing pre-commit hook → show its output, fix what it reports, go back to step 3 and confirm again.
```

- [ ] **Step 3: `config/settings.example.json`** — удалить ключ `checks` (и запятую после `stack`). Результат:

```json
{
  "forgejo": { "host": "forgejo.example.org", "owner": "team", "repo": "project" },
  "baseBranch": "main",
  "stack": [
    { "paths": ["apps/api/**", "libs/shared/**"], "skill": ".agents/skills/nestjs-best-practices/SKILL.md" },
    { "paths": ["apps/web/**"], "skill": ".agents/skills/angular-best-practices/SKILL.md" }
  ]
}
```

- [ ] **Step 4: Проверка**

Run: `grep -rn "checks_baseline\|checks.json\|\"checks\"\|timeout 600000" skills tools mod config; python3 -c "import json;json.load(open('config/settings.example.json'))" && echo ok`
Expected: grep пуст; `ok`.

---

### Task 5: Удалить установщик, учёт расхода, `rules/`, `VERSION`, `pack`; скиллы ссылаются на папку плагина

**Files:**
- Delete: `tools/setup.py`, `skills/review-setup/`, `tools/usage_summary.py`, `rules/`, `VERSION`, `tools/pack`, `INSTALL.md`
- Modify: `mod/register.ts` (учёт расхода), `types/index.d.ts`
- Modify: все `skills/*/SKILL.md` — пути `.claude/skills/review-kit/…` → путь к папке плагина (см. Step 5)
- Modify: `skills/pr-review-run/SKILL.md` — уровни и инварианты из `rules/code-review-report.local.md`
- Modify: `CLAUDE.md` (таблица «Устройство», «Запуск и проверка»)
- Modify: `docs/superpowers/specs/2026-10-12-review-kit-3-design.md` (раздел «Что удаляется»)

**Interfaces:**
- Consumes: —
- Produces: `finishRun($, pr, status)` без опции `drain`; состояние плагина без `usage`/`usageDrain`.

Порядок шагов: сначала перенос содержимого `rules/` (Step 1), потом удаление (Step 2).

- [ ] **Step 1: Перенести уровни и инварианты отчёта в `skills/pr-review-run/SKILL.md`**

Открыть `rules/code-review-report.local.md` и сверить с текстом ниже (текст составлен по этому файлу: разделы «Levels and
verdict», «Mapping to Forgejo», «Invariants»; пункт «finding carries a failure scenario or a rule» уже обеспечен
`funnel_finish`). После первого абзаца раздела `## 2. Report` добавить:

```markdown
Levels: **critical** — breaks the product, loses data, or is exploitable → Blocked; **important** — a measurable
regression, a concrete risk, or a project-rule violation a reviewer would send back → Changes requested; **minor** —
style, naming, preference. Only minor → Approved with comments; nothing → Approved. «Не проверялось» is always present.
A finding states the problem, not the author. A rule quote stays in the report, never in the published comment.
Approved and Approved with comments are published as `APPROVED` only after the second confirmation question,
otherwise as a comment; Changes requested and Blocked — as request changes with a non-empty body.
```

Инварианты из `rules/review-kit.local.md` и `rules/agent-context.local.md` уже есть в `CLAUDE.md` («Инварианты») и в
текстах скиллов/агентов; переносить их не нужно — проверить: `grep -c "review_confirm\|review_finish" skills/*/SKILL.md`
даёт ненулевые числа для `pr-review-run`, `pr-fix-run`, `pr-feedback-run`, `pr-recheck-run`.

- [ ] **Step 2: Удалить файлы**

```bash
rm -r tools/setup.py skills/review-setup tools/usage_summary.py rules VERSION tools/pack INSTALL.md
```

- [ ] **Step 3: `mod/register.ts` — убрать учёт расхода**

Удалить константы (строки 9–10):

```ts
// ключ состояния: строки расхода токенов по PR
const USAGE = { plugin: 'review-kit', key: 'usage' } as const
// ключ состояния: PR, расход которого выгрузить в конце хода
const USAGE_DRAIN = { plugin: 'review-kit', key: 'usageDrain' } as const
```

Удалить целиком функции и тип (строки 198–246): `drainedPr`, `flushDrained`, `UsageRow`, `usageLine`, `flushUsage`, `flushSafely`.

`openRun`, до:

```ts
// записывает session.json и помечает прогон активным
async function openRun($: EngineInterface, { pr, context, head, scenario }: { pr: number; context: PrContext; head: string; scenario: RunScenario }): Promise<void> {
  await flushDrained($)
  await $.fs.write(`${await runDir($, pr)}/session.json`, JSON.stringify({ sessionId: await $.session.id(), status: 'active' }))
```

После:

```ts
// записывает session.json и помечает прогон активным
async function openRun($: EngineInterface, { pr, context, head, scenario }: { pr: number; context: PrContext; head: string; scenario: RunScenario }): Promise<void> {
  await $.fs.write(`${await runDir($, pr)}/session.json`, JSON.stringify({ sessionId: await $.session.id(), status: 'active' }))
```

`finishRun`, до:

```ts
// закрывает прогон: гасит Plannotator, отметки, выгружает расход, удаляет папку прогона
async function finishRun($: EngineInterface, pr: number, status: 'done' | 'aborted', { drain }: { drain: boolean } = { drain: false }): Promise<void> {
  plannotatorChildren.get(pr)?.stop()
  await $.state.set(RUN, { pr, status, isOwn: false, state: 'closed', head: '' })
  await update($, MARKS, marks => withoutPr(marks ?? {}, pr))
  await update($, PUBLISH_MARKS, marks => withoutPr(marks ?? {}, pr))
  if (drain) await $.state.set(USAGE_DRAIN, pr)
  else $.ui.log(await flushSafely($, pr))
  await deleteRunDir($, pr)
}
```

После:

```ts
// закрывает прогон: гасит Plannotator, отметки, удаляет папку прогона
async function finishRun($: EngineInterface, pr: number, status: 'done' | 'aborted'): Promise<void> {
  plannotatorChildren.get(pr)?.stop()
  await $.state.set(RUN, { pr, status, isOwn: false, state: 'closed', head: '' })
  await update($, MARKS, marks => withoutPr(marks ?? {}, pr))
  await update($, PUBLISH_MARKS, marks => withoutPr(marks ?? {}, pr))
  await deleteRunDir($, pr)
}
```

Обработчик `review_finish`, до:

```ts
    await finishRun($, pr, 'done', { drain: true })
    return { result: await withCleanup($, 'finished (расход прогона — в конце хода)', CLEANUP_MIN_BRANCHES_AFTER_RUN) }
```

После:

```ts
    await finishRun($, pr, 'done')
    return { result: await withCleanup($, 'finished', CLEANUP_MIN_BRANCHES_AFTER_RUN) }
```

Удалить обработчики `on('turn.step', …)` и `on('turn.complete', …)` целиком (строки 1002–1024 в 2.2). Из импорта первой строки, если после удаления не используются, убрать нечего: `HookStream`, `ProcessSpawnChunk`, `ProcessSpawnResult` нужны Plannotator.

Run: `TMPDIR=$S node $S/tscheck.mjs mod/register.ts 2>&1 | grep -v ExperimentalWarning; grep -n "USAGE\|usage\|drain\|turn\.\(step\|complete\)" mod/register.ts`
Expected: `ok mod/register.ts`; grep находит только `usage: kitUsage(scripts)` (это guard в `policy.ts`, не учёт расхода).

- [ ] **Step 4: `types/index.d.ts`**

До:

```ts
// строка расхода токенов одного шага прогона
export type ReviewKitUsageRow = { at: string; pr: number; session: string; agentId: string | null; turnId: string; index: number; model: string; input: number; output: number; cacheRead: number; cacheCreation: number }
```

```ts
      // строки расхода по PR
      usage: Record<number, ReviewKitUsageRow[]>
      // PR, расход которого выгрузить в конце хода
      usageDrain: number | null
```

После: оба фрагмента удалены, остальное без изменений.

- [ ] **Step 5: Пути к папке плагина в скиллах**

Во всех `skills/*/SKILL.md` заменить префикс `.claude/skills/review-kit/` на `${CLAUDE_PLUGIN_ROOT}/`. По
документации Claude Code (`code.claude.com/docs/en/skills`, таблица подстановок) `${CLAUDE_PLUGIN_ROOT}` в тексте
скилла плагина подставляется абсолютным путём до того, как текст видит модель; в окружении Bash этой переменной нет,
поэтому писать нужно именно `${CLAUDE_PLUGIN_ROOT}` в тексте, а не полагаться на shell. Команда (одинарные кавычки —
чтобы shell не раскрыл `$`):

```bash
grep -rl "\.claude/skills/review-kit/" skills | xargs sed -i 's#\.claude/skills/review-kit/#${CLAUDE_PLUGIN_ROOT}/#g'
```

Run: `grep -rn "CLAUDE_PLUGIN_ROOT" skills | wc -l; grep -rn "\.claude/skills/review-kit" skills`
Expected: первое — число замен (> 15); второе — пусто.

`mod/policy.ts` не меняется: `kitScriptPaths` уже признаёт абсолютный путь `${pluginRoot}/tools/...`.

- [ ] **Step 6: Проверка guard на абсолютном пути и источника корня плагина в моде**

Run: `grep -n "kitScriptPaths(\|skills/review-kit\|installed\|VERSION\|plugin.root" mod/*.ts`
Expected: `kitScriptPaths($.plugin.root)` (`register.ts:76`) и вызовы `${$.plugin.root}/tools/…`; нет
`skills/review-kit` (кроме маркера `/.claude/skills/` внутри `kitScriptPaths` в `policy.ts`), `installed`, `VERSION`.
Проверено на 2.2: мод не читает `.claude/review-kit.installed.json` и `VERSION`, корень плагина берёт только из
`$.plugin.root`. `scriptPath` воронки задаётся только в тексте скиллов (Step 5).

`policy.ts` ничего не импортирует, поэтому грузится в Node напрямую (Node 24 снимает типы при `import()` `.ts`; проверено). Run:

```bash
node -e "
import('./mod/policy.ts').then(p => {
  const scripts = p.kitScriptPaths('/opt/rk')
  const c = p.classifyBash({ command: 'bash /opt/rk/tools/commit-push --branch b --base-head abc --message \"m\" -- a.ts', scripts })
  const f = p.classifyBash({ command: 'python3 /opt/rk/tools/forgejo.py post-review 5 --payload .review-kit/run/5/payload.json', scripts })
  console.log(c.kind, f.kind)
})"
```

Expected: `kit-commit-push kit-post-review`.

- [ ] **Step 7: `CLAUDE.md`**

- В таблице «Устройство»: строку `skills/` — убрать «`review-lite`, `review-setup` — под удаление»; строку `config/` — убрать «`checks.json` — под удаление»; строку `rules/` удалить. Строку `mod/register.ts` не менять.
- В «Запуск и проверка»: «Локальный запуск» дополнить — скиллы ссылаются на скрипты через `${CLAUDE_PLUGIN_ROOT}`, установка в проект не нужна.
- Абзац «Версии сейчас расходятся: `VERSION` = 2.2.0…» заменить на «Версия — только в `.claude-plugin/plugin.json`».
- В «Соглашениях»: «Формат отчёта ревью и вердикты описаны в `rules/code-review-report.local.md`…» → «Формат отчёта ревью и вердикты — в `skills/pr-review-run/SKILL.md`, раздел 2».

- [ ] **Step 8: Выровнять спеку с фактическим порядком**

В `docs/superpowers/specs/2026-10-12-review-kit-3-design.md`, раздел «Что удаляется», пункт «Стек и правила 2.2
(на этапе 3, …)»: вынести из него «папка `rules/`» и «хук правил коммита в `commit-push`» в отдельный пункт
«На этапе 1: папка `rules/` (содержимое — в `pr-review-run` и `CLAUDE.md`), обязательный хук ai-dev-kit в `commit-push`».
В «Этапах», пункт 1, дописать «хук ai-dev-kit в `commit-push`».

---

### Task 6: Финальная проверка этапа

- [ ] **Step 1: Синтаксис и манифест**

Run: `TMPDIR=$S node $S/tscheck.mjs mod/*.ts 2>&1 | grep -v ExperimentalWarning && bash -n tools/commit-push tools/switch-pr tools/snapshot tools/open-pr-tab && python3 -m py_compile tools/*.py && claude plugin validate .`
Expected: `ok` для каждого `mod/*.ts`; без ошибок; `validate` — успех.

- [ ] **Step 2: Ничего не ссылается на удалённое**

Run:

```bash
grep -rnE "review-lite|review_lite_eval|simplify|checks_baseline|checks\.json|setup\.py|review-setup|usage_summary|USAGE|VERSION|installed\.json|tools/pack|INSTALL\.md|rules/(agent-context|code-review-report|review-kit)|\.claude/skills/review-kit/|ai-dev-kit/rules/hooks" \
  mod funnel agents skills tools config types hooks .claude-plugin
```

Expected: пусто. Шаблон не задевает то, что остаётся до этапа 3: имена `review_lite_input`/`review_lite_check` (в нём нет
`review-lite` с дефисом), `RULE_PREFIXES` в `funnel_finish.py` (там `.claude/rules/` и `.claude/ai-dev-kit/rules/`, без
`hooks`), маркер `/.claude/skills/` в `policy.ts` (без `review-kit/`). Если что-то из этого всё же совпало — это
допустимо, остальное — нет. В корне репозитория нет `package.json` и других сборочных файлов (проверено), поэтому grep
корня не нужен.

- [ ] **Step 3: Живой прогон (ручной, с пользователем)**

В тестовом репозитории на Forgejo: `claude --plugin-dir /home/prian/projects/review-kit`, затем `/pr-review <N>` на чужом открытом PR. Ожидается:
- вопрос о модели без вопроса о режиме;
- в тексте скилла путь к скриптам — абсолютный `/home/prian/projects/review-kit/tools/…` (подстановка `${CLAUDE_PLUGIN_ROOT}` сработала), `funnel_prep.py` запускается;
- `Workflow` с `scriptPath` = `/home/prian/projects/review-kit/funnel/review-funnel.js` стартует. Это поведение не документировано: если `Workflow` отказывает в чтении скрипта вне проекта — добавить в `.claude/settings.local.json` тестового проекта правило `Read(/home/prian/projects/review-kit/**)` и повторить; факт отказа записать в отчёт этапа — запуск воронки из папки плагина (`workflows/` плагина или разрешение на чтение) решается на этапе 4;
- отчёт с уровнями; `review_finish` отвечает `finished` без строки расхода.

**Стоп: этап 1 закончен, ждём «дальше» пользователя перед планом этапа 2.**
