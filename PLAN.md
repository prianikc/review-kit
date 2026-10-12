# review-kit 2.2.0 → 3.0: ответ на ревью команды

## Context
Команда прислала замечания к review-kit 2.2.0:
- в плагине лежат команды проверок, хотя они разные на разных проектах и уже запускаются pre-commit хуком;
- есть ссылки на «стек», best-practices и правила проекта, плюс привязка к конкретному проекту;
- Python-скриптов много, а мода не видно;
- установка слишком сложная.

К этому добавились твои требования:
- плагин «сухой»: никаких внешних правил, соглашений и зависимостей, кроме Orca для `pr-tab`;
- ревью делают только агенты A/B/C, режим lite удаляется;
- simplify удаляется полностью;
- скиллы лёгкие и экономят токены;
- у каждого PR показывается статус.

Итог: плагин, который работает в любом репозитории на Forgejo сразу после `/plugin install`.

## Принципы
1. **Ноль внешних зависимостей.**
   - Плагин не читает, не требует и не проверяет `CLAUDE.md`, `AGENTS.md`, `.claude/rules`, `.agents/skills`, `ai-dev-kit`, nx, Python, Plannotator, superpowers.
   - Что Claude Code сам подгружает агентам, то они и видят. Плагин об этом не знает и на это не опирается.
   - Единственная внешняя зависимость — Orca, и только для `pr-tab`.
2. **Ничего не копируется** ни из проекта в плагин, ни из плагина в проект. Rules-файлы, `.claude/skills/review-kit`, state-файлы установки не создаются.
3. **Детерминированная работа — в моде, в скилле — только то, что требует суждения модели.** Модель не тратит токены на `cp`, сборку JSON и вызовы API: один вызов инструмента мода возвращает короткий результат.
4. **Минимум кода.** Каждый файл мода проходит проверку «нужен ли он вообще».

## Что убираем целиком
- **Lite-ревьюер:** `skills/review-lite/`, `tools/review-lite-run`, `review_lite_input.py`, `review_lite_check.py`, `review_lite_eval.py`, выбор режима `MODES` в моде, ветки `mode: "lite"` во всех скиллах. Triage (D) в lite-режиме тоже удаляется, остаётся только агентный.
- **Simplify:** раздел 2.5 в `pr-review-run`, шаг 3a в `pr-fix-run`, `tools/simplify.py`, поля `simplify` в payload и отчёте. Больше не спрашиваем.
- **Проверки:** `tools/checks_baseline.py`, `config/checks.json`, `checks` в конфиге, шаги 1 и 3 в `pr-fix-run`. Коммит идёт обычным `git commit`, pre-commit проекта срабатывает сам. Если он упал, показываем вывод и чиним.
- **Стек и правила:**
  - `stack` в конфиге, `stack_config`/`stack_skills`;
  - `RULES` в input агентов;
  - `RULE_PREFIXES`, `.claude/ai-dev-kit` в `gate.ts`, `funnel_finish.py`, `commit-push`, `agents/*.md`;
  - ссылка на `splitting-pr`;
  - папка `rules/` (её инварианты переезжают в тексты скиллов и в принуждение мода, см. ниже).
  Находка агента обязана нести сценарий отказа. Цитата правила допускается, если агент сам её нашёл, но плагин не требует правил и не проверяет, откуда они.
- **Gate чтения манифеста:** манифест больше не перечисляет правила проекта. Gate проверяет только, что агент прочитал свой input. Список защищённых путей проекта (`PROTECTED_IN_ROOT`) удаляется.
- **Plannotator:** `tools/plannotator.py`, `review_plannotator`, шаги 3P и 5–6 в `pr-fix-run`. Тексты ревью и ответов согласуются в чате. Это внешняя зависимость, поэтому удаляется по принципу 1.
- **superpowers:writing-plans** в `pr-fix-run` заменяется обычным Plan Mode.
- **Установщик и миграция 1.17:** `tools/setup.py`, `skills/review-setup/`, `.claude/review-kit.installed.json`, любые упоминания 1.17.
- **Dev-утилиты:** `usage_summary.py` и учёт usage в моде (`USAGE`, `usageDrain`), если они не нужны в рантайме.

## Что остаётся и как устроено
**Мод (TS)** — весь Python и bash переезжают сюда, после переноса `tools/` не остаётся:
| файл | что делает | откуда |
|---|---|---|
| `mod/register.ts` | команды `/pr`, `/pr-review`, `/pr-feedback`, `/pr-fix`, `/pr-recheck`, инструменты, hooks | как есть, худеет |
| `mod/forgejo.ts` | клиент Forgejo API на `fetch`: PR, ревью, комментарии, публикация | `forgejo.py`, `pr_context.py`, `intake.py`, `recheck_prep.py` |
| `mod/run.ts` | подготовка input для A/B/C и D, приём результата workflow, payload ревью и ответов | `funnel_prep`, `triage_prep`, `funnel_finish`, `triage_finish`, `review_payload`, `replies`, `pack`, `snapshot` |
| `mod/git.ts` | переключение на PR, stash, commit-push по подтверждению, cleanup, worktree | `switch-pr`, `commit-push`, `cleanup.py` |
| `mod/policy.ts`, `mod/gate.ts` | запрет сырых `git push`/`curl` и т.п. во время прогона, gate чтения input | упрощаются: внешние эффекты только через инструменты мода, поэтому пропуск kit-скриптов по путям не нужен |
| `funnel/review-funnel.js`, `funnel/triage.js` | Workflow-скрипты A/B→C и D | остаются |

