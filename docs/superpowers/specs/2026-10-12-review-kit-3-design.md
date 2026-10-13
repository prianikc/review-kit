# Спека: review-kit 3.0 — универсальный плагин для PR

> Утверждена 2026-10-12. План реализации пишется отдельно, на каждый этап — непосредственно перед его кодом.

## Контекст

Команда прислала замечания к review-kit 2.2.0:
- в плагине лежат команды проверок, хотя на разных проектах они разные и их уже запускает pre-commit;
- есть ссылки на стек, best-practices и привязка к конкретному проекту;
- много Python-скриптов, а мода не видно;
- установка слишком сложная.

`PLAN.md` описывает переделку в целом. Эта спека фиксирует контракты и решения, принятые при обсуждении 2026-10-12.
Там, где решения расходятся с `PLAN.md`, действует спека. `PLAN.md` и `CLAUDE.md` правятся на этапе 7.

Результат: плагин ставится через `/plugin install` и сразу работает в любом репозитории на поддерживаемой системе
(в 3.0 — Forgejo/Gitea). Код в разы меньше, а ядро не знает о конкретном хостинге.

## Решения

| Решение | Почему |
|---|---|
| Весь Python и bash из `tools/` переезжает в TS-мод, `tools/` исчезает | Выбор пользователя. Одна среда выполнения, детерминированная работа в моде, тесты без Python |
| Агент B работает по правилам, которые мод сам находит в инструкциях агентам. Правил нет — B не запускается, отчёт пишет «для работы B нужны правила и соглашения проекта» | Плагин не требует правил, но использует найденные. Без правил B — пустая трата токенов |
| Где мод ищет правила: `CLAUDE.md` и `AGENTS.md` (в корне и в папках изменённых файлов вверх до корня), `.claude/rules/**`, `.cursor/rules/**`, `.github/copilot-instructions.md` | Выбор пользователя: только инструкции агентам, без CONTRIBUTING, docs, скиллов и конфигов линтеров |
| В `review` и `recheck` (чужой PR) правила берутся с базы PR, а не с его головы. База правил = `git merge-base origin/<baseRef> <headSha>`. Список файлов строится по `git ls-tree -r <mergeBase>` (подъём «из папок изменённых файлов вверх до корня» идёт по путям этого дерева, а не по файловой системе: новых папок PR в базе нет, и для них берутся только правила их существующих предков). Содержимое — `git show <mergeBase>:<path>` в `.review-kit/run/<N>/rules/`; манифест и проверка цитат ссылаются на эти копии. «PR меняет правила агентов» = файлы правил в `git diff --name-only <mergeBase>..<headSha>`; отчёт пишет их отдельной строкой «PR меняет правила агентов: <пути> — ревью шло по правилам базы». В `feedback`/`fix-check` (свой PR) правила берутся из дерева | Автор чужого PR не может подложить агентам свои инструкции или ослабить проверку. Merge-base, а не кончик `baseRef`: изменения, пришедшие в базу после ответвления, не выдаются за изменения PR |
| Перед переключением дерева на чужой PR (`review_start`, сценарии `review` и `recheck` — на каждом прогоне по текущему `headSha`) и перед вкладкой `pr-tab` мод проверяет `git diff --name-only <mergeBase>..<headSha>` на файлы, которые Claude Code исполняет или подгружает, — константа `CLAUDE_CODE_PATHS` в `git.ts`: `.claude/**`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude-plugin/**` (на любой глубине). Порядок: `git fetch` головы PR (`pullRef`) и `origin/<baseRef>` → merge-base → проверка путей → диалог → только потом переключение. Нашлись: в текущем дереве — диалог «PR меняет настройки Claude Code: <пути>. Хуки и MCP из них могут выполнить команды на вашей машине» с «Продолжить» / «Отмена» (по умолчанию — «Отмена»); для `pr-tab` вкладка с новой сессией не открывается, пользователю предлагается ревью в текущем дереве с тем же диалогом | Новая сессия в worktree чужого PR подгрузит его хуки и MCP — это выполнение чужого кода. Текущая сессия при переключении дерева тоже может перечитать настройки. README описывает риск |
| Токен — только из переменной окружения терминала. Имя переменной знает адаптер (`provider.tokenEnv`, у Forgejo — `FORGEJO_TOKEN`, затем `GITEA_TOKEN`). Логин — `GET /user`, один раз за сессию. Файлы токена и логина из 2.2 не читаются | Выбор пользователя. Плагин не хранит секретов, ядро не знает имён переменных |
| Публикация ревью, ответов и commit+push выполняются внутри инструментов мода: инструмент сам показывает диалог подтверждения (`$.ui.ask`) и сам действует. Отдельный `review_confirm` и отметки подтверждения удаляются | Подтверждение и действие в одном вызове — проверять совпадение аргументов не нужно. Уходит разбор «канонических» bash-команд (~150 строк `policy.ts`). Диалог из обработчика инструмента — не допущение: так уже работает `review_confirm` в 2.2 (`confirmPublish`, `mod/register.ts:672`) |
| Запрет grep/sed/cat по правилам, докам и памяти (`accessDenial`) удаляется. Gate проверяет только, что агент прочитал свой манифест целиком | Манифест уже гарантирует чтение. Минус ~120 строк |
| Выбор системы — `userConfig` в `plugin.json`, одна галочка (`boolean`, ключ = `provider.id`) на систему. В 3.0 одна: Forgejo/Gitea, `default: true`. Явный `provider` в `.claude/review-kit.local.json` побеждает галочку. Все галочки сняты и явного конфига нет → `/pr`: «все системы выключены — включите в /plugin → Configure options» | `userConfig` поддерживается (вопрос при включении плагина, значения приходят в `register(on, options)`). Списка с множественным выбором нет. Пунктов «скоро» не показываем. С одной системой галочка — задел под следующие адаптеры, поведение при снятой галочке определено |
| Проверки (lint, typecheck, тесты) плагин не запускает. Если в проекте нет pre-commit, push раунда уходит без проверок; перед push есть только `fix-check` (агенты по diff правок) и Plannotator | Осознанное решение по замечанию команды. README говорит об этом прямо |
| Функциональность 2.2, которая не названа в «Что удаляется», сохраняется как была | Решение пользователя: 3.0 меняет устройство, а не возможности |
| Plannotator остаётся, как в 2.2: тексты ревью разбираются «В чате» или «В Plannotator» (без Plannotator → чат), а раунд правок перед push обязательно проходит Plannotator. Без Plannotator раунд правок не начинается: проверка в начале `pr-fix-run` (и перед «Чиним» в `pr-feedback-run`), остановка «нужен Plannotator» | Решение пользователя. Plannotator — внешняя зависимость `/pr-fix` и `/pr-feedback` с правками, README об этом говорит |
| `pr-fix-run` планирует правки через `superpowers:writing-plans`, как в 2.2. Без superpowers скилл останавливается и просит его установить | Решение пользователя. superpowers — внешняя зависимость раунда правок |
| Режимы lite/agents и вопрос о режиме удаляются. Если воронка не сработала, отчёт говорит «Ревью агентами не состоялось — не проверено» без вердикта; запасного lite больше нет | Принцип: ревью делают только A/B/C |

## Что удаляется

- Lite: `skills/review-lite/`, `tools/review-lite-run`, `review_lite_*.py`, `MODES`, ветки `mode: "lite"` в скиллах и моде.
  Инструкция `review-lite/prompt.md` переезжает в агентов A и B (см. «Агенты»). Код сборки входа и проверки находок —
  в `run.ts`.
- Simplify: шаги в `pr-review-run` и `pr-fix-run`, `tools/simplify.py`, поле `simplify` в отчёте и payload.
- Проверки: `tools/checks_baseline.py`, `config/checks.json`, шаги проверок в `pr-fix-run`. Коммит идёт обычным
  `git commit`: pre-commit проекта срабатывает сам.
- Стек и правила 2.2 (на этапе 3, вместе с появлением поиска правил): `stack` в конфиге, `RULE_PREFIXES`, `.claude/ai-dev-kit`,
  `PROTECTED_IN_ROOT`, ссылка на `splitting-pr`.
- На этапе 1: папка `rules/` (содержимое — в `pr-review-run` и `CLAUDE.md`), обязательный хук ai-dev-kit в `commit-push`.
- Установщик и 1.17: `tools/setup.py`, `skills/review-setup/`, `.claude/review-kit.installed.json`.
- Учёт расхода: `USAGE`, `usageDrain`, хук `turn.step`, `usage_summary.py`.
- `VERSION`, `INSTALL.md`, `tools/pack`, `config/settings.example.json` (ключи `stack`, `checks`, `forgejo.tokenFile`).

## Устройство

```
mod/
  register.ts       команды, инструменты, хуки — только маршрутизация
  forge/types.ts    ForgeProvider и общая модель
  forge/index.ts    реестр адаптеров; выбор по включённым галочкам, git remote и явной настройке
  forge/forgejo.ts  адаптер Forgejo/Gitea на fetch
  status.ts         сценарий и статус PR, пункты замечаний (intake), прошлые замечания для recheck
  run.ts            поиск правил, input.md и манифесты, сбор находок и триажа, тело ревью, ответы
  git.ts            переключение на PR, snapshot, commit+push, stash, ветки, worktree, база recheck
  plannotator.ts    аннотации находок, запуск и ожидание сессии, разбор решения (из plannotator.py и register.ts)
  policy.ts         запрет сырых git push/commit, curl/wget-записи, --force, --amend и т.п. в прогоне
  gate.ts           «манифест прочитан целиком»
  *.test.ts         node --test
funnel/review-funnel.js, funnel/triage.js   без изменений контракта args
agents/  correctness (A), quality (B), refuter (C), triage (D)
skills/  pr-flow, pr-review-run, pr-feedback-run, pr-fix-run, pr-recheck-run, pr-tab
config/funnel.json  пороги воронки (без изменений)
```

Чистые модули (`forge/*`, `status.ts`, `run.ts`, логика `git.ts`, `plannotator.ts`, `policy.ts`, `gate.ts`) не
импортируют `'claude-code'` во время выполнения. Процессы, файлы и HTTP они получают параметром (интерфейс из
`$.process`, `$.fs`, `$.http`), поэтому тестируются без Claude Code.

Ограничения стиля TS (код исполняется Node 24 без сборки, «стираемый» TS):
- нет `enum`, `namespace`, параметр-свойств конструктора и прочего, что требует трансформации, — вместо `enum`
  объекты `as const` и объединения строк;
- относительные импорты с расширением `.ts`;
- типы из `'claude-code'` — только `import type` (значения из него импортирует лишь `register.ts`).

Вне `mod/forge/` нет обращений к API и слов Forgejo/Gitea. Имя системы для текстов отдаёт `provider.name`, имя
переменной токена — `provider.tokenEnv`, ключ галочки — `provider.id`; `register.ts` передаёт `options` в
`forge/index.ts`, не называя систем. Записанные ответы API для тестов лежат в `mod/forge/fixtures/`.

## Хостинг: `mod/forge/types.ts`

```ts
interface PullRequest { number: number; title: string; author: string; headRef: string; headSha: string; baseRef: string; state: 'open' | 'closed'; merged: boolean; url: string }
interface Comment { id: string; author: string; body: string; createdAt: string; path?: string; line?: number; commitSha?: string; reviewId?: string }
interface Thread { id: string; path?: string; line?: number; commitSha?: string; comments: Comment[]; resolved: boolean }
interface Review { id: string; author: string; state: 'approved' | 'changes' | 'comment' | 'pending'; body: string; commitSha: string; submittedAt: string }
type Verdict = 'approve' | 'request-changes' | 'comment'

interface ForgeProvider {
  id: string            // ключ галочки userConfig и значение provider в конфиге
  name: string          // для текстов пользователю
  tokenEnv: string[]    // переменные окружения с токеном, по порядку
  capabilities: { inline: boolean; requestChanges: boolean }
  detect(remoteUrl: string): { host: string; owner: string; repo: string } | null
  currentUser(): Promise<string>
  listPulls(state: 'open' | 'closed'): Promise<PullRequest[]>
  getPull(n: number): Promise<PullRequest>
  listReviews(n: number): Promise<Review[]>
  listThreads(n: number): Promise<{ threads: Thread[]; general: Comment[] }>
  publishReview(n: number, review: { verdict: Verdict; body: string; comments: Array<{ path: string; line: number; body: string }> }): Promise<{ url: string }>
  publishReplies(n: number, replies: Array<{ threadId?: string; quote?: string; body: string }>): Promise<void>
  pullRef(n: number): string
}
```

- Всё, что специфично для Forgejo, живёт в адаптере: `/api/v1`, состояния `APPROVED`/`REQUEST_CHANGES`/`COMMENT`,
  `new_position`, группировка тредов по `(review, path, position)`, ответ в общий тред цитатой, повторная проверка
  публикации при обрыве связи, `refs/pull/N/head`.
- Если `capabilities.requestChanges` = false, адаптер понижает вердикт до `comment`, а отчёт об этом говорит.
- Если `capabilities.inline` = false, `review_publish` кладёт все комментарии в тело ревью (`путь:строка — текст`),
  а `publishReview` получает пустой `comments`.
- Выбор провайдера: явный `provider` и `{host, owner, repo}` в `.claude/review-kit.local.json`, если он есть. Иначе
  адаптер из включённых галочек, чей `detect` узнал `git remote get-url origin`. Не узнал ни один — `/pr` отвечает одной
  строкой: какой remote и какие системы включены.
- `baseBranch` — из `origin/HEAD`. Конфиг проекта нужен только для нестандартного remote.
- `listReviews` и `listThreads` возвращают **все** записи: адаптер проходит все страницы (у Forgejo — по
  `X-Total-Count` или до пустой страницы). Иначе в длинном PR свежие комментарии не придут, и `status.ts` молча
  ошибётся. Ограничение в 50 остаётся только у `listPulls`.

## Статус и сценарий PR (`status.ts`)

Проверки сверху вниз, срабатывает первая:

| Статус | Условие | Сценарий |
|---|---|---|
| влит / закрыт | `state: closed` | `closed` |
| есть замечания | мой PR: открытый тред с чужим последним комментарием, или чужой комментарий/ревью с текстом после моей последней активности | `feedback` |
| на проверке | чужой PR, моих ревью (кроме черновиков) нет | `review` |
| перепроверка | чужой PR: моё последнее ревью (кроме черновиков) не на текущем `headSha`, или автор PR ответил последним в треде, где есть мой комментарий | `recheck` |
| готов к слиянию | есть approve, нет активного request changes, нет открытых тредов | `wait-author` / `none-own` |
| ждём автора | чужой PR, после моего ревью ничего нового | `wait-author` |
| ждём ревью | мой PR без замечаний | `none-own` |

- Черновики ревью (`pending`) не учитываются ни в одной строке.
- «Моя последняя активность» вычисляется одной функцией (сейчас она продублирована в `pr_context.py` и `intake.py`
  и в двух местах считается по-разному). Мои ответы с маркером `<!-- review-kit -->` считаются моими.
- Пункты замечаний (`intake`) берутся из тех же данных, что и сценарий `feedback`, поэтому не могут с ним разойтись.
  У пункта есть метки `stale` (тред к старому коммиту) и `disagree` (ревьюер ответил на наш ответ).
- `/pr` показывает открытые PR со статусом: сначала те, где есть дело, затем остальные. Адаптер читает не больше
  50 PR; если пришло ровно 50, последняя строка списка — «показаны первые 50 открытых PR, остальные — /pr <номер>».
  Статус — первая строка каждого отчёта.

## Инструменты мода

| Инструмент | Контракт |
|---|---|
| `review_start(pr?)` | Как в 2.2: маршрутизация по сценарию, активный или чужой прогон, worktree, занятый веткой, stash грязного дерева, переключение на PR, вопрос о модели (opus/sonnet/haiku), открытие прогона, передача скиллу. Прогон, оставшийся открытым (например, после остановки Plannotator), при следующем `/pr…` предлагается продолжить: «Вернуться к нему» / «Начать заново», как в 2.2. В `context.json` пишет `plannotator: true/false` — найден ли `plannotator` в `PATH` (на Windows с учётом `PATHEXT`: `.cmd`, `.exe` и т.д.). Для `feedback`/`fix` пишет в `session.json` `roundBase` — SHA HEAD после переключения на ветку PR; `commit_push` считает от него коммит раунда |
| `review_prepare(pr, kind)` | `kind`: `review`, `recheck`, `feedback`, `fix-check`. Ищет правила, пишет `input.md` и манифесты, возвращает `{scriptPath, args}` для `Workflow` и строку о пропуске B. Слишком большой вход — ошибка с пояснением |
| `review_collect(pr, outputFile)` | Разбирает результат workflow. Для находок: опровержение только с доказательством в своём файле, проверка файла, строки и цитаты, дубли, пороги `config/funnel.json`. Возвращает `{findings, belowBar, dropped, notChecked}`. Для триажа: ровно один класс на пункт, пропущенным — `question` (feedback) или `unknown` (recheck) |
| `review_publish(pr, ids, texts, approve?)` | Только чужой открытый PR. Собирает тело и inline-комментарии: вне diff — в тело. Вердикт считает мод по серьёзности всех находок отчёта (для recheck — плюс open/partial прошлые замечания как important) и блок статусов прошлых замечаний. `approve` — только просьба одобрить: допустима, лишь если вердикт Approved или Approved with comments; при critical/important — отказ с причиной, ничего не публикуется. Без `approve` одобряемый вердикт публикуется как комментарий. Диалог «Публикуем ревью PR N (вердикт)?» с текстом; для approve — второй вопрос «Одобрить PR N?». Публикует, возвращает URL |
| `replies_publish(pr, replies)` | Только свой открытый PR. Диалог со всеми ответами, затем публикация |
| `commit_push(pr, message, paths)` | Только свой открытый PR и только его ветка, текущая в дереве. Сообщение — одна непустая строка без пробелов по краям; git вызывается массивом аргументов без shell, поэтому запрета на `"`, `$`, `` ` ``, `\` больше нет. Изменённые отслеживаемые файлы вне `paths` — отказ со списком. Диалог: сообщение, файлы и неотправленные коммиты ветки, в том числе созданные до прогона; «Да» подтверждает push их всех. Затем `git add <paths>`, `git commit`, `git push origin HEAD:refs/heads/<branch>` без force. Состояния при повторе: (1) коммита раунда ещё нет — полный цикл; (2) HEAD ≠ `roundBase` из `session.json`, коммит раунда есть (родитель — `roundBase`) и его нет на origin — только push, без нового коммита; если переданное сообщение отличается от сообщения этого коммита — отказ с пояснением, второй коммит не создаётся; (3) коммит раунда уже на origin — «уже отправлено». Push отклонён как non-fast-forward (в ветку PR успел запушить кто-то другой) — отдельный ответ «ветка на origin ушла вперёд — нужен pull/rebase», без повторов. Rebase внутри прогона агенту запрещён `policy.ts`, поэтому скилл предлагает пользователю выполнить его самому (`! git pull --rebase`), затем снова вызвать `commit_push`. Каждый вызов `commit_push` сначала проверяет, что `roundBase` — предок HEAD; если нет (после rebase у коммита раунда новый родитель), `roundBase` пересчитывается как `git merge-base HEAD origin/<branch>` и сохраняется в `session.json`, после чего состояния (1)–(3) определяются заново: закоммиченный и перебазированный раунд попадает в (2) и только пушится; обрыв связи — ответ «push не прошёл: <ошибка>», повтор вызова уходит в состояние (2). pre-commit упал — его вывод возвращается скиллу, коммита нет; если хук сам исправил файлы (форматтер), при повторе `git add <paths>` берёт исправления в тех же путях, а исправления вне `paths` дают отказ со списком — скилл добавляет эти пути и вызывает снова (новый диалог) |
| `review_plannotator(pr, mode)` | Как в 2.2: `review` — находки с черновиками текстов аннотациями над diff PR; `fix` — незакоммиченные правки раунда. Ответ `started: …` / `unavailable: …`, решение приходит отдельным сообщением. Результат `approved`/`annotated` с выбранными id передаётся в `review_publish` |
| `review_tab(prs)` | Для каждого открытого PR — worktree и вкладка Orca. Без Orca — fallback (см. pr-tab) |
| `review_finish(pr)` | Закрывает прогон и предлагает уборку веток, stash и worktree, как в 2.2 |

Файлы прогона: `.review-kit/run/<N>/` — `context.json`, `session.json`, `intake.json`, `recheck.json`,
`funnel/` и `triage/` (`input.md`, `manifest-*.txt`, `gate-*.jsonl`, `raw.json`), `findings.json`, `triage.json`,
`statuses.json`. Аргументы `Workflow`-скриптов не меняются: `{pr, input, manifestDir, roles|mode, model}`.

## Агенты

- Общая инструкция из `review-lite/prompt.md` переносится в `correctness.md` и `quality.md`, без NestJS/Angular и
  без «у тебя нет инструментов».
- **A (correctness):** логика, граничные случаи, пути ошибок, целостность данных, безопасность, контракты между слоями,
  новое ветвление без теста. Обязателен `failureScenario`.
- **B (quality):** только нарушения правил из `RULES`, обязательна дословная цитата (не меньше 6 слов и 30 символов)
  из файла своего манифеста. Запускается, только если правила найдены.
- **C (refuter), D (triage):** логика без изменений. Правила для входа — из того же поиска. Ссылки на
  `.claude/ai-dev-kit` удаляются.
- Агенты запускаются только своими типами через workflow; gate висит только на них.

## Скиллы

Каждый шаг — один вызов инструмента. Нет «run exactly python3 …», нет слов Forgejo/Gitea.

- `pr-flow` — `review_start` по словам пользователя.
- `pr-review-run` — `review_prepare(review)` → `Workflow` → `review_collect` → отчёт (формат из
  `rules/code-review-report.local.md` переезжает сюда) → по просьбе пользователя: «Где разбираем тексты ревью?» —
  «В чате» или «В Plannotator» (`review_plannotator`, при `unavailable` → чат) → `review_publish` → `review_finish`.
  Голый approve без находок — без вопроса о текстах, как в 2.2.
- `pr-recheck-run` — `review_prepare(recheck)` для статусов (D) и дельты (A/B→C); в отчёт только critical и important;
  open/partial считаются important.
- `pr-feedback-run` — `review_prepare(feedback)` → D → сводка → «Чиним» / «Только ответить».
- `pr-fix-run` — сначала, до любых правок, проверка зависимостей: `superpowers:writing-plans` нет среди доступных
  скиллов или `plannotator: false` в `context.json` → остановка с названием недостающего и `review_finish`. Тот же
  шаг выполняет `pr-feedback-run` перед «Чиним». Затем Plan Mode с `superpowers:writing-plans` → правки → по желанию `review_prepare(fix-check)` по diff
  правок → `review_plannotator(fix)` (`annotated` → замечания становятся новыми пунктами, снова план; `dismissed`/`failed`
  → остановка с правками в дереве, без `review_finish`, как в 2.2) → `commit_push` → ответы (`replies_publish`) →
  `review_finish`.
- `pr-tab` — `review_tab`.
- Каждая остановка скилла заканчивается `review_finish`, кроме остановок Plannotator `dismissed`/`failed` в `pr-fix-run`.

## pr-tab

- Worktree `.claude/worktrees/pr-<N>-<branch>` и вкладка Orca с `/pr-review N`.
- Файлы проекта, локальный слой и память в worktree не копируются и не линкуются.
- Orca не найдена → «Orca не найдена — ревью запускаю в текущем дереве», затем обычный `/pr-review N` здесь.
- Сессия во вкладке видит токен, только если переменная задана постоянно (профиль shell, переменные пользователя
  Windows), а не в одном терминале. Если токена там нет, `/pr-review` во вкладке ответит строкой «нет токена».
  README говорит, где задавать переменную.

## Установка

- `.claude-plugin/plugin.json`: `version: "3.0.0"` (единственное место версии), `userConfig: { forgejo: { type: "boolean", title: "Forgejo/Gitea", description: …, default: true } }`.
- `.claude-plugin/marketplace.json`: `{ name: "review-kit", owner: { name: "prianikc" }, plugins: [{ name: "review-kit", source: "." }] }`.
- Команды: `/plugin marketplace add prianikc/review-kit`, `/plugin install review-kit@review-kit`.
- README: «Установка» (токен в переменной окружения; внешние зависимости: Orca для `pr-tab` — без неё ревью в текущем
  дереве; Plannotator и superpowers — для раунда правок, Plannotator ещё и как способ разбора текстов ревью;
  `npx skills` не ставит мод; токен задаётся постоянно — профиль shell или переменные пользователя Windows, иначе
  вкладки `pr-tab` его не увидят; плагин не запускает проверки — без pre-commit push уходит непроверенным;
  ревью чужого PR переключает дерево на его код: если PR меняет файлы из `CLAUDE_CODE_PATHS` (`.claude/**`,
  `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude-plugin/**`), мод предупреждает, но хуки и MCP из головы PR при продолжении могут выполнить команды, а `CLAUDE.md` дерева Claude
  Code подгружает сам; после 2.2 удалить вручную `.claude/review-kit.installed.json`,
  `.claude/skills/review-kit/`, файлы токена `~/.config/forgejo/…`) и «Как устроено» (мод, инструменты, скиллы,
  агенты). Плюс короткий ответ команде.

## Ошибки

| Ситуация | Поведение |
|---|---|
| Нет токена | Одна строка: какую переменную задать (из `provider.tokenEnv`). Прогон не открывается |
| Remote не узнан ни одним включённым адаптером | Одна строка: remote и список включённых систем |
| Все системы выключены, явного `provider` нет | «Все системы выключены — включите в /plugin → Configure options» |
| `approve` при critical/important | Отказ с причиной, ничего не публикуется |
| Push упал после коммита (обрыв связи) | Повтор `commit_push` только пушит |
| Push отклонён как non-fast-forward | «Ветка на origin ушла вперёд — нужен pull/rebase», без повторов. Пользователь делает `! git pull --rebase`, повтор `commit_push` пересчитывает `roundBase` и только пушит |
| PR меняет файлы правил агентов | Ревью по правилам базы, отдельная строка в отчёте |
| Чужой PR меняет файлы из `CLAUDE_CODE_PATHS` (`.claude/**`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude-plugin/**`) | Текущее дерево: диалог «Продолжить» / «Отмена» до переключения. `pr-tab`: вкладка не открывается, предлагается ревью здесь |
| Ошибка API при чтении | Сообщение с кодом и путём. Дерево не тронуто |
| Обрыв связи при публикации ревью | Адаптер ищет опубликованное ревью по автору и тексту. Не нашёл — «статус публикации неизвестен — проверьте PR», повтор запрещён |
| Пользователь отказал в диалоге | Ничего не публикуется и не коммитится |
| pre-commit упал | Вывод возвращается скиллу, тот чинит и снова вызывает `commit_push` (новый диалог) |
| Workflow не дал результата / все искатели упали | «Ревью агентами не состоялось — не проверено», без вердикта, `review_finish` |
| Вход слишком большой | Сообщение, `review_finish` |
| Нет правил | B не запускается, строка в «Не проверялось» |
| Plannotator не установлен | Тексты ревью — в чате. Раунд правок не начинается: остановка в начале `pr-fix-run` (и перед «Чиним» в `pr-feedback-run`) «нужен Plannotator» |
| Plannotator не открылся или закрыт без решения в раунде правок | Остановка, правки остаются в дереве, прогон открыт — следующий `/pr-fix N` предложит продолжить |
| superpowers не установлен | Раунд правок не начинается: остановка в начале `pr-fix-run` «нужен superpowers» |
| Сырые `git push`/`commit`, curl-запись, `--force`, `--amend` в прогоне | Мод отклоняет |
| Грязное дерево, занятая ветка, переписанная история, удалённая база | Как в 2.2 (`switch-pr`, `cleanup`): диалоги stash и worktree, коды ошибок переносятся в `git.ts` |

## Тесты

- `node --test` (Node 24, TS без сборки и без зависимостей) по `mod/**/*.test.ts`.
- Юнит-тесты: маппинг Forgejo ↔ общая модель на записанных ответах API (`mod/forge/fixtures/`), включая пагинацию на 2+ страницы; выбор провайдера
  (галочки, явный конфиг побеждает, всё выключено, remote не узнан); `status.ts` по каждой строке таблицы статусов,
  включая черновики и свой ответ в своём треде; проверка изменённых настроек Claude Code в чужом PR; `run.ts` (поиск
  правил по `ls-tree` merge-base, новые папки PR, правила с базы и строка об изменённых правилах,
  пропуск B, пороги, проверка цитаты и строки, дубли, триаж, вердикт, отказ approve при important, тело без inline);
  `git.ts` на временном репозитории (переключение, snapshot, commit+push в локальный bare-remote: все три состояния
  повтора, другое сообщение при повторе, non-fast-forward, повтор после rebase с пересчётом `roundBase`, pre-commit, исправивший файлы, файлы вне `paths`;
  `CLAUDE_CODE_PATHS` на вложенных путях); `review_start` — порядок fetch → merge-base → проверка → диалог →
  переключение и повторная проверка при recheck на новом `headSha`; `policy.ts`; `gate.ts`.
- Фейковый провайдер в тестах проходит сценарии `review`, `recheck`, `feedback`, `wait-author` без изменений ядра.
- Паритет: перед удалением каждого Python-скрипта его TS-замена выдаёт тот же результат на тех же входах (там, где
  поведение не меняется спекой).
- Финальные проверки: `grep -rniE "forgejo|gitea|/api/v1" --exclude-dir=forge` по плагину пуст, кроме README,
  `plugin.json` (галочка `userConfig`), `PLAN.md`, `CLAUDE.md` и `docs/`; grep чистоты из `PLAN.md` без `plannotator` в шаблоне пуст; `claude plugin validate .` проходит.
- `plannotator.ts`: сборка аннотаций и разбор решений (`approved`/`annotated`/`dismissed`) на записанных выводах
  Plannotator, паритет с `plannotator.py`.

## Этапы

На каждый этап — свой план реализации, после этапа остановка до «дальше» пользователя.

1. Удаления: lite (кроме `review_lite_input.py`/`review_lite_check.py`, пока на них опираются другие скрипты),
   simplify, проверки, установщик, usage, `rules/` (копируемые установщиком файлы), `VERSION`, `pack`, хук ai-dev-kit
   в `commit-push`. Перенос
   `prompt.md` в агентов, манифест его больше не включает. `stack`, `RULE_PREFIXES` и `AGENTS.md` в манифесте
   остаются до этапа 3, чтобы B не остался без правил. Плагин после этапа работает (только режим agents).
2. Каркас тестов, `forge/types.ts`, фейковый провайдер, `forge/forgejo.ts`, `forge/index.ts`.
3. `status.ts`, `run.ts` (поиск правил с базы заменяет `stack`, `RULE_PREFIXES`, `AGENTS.md`-floor), `git.ts`,
   `plannotator.ts`, новые инструменты, паритет с Python, удаление `tools/`, упрощение `policy.ts` и `gate.ts`,
   удаление `review_confirm`.
4. Скиллы на инструментах.
5. Статусы в `/pr` и отчётах.
6. `pr-tab` с fallback.
7. `userConfig`, `marketplace.json`, README, ответ команде, правка `CLAUDE.md` и `PLAN.md`. Формулировку пути к
   настройкам плагина («/plugin → … Configure options») в сообщениях и README сверить с реальным интерфейсом.

## В 3.0 не делаем

- Адаптеры GitHub, GitLab, Bitbucket.
- Изменение порогов воронки и логики агентов сверх правил и стека.
- Пагинацию списка PR дальше 50 (комментарии и ревью читаются полностью).
- Resolve тредов после исправлений.
- Миграцию настроек 2.2 (файлы токена, `forgejo` в конфиге).