Перед переносом каждого скрипта решаем, нужен ли он. Например, `pack` и `snapshot` скорее всего сводятся к паре вызовов `git` внутри `run.ts`.

**Инструменты мода**, которые зовёт скилл (каждый одна строка в скилле):
- `review_start(pr?)` — уже есть;
- `review_prepare(pr, kind)` → JSON для `Workflow`;
- `review_collect(pr, outputFile)` → компактный findings для отчёта;
- `review_publish(pr, ids, texts, approve?)` — внутри задаёт вопрос `review_confirm` и публикует;
- `replies_publish(pr, replies)` — то же для ответов;
- `commit_push(pr, message, paths)` — спрашивает подтверждение и делает commit и push;
- `review_finish` — уже есть.

**Скиллы** (короткие, без «run exactly python3 …»): `pr-flow`, `pr-review-run`, `pr-feedback-run`, `pr-fix-run`, `pr-recheck-run`, `pr-tab`.

**Агенты:** `correctness` (A), `quality` (B), `refuter` (C), `triage` (D) — без ссылок на правила проекта.

## Статус PR
- `pr_context` в `forgejo.ts` вычисляет статус и показывает его в `/pr` (список) и первой строкой каждого отчёта:
  - «готов к слиянию» — есть APPROVED, нет активного REQUEST_CHANGES, нет открытых тредов;
  - «на проверке» — ревью от меня ещё не было;
  - «перепроверка» — после моего ревью есть новые коммиты или ответы;
  - «ждём автора» — после моего ревью ничего нового;
  - «есть замечания» — мой PR с неразобранными комментариями;
  - «закрыт» / «влит».
- Использует уже существующие сценарии мода (`review`, `recheck`, `wait-author`, `feedback`, `none-own`, `closed`), добавляется только «готов к слиянию».

## pr-tab
- Остаётся в плагине.
- Работает через инструмент мода `review_tab(pr)`: worktree в `.claude/worktrees/pr-<N>-<branch>` и вкладка Orca с `/pr-review N`.
- Локальный слой и память проекта больше не копируются и не линкуются (принцип 2).
- Orca не найдена → сообщение «Orca не найдена — ревью запускаю в текущем дереве», затем обычный `/pr-review N` здесь.
- В README в разделе установки: «`pr-tab` требует Orca. Без неё скилл ревьюит в текущем дереве».

## Установка
- Плагин на GitHub, PR проектов на Forgejo.
- `marketplace.json` с одним плагином `review-kit`. Установка:
  ```
  /plugin marketplace add <owner>/review-kit
  /plugin install review-kit@review-kit
  ```
- Настройка проекта сведена к минимуму:
  - `forgejo {host, owner, repo}` по умолчанию берётся из `git remote get-url origin`;
  - `baseBranch` берётся из `origin/HEAD`;
  - токен Forgejo читается из переменной окружения `FORGEJO_TOKEN`.
  Файл конфига не нужен, если remote стандартный.
- `npx skills` не используем: он не ставит мод. В ответе команде объясним это одной строкой.
- Версия одна, в `plugin.json`. Файл `VERSION` удаляется.

## Порядок работы
Работаем прямо в `/home/prian/projects/review-kit` (туда распакован плагин 2.2.0).
1. Удаления: lite, simplify, проверки, стек и правила, Plannotator, установщик, 1.17.
2. Аудит оставшихся скриптов: таблица «скрипт → нужен / сливается / удаляется».
3. Перенос Python/bash в `forgejo.ts`, `run.ts`, `git.ts` с юнит-тестами. Чистые функции сверяются с выводом старых скриптов на одинаковых входах до их удаления.
4. Переписать скиллы на инструменты мода и сократить тексты.
5. Статус PR.
6. `pr-tab` с fallback без Orca.
7. Установка, `marketplace.json`, README «Как устроено» (мод, инструменты, скиллы, агенты) + короткий ответ команде.

## Проверка
1. Чистый тестовый репозиторий на Forgejo без nx, CLAUDE.md, правил, Python и Orca. Плагин ставится через `/plugin install`, один перезапуск.
2. `/pr` показывает список со статусами. `/pr-review N` проходит путь A/B→C → отчёт → публикация только после `review_confirm`.
3. `/pr-feedback N` → триаж D → «Чиним» → `commit_push`. Срабатывает pre-commit проекта, если он есть, а плагин ничего не запускает сам.
4. `/pr-recheck N` → статусы прошлых замечаний + дельта.
5. `pr-tab` без Orca: сообщение и ревью в текущем дереве. С Orca открывается вкладка.
6. Поиск `grep -rE "python3|ai-dev-kit|nx |apps/|best-practices|CLAUDE\.md|AGENTS\.md|\.claude/rules|plannotator|simplify|review-lite|1\.17|\.claude/skills/review-kit"` по плагину ничего не находит.
7. Юнит-тесты мода проходят.
