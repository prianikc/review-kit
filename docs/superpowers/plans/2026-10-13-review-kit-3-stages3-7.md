# review-kit 3.0 — этапы 3–7: ядро в моде, скиллы, статусы, pr-tab, установка — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Довести review-kit до 3.0: весь `tools/` (Python и bash) переезжает в TS-мод, ядро работает через `mod/forge/`,
публикация и commit+push выполняются инструментами мода с собственным подтверждением, скиллы становятся короткими,
у PR есть статус, `pr-tab` работает с fallback без Orca, плагин ставится через `/plugin install` с выбором системы.

**Architecture:** Чистые модули без импорта `'claude-code'` (процессы, файлы, HTTP приходят параметром) —
`mod/status.ts`, `mod/git.ts`, `mod/run/{input,findings,review}.ts`, `mod/plannotator.ts`; их вызывает `mod/register.ts`,
который остаётся маршрутизатором команд, инструментов и хуков. Каждый подэтап — своя ветка (и PR, если пользователь попросит закоммитить) поверх предыдущего,
после каждого плагин работает.

**Tech Stack:** TypeScript (Node 24, стирание типов, без сборки и зависимостей), `node:test`, git, Markdown-скиллы.

**Spec:** `docs/superpowers/specs/2026-10-12-review-kit-3-design.md`

## Global Constraints

- Стираемый TS: нет `enum`, `namespace`, параметр-свойств; относительные импорты с `.ts`; из `'claude-code'` значения импортирует только `register.ts`, остальные — `import type`.
- Стиль `mod/`: без точек с запятой, одинарные кавычки, константы `UPPER_CASE` в начале файла, `const` по умолчанию.
- Вне `mod/forge/` нет обращений к API и слов Forgejo/Gitea (кроме README, `plugin.json`, `PLAN.md`, `CLAUDE.md`, `docs/`).
- Всё, что видит пользователь, — на русском; тексты скиллов и промпты агентов — на английском.
- Имя команды мода и имя скилла никогда не совпадают.
- Необратимое (публикация ревью/ответов, commit+push) — только после диалога мода внутри инструмента; «да» в чате не считается.
- Внутри активного прогона мод отклоняет сырые `git commit`/`push`/`pull`/`--force`/`--amend`/`rebase`, curl/wget-запись.
- Каждая остановка скилла заканчивается `review_finish`, кроме остановок Plannotator (`unavailable`, `dismissed`, `failed`) в `pr-fix-run`: правки остаются в дереве, прогон открыт, следующий `/pr-fix N` предлагает продолжить.
- Агенты A–D запускаются только своими типами через workflow; находка без сценария отказа (A) или дословной цитаты (B) отбрасывается.
- Токен — только из переменных окружения адаптера; Plannotator и superpowers — зависимости раунда правок; Orca — только `pr-tab`.
- Тесты: `node --test 'mod/**/*.test.ts'`; синтаксис: `TMPDIR=$S node $S/tscheck.mjs <файлы>` (скрипт из плана этапа 1, scratchpad `$S`; если его нет — создать тем же кодом).
- Коммиты и PR — только по просьбе пользователя; в плане нет шагов `git add`/`git commit`.
- Каждый подэтап заканчивается стоп-точкой: пользователь решает, коммитить ли и открывать ли PR (коммит и PR делаются только по его просьбе). Следующий подэтап начинается с `git switch -c feature/3.0-<подэтап>` от ветки предыдущего — после того как её работа закоммичена; если пользователь коммитить не стал, работа продолжается в той же ветке.

## Review Focus

1. Чужой PR меняет `.claude/settings.json` (хук) → до переключения дерева диалог «PR меняет настройки Claude Code», по умолчанию «Отмена»; `pr-tab` вкладку не открывает (3c, 6 — тесты `claudeCodeChanges`).
2. Агент B цитирует правило, которое PR сам добавил в `CLAUDE.md` → цитата не находится в правилах базы, находка отбрасывается `quote-not-found` (3b — тест «правила с базы»).
3. Повтор `commit_push` после упавшего push и после `git pull --rebase` → второго коммита нет, только push (3c — тесты состояний).
4. `review_publish` с `approve` при important-находке → отказ, ничего не публикуется (3c — тест).
5. Длинный PR, где свежие ответы автора на 2-й странице комментариев → сценарий `recheck`, не `wait-author`. Покрыто только тестами пагинации адаптера этапа 2 (`пагинация: 50 + 3`, `по 30 — до X-Total-Count`): `status.ts` страниц не видит и получает уже полный список; отдельного теста в 3a нет.

---

## Карта этапов

| Подэтап | Ветка | Что уходит из `tools/` | Что появляется |
|---|---|---|---|
| 3a | `feature/3.0-stage3a` | `pr_context.py`, `intake.py`, `recheck_prep.py` | `mod/status.ts`, `mod/git.ts` (`recheckBase`), `withTimeout`, `/pr` и маршрутизация через `forge/` |
| 3b | `feature/3.0-stage3b` | `funnel_prep.py`, `funnel_finish.py`, `triage_prep.py`, `triage_finish.py`, `review_lite_input.py`, `review_lite_check.py`, `snapshot`, `stack` | `mod/run/input.ts`, `mod/run/findings.ts`, инструменты `review_prepare`, `review_collect`; правила с базы; gate без `accessDenial` |
| 3c | `feature/3.0-stage3c` | `forgejo.py`, `review_payload.py`, `replies.py`, `switch-pr`, `commit-push`, `cleanup.py` | `mod/run/review.ts`, `git.ts` (switch, commit, cleanup, `CLAUDE_CODE_PATHS`), инструменты `review_publish`, `replies_publish`, `commit_push`; без `review_confirm`; `policy.ts` урезан |
| 3d | `feature/3.0-stage3d` | `plannotator.py` | `mod/plannotator.ts` |
| 4 | `feature/3.0-stage4` | — | скиллы на инструментах мода |
| 5 | `feature/3.0-stage5` | — | статусы PR в `/pr` и отчётах |
| 6 | `feature/3.0-stage6` | `open-pr-tab`, папка `tools/` | инструмент `review_tab`, скилл `pr-tab` |
| 7 | `feature/3.0-stage7` | — | `userConfig`, версия 3.0.0, `marketplace.json`, README, ответ команде, `CLAUDE.md`, `PLAN.md` |

Скиллы на этапах 3a–3d правятся минимально — ровно там, где меняется контракт (вызов удалённого скрипта → инструмент);
полная переработка текстов — этап 4.

## Отклонения от спеки (решения)

- `run.ts` разделён на `mod/run/input.ts` (правила и вход агентов), `mod/run/findings.ts` (сбор находок и триажа),
  `mod/run/review.ts` (вердикт, тело ревью, ответы): один файл вышел бы на ~600 строк трёх разных обязанностей.
- `review_publish` берёт тексты не аргументом, а из `.review-kit/run/<N>/texts.json` (пишет скилл) или из результата
  Plannotator (`from: 'plannotator'`); `replies_publish` — из `replies.json`. Длинные тексты в аргументах инструмента
  неудобны модели, а файлы прогона уже есть.
- Сценарий `feedback` = «есть пункты intake» (одна функция для обоих), и маркер `<!-- review-kit -->` считается «моим»
  везде. В 2.2 `pr_context.py` маркер не учитывал — в краевых случаях сценарий может отличаться; это и есть исправление.
- Правила своего PR (`feedback`, `fix-check`) берутся из `HEAD`, а не из незакоммиченного дерева.
- В `input.md` нет раздела `FOCUS` (агенты его не используют).
- Агенты A/B ссылаются только на файлы раздела RULES («правило из контекста» больше не принимается — проверка цитаты идёт по найденным правилам).
- `recheckBase` бросает ошибку, если базу не найти (2.2 писал пустую базу).
- `open-pr-tab` живёт до этапа 6, поэтому папка `tools/` удаляется на этапе 6, а не 3.
- Мои прошлые замечания для перепроверки включают и мои треды прежних ревью, где автор ответил последним: именно они
  дают сценарий `recheck` (в 2.2 такой тред запускал перепроверку, но агент D его не видел).
- Plannotator `approved`: отправленные находки, которые человек не тронул, публикуются с исходными текстами — и когда
  правок нет вовсе, и когда есть только общая заметка (в 2.2 в обоих случаях «Публиковать нечего» или только тело).
- Любой `git pull` внутри прогона запрещён модели (с `--rebase`, `-r` или `pull.rebase` в конфиге он переписывает историю); подтянуть ветку при non-fast-forward пользователь делает сам: `! git pull --rebase` или в своём терминале.
- Остановка `pr-fix-run` при `review_plannotator: unavailable` тоже без `review_finish` (как `dismissed`/`failed`): правки в
  дереве, прогон открыт.
- `roundState` пересчитывает базу раунда, если HEAD не стоит на ней или прямо над ней (строже «roundBase — предок HEAD»):
  после `pull --rebase` у коммита раунда новый родитель, хотя старая база осталась предком.
- Файл с настоящим символом U+FFFD считается «не UTF-8»: `$.process.run` отдаёт уже декодированный текст, и отличить
  замену от настоящего символа нельзя. Такой файл не прикладывается к входу — безопасная сторона.
- Каталог прогона очищается при старте нового прогона (не при продолжении): файлы прошлого прогона того же PR не
  попадают в новый.
- Платформа — POSIX (Linux, macOS, WSL). Нативная Windows без WSL не поддерживается: мод вызывает `rm`, `ls`, `git`.
- Модель тредов: ответ в треде лежит в том же ревью, что и исходный комментарий (так хранит Forgejo/Gitea; адаптер
  этапа 2 группирует по `reviewId:path:position` и сам отвечает через `/reviews/{id}/comments` исходного ревью). На этом
  стоят `scenarioOf` (автор ответил последним), `disagree` в intake и прошлые замечания; живая проверка 3a это подтверждает.

## Что не делаем

- Адаптеры GitHub/GitLab/Bitbucket, пагинацию списка PR дальше 50, resolve тредов, миграцию настроек 2.2.
- Изменение порогов воронки и логики агентов сверх правил и стека.
- Отложенные мелочи этапов 1–2 вне явных задач ниже: ответ 502/504 при публикации без поиска созданного ревью, ограничение параллельных запросов комментариев ревью в адаптере.
- Общий лимит одновременных запросов к хостингу: `/pr` грузит по 4 PR, каждый — 4 запроса плюс комментарии каждого ревью
  параллельно; пик — десятки запросов. Для self-hosted Forgejo это допустимо; общий семафор на HTTP — следующая версия.

---

# Подэтап 3a: статус PR и маршрутизация через forge

### Task 3a.1: `mod/status.ts` — сценарий, intake, прошлые замечания

**Files:**
- Create: `mod/status.ts`
- Test: `mod/status.test.ts`

**Interfaces:**
- Consumes: `ForgeProvider`, `PullRequest`, `Review`, `Thread`, `Comment` (`mod/forge/types.ts`); `fakeProvider` (`mod/forge/fake.ts`).
- Produces:
  - `MARKER = '<!-- review-kit -->'`
  - `type Scenario = 'closed' | 'feedback' | 'none-own' | 'review' | 'recheck' | 'wait-author'`
  - `interface PrData { pull: PullRequest; me: string; reviews: Review[]; threads: Thread[]; general: Comment[] }`
  - `loadPr(provider: ForgeProvider, number: number, pull?: PullRequest): Promise<PrData>`
  - `interface IntakeItem { id: string; kind: 'thread' | 'issue' | 'review'; reviewId: string | null; threadId: string | null; path: string | null; position: number | null; commitId: string; author: string; quote: string; stale: boolean; disagree: boolean }`
  - `intakeItems(data: PrData): IntakeItem[]`
  - `scenarioOf(data: PrData): Scenario`
  - `interface PriorItem { id: string; reviewId: string; path: string | null; line: number | null; author: string; body: string; quote: string }`
  - `priorComments(data: PrData): { review: Review; prior: PriorItem[] } | null`
  - `interface PrContext { number; title; author; isOwn; headRef; headSha; baseRef; state; merged; url; scenario }` (поля и типы как в 2.2 `register.ts`)
  - `contextOf(data: PrData, scenario: Scenario): PrContext`
  - `ACTIONABLE: readonly Scenario[]`, `interface ListRow { number; title; author; isOwn; scenario }`, `actionableRows(provider: ForgeProvider): Promise<ListRow[]>`

- [ ] **Step 1: Тесты**

`mod/status.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { actionableRows, contextOf, intakeItems, loadPr, MARKER, priorComments, scenarioOf, type PrData } from './status.ts'
import { fakeProvider } from './forge/fake.ts'
import type { Comment, PullRequest, Review, Thread } from './forge/types.ts'

const pull = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 5, title: 'T', author: 'bob', headRef: 'f', headSha: 'h2', baseRef: 'main', state: 'open', merged: false, url: 'u', ...over })
const review = (id: string, author: string, state: Review['state'], commitSha = 'h1', submittedAt = '2026-10-01T10:00:00Z', body = ''): Review => ({ id, author, state, body, commitSha, submittedAt, dismissed: false })
const comment = (id: string, author: string, body: string, createdAt: string, reviewId = 'r1'): Comment => ({ id, author, body, createdAt, path: 'a.ts', line: 3, commitSha: 'h1', reviewId })
const thread = (comments: Comment[], resolved = false): Thread => ({ id: `${comments[0].reviewId}:a.ts:3`, path: 'a.ts', line: 3, commitSha: 'h1', comments, resolved })
const data = (over: Partial<PrData> = {}): PrData => ({ pull: pull(), me: 'alice', reviews: [], threads: [], general: [], ...over })
const own = (over: Partial<PrData> = {}) => data({ pull: pull({ author: 'Alice' }), ...over })

test('закрытый PR', () => {
  assert.equal(scenarioOf(data({ pull: pull({ state: 'closed' }) })), 'closed')
})

test('чужой PR: моего ревью нет (черновик не в счёт) → review', () => {
  assert.equal(scenarioOf(data()), 'review')
  assert.equal(scenarioOf(data({ reviews: [review('r1', 'alice', 'pending')] })), 'review')
})

test('чужой PR: новые коммиты после моего ревью → recheck', () => {
  assert.equal(scenarioOf(data({ reviews: [review('r1', 'alice', 'changes', 'h1')] })), 'recheck')
})

test('чужой PR: автор ответил последним в моём треде → recheck', () => {
  const threads = [thread([comment('c1', 'alice', 'null тут', '2026-10-01T10:00:00Z'), comment('c2', 'BOB', 'поправил', '2026-10-01T11:00:00Z')])]
  assert.equal(scenarioOf(data({ reviews: [review('r1', 'alice', 'changes', 'h2')], threads })), 'recheck')
})

test('чужой PR: ничего нового → wait-author', () => {
  const threads = [thread([comment('c1', 'alice', 'null тут', '2026-10-01T10:00:00Z')])]
  assert.equal(scenarioOf(data({ reviews: [review('r1', 'alice', 'changes', 'h2')], threads })), 'wait-author')
})

test('свой PR: открытый тред с чужим последним словом → feedback и пункт intake', () => {
  const d = own({ threads: [thread([comment('c1', 'carol', 'Имя', '2026-10-01T10:00:00Z')])] })
  assert.equal(scenarioOf(d), 'feedback')
  assert.deepEqual(intakeItems(d), [{
    id: 'r1/c1', kind: 'thread', reviewId: 'r1', threadId: 'r1:a.ts:3', path: 'a.ts', position: 3, commitId: 'h1',
    author: 'carol', quote: 'carol: Имя', stale: true, disagree: false,
  }])
})

test('свой PR: последнее слово моё, решённый тред, ответ с маркером → none-own', () => {
  assert.equal(scenarioOf(own({ threads: [thread([comment('c1', 'carol', 'Имя', '2026-10-01T10:00:00Z'), comment('c2', 'alice', 'ок', '2026-10-01T11:00:00Z')])] })), 'none-own')
  assert.equal(scenarioOf(own({ threads: [thread([comment('c1', 'carol', 'Имя', '2026-10-01T10:00:00Z')], true)] })), 'none-own')
  assert.equal(scenarioOf(own({ threads: [thread([comment('c1', 'carol', 'Имя', '2026-10-01T10:00:00Z'), comment('c2', 'kit-bot', `Сделано\n\n${MARKER}`, '2026-10-01T11:00:00Z')])] })), 'none-own')
})

test('свой PR: ревьюер ответил на наш ответ → disagree, цитата всего треда', () => {
  const d = own({ threads: [thread([
    comment('c1', 'carol', 'Имя', '2026-10-01T10:00:00Z'),
    comment('c2', 'alice', 'Так принято', '2026-10-01T11:00:00Z'),
    comment('c3', 'carol', 'Нет', '2026-10-01T12:00:00Z'),
  ])] })
  const [item] = intakeItems(d)
  assert.equal(item.disagree, true)
  assert.equal(item.quote, 'carol: Имя\nalice: Так принято\ncarol: Нет')
})

test('свой PR: общий комментарий и ревью с текстом — только после моей последней активности', () => {
  const general = [comment('g1', 'carol', 'старое', '2026-10-01T09:00:00Z'), comment('g2', 'alice', 'мой', '2026-10-01T10:00:00Z'), comment('g3', 'dave', 'новое', '2026-10-01T11:00:00Z')]
  const reviews = [review('r7', 'carol', 'changes', 'h2', '2026-10-01T12:00:00Z', 'Поправьте'), review('r8', 'erin', 'comment', 'h2', '2026-10-01T12:30:00Z', '   ')]
  assert.deepEqual(intakeItems(own({ general, reviews })).map(i => [i.id, i.kind]), [['issue/g3', 'issue'], ['review/r7', 'review']])
})

test('свой PR: тред черновика не учитывается', () => {
  const d = own({ reviews: [review('r9', 'carol', 'pending')], threads: [thread([comment('c1', 'carol', 'черновик', '2026-10-01T10:00:00Z', 'r9')])] })
  assert.equal(scenarioOf(d), 'none-own')
})

test('priorComments: мои комментарии последнего ревью и его текст', () => {
  const reviews = [review('r1', 'alice', 'changes', 'h1', '2026-10-01T10:00:00Z', 'старое'), review('r2', 'alice', 'changes', 'h2', '2026-10-02T10:00:00Z', 'Итог')]
  const threads = [thread([comment('c5', 'alice', 'тут', '2026-10-02T10:00:00Z', 'r2'), comment('c6', 'bob', 'ок', '2026-10-02T11:00:00Z', 'r2')])]
  const result = priorComments(data({ reviews, threads }))
  assert.equal(result?.review.id, 'r2')
  assert.deepEqual(result?.prior.map(p => [p.id, p.path, p.line]), [['r2/c5', 'a.ts', 3], ['review/r2', null, null]])
  assert.equal(priorComments(data()), null)
})

test('priorComments: тред прежнего ревью, где автор ответил последним, тоже перепроверяется', () => {
  const reviews = [review('r1', 'alice', 'changes', 'h1', '2026-10-01T10:00:00Z'), review('r2', 'alice', 'comment', 'h2', '2026-10-02T10:00:00Z', 'Итог 2')]
  const old = thread([comment('c1', 'alice', 'старое', '2026-10-01T10:00:00Z', 'r1'), comment('c2', 'bob', 'ответ', '2026-10-03T10:00:00Z', 'r1')])
  const quiet = { ...thread([comment('c3', 'alice', 'молчит', '2026-10-01T10:00:00Z', 'r1')]), id: 'r1:b.ts:1' }
  const d = data({ reviews, threads: [old, quiet] })
  assert.equal(scenarioOf(d), 'recheck')
  assert.deepEqual(priorComments(d)?.prior.map(p => p.id), ['r1/c1', 'review/r2'])
})

test('contextOf: поля для прогона', () => {
  assert.deepEqual(contextOf(own(), 'none-own'), {
    number: 5, title: 'T', author: 'Alice', isOwn: true, headRef: 'f', headSha: 'h2', baseRef: 'main',
    state: 'open', merged: false, url: 'u', scenario: 'none-own',
  })
})

test('фейковый провайдер: четыре сценария без изменений ядра', async () => {
  const pulls = [pull({ number: 1, author: 'alice' }), pull({ number: 2 }), pull({ number: 3 }), pull({ number: 4 })]
  const fake = fakeProvider({
    me: 'alice', pulls,
    reviews: { 3: [review('r3', 'alice', 'changes', 'h1')], 4: [review('r4', 'alice', 'changes', 'h2')] },
    threads: { 1: { threads: [thread([comment('c1', 'carol', 'Имя', '2026-10-01T10:00:00Z')])], general: [] } },
  })
  const scenarios = await Promise.all([1, 2, 3, 4].map(async n => scenarioOf(await loadPr(fake, n))))
  assert.deepEqual(scenarios, ['feedback', 'review', 'recheck', 'wait-author'])
  assert.deepEqual((await actionableRows(fake)).map(r => [r.number, r.scenario]), [[1, 'feedback'], [2, 'review'], [3, 'recheck']])
})
```

- [ ] **Step 2: Запустить — падает**

Run: `node --test mod/status.test.ts 2>&1 | grep -E "Cannot find|^ℹ (pass|fail)"`
Expected: `Cannot find module '.../mod/status.ts'`.

- [ ] **Step 3: Создать `mod/status.ts`**

```ts
import type { Comment, ForgeProvider, PullRequest, Review, Thread } from './forge/types.ts'

/** метка ответов, которые публикует review-kit: такие комментарии — «мои» */
export const MARKER = '<!-- review-kit -->'
/** сценарии, по которым у пользователя есть дело */
export const ACTIONABLE: readonly Scenario[] = ['feedback', 'review', 'recheck']

/** что делать с PR */
export type Scenario = 'closed' | 'feedback' | 'none-own' | 'review' | 'recheck' | 'wait-author'

/** всё о PR, что нужно для решений ядра */
export interface PrData {
  /** сам PR */
  pull: PullRequest
  /** логин пользователя */
  me: string
  /** все ревью, включая черновики */
  reviews: Review[]
  /** треды к коду */
  threads: Thread[]
  /** общие комментарии */
  general: Comment[]
}

/** пункт замечаний к своему PR (формат intake.json 2.2 + threadId) */
export interface IntakeItem {
  /** id пункта: reviewId/commentId, issue/id, review/id */
  id: string
  /** тред, общий комментарий или текст ревью */
  kind: 'thread' | 'issue' | 'review'
  /** ревью, к которому относится пункт */
  reviewId: string | null
  /** тред для ответа (только у thread) */
  threadId: string | null
  /** файл (только у thread) */
  path: string | null
  /** строка (только у thread) */
  position: number | null
  /** коммит, к которому оставлено замечание */
  commitId: string
  /** автор последнего слова */
  author: string
  /** текст замечания (у треда — весь тред «автор: текст» построчно) */
  quote: string
  /** тред к старому коммиту */
  stale: boolean
  /** ревьюер ответил на наш ответ */
  disagree: boolean
}

/** моё прошлое замечание для перепроверки (формат recheck.json 2.2) */
export interface PriorItem {
  /** reviewId/commentId или review/reviewId */
  id: string
  /** ревью, в котором оставлено */
  reviewId: string
  /** файл (null — текст ревью) */
  path: string | null
  /** строка (null — текст ревью) */
  line: number | null
  /** я */
  author: string
  /** текст */
  body: string
  /** текст (для ITEMS агента D) */
  quote: string
}

/** контекст PR для прогона (формат context.json 2.2) */
export interface PrContext {
  /** номер */
  number: number
  /** заголовок */
  title: string
  /** автор */
  author: string
  /** мой ли PR */
  isOwn: boolean
  /** ветка PR */
  headRef: string
  /** голова PR */
  headSha: string
  /** базовая ветка */
  baseRef: string
  /** open | closed */
  state: 'open' | 'closed'
  /** влит ли */
  merged: boolean
  /** ссылка */
  url: string
  /** сценарий */
  scenario: Scenario
}

/** строка списка /pr */
export interface ListRow {
  /** номер */
  number: number
  /** заголовок */
  title: string
  /** автор */
  author: string
  /** мой ли PR */
  isOwn: boolean
  /** сценарий */
  scenario: Scenario
}

/** логины равны без учёта регистра; пустой логин (удалённый пользователь) не равен никому */
function same(a: string, b: string): boolean {
  return a !== '' && a.toLowerCase() === b.toLowerCase()
}

/** комментарий мой: я автор или он помечен маркером review-kit */
function mine(comment: Comment, me: string): boolean {
  return same(comment.author, me) || comment.body.includes(MARKER)
}

/** последний комментарий треда */
function lastOf(thread: Thread): Comment {
  return thread.comments[thread.comments.length - 1]
}

/** ревью и треды без черновиков */
function live(data: PrData): { reviews: Review[]; threads: Thread[] } {
  const drafts = new Set(data.reviews.filter(review => review.state === 'pending').map(review => review.id))
  return {
    reviews: data.reviews.filter(review => !drafts.has(review.id)),
    threads: data.threads.filter(thread => thread.comments.length > 0 && !drafts.has(thread.comments[0].reviewId ?? '')),
  }
}

/** загружает PR, ревью, треды и логин параллельно */
export async function loadPr(provider: ForgeProvider, number: number, pull?: PullRequest): Promise<PrData> {
  const [loaded, me, reviews, discussion] = await Promise.all([pull ?? provider.getPull(number), provider.currentUser(), provider.listReviews(number), provider.listThreads(number)])
  return { pull: loaded, me, reviews, threads: discussion.threads, general: discussion.general }
}

/** пункты замечаний к своему PR: открытые треды с чужим последним словом и всё чужое после моей последней активности */
export function intakeItems(data: PrData): IntakeItem[] {
  const { reviews, threads } = live(data)
  const { me } = data
  const myTimes = [
    ...[...threads.flatMap(thread => thread.comments), ...data.general].filter(comment => mine(comment, me)).map(comment => Date.parse(comment.createdAt)),
    ...reviews.filter(review => same(review.author, me)).map(review => Date.parse(review.submittedAt)),
  ]
  const myLast = Math.max(-Infinity, ...myTimes)
  const later = (iso: string) => Date.parse(iso) > myLast

  const threadItems: IntakeItem[] = threads.filter(thread => !thread.resolved && !mine(lastOf(thread), me)).map(thread => {
    const first = thread.comments[0]
    const commit = first.commitSha ?? ''
    return {
      id: `${first.reviewId ?? thread.id}/${first.id}`, kind: 'thread', reviewId: first.reviewId ?? null, threadId: thread.id, path: first.path ?? null,
      position: first.line ?? null, commitId: commit, author: lastOf(thread).author,
      quote: thread.comments.map(comment => `${comment.author}: ${comment.body}`).join('\n'), stale: commit !== data.pull.headSha,
      disagree: thread.comments.slice(0, -1).some(comment => mine(comment, me)),
    }
  })
  const issueItems: IntakeItem[] = data.general.filter(comment => !mine(comment, me) && later(comment.createdAt)).map(comment => ({
    id: `issue/${comment.id}`, kind: 'issue', reviewId: null, threadId: null, path: null, position: null, commitId: '',
    author: comment.author, quote: comment.body, stale: false, disagree: false,
  }))
  const reviewItems: IntakeItem[] = reviews
    .filter(review => (review.state === 'changes' || review.state === 'comment') && review.body.trim() && !same(review.author, me) && later(review.submittedAt))
    .map(review => ({
      id: `review/${review.id}`, kind: 'review', reviewId: review.id, threadId: null, path: null, position: null, commitId: review.commitSha,
      author: review.author, quote: review.body, stale: false, disagree: false,
    }))
  return [...threadItems, ...issueItems, ...reviewItems]
}

/** моё последнее ревью (без черновиков). Ответы в тредах Forgejo/Gitea кладут в исходное ревью треда, отдельного ревью
 * они не создают — поэтому «последнее ревью» здесь всегда настоящее */
function latestMine(reviews: Review[], me: string): Review | undefined {
  return reviews.filter(review => same(review.author, me)).sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt)).at(-1)
}

/** сценарий PR для пользователя */
export function scenarioOf(data: PrData): Scenario {
  if (data.pull.state === 'closed') return 'closed'
  if (same(data.pull.author, data.me)) return intakeItems(data).length > 0 ? 'feedback' : 'none-own'

  const { reviews, threads } = live(data)
  const last = latestMine(reviews, data.me)
  if (!last) return 'review'
  if (last.commitSha !== data.pull.headSha) return 'recheck'
  const answered = threads.some(thread => thread.comments.some(comment => same(comment.author, data.me)) && same(lastOf(thread).author, data.pull.author))
  return answered ? 'recheck' : 'wait-author'
}

/** мои замечания для перепроверки: всё моё в последнем ревью и мои треды прежних ревью, где автор ответил последним
 * (именно они дают сценарий recheck); null — моего ревью нет */
export function priorComments(data: PrData): { review: Review; prior: PriorItem[] } | null {
  const { reviews, threads } = live(data)
  const last = latestMine(reviews, data.me)
  if (!last) return null
  const toPrior = (comment: Comment): PriorItem => {
    const reviewId = comment.reviewId ?? last.id
    return { id: `${reviewId}/${comment.id}`, reviewId, path: comment.path ?? null, line: comment.line ?? null, author: data.me, body: comment.body, quote: comment.body }
  }
  const latest = threads.flatMap(thread => thread.comments).filter(comment => comment.reviewId === last.id && same(comment.author, data.me))
  const answered = threads
    .filter(thread => thread.comments[0].reviewId !== last.id && same(lastOf(thread).author, data.pull.author))
    .flatMap(thread => thread.comments.filter(comment => same(comment.author, data.me)).slice(0, 1))
  const prior: PriorItem[] = [...latest, ...answered].map(toPrior)
  const body: PriorItem[] = last.body.trim() ? [{ id: `review/${last.id}`, reviewId: last.id, path: null, line: null, author: data.me, body: last.body, quote: last.body }] : []
  return { review: last, prior: [...prior, ...body] }
}

/** контекст прогона */
export function contextOf(data: PrData, scenario: Scenario): PrContext {
  const { pull } = data
  return {
    number: pull.number, title: pull.title, author: pull.author, isOwn: same(pull.author, data.me), headRef: pull.headRef, headSha: pull.headSha,
    baseRef: pull.baseRef, state: pull.state, merged: pull.merged, url: pull.url, scenario,
  }
}

/** открытые PR, по которым есть дело: свои сначала, затем по номеру; PR читаются по одному */
export async function actionableRows(provider: ForgeProvider): Promise<ListRow[]> {
  const rows: ListRow[] = []
  for (const pull of await provider.listPulls('open')) {
    const data = await loadPr(provider, pull.number, pull)
    const scenario = scenarioOf(data)
    if (ACTIONABLE.includes(scenario)) rows.push({ number: pull.number, title: pull.title, author: pull.author, isOwn: same(pull.author, data.me), scenario })
  }
  return rows.sort((a, b) => Number(b.isOwn) - Number(a.isOwn) || a.number - b.number)
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `node --test mod/status.test.ts 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `pass 14`, `fail 0`.

---

### Task 3a.2: `mod/git.ts` — база перепроверки; `withTimeout` для HTTP

**Files:**
- Create: `mod/git.ts`
- Create: `mod/testing/repo.ts` (помощник временных репозиториев для тестов; не `*.test.ts`, чтобы импорт не дублировал тесты)
- Test: `mod/git.test.ts`
- Modify: `mod/forge/index.ts` (добавить `withTimeout`)
- Test: `mod/forge/index.test.ts` (добавить тест)

**Interfaces:**
- Produces:
  - `type Run = (argv: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>` — форма `$.process.run`.
  - `FULL_NOTE` (текст 2.2), `recheckBase(run: Run, input: { lastCommit: string; head: string; baseRef: string }): Promise<{ base: string; mode: 'delta' | 'full'; note?: string }>`
  - `withTimeout(http: Http, sleep: (ms: number) => Promise<void>, ms: number): Http`

- [ ] **Step 1: Тесты**

`mod/testing/repo.ts` (помощник, его импортируют тесты 3a–3c):

```ts
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Run } from '../git.ts'

/** временный git-репозиторий на ветке main: run для кода мода, git для подготовки, commit — записать один файл и закоммитить
 * только его (git add -A подобрал бы worktree ревью внутри дерева как встроенный репозиторий) */
export function repo(): { dir: string; run: Run; git: (...args: string[]) => string; commit: (file: string, text: string, message: string) => string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rk-git-')))
  const run: Run = async (argv, init) => {
    const result = spawnSync(argv[0], argv.slice(1), { cwd: init?.cwd ?? dir, env: { ...process.env, ...init?.env }, input: init?.stdin, encoding: 'utf8' })
    return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
  }
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  const commit = (file: string, text: string, message: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
    git('add', '--', file)
    git('commit', '-qm', message)
    return git('rev-parse', 'HEAD')
  }
  return { dir, run, git, commit }
}
```

`mod/git.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recheckBase } from './git.ts'
import { repo } from './testing/repo.ts'

test('recheckBase: моё ревью в истории — дельта от него', async () => {
  const r = repo()
  r.commit('a.txt', '1', 'base')
  const reviewed = r.commit('a.txt', '2', 'pr 1')
  const head = r.commit('a.txt', '3', 'pr 2')
  assert.deepEqual(await recheckBase(r.run, { lastCommit: reviewed, head, baseRef: 'main' }), { base: reviewed, mode: 'delta' })
})

test('recheckBase: история переписана — всё от merge-base с origin/<base>', async () => {
  const r = repo()
  const base = r.commit('a.txt', '1', 'base')
  r.git('update-ref', 'refs/remotes/origin/main', base)
  r.git('switch', '-qc', 'pr')
  const reviewed = r.commit('a.txt', '2', 'pr old')
  r.git('reset', '-q', '--hard', base)
  const head = r.commit('a.txt', '9', 'pr rewritten')
  const result = await recheckBase(r.run, { lastCommit: reviewed, head, baseRef: 'main' })
  assert.equal(result.base, base)
  assert.equal(result.mode, 'full')
  assert.match(result.note ?? '', /после rebase/)
})

test('recheckBase: базовой ветки нет — запасной origin/main; нет и его — ошибка', async () => {
  const r = repo()
  const base = r.commit('a.txt', '1', 'base')
  const head = r.commit('a.txt', '2', 'pr')
  await assert.rejects(recheckBase(r.run, { lastCommit: 'deadbeef', head, baseRef: 'gone' }), /не найдена база перепроверки/)
  r.git('update-ref', 'refs/remotes/origin/main', base)
  assert.equal((await recheckBase(r.run, { lastCommit: 'deadbeef', head, baseRef: 'gone' })).base, base)
})
```

В `mod/forge/index.test.ts` добавить:

```ts
import { withTimeout } from './index.ts'

test('withTimeout: нет ответа за отведённое время — ошибка', async () => {
  const never = () => new Promise<never>(() => {})
  const http = withTimeout(never, async () => {}, 30_000)
  await assert.rejects(http('https://x'), /нет ответа за 30 с/)
})

test('withTimeout: ответ успел — отдаётся как есть', async () => {
  const response = { status: 200, ok: true, headers: {}, text: 'ok' }
  const http = withTimeout(async () => response, () => new Promise<void>(() => {}), 30_000)
  assert.equal(await http('https://x'), response)
})
```

(импорт `withTimeout` дописать в существующую строку `import { createProvider, selectProvider } from './index.ts'`.)

- [ ] **Step 2: Запустить — падает**

Run: `node --test mod/git.test.ts mod/forge/index.test.ts 2>&1 | grep -E "Cannot find|withTimeout|^ℹ (pass|fail)" | head -5`
Expected: `Cannot find module '.../mod/git.ts'` и падение тестов `withTimeout`.

- [ ] **Step 3: Создать `mod/git.ts`**

```ts
/** примечание к перепроверке, когда моего ревью нет в истории PR */
export const FULL_NOTE = 'после rebase/force-push моего ревью нет в истории — проверено всё от базы PR'

/** запуск команды без shell — форма $.process.run */
export type Run = (argv: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/** база перепроверки: дельта от моего ревью или всё от merge-base, если история переписана */
export async function recheckBase(run: Run, { lastCommit, head, baseRef }: { lastCommit: string; head: string; baseRef: string }): Promise<{ base: string; mode: 'delta' | 'full'; note?: string }> {
  if ((await run(['git', 'merge-base', '--is-ancestor', lastCommit, head])).exitCode === 0) return { base: lastCommit, mode: 'delta' }
  const primary = await run(['git', 'merge-base', `origin/${baseRef}`, head])
  const merge = primary.exitCode === 0 ? primary : await run(['git', 'merge-base', 'origin/main', head])
  if (merge.exitCode !== 0) throw new Error(`не найдена база перепроверки: нет ни origin/${baseRef}, ни origin/main`)
  return { base: merge.stdout.trim(), mode: 'full', note: FULL_NOTE }
}
```

В `mod/forge/index.ts` добавить:

```ts
/** HTTP с ограничением времени: $.http.fetch своего таймаута не имеет */
export function withTimeout(http: Http, sleep: (ms: number) => Promise<void>, ms: number): Http {
  return (url, init) => Promise.race([http(url, init), sleep(ms).then((): never => { throw new Error(`нет ответа за ${ms / 1000} с`) })])
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `node --test mod/git.test.ts mod/forge/index.test.ts 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `pass 17` (3 + 14), `fail 0`.

---

### Task 3a.3: Паритет с Python перед удалением

**Files:**
- Create (scratchpad, не в репозиторий): `$S/parity-3a.mjs`

- [ ] **Step 1: Скрипт сравнения**

Скрипт прогоняет одни и те же «сырые» ответы Forgejo через Python (`pr_context.scenario`, `intake.intake`, `recheck_prep.prior_comments`) и через TS (адаптер на фейковом HTTP → `status.ts`) и печатает расхождения.

```js
// parity-3a.mjs — сравнение pr_context/intake/recheck_prep (2.2) и status.ts (3.0) на одних входах
import { spawnSync } from 'node:child_process'
import { forgejo } from '/home/prian/projects/review-kit/mod/forge/forgejo.ts'
import { intakeItems, loadPr, priorComments, scenarioOf } from '/home/prian/projects/review-kit/mod/status.ts'

const API = 'https://h/api/v1/repos/o/r'
const user = login => ({ login })
const pr = (author, sha = 'h2', state = 'open') => ({ number: 1, title: 't', user: user(author), head: { ref: 'f', sha }, base: { ref: 'main' }, state, merged: false, html_url: 'u' })
const rv = (id, author, state, commit, at, body = '') => ({ id, user: user(author), state, body, commit_id: commit, submitted_at: at, dismissed: false })
const cm = (id, rid, author, body, at, resolver = null) => ({ id, user: user(author), body, created_at: at, path: 'a.ts', position: 3, commit_id: 'h1', pull_request_review_id: rid, resolver })
const gc = (id, author, body, at) => ({ id, user: user(author), body, created_at: at })
const CASES = {
  'свой, тред carol': [pr('alice'), [rv(1, 'carol', 'COMMENT', 'h1', '2026-10-01T10:00:00Z')], [cm(10, 1, 'carol', 'x', '2026-10-01T10:00:00Z')], []],
  'свой, ответил я': [pr('alice'), [rv(1, 'carol', 'COMMENT', 'h1', '2026-10-01T10:00:00Z')], [cm(10, 1, 'carol', 'x', '2026-10-01T10:00:00Z'), cm(11, 1, 'alice', 'ok', '2026-10-01T11:00:00Z')], []],
  'свой, общий после меня': [pr('alice'), [], [], [gc(20, 'alice', 'a', '2026-10-01T10:00:00Z'), gc(21, 'dave', 'b', '2026-10-01T11:00:00Z')]],
  'свой, ревью с текстом': [pr('alice'), [rv(2, 'carol', 'REQUEST_CHANGES', 'h2', '2026-10-01T12:00:00Z', 'fix')], [], []],
  'чужой, без ревью': [pr('bob'), [], [], []],
  'чужой, новые коммиты': [pr('bob'), [rv(3, 'alice', 'REQUEST_CHANGES', 'h1', '2026-10-01T10:00:00Z', 'итог')], [cm(30, 3, 'alice', 'тут', '2026-10-01T10:00:00Z')], []],
  'чужой, автор ответил': [pr('bob'), [rv(3, 'alice', 'REQUEST_CHANGES', 'h2', '2026-10-01T10:00:00Z')], [cm(30, 3, 'alice', 'тут', '2026-10-01T10:00:00Z'), cm(31, 3, 'bob', 'ок', '2026-10-01T11:00:00Z')], []],
  'чужой, ждём': [pr('bob'), [rv(3, 'alice', 'COMMENT', 'h2', '2026-10-01T10:00:00Z')], [cm(30, 3, 'alice', 'тут', '2026-10-01T10:00:00Z')], []],
  'закрыт': [pr('bob', 'h2', 'closed'), [], [], []],
  'свой, ответ с маркером': [pr('alice'), [rv(1, 'carol', 'COMMENT', 'h1', '2026-10-01T10:00:00Z')], [cm(10, 1, 'carol', 'x', '2026-10-01T10:00:00Z'), cm(11, 1, 'kitbot', 'Сделано <!-- review-kit -->', '2026-10-01T11:00:00Z')], []],
}
const PY = `
import json, sys
sys.path.insert(0, '/home/prian/projects/review-kit/tools')
from pr_context import scenario
from intake import intake
from recheck_prep import prior_comments
pr, reviews, comments, issues = json.load(sys.stdin)
mine = [r for r in reviews if r['user']['login'] == 'alice' and r['state'] != 'PENDING']
prior = [p['id'] for p in prior_comments(reviews, comments, 'alice')[1]] if mine else None
print(json.dumps({'scenario': scenario(pr, reviews, comments, issues, 'alice'), 'intake': [i['id'] for i in intake(pr, reviews, comments, issues, 'alice')['items']], 'prior': prior}))
`
const ok = text => ({ status: 200, ok: true, headers: {}, text })
for (const [name, [rawPr, reviews, comments, issues]] of Object.entries(CASES)) {
  const routes = {
    [`${API}/pulls/1`]: rawPr, ['https://h/api/v1/user']: { login: 'alice' },
    [`${API}/pulls/1/reviews?page=1&limit=50`]: reviews, [`${API}/pulls/1/reviews?page=2&limit=50`]: [],
    [`${API}/issues/1/comments?page=1&limit=50`]: issues, [`${API}/issues/1/comments?page=2&limit=50`]: [],
    ...Object.fromEntries(reviews.map(r => [`${API}/pulls/1/reviews/${r.id}/comments`, comments.filter(c => c.pull_request_review_id === r.id)])),
  }
  const http = async url => (url in routes ? ok(JSON.stringify(routes[url])) : Promise.reject(new Error(`нет ${url}`)))
  const data = await loadPr(forgejo.create({ repo: { host: 'h', owner: 'o', repo: 'r' }, token: 't', http, sleep: async () => {} }), 1)
  const prior = priorComments(data)
  const ts = { scenario: scenarioOf(data), intake: intakeItems(data).map(i => i.id), prior: prior ? prior.prior.map(p => p.id) : null }
  const py = JSON.parse(spawnSync('python3', ['-c', PY], { input: JSON.stringify([rawPr, reviews, comments, issues]), encoding: 'utf8' }).stdout)
  const same = JSON.stringify(ts) === JSON.stringify(py)
  console.log(`${same ? 'ok  ' : 'DIFF'} ${name}${same ? '' : `\n  ts ${JSON.stringify(ts)}\n  py ${JSON.stringify(py)}`}`)
}
```

- [ ] **Step 2: Запустить**

Run: `node $S/parity-3a.mjs 2>&1 | grep -v ExperimentalWarning`
Expected: `ok` во всех строках, кроме, возможно, «свой, ответ с маркером»: Python `pr_context` маркер не учитывает и даст `feedback`, TS — `none-own` (решение «Отклонения от спеки»). Любое другое `DIFF` — найти причину в `status.ts` (не в Python) и исправить до Task 3a.4.

---

### Task 3a.4: Подключить `forge/` и `status.ts` к `register.ts`; удалить три скрипта

**Files:**
- Modify: `mod/register.ts`
- Modify: `skills/pr-recheck-run/SKILL.md` (шаг 1)
- Delete: `tools/pr_context.py`, `tools/intake.py`, `tools/recheck_prep.py`

**Interfaces:**
- Consumes: `selectProvider`, `createProvider`, `withTimeout`, `ADAPTERS`, `ExplicitConfig` (`forge/index.ts`); всё из `status.ts`; `recheckBase` (`git.ts`).
- Produces (внутри `register.ts`, для 3b–3c): `forge($): Promise<ForgeProvider>`, `type Loaded = { context: PrContext; data: PrData }`, `prContext($, pr): Promise<Loaded>`, `SETTINGS.options`.

- [ ] **Step 1: Импорты и константы**

В начало `mod/register.ts` после импорта `gate.ts` добавить:

```ts
import { ADAPTERS, createProvider, selectProvider, withTimeout, type ExplicitConfig } from './forge/index.ts'
import type { ForgeProvider } from './forge/types.ts'
import { actionableRows, contextOf, intakeItems, loadPr, priorComments, scenarioOf, type ListRow, type PrContext, type PrData } from './status.ts'
import { recheckBase } from './git.ts'
```

Константу `LIST_TIMEOUT_MS` удалить (список больше не идёт через `runTool`). Добавить:

```ts
// …существующие константы…
/** ограничение одного HTTP-запроса к хостингу */
const HTTP_TIMEOUT_MS = 30_000
/** явная настройка проекта для нестандартного remote */
const CONFIG_PATH = '.claude/review-kit.local.json'
/** значения userConfig, которые движок передаёт в register */
const SETTINGS: { options: Record<string, unknown> } = { options: {} }
```

Удалить локальные `interface PrContext` и `interface ListRow` (теперь из `status.ts`).

- [ ] **Step 2: Провайдер и контекст PR**

Добавить перед `resumeRun`:

```ts
/** PR и его данные: контекст для прогона и сырьё для intake/recheck */
type Loaded = { context: PrContext; data: PrData }

/** явная настройка из .claude/review-kit.local.json; нет файла — undefined */
async function explicitConfig($: EngineInterface): Promise<ExplicitConfig | undefined> {
  const text = await $.fs.read(`${await projectRoot($)}/${CONFIG_PATH}`).then(String, () => '')
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    const field = (key: string) => (typeof value[key] === 'string' ? value[key] as string : undefined)
    return { provider: field('provider'), host: field('host'), owner: field('owner'), repo: field('repo') }
  } catch {
    throw new Error(`${CONFIG_PATH}: не JSON`)
  }
}

/** провайдер хостинга для репозитория origin: явная настройка → галочки → remote; токен из окружения */
async function forge($: EngineInterface): Promise<ForgeProvider> {
  const remote = await $.process.run(['git', 'remote', 'get-url', 'origin'])
  const names = ADAPTERS.flatMap(adapter => adapter.tokenEnv)
  const values = new Map(await Promise.all(names.map(async name => [name, await $.env.get(name)] as const)))
  const selection = selectProvider({
    options: SETTINGS.options, config: await explicitConfig($), remoteUrl: remote.exitCode === 0 ? remote.stdout.trim() : '',
    env: name => values.get(name),
  })
  if ('error' in selection) throw new Error(selection.error)
  const sleep = (ms: number) => $.clock.sleep(ms)
  return createProvider(selection, withTimeout((url, init) => $.http.fetch(url, init), sleep, HTTP_TIMEOUT_MS), sleep)
}
```

Заменить функцию `prContext`:

```ts
// загружает PR и вычисляет сценарий
async function prContext($: EngineInterface, pr: number): Promise<Loaded> {
  const data = await loadPr(await forge($), pr)
  return { context: contextOf(data, scenarioOf(data)), data }
}
```

В `resumeRun` строку `const fresh = JSON.parse(await runTool($, ['python3', `${$.plugin.root}/tools/pr_context.py`, String(pr)])) as PrContext` заменить на `const fresh = (await prContext($, pr)).context`.

- [ ] **Step 3: Маршрутизация и старт прогона на `Loaded`**

В `routePr` строку списка заменить:

```ts
    const rows: ListRow[] = await actionableRows(await forge($))
```

и конец функции:

```ts
  const loaded = await prContext($, pr)
  const { context } = loaded
  if (context.scenario === 'review') return startReview($, pr, { loaded, handoff })
  if (context.scenario === 'feedback') return startFix($, pr, { loaded, handoff, scenario: 'feedback' })
  if (context.scenario === 'recheck') return startReview($, pr, { loaded, handoff, scenario: 'recheck' })
  return context.scenario === 'closed' ? closedText(context) : SCENARIO_TEXT[context.scenario]
```

`startReview`, `startFix`, `startRun` — параметр `context: PrContext` заменить на `loaded: Loaded`, первой строкой тела каждой — `const { context } = loaded`; в `startReview`/`startFix` передавать дальше `{ loaded, handoff, scenario }`. В `startRun` строку с `intake.py` заменить на запись файлов прогона:

```ts
  if (scenario === 'feedback' || scenario === 'fix') {
    await $.fs.write(`${dir}/intake.json`, JSON.stringify({ head: context.headSha, items: intakeItems(loaded.data) }, null, 2))
  }
  if (scenario === 'recheck') {
    const prior = priorComments(loaded.data)
    if (!prior) throw new Error(`моего ревью в PR ${pr} нет — перепроверять нечего; дерево на коммите PR${stash ? `, ваши изменения в stash «${stash}» — вернуть: /pr cleanup` : ''}`)
    const base = await recheckBase(argv => $.process.run(argv), { lastCommit: prior.review.commitSha, head: switched.head, baseRef: context.baseRef })
    await $.fs.write(`${dir}/recheck.json`, JSON.stringify({ ...base, reviewId: prior.review.id, prior: prior.prior }, null, 2))
  }
```

(ошибка здесь — после переключения дерева, как и прежние ошибки `switch-pr`: прогон не открыт, текст ошибки говорит, где дерево.)

Три обработчика команд (`pr-${scenario}`, `pr-recheck`, `pr-review`): `{ context: await prContext($, pr), handoff: 'submit', … }` → `{ loaded: await prContext($, pr), handoff: 'submit', … }`.

Сигнатура регистрации: `export const register: Register = on => {` → `export const register: Register = (on, options) => {` и первой строкой тела `SETTINGS.options = { ...options }`.

- [ ] **Step 4: Скилл перепроверки**

В `skills/pr-recheck-run/SKILL.md` шаг 1 заменить на:

```markdown
1. Read `.review-kit/run/<N>/recheck.json` (the mod wrote it when it opened the run): `base`, `mode` (`delta` — since my
   last review; `full` — history was rewritten, with `note`), `prior` (my earlier comments).
```

- [ ] **Step 4a: Модель тредов на живом сервере (с пользователем, до удаления Python)**

В PR на тестовом Forgejo, где автор ответил на мой комментарий кнопкой «Ответить»:
`curl -s -H "Authorization: token $FORGEJO_TOKEN" https://<host>/api/v1/repos/<o>/<r>/pulls/<N>/reviews/<id моего ревью>/comments`
содержит и его ответ (тот же `pull_request_review_id`). Если ответ оказался в отдельном ревью — стоп: адаптер этапа 2
должен склеивать треды по `path` + `position` + исходному комментарию; после этой правки перегнать паритет 3a.3 и только
потом удалять скрипты.

- [ ] **Step 5: Удалить скрипты и проверить**

```bash
rm tools/pr_context.py tools/intake.py tools/recheck_prep.py
```

Run: `grep -rn "pr_context\|intake.py\|recheck_prep" mod skills tools; TMPDIR=$S node $S/tscheck.mjs mod/register.ts mod/status.ts mod/git.ts mod/forge/index.ts 2>&1 | grep -v ExperimentalWarning; node --test 'mod/**/*.test.ts' 2>&1 | grep -E "^ℹ (pass|fail)"; for m in $(ls tools/*.py 2>/dev/null | xargs -rn1 basename | sed 's/\.py$//'); do python3 -c "import sys; sys.path.insert(0, 'tools'); import $m" || echo "IMPORT-FAIL $m"; done; echo imports-checked`
Проверка импорта безопасна: у всех Python-скриптов 2.2 код за `if __name__ == '__main__':` (проверено), импорт не
разбирает `argv` и не ходит в сеть.

Expected: grep пуст; `ok` ×4; `pass 58`, `fail 0` (39 этапа 2 + 14 `status` + 3 `git` + 2 `withTimeout`); нет строк `IMPORT-FAIL` — каждый оставшийся Python-модуль импортируется (`py_compile` сломанный импорт не поймал бы).

- [ ] **Step 6: Живая проверка (с пользователем)**

`claude --plugin-dir /home/prian/projects/review-kit` в тестовом репозитории на Forgejo с `FORGEJO_TOKEN` в окружении:
`/pr` — список PR со сценариями; `/pr-recheck <N>` — `recheck.json` в `.review-kit/run/<N>/`; модель тредов подтверждена в Step 4a; без токена — строка «Нет токена Forgejo/Gitea: задайте переменную FORGEJO_TOKEN или GITEA_TOKEN…». Публикация на этом подэтапе ещё идёт через `forgejo.py` и его файл токена.

**Стоп 3a: ждём «дальше» пользователя.**

---

# Подэтап 3b: вход агентам и сбор их ответов

Уходят `funnel_prep.py`, `funnel_finish.py`, `triage_prep.py`, `triage_finish.py`, `review_lite_input.py`,
`review_lite_check.py`, `snapshot`, `stack` в конфиге и `config/settings.example.json`. Появляются инструменты
`review_prepare(pr, kind, paths?)` и `review_collect(pr, id, outputFile)`; скиллы зовут их вместо скриптов.

Контракт инструментов:

- `review_prepare` → JSON `{ workflows: [{ id, scriptPath, args }], notes: string[] }`. `kind`:
  - `review` — одна воронка `funnel` по `context.base..context.head`, правила с `context.base`;
  - `recheck` — две: `statuses` (агент D по `recheck.json.prior`) и `delta` (воронка по `recheck.base..head`), правила с `context.base`;
  - `feedback` — `triage` (агент D по `intake.json.items`), правила с `HEAD`;
  - `fix-check` — `fix-check` (воронка по `HEAD..<snapshot путей раунда>`), правила с `HEAD`; `paths` — пути раунда.
- `review_collect(pr, id, outputFile)` читает вывод `Workflow` и пишет итог: `funnel`/`delta` → `findings.json`
  (`delta` оставляет только critical и important), `fix-check` → `fix-check/findings.json`, `triage` → `triage.json`,
  `statuses` → `statuses.json`; отвечает тем же JSON. Ошибка (воркфлоу без результата, ни один искатель не ответил) —
  текст `review-kit: …`.
- Файлы воронки `<id>/`: `input.md`, `manifest-<роль>.txt` (абсолютные пути копий правил + строки `# заметка`),
  `rules/<путь>` (копии правил), `rules.json` (путь → текст), `range.json` (`{ base, head }`), `raw.json`, `gate-*.jsonl`.

### Task 3b.1: git-помощники входа и снимок раунда

**Files:**
- Modify: `mod/git.ts`
- Test: `mod/git.test.ts`

**Interfaces:**
- Produces: `gitText(run: Run, args: string[]): Promise<string>`; `changedFiles(run, base, head): Promise<string[]>`; `treeEntries(run, rev): Promise<Map<string, string>>` (путь → тип `blob`/`commit`); `binaryFiles(run, base, head): Promise<Set<string>>`; `showFile(run, rev, path): Promise<string>`; `fileDiff(run, base, head, path): Promise<string>`; `snapshot(run, { paths, indexFile }): Promise<string>`.

- [ ] **Step 1: Тесты** (дописать в `mod/git.test.ts`, импорт расширить)

```ts
import { binaryFiles, changedFiles, fileDiff, showFile, snapshot, treeEntries } from './git.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

test('changedFiles/treeEntries/showFile/fileDiff: пути с пробелами и кириллицей без кавычек', async () => {
  const r = repo()
  const base = r.commit('a.txt', '1\n', 'base')
  r.commit('папка/b c.txt', 'x\n', 'add')
  const head = r.commit('a.txt', '2\n', 'edit')
  assert.deepEqual(await changedFiles(r.run, base, head), ['a.txt', 'папка/b c.txt'])
  assert.equal((await treeEntries(r.run, head)).get('папка/b c.txt'), 'blob')
  assert.equal(await showFile(r.run, head, 'папка/b c.txt'), 'x\n')
  assert.match(await fileDiff(r.run, base, head, 'a.txt'), /^-1$\n^\+2$/m)
})

test('binaryFiles: бинарный файл узнаётся по numstat', async () => {
  const r = repo()
  const base = r.commit('a.txt', '1', 'base')
  writeFileSync(join(r.dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]))
  r.git('add', '-A'); r.git('commit', '-qm', 'bin')
  assert.deepEqual([...await binaryFiles(r.run, base, 'HEAD')], ['bin.dat'])
})

test('snapshot: коммит поверх HEAD с путями раунда, рабочий индекс не тронут', async () => {
  const r = repo()
  const head = r.commit('a.txt', '1', 'base')
  writeFileSync(join(r.dir, 'a.txt'), '2')
  writeFileSync(join(r.dir, 'other.txt'), 'не в раунде')
  const snap = await snapshot(r.run, { paths: ['a.txt'], indexFile: join(r.dir, '.git', 'rk-snapshot.index') })
  assert.equal(r.git('rev-parse', `${snap}^`), head)
  assert.equal(r.git('show', `${snap}:a.txt`), '2')
  assert.throws(() => r.git('show', `${snap}:other.txt`))
  assert.equal(r.git('diff', '--cached', '--name-only'), '')
})
```

- [ ] **Step 2: Запустить — падает** (`node --test mod/git.test.ts`) — `does not provide an export named 'binaryFiles'`.

- [ ] **Step 3: Реализация** (дописать в `mod/git.ts`)

```ts
/** git с неэкранированными путями; ненулевой выход — ошибка с stderr */
export async function gitText(run: Run, args: string[], init?: { env?: Record<string, string> }): Promise<string> {
  const result = await run(['git', '-c', 'core.quotePath=false', ...args], init)
  if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr.trim() || `код ${result.exitCode}`}`)
  return result.stdout
}

/** вывод -z git → список строк */
function splitZ(text: string): string[] {
  return text.split('\0').filter(Boolean)
}

/** пути, изменённые между ревизиями, по алфавиту */
export async function changedFiles(run: Run, base: string, head: string): Promise<string[]> {
  return splitZ(await gitText(run, ['diff', '--name-only', '-z', '--no-renames', base, head])).sort()
}

/** файлы ревизии: путь → тип записи дерева (blob, commit для сабмодуля) */
export async function treeEntries(run: Run, rev: string): Promise<Map<string, string>> {
  return new Map(splitZ(await gitText(run, ['ls-tree', '-r', '-z', rev])).map(entry => {
    const [meta, path] = entry.split('\t')
    return [path, meta.split(' ')[1]] as const
  }))
}

/** бинарные изменённые файлы (numstat «-») */
export async function binaryFiles(run: Run, base: string, head: string): Promise<Set<string>> {
  const rows = splitZ(await gitText(run, ['diff', '--numstat', '-z', '--no-renames', base, head])).map(record => record.split('\t'))
  return new Set(rows.filter(row => row.length === 3 && row[0] === '-').map(row => row[2]))
}

/** текст файла на ревизии */
export async function showFile(run: Run, rev: string, path: string): Promise<string> {
  return gitText(run, ['show', `${rev}:${path}`])
}

/** diff одного файла */
export async function fileDiff(run: Run, base: string, head: string, path: string): Promise<string> {
  return gitText(run, ['diff', '--no-color', '--no-renames', base, head, '--', path])
}

/** коммит-снимок HEAD + текущих путей раунда во временном индексе; рабочий индекс и дерево не трогаются */
export async function snapshot(run: Run, { paths, indexFile }: { paths: string[]; indexFile: string }): Promise<string> {
  if (paths.length === 0) throw new Error('snapshot: нет путей раунда')
  const env = { GIT_INDEX_FILE: indexFile }
  await gitText(run, ['read-tree', 'HEAD'], { env })
  await gitText(run, ['add', '-A', '--', ...paths], { env })
  const tree = (await gitText(run, ['write-tree'], { env })).trim()
  return (await gitText(run, ['commit-tree', tree, '-p', 'HEAD', '-m', 'review-kit snapshot'])).trim()
}
```

Решение: снимок строится от `HEAD` (`read-tree HEAD`), а не от копии текущего индекса, как в bash 2.2 — раунд
не трогает индекс, результат тот же, а копировать файл индекса мод не умеет без `cp`.

- [ ] **Step 4: Запустить — проходит**: `node --test mod/git.test.ts` → `pass 6`, `fail 0`.

---

### Task 3b.2: `mod/run/input.ts` — правила, состояния файлов, вход агентам

**Files:**
- Create: `mod/run/input.ts`
- Test: `mod/run/input.test.ts`

**Interfaces:**
- Consumes: `Run`, `changedFiles`, `treeEntries`, `binaryFiles`, `showFile`, `fileDiff` (3b.1).
- Produces:
  - `MAX_FILE_CHARS = 60_000`, `MAX_INPUT_CHARS = 250_000`, `B_SKIPPED` (текст заметки)
  - `isRulePath(path: string): boolean`, `rulePaths(tree: readonly string[], changed: readonly string[]): string[]`
  - `interface FileState { text: string | null; reason: string | null }`, `fileStates(run, base, head): Promise<Map<string, FileState>>`
  - `lineCount(text: string): number`, `notAttached(states, max?): Map<string, string>`, `fenced(text, lang?): string`
  - `interface TriageItem { id: string; path?: string | null; position?: number | null; line?: number | null; author?: string; quote?: string; body?: string; stale?: boolean; disagree?: boolean }`, `itemsSection(items: TriageItem[]): string`
  - `readRules(run, { rev, base, head }): Promise<{ rules: Map<string, string>; changedRules: string[] }>`
  - `buildInput(run, { base, head, rules, items? }): Promise<string>`
  - `manifestText(paths: string[], notes: string[]): string`

- [ ] **Step 1: Тесты**

`mod/run/input.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildInput, fenced, fileStates, itemsSection, lineCount, manifestText, MAX_INPUT_CHARS, notAttached, readRules, rulePaths } from './input.ts'
import { repo } from '../testing/repo.ts'

test('rulePaths: CLAUDE.md/AGENTS.md вверх от изменённых файлов, папки правил, copilot', () => {
  const tree = ['CLAUDE.md', 'src/AGENTS.md', 'src/x/a.ts', 'lib/CLAUDE.md', '.claude/rules/ts.md', '.cursor/rules/a.mdc', '.github/copilot-instructions.md', 'docs/CLAUDE.md.bak']
  assert.deepEqual(rulePaths(tree, ['src/x/a.ts', 'new/dir/f.ts']), ['.claude/rules/ts.md', '.cursor/rules/a.mdc', '.github/copilot-instructions.md', 'CLAUDE.md', 'src/AGENTS.md'])
})

test('fileStates: удалён, бинарный, большой файл не приложен', async () => {
  const r = repo()
  r.commit('gone.txt', 'x', 'base0')
  const base = r.commit('keep.txt', 'k', 'base')
  r.git('rm', '-q', 'gone.txt')
  writeFileSync(join(r.dir, 'bin.dat'), Buffer.from([0, 0, 1]))
  writeFileSync(join(r.dir, 'big.txt'), 'a'.repeat(61_000))
  writeFileSync(join(r.dir, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  r.git('add', '-A'); r.git('commit', '-qm', 'head')
  const states = await fileStates(r.run, base, 'HEAD')
  assert.deepEqual(states.get('gone.txt'), { text: null, reason: 'удалён' })
  assert.deepEqual(states.get('bin.dat'), { text: null, reason: 'бинарный' })
  assert.deepEqual(states.get('latin1.txt'), { text: null, reason: 'не UTF-8' })
  assert.deepEqual([...notAttached(states)], [['big.txt', 'больше 60000 символов'], ['bin.dat', 'бинарный'], ['gone.txt', 'удалён'], ['latin1.txt', 'не UTF-8']])
})

test('lineCount как splitlines, fenced длиннее бэктиков внутри', () => {
  assert.equal(lineCount('a\nb\n'), 2)
  assert.equal(lineCount(''), 0)
  assert.equal(fenced('x ```` y'), '`````\nx ```` y\n`````')
})

test('readRules: правила берутся с базы, изменённые PR правила — в changedRules', async () => {
  const r = repo()
  const base = r.commit('CLAUDE.md', 'Все функции с комментарием над ними обязательно всегда.\n', 'base')
  r.commit('CLAUDE.md', 'Можно всё.\n', 'pr ослабил правила')
  const head = r.commit('src/a.ts', 'x\n', 'pr code')
  const { rules, changedRules } = await readRules(r.run, { rev: base, base, head })
  assert.deepEqual([...rules], [['CLAUDE.md', 'Все функции с комментарием над ними обязательно всегда.\n']])
  assert.deepEqual(changedRules, ['CLAUDE.md'])
})

test('buildInput: разделы RULES/DIFF/FILES и ITEMS; лимит входа', async () => {
  const r = repo()
  const base = r.commit('a.ts', '1\n', 'base')
  const head = r.commit('a.ts', '2\n', 'head')
  const text = await buildInput(r.run, { base, head, rules: new Map([['CLAUDE.md', 'правило']]), items: [{ id: 'i1', path: 'a.ts', position: 1, author: 'carol', quote: 'почему 2?', stale: true }] })
  assert.match(text, /^## RULES\n=== RULE FILE: CLAUDE.md ===\n```\nправило\n```/)
  assert.match(text, /## DIFF\n```diff\n[\s\S]*\+2/)
  assert.match(text, /## FILES\n=== FILE: a.ts ===\n```\n2\n\n```/)
  assert.match(text, /## ITEMS\n### i1 — a.ts:1 — carol \(stale\)\nпочему 2\?/)
  const huge = new Map([['CLAUDE.md', 'x'.repeat(MAX_INPUT_CHARS)]])
  await assert.rejects(buildInput(r.run, { base, head, rules: huge }), /вход .* больше лимита/)
})

test('itemsSection: общий пункт и disagree', () => {
  assert.equal(itemsSection([{ id: 'issue/1', author: 'dave', quote: 'когда?', disagree: true }]), '## ITEMS\n### issue/1 — общий — dave (disagree)\nкогда?')
})

test('manifestText: пути и заметки', () => {
  assert.equal(manifestText(['/r/CLAUDE.md'], ['нет правил']), '/r/CLAUDE.md\n# нет правил\n')
})
```

- [ ] **Step 2: Запустить — падает** (`Cannot find module '.../mod/run/input.ts'`).

- [ ] **Step 3: Создать `mod/run/input.ts`**

```ts
import { binaryFiles, changedFiles, fileDiff, showFile, treeEntries, type Run } from '../git.ts'

/** больше — файл и его diff не прикладываются */
export const MAX_FILE_CHARS = 60_000
/** больше — вход одним запросом не делается */
export const MAX_INPUT_CHARS = 250_000
/** заметка, когда правил нет и агент B не запускается */
export const B_SKIPPED = 'агент B не запускался: для его работы нужны правила и соглашения проекта (CLAUDE.md, AGENTS.md, .claude/rules, .cursor/rules, .github/copilot-instructions.md)'
/** файлы-инструкции агентам на любом уровне каталогов */
const RULE_NAMES = ['CLAUDE.md', 'AGENTS.md']
/** папки правил целиком */
const RULE_DIRS = ['.claude/rules/', '.cursor/rules/']
/** отдельные файлы правил */
const RULE_FILES = ['.github/copilot-instructions.md']

/** текст файла на голове или причина, по которой он не приложен */
export interface FileState {
  /** текст или null */
  text: string | null
  /** причина отсутствия текста или null */
  reason: string | null
}

/** пункт для агента D: замечание к своему PR или моё прошлое замечание */
export interface TriageItem {
  /** id пункта */
  id: string
  /** файл */
  path?: string | null
  /** строка (intake) */
  position?: number | null
  /** строка (recheck) */
  line?: number | null
  /** автор */
  author?: string
  /** текст (intake) */
  quote?: string
  /** текст (recheck) */
  body?: string
  /** тред к старому коммиту */
  stale?: boolean
  /** ревьюер возразил на наш ответ */
  disagree?: boolean
}

/** путь — файл правил по списку спеки */
export function isRulePath(path: string): boolean {
  const name = path.split('/').pop() ?? ''
  return RULE_NAMES.includes(name) || RULE_DIRS.some(dir => path.startsWith(dir)) || RULE_FILES.includes(path)
}

/** правила дерева, относящиеся к изменённым файлам: инструкции в их папках и выше + папки правил */
export function rulePaths(tree: readonly string[], changed: readonly string[]): string[] {
  const dirs = new Set([''])
  for (const file of changed) {
    const parts = file.split('/')
    for (let depth = 1; depth < parts.length; depth++) dirs.add(parts.slice(0, depth).join('/'))
  }
  const present = new Set(tree)
  const named = [...dirs].flatMap(dir => RULE_NAMES.map(name => (dir ? `${dir}/${name}` : name))).filter(path => present.has(path))
  const shared = tree.filter(path => RULE_DIRS.some(dir => path.startsWith(dir)) || RULE_FILES.includes(path))
  return [...new Set([...named, ...shared])].sort()
}

/** число строк как у Python splitlines */
export function lineCount(text: string): number {
  if (text === '') return 0
  const lines = text.split(/\r\n|\r|\n/)
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

/** состояние каждого изменённого файла на голове */
export async function fileStates(run: Run, base: string, head: string): Promise<Map<string, FileState>> {
  const [changed, types, binary] = await Promise.all([changedFiles(run, base, head), treeEntries(run, head), binaryFiles(run, base, head)])
  const states = new Map<string, FileState>()
  for (const path of changed) {
    const type = types.get(path)
    if (type === undefined) states.set(path, { text: null, reason: 'удалён' })
    else if (type === 'commit') states.set(path, { text: null, reason: 'сабмодуль' })
    else if (binary.has(path)) states.set(path, { text: null, reason: 'бинарный' })
    else {
      const text = await showFile(run, head, path)
      states.set(path, text.includes('�') ? { text: null, reason: 'не UTF-8' } : { text, reason: null })
    }
  }
  return states
}

/** файлы, текст которых не прикладывается, с причиной */
export function notAttached(states: Map<string, FileState>, max = MAX_FILE_CHARS): Map<string, string> {
  return new Map([...states].filter(([, state]) => state.reason || (state.text ?? '').length > max).map(([path, state]) => [path, state.reason ?? `больше ${max} символов`]))
}

/** блок кода с ограждением длиннее любых бэктиков внутри */
export function fenced(text: string, lang = ''): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${lang}\n${text}\n${fence}`
}

/** раздел ITEMS для агента D */
export function itemsSection(items: TriageItem[]): string {
  const blocks = items.map(item => {
    const place = item.path ? `${item.path}:${item.position ?? item.line ?? ''}` : 'общий'
    const marks = (['stale', 'disagree'] as const).filter(name => item[name])
    return `### ${item.id} — ${place} — ${item.author ?? ''}${marks.length ? ` (${marks.join(', ')})` : ''}\n${item.quote ?? item.body ?? ''}`
  })
  return `## ITEMS\n${blocks.join('\n\n')}`
}

/** правила с ревизии rev для изменений base..head и изменённые самим PR файлы правил */
export async function readRules(run: Run, { rev, base, head }: { rev: string; base: string; head: string }): Promise<{ rules: Map<string, string>; changedRules: string[] }> {
  const [tree, changed] = await Promise.all([treeEntries(run, rev), changedFiles(run, base, head)])
  const blobs = [...tree].filter(([, type]) => type === 'blob').map(([path]) => path)
  const paths = rulePaths(blobs, changed)
  const rules = new Map(await Promise.all(paths.map(async path => [path, await showFile(run, rev, path)] as const)))
  return { rules, changedRules: changed.filter(isRulePath) }
}

/** input.md: RULES, DIFF, FILES и, для агента D, ITEMS */
export async function buildInput(run: Run, { base, head, rules, items }: { base: string; head: string; rules: Map<string, string>; items?: TriageItem[] }): Promise<string> {
  const rulesText = [...rules].map(([path, text]) => `=== RULE FILE: ${path} ===\n${fenced(text)}`).join('\n\n')
  const changed = await changedFiles(run, base, head)
  const diffs = await Promise.all(changed.map(async path => {
    const diff = await fileDiff(run, base, head, path)
    return diff.length > MAX_FILE_CHARS ? `--- ${path} (дифф не приложен: больше ${MAX_FILE_CHARS} символов)\n` : diff
  }))
  const states = await fileStates(run, base, head)
  const skipped = notAttached(states)
  const files = [...states].map(([path, state]) => (skipped.has(path) ? `=== FILE: ${path} === (не приложен: ${skipped.get(path)})` : `=== FILE: ${path} ===\n${fenced(state.text ?? '')}`)).join('\n\n')
  const sections = [`## RULES\n${rulesText}`, `## DIFF\n${fenced(diffs.join(''), 'diff')}`, `## FILES\n${files}`, ...(items ? [itemsSection(items)] : [])]
  const text = `${sections.join('\n\n')}\n`
  if (text.length > MAX_INPUT_CHARS) throw new Error(`вход ${text.length} символов больше лимита ${MAX_INPUT_CHARS}: ревью одним запросом не делается, нужно делить PR`)
  return text
}

/** текст манифеста: файлы, которые агент обязан прочитать, и строки-заметки */
export function manifestText(paths: string[], notes: string[]): string {
  return [...paths, ...notes.map(note => `# ${note}`)].map(line => `${line}\n`).join('')
}
```

- [ ] **Step 4: Запустить — проходит**: `node --test mod/run/input.test.ts` → `pass 7`, `fail 0`.

---

### Task 3b.3: `mod/run/findings.ts` — сбор находок воронки и ответов агента D

**Files:**
- Create: `mod/run/findings.ts`
- Test: `mod/run/findings.test.ts`

**Interfaces:**
- Consumes: `lineCount` (3b.2) — нет, только данные; чистый модуль.
- Produces:
  - `type Severity = 'critical' | 'important' | 'minor'`
  - `interface Finding { id: string; role?: string; file: string; line: number; lines?: number[]; severity: Severity; confidence: number; problem: string; failureScenario?: string; rule?: { file: string; quote: string }; suggestion?: string; verdict?: string; evidence?: string; duplicateOf?: string; mark?: string; ruleDropped?: string }`
  - `interface ThresholdRow { verdict: string; severity: Severity[]; min: number; result: 'in' | 'below'; mark?: string }`
  - `interface GateRow { role?: string; event?: string; unread?: string[]; error?: string }`
  - `interface FindingsResult { findings: Finding[]; belowBar: Finding[]; dropped: Array<{ id: string; reason: string }>; notChecked: string[] }`
  - `normalize(text: string): string`
  - `collectFindings(input: { raw: unknown; changed: string[]; lineCounts: Map<string, number>; rules: Map<string, string>; skipped: Map<string, string>; table: ThresholdRow[]; manifestNotes: string[]; gateRows: GateRow[]; minSeverity?: Severity }): FindingsResult` — бросает `Error` при пустом результате воркфлоу.
  - `type TriageMode = 'feedback' | 'recheck'`, `interface TriageAnswer { id: string; class: string; reason: string; fixed?: true; evidence?: string }`, `finishTriage(raw: unknown, items: Array<{ id: string }>, mode: TriageMode): TriageAnswer[]`

- [ ] **Step 1: Тесты**

`mod/run/findings.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { collectFindings, finishTriage, normalize, type Finding } from './findings.ts'

const TABLE = JSON.parse(readFileSync(new URL('../../config/funnel.json', import.meta.url), 'utf8')).threshold
const RULE = 'Все экспортируемые функции должны иметь комментарий над объявлением.'
const base = {
  changed: ['src/a.ts'], lineCounts: new Map([['src/a.ts', 10]]), rules: new Map([['CLAUDE.md', `# Правила\n- ${RULE}\n`]]),
  skipped: new Map<string, string>(), table: TABLE, manifestNotes: [], gateRows: [{ role: 'correctness', event: 'passed' }],
}
const finding = (over: Partial<Finding> = {}): Finding => ({ id: 'A-1', role: 'correctness', file: 'src/a.ts', line: 3, severity: 'important', confidence: 90, problem: 'p', failureScenario: 's', ...over })
const raw = (findings: Finding[], verdicts: unknown[], over = {}) => ({ findings, verdicts, refuter: 'ok', failed: [], roles: ['correctness', 'quality'], notChecked: [], ...over })

test('подтверждённая important ≥75 — в отчёт; строка из evidence C', () => {
  const result = collectFindings({ ...base, raw: raw([finding()], [{ id: 'A-1', verdict: 'confirmed', evidence: 'src/a.ts:5 — так', severity: 'important', confidence: 80 }]) })
  assert.deepEqual(result.findings.map(f => [f.id, f.line, f.verdict]), [['A-1', 5, 'confirmed']])
})

test('опровержение с доказательством в чужом файле → cannot-refute (critical — в отчёт с меткой)', () => {
  const result = collectFindings({ ...base, raw: raw([finding({ severity: 'critical' })], [{ id: 'A-1', verdict: 'refuted', evidence: 'src/other.ts:2 — не так' }]) })
  assert.equal(result.findings[0].mark, 'не проверено')
})

test('опровергнутая находка выпадает с причиной', () => {
  const result = collectFindings({ ...base, raw: raw([finding()], [{ id: 'A-1', verdict: 'refuted', evidence: 'src/a.ts:3 — проверено' }]) })
  assert.deepEqual(result.dropped, [{ id: 'A-1', reason: 'refuted:src/a.ts:3 — проверено' }])
})

test('цитата правила: найдена после нормализации; не из RULES — rule-file-not-provided; нет сценария и цитата неверна — выпадает', () => {
  const quoted = finding({ id: 'B-1', role: 'quality', failureScenario: undefined, rule: { file: './CLAUDE.md', quote: 'Все  экспортируемые функции должны иметь *комментарий* над объявлением' } })
  const foreign = finding({ id: 'B-2', role: 'quality', failureScenario: undefined, rule: { file: '.claude/rules/x.md', quote: RULE } })
  const confirm = (id: string) => ({ id, verdict: 'confirmed', evidence: 'src/a.ts:3 — да', severity: 'important', confidence: 90 })
  const result = collectFindings({ ...base, raw: raw([quoted, foreign], [confirm('B-1'), confirm('B-2')]) })
  assert.deepEqual(result.findings.map(f => f.id), ['B-1'])
  assert.deepEqual(result.dropped, [{ id: 'B-2', reason: 'rule-file-not-provided' }])
})

test('файл не в diff и строка за концом файла — выпадают', () => {
  const result = collectFindings({ ...base, raw: raw([finding({ id: 'A-1', file: 'x.ts' }), finding({ id: 'A-2', line: 99 })], []) })
  assert.deepEqual(result.dropped.map(d => d.reason), ['file-not-in-diff', 'line-out-of-range'])
})

test('дубли сливаются в сильнейшую, строки объединяются', () => {
  const result = collectFindings({ ...base, raw: raw([finding({ id: 'A-1', line: 3 }), finding({ id: 'B-1', role: 'quality', line: 4 })], [
    { id: 'A-1', verdict: 'confirmed', evidence: 'src/a.ts:3 — да', severity: 'critical', confidence: 90 },
    { id: 'B-1', verdict: 'confirmed', evidence: 'src/a.ts:4 — да', severity: 'important', confidence: 90, duplicateOf: 'A-1' },
  ]) })
  assert.deepEqual(result.findings.map(f => [f.id, f.lines]), [['A-1', [3, 4]]])
  assert.deepEqual(result.dropped, [{ id: 'B-1', reason: 'duplicate-of:A-1' }])
})

test('minSeverity important: minor уходит в dropped', () => {
  const result = collectFindings({ ...base, minSeverity: 'important', raw: raw([finding({ severity: 'minor' })], [{ id: 'A-1', verdict: 'confirmed', evidence: 'src/a.ts:3 — да', severity: 'minor', confidence: 95 }]) })
  assert.deepEqual([result.findings.length, result.dropped], [0, [{ id: 'A-1', reason: 'below-important' }]])
})

test('заметки: пропущенные файлы, манифест, гейт, упавшие агенты', () => {
  const result = collectFindings({ ...base, skipped: new Map([['big.txt', 'больше 60000 символов']]), manifestNotes: ['агент B не запускался'], gateRows: [{ role: 'quality', event: 'exhausted', unread: ['/r/CLAUDE.md'] }], raw: raw([], [], { failed: ['quality'], refuter: 'skipped' }) })
  assert.deepEqual(result.notChecked, ['big.txt — не приложен: больше 60000 символов', 'агент B не запускался', 'агент quality: гейт чтения — exhausted: не прочитаны /r/CLAUDE.md', 'агент quality не ответил — угол quality не проверен'])
})

test('нет результата / ни один искатель не ответил — ошибка; обёртка workflowProgress снимается', () => {
  assert.throws(() => collectFindings({ ...base, raw: { workflowProgress: [], result: null } }), /ревью агентами не состоялось/)
  assert.throws(() => collectFindings({ ...base, raw: raw([], [], { failed: ['correctness', 'quality'] }) }), /ни один агент-искатель не ответил/)
  assert.equal(collectFindings({ ...base, raw: { workflowProgress: [], result: raw([], []) } }).findings.length, 0)
})

test('normalize: типографика, ё, маркеры списков, разметка', () => {
  assert.equal(normalize('- «Ёлка» — *важно*  `x`'), '"Елка" - важно x')
})

test('finishTriage: класс, fixed только у valid, пропуски', () => {
  const answers = { items: [{ id: 'a', class: 'valid', reason: 'r', fixed: true, evidence: 'e' }, { id: 'b', class: 'invalid', reason: 'r', fixed: true }, { id: 'c', class: 'closed', reason: 'r' }] }
  assert.deepEqual(finishTriage(answers, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], 'feedback'), [
    { id: 'a', class: 'valid', reason: 'r', fixed: true, evidence: 'e' },
    { id: 'b', class: 'invalid', reason: 'r' },
    { id: 'c', class: 'question', reason: 'агент D не дал ответа по этому пункту' },
    { id: 'd', class: 'question', reason: 'агент D не дал ответа по этому пункту' },
  ])
  assert.equal(finishTriage({ result: { items: [] } }, [{ id: 'x' }], 'recheck')[0].class, 'unknown')
})
```

- [ ] **Step 2: Запустить — падает** (`Cannot find module '.../mod/run/findings.ts'`).

- [ ] **Step 3: Создать `mod/run/findings.ts`** (перенос `funnel_finish.py` + `review_lite_check.checked_item` + `triage_finish.py`)

```ts
/** вердикты агента C */
const VERDICTS = ['refuted', 'confirmed', 'cannot-refute']
/** события гейта, означающие, что агент не прочитал манифест */
const GATE_FAILURES = ['exhausted', 'stopped', 'hook-error', 'no-manifest']
/** «путь:строка» в доказательстве агента C */
const EVIDENCE = /(?:^|[\s(`"'])([\p{L}\p{N}_./@-]+):(\d+)(?:-\d+)?/u
/** ранг серьёзности для сравнения */
const SEVERITY_RANK: Record<Severity, number> = { critical: 3, important: 2, minor: 1 }
/** минимум слов в цитате правила */
const MIN_QUOTE_WORDS = 6
/** минимум символов в цитате правила */
const MIN_QUOTE_CHARS = 30
/** классы агента D по режиму */
const CLASSES: Record<TriageMode, string[]> = { feedback: ['valid', 'invalid', 'question', 'out-of-scope'], recheck: ['closed', 'open', 'partial'] }
/** класс пункта без ответа */
const FALLBACK: Record<TriageMode, string> = { feedback: 'question', recheck: 'unknown' }
/** типографика, которую сравнение цитат не различает */
const TYPOGRAPHY: Record<string, string> = { '—': '-', '–': '-', '«': '"', '»': '"', '“': '"', '”': '"', '„': '"', 'ё': 'е', 'Ё': 'Е' }

/** серьёзность находки */
export type Severity = 'critical' | 'important' | 'minor'
/** режим агента D */
export type TriageMode = 'feedback' | 'recheck'

/** находка агента A/B и всё, что к ней добавила воронка */
export interface Finding {
  /** A-n / B-n */
  id: string
  /** роль агента */
  role?: string
  /** файл от корня */
  file: string
  /** строка на голове */
  line: number
  /** все строки после слияния дублей */
  lines?: number[]
  /** серьёзность */
  severity: Severity
  /** уверенность 0–100 */
  confidence: number
  /** проблема */
  problem: string
  /** сценарий отказа */
  failureScenario?: string
  /** правило с цитатой */
  rule?: { file: string; quote: string }
  /** предложение */
  suggestion?: string
  /** вердикт C */
  verdict?: string
  /** доказательство C */
  evidence?: string
  /** дубль какой находки */
  duplicateOf?: string
  /** метка из таблицы порогов */
  mark?: string
  /** почему цитата правила снята (находка держится на сценарии) */
  ruleDropped?: string
}

/** строка таблицы порогов config/funnel.json */
export interface ThresholdRow {
  /** вердикт C */
  verdict: string
  /** серьёзности */
  severity: Severity[]
  /** минимальная уверенность */
  min: number
  /** в отчёт или ниже порога */
  result: 'in' | 'below'
  /** метка */
  mark?: string
}

/** строка gate-*.jsonl */
export interface GateRow {
  /** роль агента */
  role?: string
  /** событие гейта */
  event?: string
  /** непрочитанные файлы */
  unread?: string[]
  /** ошибка хука */
  error?: string
}

/** итог воронки для отчёта и публикации */
export interface FindingsResult {
  /** находки отчёта */
  findings: Finding[]
  /** подтверждённые ниже порога */
  belowBar: Finding[]
  /** отброшенные с причиной */
  dropped: Array<{ id: string; reason: string }>
  /** что не проверялось */
  notChecked: string[]
}

/** ответ агента D по пункту */
export interface TriageAnswer {
  /** id пункта */
  id: string
  /** класс */
  class: string
  /** объяснение */
  reason: string
  /** уже исправлено (только valid) */
  fixed?: true
  /** доказательство */
  evidence?: string
}

/** результат воркфлоу воронки */
interface RawFunnel {
  /** находки A/B */
  findings: Finding[]
  /** вердикты C */
  verdicts: Array<Record<string, unknown>>
  /** ok | failed | skipped */
  refuter: string
  /** роли, не ответившие */
  failed: string[]
  /** запущенные роли */
  roles: string[]
  /** «не проверялось» от агентов */
  notChecked: string[]
}

/** файл находки и путь совпадают с точностью до префикса */
function sameFile(path: string, file: string): boolean {
  const cleaned = path.replace(/^\.\//, '')
  return cleaned === file || file.endsWith(`/${cleaned}`) || cleaned.endsWith(`/${file}`)
}

/** строка из доказательства, если оно ссылается на файл находки */
function evidenceLine(evidence: string | undefined, file: string): number | null {
  const match = EVIDENCE.exec(evidence ?? '')
  return match && sameFile(match[1], file) ? Number(match[2]) : null
}

/** вердикт C, применённый к находке */
function verdictOf(item: Finding, verdict: Record<string, unknown> | undefined): Finding {
  const name = verdict?.verdict
  if (!verdict || typeof name !== 'string' || !VERDICTS.includes(name)) return { ...item, verdict: 'cannot-refute' }
  const evidence = typeof verdict.evidence === 'string' ? verdict.evidence : ''
  if (name === 'refuted') return evidenceLine(evidence, item.file) !== null ? { ...item, verdict: 'refuted', evidence } : { ...item, verdict: 'cannot-refute' }
  if (name === 'confirmed') {
    return { ...item, verdict: 'confirmed', severity: (verdict.severity as Severity) ?? item.severity, confidence: (verdict.confidence as number) ?? item.confidence, ...(evidence ? { evidence } : {}) }
  }
  return { ...item, verdict: 'cannot-refute' }
}

/** нормализация текста для сравнения цитат: Unicode, разметка, типографика, пробелы */
export function normalize(text: string): string {
  const plain = text.normalize('NFKC').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*(?:[-*+>]|\d+\.)\s+/gm, '').replace(/\|/g, ' ')
  const typo = [...plain].map(char => TYPOGRAPHY[char] ?? char).join('')
  return typo.replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim()
}

/** путь среди известных: точный или известный в конце пути */
function resolvePath(path: string, known: readonly string[]): string | null {
  const cleaned = path.replace(/^\.\//, '')
  if (known.includes(cleaned)) return cleaned
  return known.filter(item => cleaned.endsWith(`/${item}`)).sort((a, b) => b.length - a.length)[0] ?? null
}

/** экранирование для RegExp */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/** причина отклонить цитату правила или null */
function ruleReason(rule: { file: string; quote: string }, rules: Map<string, string>): string | null {
  const file = resolvePath(rule.file, [...rules.keys()])
  if (file === null) return 'rule-file-not-provided'
  const quote = normalize(rule.quote)
  if (quote.split(' ').length < MIN_QUOTE_WORDS || quote.length < MIN_QUOTE_CHARS) return 'quote-too-short'
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped(quote)}(?![\\p{L}\\p{N}_])`, 'u')
  return pattern.test(normalize(rules.get(file) ?? '')) ? null : 'quote-not-found'
}

/** проверка находки: место в diff, доказательство сценарием или цитатой */
function checkedItem(item: Finding, rules: Map<string, string>, changed: string[], lineCounts: Map<string, number>): { item: Finding } | { reason: string } {
  const file = resolvePath(item.file, changed)
  if (file === null) return { reason: 'file-not-in-diff' }
  if (!lineCounts.has(file)) return { reason: 'file-not-text' }
  if (item.line > (lineCounts.get(file) ?? 0)) return { reason: 'line-out-of-range' }
  const result = { ...item, file }
  const scenario = Boolean(item.failureScenario?.trim())
  if (!item.rule) return scenario ? { item: result } : { reason: 'no-evidence' }
  const problem = ruleReason(item.rule, rules)
  if (problem === null) return { item: { ...result, rule: { ...item.rule, file: resolvePath(item.rule.file, [...rules.keys()]) ?? item.rule.file } } }
  if (!scenario) return { reason: problem }
  const { rule: _rule, ...withoutRule } = result
  return { item: { ...withoutRule, ruleDropped: problem } }
}

/** сила находки при слиянии дублей: в отчёте > ниже порога, затем серьёзность, затем уверенность */
function stronger(a: Finding, aBucket: number, b: Finding, bBucket: number): boolean {
  const left = [aBucket, SEVERITY_RANK[a.severity], a.confidence]
  const right = [bBucket, SEVERITY_RANK[b.severity], b.confidence]
  const index = left.findIndex((value, i) => value !== right[i])
  return index >= 0 && left[index] > right[index]
}

/** без служебного duplicateOf */
function withoutDuplicate({ duplicateOf: _duplicate, ...item }: Finding): Finding {
  return item
}

/** сливает дубли (по отметке C) в сильнейшую находку того же файла */
function foldDuplicates(kept: Finding[], below: Finding[]): [Finding[], Finding[], Array<{ id: string; reason: string }>] {
  const survivors = new Map<string, [Finding, number]>([...kept.map(item => [item.id, [item, 1]] as [string, [Finding, number]]), ...below.map(item => [item.id, [item, 0]] as [string, [Finding, number]])])
  const merged = new Map(survivors)
  const dropped: Array<{ id: string; reason: string }> = []
  for (const id of survivors.keys()) {
    const current = merged.get(id)
    if (!current) continue
    const [item, bucket] = current
    const target = item.duplicateOf ? merged.get(item.duplicateOf) : undefined
    if (!target || item.duplicateOf === id || target[0].file !== item.file) continue
    const [keep, keepBucket, lose] = stronger(item, bucket, target[0], target[1]) ? [item, bucket, target[0]] : [target[0], target[1], item]
    const lines = [...new Set([...(keep.lines ?? [keep.line]), ...(lose.lines ?? [lose.line])])].sort((a, b) => a - b)
    merged.set(keep.id, [{ ...keep, lines, line: lines[0] }, keepBucket])
    merged.delete(lose.id)
    dropped.push({ id: lose.id, reason: `duplicate-of:${keep.id}` })
  }
  const values = [...merged.values()]
  return [values.filter(([, b]) => b === 1).map(([item]) => withoutDuplicate(item)), values.filter(([, b]) => b === 0).map(([item]) => withoutDuplicate(item)), dropped]
}

/** таблица порогов: в отчёт, ниже порога или прочь */
function applyThreshold(items: Finding[], table: ThresholdRow[]): [Finding[], Finding[], Array<{ id: string; reason: string }>] {
  const kept: Finding[] = []
  const below: Finding[] = []
  const dropped: Array<{ id: string; reason: string }> = []
  for (const item of items) {
    const row = table.find(r => r.verdict === item.verdict && r.severity.includes(item.severity) && item.confidence >= r.min)
    const marked = row?.mark ? { ...item, mark: row.mark } : item
    if (!row) dropped.push({ id: item.id, reason: item.verdict === 'refuted' ? `refuted:${item.evidence}` : `below-threshold:${item.verdict}:${item.severity}:${item.confidence}` })
    else if (row.result === 'in') kept.push(marked)
    else below.push(marked)
  }
  return [kept, below, dropped]
}

/** результат воркфлоу; бросает, если ревью не состоялось */
function readRaw(raw: unknown): RawFunnel {
  const box = raw as Record<string, unknown> | null
  const result = (box && 'workflowProgress' in box ? box.result : box) as RawFunnel | null
  if (!result || typeof result !== 'object' || !Array.isArray(result.findings)) throw new Error('Workflow не вернул результат — ревью агентами не состоялось')
  if (result.roles?.length && result.roles.every(role => result.failed?.includes(role))) throw new Error(`ни один агент-искатель не ответил (${result.roles.join(', ')}) — ревью агентами не состоялось`)
  return { findings: result.findings, verdicts: result.verdicts ?? [], refuter: result.refuter ?? 'ok', failed: result.failed ?? [], roles: result.roles ?? [], notChecked: result.notChecked ?? [] }
}

/** заметки гейта чтения */
function gateNotes(rows: GateRow[]): string[] {
  if (rows.length === 0) return ['гейт чтения: записей нет — чтение агентов не подтверждено']
  return rows.filter(row => GATE_FAILURES.includes(row.event ?? '')).map(row => `агент ${row.role}: гейт чтения — ${row.event}${row.unread?.length ? `: не прочитаны ${row.unread.join(', ')}` : ''}${row.error ? ` (${row.error})` : ''}`)
}

/** итог воронки: вердикты C, проверки, пороги, дубли, заметки */
export function collectFindings(input: { raw: unknown; changed: string[]; lineCounts: Map<string, number>; rules: Map<string, string>; skipped: Map<string, string>; table: ThresholdRow[]; manifestNotes: string[]; gateRows: GateRow[]; minSeverity?: Severity }): FindingsResult {
  const raw = readRaw(input.raw)
  const verdicts = new Map(raw.verdicts.filter(v => v && typeof v === 'object').map(v => [v.id as string, v]))
  const resolved = raw.findings.map(item => {
    const verdict = verdicts.get(item.id)
    const duplicate = typeof verdict?.duplicateOf === 'string' ? { duplicateOf: verdict.duplicateOf } : {}
    return { ...verdictOf(item, verdict), lines: [item.line], ...duplicate }
  })
  const valid: Finding[] = []
  const invalid: Array<{ id: string; reason: string }> = []
  for (const item of resolved) {
    const line = item.verdict === 'confirmed' ? evidenceLine(item.evidence, item.file) : null
    const located = line !== null && line >= 1 && line <= (input.lineCounts.get(item.file) ?? 0) ? { ...item, line, lines: [line] } : item
    const checked = checkedItem(located, input.rules, input.changed, input.lineCounts)
    if ('reason' in checked) invalid.push({ id: item.id, reason: checked.reason })
    else valid.push(checked.item)
  }
  const [passed, passedBelow, belowDropped] = applyThreshold(valid, input.table)
  const [folded, below, foldDropped] = foldDuplicates(passed, passedBelow)
  const floor = input.minSeverity ? SEVERITY_RANK[input.minSeverity] : 0
  const findings = folded.filter(item => SEVERITY_RANK[item.severity] >= floor)
  const minDropped = folded.filter(item => SEVERITY_RANK[item.severity] < floor).map(item => ({ id: item.id, reason: `below-${input.minSeverity}` }))
  const notes = [
    ...raw.notChecked,
    ...[...input.skipped].map(([path, why]) => `${path} — не приложен: ${why}`),
    ...input.manifestNotes,
    ...gateNotes(input.gateRows),
    ...raw.failed.map(role => `агент ${role} не ответил — угол ${role} не проверен`),
    ...(raw.refuter === 'failed' ? ['агент C не ответил — вердиктов нет'] : []),
  ]
  return { findings, belowBar: below, dropped: [...invalid, ...belowDropped, ...foldDropped, ...minDropped], notChecked: [...new Set(notes)] }
}

/** ответы агента D: ровно один класс на пункт, без ответа — запасной класс */
export function finishTriage(raw: unknown, items: Array<{ id: string }>, mode: TriageMode): TriageAnswer[] {
  const box = raw as { result?: unknown; items?: unknown } | null
  const answer = (box?.result && typeof box.result === 'object' ? box.result : box) as { items?: Array<Record<string, unknown>> } | null
  const answers = new Map((answer?.items ?? []).filter(a => a && typeof a === 'object').map(a => [a.id as string, a]))
  return items.map(item => {
    const found = answers.get(item.id)
    const cls = found?.class
    if (typeof cls !== 'string' || !CLASSES[mode].includes(cls)) return { id: item.id, class: FALLBACK[mode], reason: 'агент D не дал ответа по этому пункту' }
    return {
      id: item.id, class: cls, reason: typeof found?.reason === 'string' ? found.reason : '',
      ...(cls === 'valid' && found?.fixed === true ? { fixed: true as const } : {}),
      ...(typeof found?.evidence === 'string' && found.evidence ? { evidence: found.evidence } : {}),
    }
  })
}
```

Тест «заметки» проверяет точный порядок; гейт `passed` в `base.gateRows` не даёт заметки, `quality: exhausted` — даёт.
В тесте «нет результата» `gateRows` по умолчанию непустой.

- [ ] **Step 4: Запустить — проходит**: `node --test mod/run/findings.test.ts` → `pass 11`, `fail 0`.

---

### Task 3b.4: Паритет с Python на одних входах

**Files:**
- Create (scratchpad): `$S/parity-3b.mjs`

- [ ] **Step 1: Скрипт**

```js
// parity-3b.mjs — funnel_finish.py (2.2) против collectFindings (3.0) на одном временном репозитории и одних raw
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectFindings } from '/home/prian/projects/review-kit/mod/run/findings.ts'

const dir = mkdtempSync(join(tmpdir(), 'rk-par-'))
const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' }).stdout.trim()
git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
const RULE = 'Все экспортируемые функции должны иметь комментарий над объявлением.'
writeFileSync(join(dir, 'CLAUDE.md'), `# Правила\n- ${RULE}\n`); writeFileSync(join(dir, 'a.ts'), '1\n'); git('add', '-A'); git('commit', '-qm', 'b')
const base = git('rev-parse', 'HEAD')
writeFileSync(join(dir, 'a.ts'), Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n') + '\n'); git('commit', '-qam', 'h')
const head = git('rev-parse', 'HEAD')
const f = (id, over = {}) => ({ id, role: 'correctness', file: 'a.ts', line: 3, severity: 'important', confidence: 90, problem: 'p', failureScenario: 's', ...over })
const CASES = {
  confirmed: [[f('A-1')], [{ id: 'A-1', verdict: 'confirmed', evidence: 'a.ts:5 — да', severity: 'important', confidence: 80 }]],
  refutedOther: [[f('A-1', { severity: 'critical' })], [{ id: 'A-1', verdict: 'refuted', evidence: 'b.ts:1 — нет' }]],
  quote: [[f('B-1', { role: 'quality', failureScenario: undefined, rule: { file: 'CLAUDE.md', quote: RULE } })], [{ id: 'B-1', verdict: 'confirmed', evidence: 'a.ts:3 — да', severity: 'important', confidence: 90 }]],
  dupes: [[f('A-1'), f('B-1', { line: 4 })], [{ id: 'A-1', verdict: 'confirmed', evidence: 'a.ts:3', severity: 'critical', confidence: 90 }, { id: 'B-1', verdict: 'confirmed', evidence: 'a.ts:4', severity: 'important', confidence: 90, duplicateOf: 'A-1' }]],
  belowBar: [[f('A-1', { severity: 'minor' })], [{ id: 'A-1', verdict: 'confirmed', evidence: 'a.ts:3', severity: 'minor', confidence: 60 }]],
}
const table = JSON.parse(readFileSync('/home/prian/projects/review-kit/config/funnel.json', 'utf8')).threshold
for (const [name, [findings, verdicts]] of Object.entries(CASES)) {
  const out = join(dir, name); mkdirSync(out)
  const raw = { findings, verdicts, refuter: 'ok', failed: [], roles: ['correctness', 'quality'], notChecked: [] }
  writeFileSync(join(out, 'raw.json'), JSON.stringify(raw))
  const py = spawnSync('python3', ['/home/prian/projects/review-kit/tools/funnel_finish.py', '--repo', dir, '--raw', join(out, 'raw.json'), '--base', base, '--head', head, '--out', out], { encoding: 'utf8' })
  const pyResult = JSON.parse(readFileSync(join(out, 'findings.json'), 'utf8'))
  const ts = collectFindings({ raw, changed: ['a.ts'], lineCounts: new Map([['a.ts', 10]]), rules: new Map([['CLAUDE.md', readFileSync(join(dir, 'CLAUDE.md'), 'utf8')]]), skipped: new Map(), table, manifestNotes: [], gateRows: [] })
  const pick = r => JSON.stringify({ findings: r.findings.map(x => [x.id, x.line, x.severity, x.mark ?? null]), belowBar: r.belowBar.map(x => x.id), dropped: r.dropped })
  console.log(`${pick(ts) === pick(pyResult) ? 'ok  ' : 'DIFF'} ${name}${pick(ts) === pick(pyResult) ? '' : `\n  ts ${pick(ts)}\n  py ${pick(pyResult)} ${py.stderr}`}`)
}
```

- [ ] **Step 2: Запустить**: `node $S/parity-3b.mjs 2>&1 | grep -v ExperimentalWarning` → `ok` во всех пяти. `DIFF` — чинить `findings.ts`.

---

### Task 3b.5: Инструменты `review_prepare`/`review_collect`, gate без запрета grep, агенты, скиллы; удаление скриптов

**Files:**
- Modify: `mod/register.ts` (инструменты, путь `findings.json` у Plannotator, хуки gate)
- Modify: `mod/gate.ts` (удалить `accessDenial` и всё, что служит только ему)
- Modify: `agents/correctness.md`, `agents/quality.md`, `agents/refuter.md`, `agents/triage.md`
- Modify: `skills/pr-review-run/SKILL.md` (раздел 1, пути `findings.json`), `skills/pr-recheck-run/SKILL.md` (шаги 2–3), `skills/pr-feedback-run/SKILL.md` (раздел 1), `skills/pr-fix-run/SKILL.md` (источник пунктов, шаг 4)
- Delete: `tools/funnel_prep.py`, `tools/funnel_finish.py`, `tools/triage_prep.py`, `tools/triage_finish.py`, `tools/review_lite_input.py`, `tools/review_lite_check.py`, `tools/snapshot`, `config/settings.example.json`

**Interfaces:**
- Consumes: всё из 3b.1–3b.3; `activeRun`, `projectRoot`, `runDir` (`register.ts`).
- Produces: инструменты `review_prepare(pr: number, kind: 'review' | 'recheck' | 'feedback' | 'fix-check', paths?: string[])`, `review_collect(pr: number, id: 'funnel' | 'delta' | 'statuses' | 'triage' | 'fix-check', outputFile: string)`; файлы `findings.json`, `triage.json`, `statuses.json`, `fix-check/findings.json`.

- [ ] **Step 1: `mod/register.ts` — подготовка и сбор**

Импорты:

```ts
import { buildInput, B_SKIPPED, fileStates, lineCount, manifestText, notAttached, readRules, type TriageItem } from './run/input.ts'
import { collectFindings, finishTriage, type GateRow, type Severity, type ThresholdRow } from './run/findings.ts'
import { changedFiles, gitText, snapshot, type Run } from './git.ts'
```

(строку `import { recheckBase } from './git.ts'` объединить с этой.)

Добавить после `writeRecheck`-кода (перед `sessionProject`):

```ts
/** вид подготовки, который просит скилл */
type PrepareKind = 'review' | 'recheck' | 'feedback' | 'fix-check'
/** id воркфлоу внутри прогона */
type WorkflowId = 'funnel' | 'delta' | 'statuses' | 'triage' | 'fix-check'
/** воркфлоу для скилла: скрипт и аргументы */
interface WorkflowSpec { id: WorkflowId; scriptPath: string; args: Record<string, unknown> }

/** запуск процессов для чистых модулей */
function runner($: EngineInterface): Run {
  return (argv, init) => $.process.run(argv, init)
}

/** context.json активного прогона этого PR */
async function runContext($: EngineInterface, pr: number): Promise<{ dir: string; context: { head: string; base: string; model: string } }> {
  if ((await activeRun($)) !== pr) throw new Error(`нет активного прогона PR ${pr}`)
  const dir = await runDir($, pr)
  return { dir, context: JSON.parse(String(await $.fs.read(`${dir}/context.json`))) }
}

/** файлы одного воркфлоу: правила, вход, манифесты, диапазон; возвращает спецификацию и заметки */
async function writeWorkflow($: EngineInterface, w: { pr: number; dir: string; id: WorkflowId; base: string; head: string; rulesRev: string; model: string; foreign: boolean; items?: TriageItem[]; mode?: 'feedback' | 'recheck' }): Promise<{ spec: WorkflowSpec; notes: string[] }> {
  const run = runner($)
  const out = `${w.dir}/${w.id}`
  const sha = async (rev: string) => (await gitText(run, ['rev-parse', rev])).trim()
  const [base, head, rulesRev] = await Promise.all([sha(w.base), sha(w.head), sha(w.rulesRev)])
  const { rules, changedRules } = await readRules(run, { rev: rulesRev, base, head })
  const input = await buildInput(run, { base, head, rules, items: w.items })
  const notes = [
    ...(!w.items && rules.size === 0 ? [B_SKIPPED] : []),
    ...(w.foreign && changedRules.length ? [`PR меняет правила агентов: ${changedRules.join(', ')} — ревью шло по правилам базы`] : []),
  ]
  await $.process.run(['rm', '-rf', out])
  await Promise.all([...rules].map(([path, text]) => $.fs.write(`${out}/rules/${path}`, text)))
  await $.fs.write(`${out}/rules.json`, JSON.stringify(Object.fromEntries(rules)))
  await $.fs.write(`${out}/range.json`, JSON.stringify({ base, head }))
  await $.fs.write(`${out}/input.md`, input)
  const copies = [...rules.keys()].map(path => `${out}/rules/${path}`)
  const roles = w.items ? [] : rules.size ? ['correctness', 'quality'] : ['correctness']
  for (const role of w.items ? ['triage'] : [...roles, 'refuter']) await $.fs.write(`${out}/manifest-${role}.txt`, manifestText(copies, notes))
  const rel = `.review-kit/run/${w.pr}/${w.id}`
  const args = w.items
    ? { pr: w.pr, mode: w.mode, input: `${rel}/input.md`, manifestDir: rel, model: w.model, ids: w.items.map(item => item.id) }
    : { pr: w.pr, input: `${rel}/input.md`, manifestDir: rel, roles, model: w.model }
  return { spec: { id: w.id, scriptPath: `${$.plugin.root}/funnel/${w.items ? 'triage' : 'review-funnel'}.js`, args }, notes }
}

/** review_prepare: воркфлоу для вида подготовки */
async function prepare($: EngineInterface, pr: number, kind: PrepareKind, paths: string[]): Promise<{ workflows: WorkflowSpec[]; notes: string[] }> {
  const { dir, context } = await runContext($, pr)
  const base = { pr, dir, model: context.model }
  const parts: Array<{ spec: WorkflowSpec; notes: string[] }> = []
  if (kind === 'review') parts.push(await writeWorkflow($, { ...base, id: 'funnel', base: context.base, head: context.head, rulesRev: context.base, foreign: true }))
  if (kind === 'recheck') {
    const recheck = JSON.parse(String(await $.fs.read(`${dir}/recheck.json`))) as { base: string; prior: TriageItem[] }
    parts.push(await writeWorkflow($, { ...base, id: 'statuses', base: recheck.base, head: context.head, rulesRev: context.base, foreign: true, items: recheck.prior, mode: 'recheck' }))
    parts.push(await writeWorkflow($, { ...base, id: 'delta', base: recheck.base, head: context.head, rulesRev: context.base, foreign: true }))
  }
  if (kind === 'feedback') {
    const intake = JSON.parse(String(await $.fs.read(`${dir}/intake.json`))) as { items: TriageItem[] }
    parts.push(await writeWorkflow($, { ...base, id: 'triage', base: context.base, head: 'HEAD', rulesRev: 'HEAD', foreign: false, items: intake.items, mode: 'feedback' }))
  }
  if (kind === 'fix-check') {
    const head = await snapshot(runner($), { paths, indexFile: `${dir}/snapshot.index` })
    parts.push(await writeWorkflow($, { ...base, id: 'fix-check', base: 'HEAD', head, rulesRev: 'HEAD', foreign: false }))
  }
  if (parts.length === 0) throw new Error(`неизвестный вид подготовки ${kind}`)
  return { workflows: parts.map(part => part.spec), notes: [...new Set(parts.flatMap(part => part.notes))] }
}

/** строки «# заметка» манифестов и записи гейта воркфлоу */
async function workflowNotes($: EngineInterface, out: string): Promise<{ manifestNotes: string[]; gateRows: GateRow[] }> {
  const names = (await $.process.run(['ls', '-1', out])).stdout.split('\n').filter(Boolean)
  const read = (name: string) => $.fs.read(`${out}/${name}`).then(String, () => '')
  const manifests = await Promise.all(names.filter(name => /^manifest-.*\.txt$/.test(name)).sort().map(read))
  const gates = await Promise.all(names.filter(name => /^gate-.*\.jsonl$/.test(name)).sort().map(read))
  return {
    manifestNotes: [...new Set(manifests.flatMap(text => text.split('\n')).filter(line => line.startsWith('# ')).map(line => line.slice(2)))],
    gateRows: gates.flatMap(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line) as GateRow)),
  }
}

/** review_collect: итог воркфлоу в файл прогона и в ответ скиллу */
async function collect($: EngineInterface, pr: number, id: WorkflowId, outputFile: string): Promise<string> {
  const { dir } = await runContext($, pr)
  const out = `${dir}/${id}`
  const text = String(await $.fs.read(outputFile))
  await $.fs.write(`${out}/raw.json`, text)
  const raw = JSON.parse(text) as unknown
  if (id === 'triage' || id === 'statuses') {
    const source = JSON.parse(String(await $.fs.read(`${dir}/${id === 'triage' ? 'intake' : 'recheck'}.json`))) as { items?: TriageItem[]; prior?: TriageItem[] }
    const items = finishTriage(raw, source.items ?? source.prior ?? [], id === 'triage' ? 'feedback' : 'recheck')
    const result = JSON.stringify({ items }, null, 2)
    await $.fs.write(`${dir}/${id === 'triage' ? 'triage' : 'statuses'}.json`, result)
    return result
  }
  const run = runner($)
  const { base, head } = JSON.parse(String(await $.fs.read(`${out}/range.json`))) as { base: string; head: string }
  const rules = new Map(Object.entries(JSON.parse(String(await $.fs.read(`${out}/rules.json`))) as Record<string, string>))
  const states = await fileStates(run, base, head)
  const lineCounts = new Map([...states].filter(([, s]) => s.text !== null).map(([path, s]) => [path, lineCount(s.text ?? '')]))
  const table = (JSON.parse(String(await $.fs.read(`${$.plugin.root}/config/funnel.json`))) as { threshold: ThresholdRow[] }).threshold
  const result = collectFindings({
    raw, changed: await changedFiles(run, base, head), lineCounts, rules, skipped: notAttached(states), table, ...(await workflowNotes($, out)),
    ...(id === 'delta' ? { minSeverity: 'important' as Severity } : {}),
  })
  const json = JSON.stringify(result, null, 2)
  await $.fs.write(id === 'fix-check' ? `${out}/findings.json` : `${dir}/findings.json`, json)
  return json
}
```

В `TOOL_SPECS` добавить:

```ts
  {
    name: 'review_prepare',
    description: 'Prepare agent input for the active review-kit run: kind review | recheck | feedback | fix-check (fix-check needs paths = the round paths). Answers JSON { workflows: [{ id, scriptPath, args }], notes } — call Workflow with each scriptPath and args; or "review-kit: …" on error.',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' }, kind: { enum: ['review', 'recheck', 'feedback', 'fix-check'] }, paths: { type: 'array', items: { type: 'string' } } }, required: ['pr', 'kind'] },
    isDeferred: false,
  },
  {
    name: 'review_collect',
    description: 'Collect a finished review-kit workflow: id from review_prepare and the <output-file> of its completion notification. Answers the result JSON (findings, or triage classes) or "review-kit: …" when the review did not happen.',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' }, id: { enum: ['funnel', 'delta', 'statuses', 'triage', 'fix-check'] }, outputFile: { type: 'string' } }, required: ['pr', 'id', 'outputFile'] },
    isDeferred: false,
  },
```

Обработчики (рядом с `review_start`):

```ts
  on('tool.call', { tool: 'mcp__review-kit__review_prepare' }, async ($, e) => {
    const { pr, kind, paths } = e as unknown as { pr: number; kind: PrepareKind; paths?: string[] }
    try {
      return { result: JSON.stringify(await prepare($, pr, kind, paths ?? [])) }
    } catch (error) {
      return { result: `review-kit: ${(error as Error).message}` }
    }
  }).catch(() => ({ result: 'review-kit: review_prepare не выполнен' }))

  on('tool.call', { tool: 'mcp__review-kit__review_collect' }, async ($, e) => {
    const { pr, id, outputFile } = e as unknown as { pr: number; id: WorkflowId; outputFile: string }
    try {
      return { result: await collect($, pr, id, outputFile) }
    } catch (error) {
      return { result: `review-kit: ${(error as Error).message}` }
    }
  }).catch(() => ({ result: 'review-kit: review_collect не выполнен' }))
```

В `startPlannotator` путь `${dir}/lite/findings.json` → `${dir}/findings.json`.

- [ ] **Step 2: gate без запрета grep**

`mod/gate.ts`: удалить константы `PROTECTED_IN_ROOT`, `PROTECTED_IN_HOME`, `MEMORY`, `LISTING`, `GIT_LISTING`, `READ_VERBS`, `BARE_PROTECTED`, `PATTERN_FLAGS`, `SEARCH_VERBS`, `FIND_ACTIONS`, `PATCH_FLAGS`, `NAME_FLAGS`, `GIT_READS`, `CD_VERBS`, `TOKEN_START`, `PATH_END`, `DENIAL` и функции `protectedDirs`, `escaped`, `mentionsProtected`, `isListing`, `pathArgs`, `chainLinks`, `isGitRead`, `readsBareProtected`, `absolute`, `accessDenial`, а также импорт `simpleCommands`. Остаются `ROLES`, `Role`, `MAX_RETURNS`, `GatedAgent`, `parseManifest`, `parseRole`, `manifestPaths`, `normalizePath`, `unreadFiles`.

`mod/register.ts`: из импорта `gate.ts` убрать `accessDenial`; удалить функцию `gatedDenial` и обработчик `on('tool.call', { tool: 'Grep' }, …)` целиком; в обработчике `Bash` удалить первые две строки (`const denial = await gatedDenial($, e)` и `if (denial) return { deny: denial }`).

- [ ] **Step 3: Агенты**

В `agents/correctness.md` и `agents/quality.md`:
- предложение `Rules, skills, docs and memory are opened with Read, whole — grep over them is refused.` удалить;
- `` `file` is a RULES path exactly as written in its header (or a project rule file loaded into your context — `CLAUDE.md`, `AGENTS.md`, `.claude/rules/…` — as a path from the repository root), `` → `` `file` is a RULES path exactly as written in its `=== RULE FILE: <path> ===` header, ``.

В `agents/refuter.md` после пункта 2 добавить: `   The rules are the RULES section of the input and the rule files of your manifest — a rule quoted from anywhere else does not count.`

В `agents/triage.md` пункт 1: `(`input.md`: diff, changed files at HEAD, rules, and the ITEMS section)` — без изменений; удалить ничего не нужно (ссылок на ai-dev-kit нет).

- [ ] **Step 4: Скиллы — вызовы инструментов вместо скриптов**

`skills/pr-review-run/SKILL.md`, раздел `## 1. Review — agents funnel` целиком:

```markdown
## 1. Review — agents funnel

1. Call `review_prepare` with `pr` and `kind: "review"`. An answer starting with `review-kit:` (e.g. the input is too
   large) → report it, call `review_finish`, stop. Otherwise it is JSON `{ workflows: [one], notes }`.
2. Call `Workflow` with that workflow's `scriptPath` and its `args` as a JSON object. This skill's instruction is the
   user's opt-in to the workflow. Wait for its completion notification; do nothing else meanwhile.
3. Call `review_collect` with `pr`, `id: "funnel"`, `outputFile` = the notification's `<output-file>`. It answers the
   findings JSON (`findings`, `belowBar`, `dropped`, `notChecked`) and writes `.review-kit/run/<N>/findings.json`.
4. The workflow failed or left no output file, or `review_collect` answered `review-kit: …`: report «Ревью агентами не
   состоялось — не проверено» with that line, never a verdict; call `review_finish`, stop.
```

В остальном тексте `pr-review-run` все пути `.review-kit/run/<N>/lite/findings.json` → `.review-kit/run/<N>/findings.json`.

`skills/pr-recheck-run/SKILL.md` шаги 2–3 заменить на:

```markdown
2. Call `review_prepare` with `pr`, `kind: "recheck"`: two workflows, `statuses` and `delta`. Call `Workflow` for both
   (they may run together), wait for both notifications, then `review_collect` for each with its `id` and `<output-file>`.
   `statuses` writes `.review-kit/run/<N>/statuses.json`; `delta` writes `findings.json` with only Critical and Important.
   `statuses` failed → «Статусы агентом не проверены», then do them yourself: for each `prior` item read the place at
   `head`, write `.review-kit/run/<N>/statuses.json` = `{"items": [{"id", "class": "closed"|"open"|"partial", "reason"}]}`.
3. `delta` failed → report the statuses with «Дельта не проверена — <line>» instead of findings (step 4), no verdict.
```

`skills/pr-feedback-run/SKILL.md`, раздел `## 1. Triage`, шаги 1–3 заменить на:

```markdown
1. Call `review_prepare` with `pr`, `kind: "feedback"` → one workflow `triage`.
2. Call `Workflow` with its `scriptPath` and `args` (an object). This instruction is the user's opt-in to the workflow.
   Wait for its completion notification; do nothing else meanwhile.
3. Call `review_collect` with `pr`, `id: "triage"`, the notification's `<output-file>`: it writes `.review-kit/run/<N>/triage.json`.
```

`skills/pr-fix-run/SKILL.md`: в абзаце об источнике пунктов `.review-kit/run/<N>/lite/findings.json` → `.review-kit/run/<N>/findings.json`; шаг 4 заменить на:

```markdown
4. AskUserQuestion «Прогнать агентов по diff правок?» — yes → `review_prepare` with `pr`, `kind: "fix-check"`, `paths` = the
   round paths; `Workflow` with the answer's `scriptPath`/`args`; `review_collect` with `id: "fix-check"`. Report its findings;
   fix what the user picks, back to step 3. A failure here: report «Ревью агентами не состоялось — не проверено» with the
   line and go on to step 5 — never call `review_finish` from this step: the round's edits still need the commit.
```

- [ ] **Step 5: Отвязать `review_payload.py` от удаляемого модуля** (до удаления!)

`tools/review_payload.py` импортирует `git` из `review_lite_input` — до его удаления в 3c заменить импорт локальной функцией:

```python
# git-команда в репозитории, вывод текстом (раньше — из review_lite_input)
def git(repo: str, *args: str) -> str:
    return subprocess.run(['git', '-C', repo, '-c', 'core.quotePath=false', *args], check=True, capture_output=True).stdout.decode('utf-8', errors='replace')
```

и `import argparse, json, re, sys` → `import argparse, json, re, subprocess, sys`, строку `from review_lite_input import git` удалить.

- [ ] **Step 5a: Удалить скрипты и проверить**

```bash
rm tools/funnel_prep.py tools/funnel_finish.py tools/triage_prep.py tools/triage_finish.py tools/review_lite_input.py tools/review_lite_check.py tools/snapshot config/settings.example.json
```

Run: `grep -rnE "funnel_prep|funnel_finish|triage_prep|triage_finish|review_lite|tools/snapshot|settings.example|lite/findings|accessDenial|grep over them" mod skills agents tools funnel; for m in $(ls tools/*.py 2>/dev/null | xargs -rn1 basename | sed 's/\.py$//'); do python3 -c "import sys; sys.path.insert(0, 'tools'); import $m" || echo "IMPORT-FAIL $m"; done; echo imports-checked; TMPDIR=$S node $S/tscheck.mjs mod/*.ts mod/run/*.ts 2>&1 | grep -v ExperimentalWarning; node --test 'mod/**/*.test.ts' 2>&1 | grep -E "^ℹ (pass|fail)"; claude plugin validate . 2>&1 | tail -1`
Expected: grep пуст; нет `IMPORT-FAIL`; все `ok`; `fail 0`; `Validation passed`.

- [ ] **Step 6: Живая проверка (с пользователем)**

`/pr-review <N>` на чужом PR: `review_prepare` → `Workflow` → `review_collect` → отчёт; в репозитории без правил — заметка
«агент B не запускался…» в «Не проверялось», в воронке только A и C. `/pr-feedback <N>`: триаж через `review_collect`.

**Стоп 3b: ждём «дальше» пользователя.**

---

# Подэтап 3c: публикация, commit+push, переключение и уборка в моде

Уходят `forgejo.py`, `review_payload.py`, `replies.py`, `switch-pr`, `commit-push`, `cleanup.py`, инструмент
`review_confirm`, отметки подтверждения (`marks`, `publishMarks`) и разбор «канонических» команд в `policy.ts`.
Появляются инструменты `review_publish`, `replies_publish`, `commit_push` — каждый сам спрашивает подтверждение.
`pr-tab` (скилл звал `forgejo.py get`) не работает с этого подэтапа до этапа 6 — ветки 3.0 не выпускаются, это допустимо.

### Task 3c.1: `mod/run/review.ts` — вердикт, тело ревью, ответы

**Files:**
- Create: `mod/run/review.ts`
- Test: `mod/run/review.test.ts`

**Interfaces:**
- Consumes: `ReviewDraft`, `Reply`, `ForgeProvider['capabilities']` (`forge/types.ts`); `IntakeItem`, `MARKER` (`status.ts`); `Finding` (`run/findings.ts`).
- Produces:
  - `type VerdictName = 'Blocked' | 'Changes requested' | 'Approved with comments' | 'Approved'`
  - `verdictName(findings: Array<{ severity: string }>, statuses?: Array<{ class: string; severity?: string }>): VerdictName`
  - `statusesBlock(statuses: Array<{ id: string; class: string; reason?: string }>, prior: Array<{ id: string; path: string | null; line: number | null }>): string`
  - `parseCovered(diffU0: string): Map<string, Set<number>>`
  - `interface Texts { summary?: string; comments: Record<string, string> }`
  - `buildDraft(input: { selected: Finding[]; texts: Texts; verdict: VerdictName; approve: boolean; covered: Map<string, Set<number>>; capabilities: { inline: boolean; requestChanges: boolean } }): { draft: ReviewDraft; notes: string[] }`
  - `buildReplies(items: IntakeItem[], replies: Record<string, string>): Reply[]`

- [ ] **Step 1: Тесты**

`mod/run/review.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDraft, buildReplies, parseCovered, statusesBlock, verdictName } from './review.ts'
import type { Finding } from './findings.ts'
import type { IntakeItem } from '../status.ts'

const f = (id: string, severity: Finding['severity'], line = 3): Finding => ({ id, file: 'a.ts', line, severity, confidence: 90, problem: 'p' })
const CAPS = { inline: true, requestChanges: true }
const COVERED = new Map([['a.ts', new Set([3, 4])]])

test('verdictName: по серьёзности; open/partial прошлые — important', () => {
  assert.equal(verdictName([f('A-1', 'critical')]), 'Blocked')
  assert.equal(verdictName([f('A-1', 'important')]), 'Changes requested')
  assert.equal(verdictName([f('A-1', 'minor')]), 'Approved with comments')
  assert.equal(verdictName([]), 'Approved')
  assert.equal(verdictName([], [{ class: 'partial' }]), 'Changes requested')
  assert.equal(verdictName([], [{ class: 'closed' }]), 'Approved')
})

test('parseCovered: строки новых хунков по файлам', () => {
  const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +3,2 @@\n+x\n+y\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-z\n'
  assert.deepEqual([...parseCovered(diff)], [['a.ts', new Set([3, 4])]])
})

test('buildDraft: inline в diff, вне diff — в тело; request changes', () => {
  const { draft } = buildDraft({ selected: [f('A-1', 'important', 3), f('A-2', 'minor', 9)], texts: { summary: 'Итог', comments: { 'A-1': 'один', 'A-2': 'два' } }, verdict: 'Changes requested', approve: false, covered: COVERED, capabilities: CAPS })
  assert.deepEqual(draft, { verdict: 'request-changes', body: 'Итог\n\nВне diff:\n- a.ts:9 — два', comments: [{ path: 'a.ts', line: 3, body: 'один' }] })
})

test('buildDraft: approve только при одобряемом вердикте; без approve — комментарий', () => {
  assert.throws(() => buildDraft({ selected: [f('A-1', 'important')], texts: { comments: { 'A-1': 'x' } }, verdict: 'Changes requested', approve: true, covered: COVERED, capabilities: CAPS }), /одобрение при вердикте Changes requested невозможно/)
  assert.equal(buildDraft({ selected: [], texts: { comments: {} }, verdict: 'Approved', approve: true, covered: COVERED, capabilities: CAPS }).draft.verdict, 'approve')
  assert.deepEqual(buildDraft({ selected: [], texts: { comments: {} }, verdict: 'Approved', approve: false, covered: COVERED, capabilities: CAPS }).draft, { verdict: 'comment', body: 'Замечаний нет.', comments: [] })
})

test('buildDraft: пустое тело request changes — текст по умолчанию', () => {
  assert.equal(buildDraft({ selected: [f('A-1', 'critical')], texts: { comments: { 'A-1': 'x' } }, verdict: 'Blocked', approve: false, covered: COVERED, capabilities: CAPS }).draft.body, 'Нужны правки — см. комментарии.')
})

test('buildDraft: система без request changes и без inline — комментарий, всё в теле, заметки', () => {
  const { draft, notes } = buildDraft({ selected: [f('A-1', 'important')], texts: { comments: { 'A-1': 'x' } }, verdict: 'Changes requested', approve: false, covered: COVERED, capabilities: { inline: false, requestChanges: false } })
  assert.deepEqual(draft, { verdict: 'comment', body: 'Вне diff:\n- a.ts:3 — x', comments: [] })
  assert.equal(notes.length, 2)
})

test('buildDraft: нет текста для находки — ошибка', () => {
  assert.throws(() => buildDraft({ selected: [f('A-1', 'minor')], texts: { comments: {} }, verdict: 'Approved with comments', approve: false, covered: COVERED, capabilities: CAPS }), /нет текста для: A-1/)
})

test('statusesBlock: счёт и строки', () => {
  const text = statusesBlock([{ id: 'r/1', class: 'closed' }, { id: 'r/2', class: 'open', reason: 'нет' }, { id: 'review/r', class: 'unknown' }], [{ id: 'r/1', path: 'a.ts', line: 3 }, { id: 'r/2', path: 'b.ts', line: 1 }, { id: 'review/r', path: null, line: null }])
  assert.equal(text, 'Прошлые замечания: закрыто 1, не закрыто 1, частично 0.\n- b.ts:1 — не закрыто: нет\n- общее — не проверено: ')
})

test('buildReplies: тред/общий, цитата — первая строка до 200, маркер, пустые пропускаются, неизвестный id — ошибка', () => {
  const items: IntakeItem[] = [
    { id: 'r1/c1', kind: 'thread', reviewId: 'r1', threadId: 'r1:a.ts:3', path: 'a.ts', position: 3, commitId: 'h', author: 'carol', quote: 'carol: x', stale: false, disagree: false },
    { id: 'issue/9', kind: 'issue', reviewId: null, threadId: null, path: null, position: null, commitId: '', author: 'dave', quote: `${'я'.repeat(250)}\nвторая`, stale: false, disagree: false },
  ]
  const replies = buildReplies(items, { 'r1/c1': ' Сделано ', 'issue/9': 'Ответ', })
  assert.deepEqual(replies[0], { threadId: 'r1:a.ts:3', body: 'Сделано\n\n<!-- review-kit -->' })
  assert.equal(replies[1].quote, 'я'.repeat(200))
  assert.equal(buildReplies(items, { 'r1/c1': '   ' }).length, 0)
  assert.throws(() => buildReplies(items, { nope: 'x' }), /нет пункта для ответа: nope/)
})
```

- [ ] **Step 2: Запустить — падает** (`Cannot find module '.../mod/run/review.ts'`).

- [ ] **Step 3: Создать `mod/run/review.ts`** (перенос `review_payload.py` и `replies.py`; маппинг на состояния системы — в адаптере)

```ts
import type { Reply, ReviewDraft } from '../forge/types.ts'
import { MARKER, type IntakeItem } from '../status.ts'
import type { Finding } from './findings.ts'

/** вердикты, которые можно опубликовать одобрением */
const APPROVABLE: readonly VerdictName[] = ['Approved', 'Approved with comments']
/** тело request changes, когда текста нет */
const DEFAULT_CHANGES_BODY = 'Нужны правки — см. комментарии.'
/** тело пустого ревью-комментария */
const DEFAULT_EMPTY_BODY = 'Замечаний нет.'
/** незакрытые прошлые замечания — считаются important */
const UNRESOLVED = ['open', 'partial']
/** слова статусов в блоке прошлых замечаний */
const STATUS_WORDS: Record<string, string> = { open: 'не закрыто', partial: 'частично', unknown: 'не проверено' }
/** длина цитаты в общем ответе */
const QUOTE_LIMIT = 200
/** заголовок нового хунка diff -U0 */
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

/** вердикт отчёта */
export type VerdictName = 'Blocked' | 'Changes requested' | 'Approved with comments' | 'Approved'

/** тексты ревью, которые согласовал пользователь */
export interface Texts {
  /** общий текст */
  summary?: string
  /** текст комментария по id находки */
  comments: Record<string, string>
}

/** вердикт по находкам и незакрытым прошлым замечаниям */
export function verdictName(findings: Array<{ severity: string }>, statuses: Array<{ class: string; severity?: string }> = []): VerdictName {
  const levels = new Set([...findings.map(item => item.severity), ...statuses.filter(s => UNRESOLVED.includes(s.class)).map(s => s.severity ?? 'important')])
  if (levels.has('critical')) return 'Blocked'
  if (levels.has('important')) return 'Changes requested'
  return levels.size ? 'Approved with comments' : 'Approved'
}

/** блок «Прошлые замечания» для тела ревью перепроверки */
export function statusesBlock(statuses: Array<{ id: string; class: string; reason?: string }>, prior: Array<{ id: string; path: string | null; line: number | null }>): string {
  const place = new Map(prior.map(p => [p.id, p.path ? `${p.path}:${p.line}` : 'общее']))
  const count = (name: string) => statuses.filter(s => s.class === name).length
  const lines = statuses.filter(s => s.class in STATUS_WORDS).map(s => `- ${place.get(s.id) ?? s.id} — ${STATUS_WORDS[s.class]}: ${s.reason ?? ''}`)
  return [`Прошлые замечания: закрыто ${count('closed')}, не закрыто ${count('open')}, частично ${count('partial')}.`, ...lines].join('\n')
}

/** строки новых версий файлов, попавшие в хунки diff -U0 */
export function parseCovered(diffU0: string): Map<string, Set<number>> {
  const covered = new Map<string, Set<number>>()
  const state: { file: string | null } = { file: null }
  for (const line of diffU0.split('\n')) {
    if (line.startsWith('+++ ')) state.file = line === '+++ /dev/null' ? null : line.slice('+++ b/'.length)
    const hunk = HUNK.exec(line)
    if (hunk && state.file) {
      const start = Number(hunk[1])
      const length = hunk[2] === undefined ? 1 : Number(hunk[2])
      const lines = covered.get(state.file) ?? new Set<number>()
      for (let n = start; n < start + length; n++) lines.add(n)
      covered.set(state.file, lines)
    }
  }
  return covered
}

/** ревью к публикации: вердикт → состояние общей модели, inline только в diff, тело по умолчанию */
export function buildDraft({ selected, texts, verdict, approve, covered, capabilities }: { selected: Finding[]; texts: Texts; verdict: VerdictName; approve: boolean; covered: Map<string, Set<number>>; capabilities: { inline: boolean; requestChanges: boolean } }): { draft: ReviewDraft; notes: string[] } {
  if (approve && !APPROVABLE.includes(verdict)) throw new Error(`одобрение при вердикте ${verdict} невозможно`)
  const missing = selected.filter(item => !(item.id in texts.comments)).map(item => item.id)
  if (missing.length) throw new Error(`нет текста для: ${missing.join(', ')}`)
  const notes: string[] = []
  const wantsChanges = !approve && !APPROVABLE.includes(verdict)
  if (wantsChanges && !capabilities.requestChanges) notes.push('система не умеет «запросить изменения» — ревью опубликовано комментарием')
  if (!capabilities.inline && selected.length) notes.push('система не умеет комментарии к строкам — все комментарии в теле ревью')
  const inline = capabilities.inline ? selected.filter(item => covered.get(item.file)?.has(item.line)) : []
  const outside = selected.filter(item => !inline.includes(item))
  const parts = [(texts.summary ?? '').trim(), ...(outside.length ? [`Вне diff:\n${outside.map(item => `- ${item.file}:${item.line} — ${texts.comments[item.id]}`).join('\n')}`] : [])]
  const body = parts.filter(Boolean).join('\n\n')
  const comments = inline.map(item => ({ path: item.file, line: item.line, body: texts.comments[item.id] }))
  const draftVerdict = approve ? 'approve' : wantsChanges && capabilities.requestChanges ? 'request-changes' : 'comment'
  const finalBody = body || (draftVerdict === 'request-changes' ? DEFAULT_CHANGES_BODY : !comments.length && draftVerdict !== 'approve' ? DEFAULT_EMPTY_BODY : '')
  return { draft: { verdict: draftVerdict, body: finalBody, comments }, notes }
}

/** ответы к публикации: в тред или общим комментарием с цитатой; с маркером review-kit */
export function buildReplies(items: IntakeItem[], replies: Record<string, string>): Reply[] {
  const byId = new Map(items.map(item => [item.id, item]))
  const unknown = Object.keys(replies).filter(id => !byId.has(id))
  if (unknown.length) throw new Error(`нет пункта для ответа: ${unknown.join(', ')}`)
  return Object.entries(replies).filter(([, text]) => text.trim()).map(([id, text]) => {
    const item = byId.get(id) as IntakeItem
    const body = `${text.trim()}\n\n${MARKER}`
    return item.threadId ? { threadId: item.threadId, body } : { quote: item.quote.split('\n')[0].slice(0, QUOTE_LIMIT), body }
  })
}
```

Решение: общий ответ при пустой цитате всё равно содержит строку `> ` — исправляется в адаптере (Task 3c.4 Step 1).

- [ ] **Step 4: Запустить — проходит**: `node --test mod/run/review.test.ts` → `pass 9`, `fail 0`.

---

### Task 3c.2: `mod/git.ts` — переключение на PR и проверка настроек Claude Code

**Files:**
- Modify: `mod/git.ts`
- Test: `mod/git.test.ts`, `mod/testing/repo.ts` (добавить `origin`)

**Interfaces:**
- Produces:
  - `CLAUDE_CODE_PATHS: readonly string[]`, `claudeCodeChanges(changed: string[]): string[]`
  - `interface SwitchInput { number: number; headRef: string; headSha: string; baseRef: string; own: boolean; pullRef: string }`
  - `interface SwitchPlan { target: string; final: string; base: string; detached: boolean; baseFallback: boolean; headRef: string; own: boolean }`
  - `planSwitch(run: Run, input: SwitchInput): Promise<SwitchPlan>` — всё скачивает и считает, дерево не трогает
  - `applySwitch(run: Run, plan: SwitchPlan): Promise<{ head: string; base: string; detached: boolean; baseFallback: boolean }>`
  - `isAncestor(run, a, b): Promise<boolean>`

- [ ] **Step 1: Помощник `origin` в `mod/testing/repo.ts`**

В возвращаемый объект `repo()` добавить:

```ts
  /** голый origin рядом: push веток и refs/pull/N/head */
  const origin = () => {
    const bare = mkdtempSync(join(tmpdir(), 'rk-origin-'))
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
    git('remote', 'add', 'origin', bare)
    return bare
  }
```

и `origin` — в объект и в тип возврата (`origin: () => string`).

- [ ] **Step 2: Тесты** (дописать в `mod/git.test.ts`)

```ts
import { applySwitch, claudeCodeChanges, planSwitch } from './git.ts'

test('claudeCodeChanges: настройки Claude Code на любой глубине', () => {
  assert.deepEqual(claudeCodeChanges(['src/a.ts', '.claude/settings.json', 'pkg/.mcp.json', 'x/CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude-plugin/plugin.json', 'docs/claude.md']),
    ['.claude/settings.json', 'pkg/.mcp.json', 'x/CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude-plugin/plugin.json'])
})

const SWITCH = { number: 7, headRef: 'feat', baseRef: 'main', own: false, pullRef: 'refs/pull/7/head' }

test('planSwitch + applySwitch: чужая ветка — локальная копия origin, база — merge-base', async () => {
  const r = repo(); r.origin()
  const base = r.commit('a.txt', '1', 'base'); r.git('push', '-q', 'origin', 'main')
  r.git('switch', '-qc', 'feat'); const head = r.commit('a.txt', '2', 'pr'); r.git('push', '-q', 'origin', 'feat')
  r.git('switch', '-q', 'main'); r.git('branch', '-qD', 'feat')
  const plan = await planSwitch(r.run, { ...SWITCH, headSha: head })
  assert.deepEqual([plan.target, plan.base, plan.detached, plan.baseFallback], [head, base, false, false])
  assert.equal(r.git('rev-parse', 'HEAD'), base)
  assert.deepEqual(await applySwitch(r.run, plan), { head, base, detached: false, baseFallback: false })
  assert.equal(r.git('branch', '--show-current'), 'feat')
})

test('ветки на origin нет — голова через refs/pull/N/head, detached', async () => {
  const r = repo(); r.origin()
  r.commit('a.txt', '1', 'base'); r.git('push', '-q', 'origin', 'main')
  r.git('switch', '-qc', 'tmp'); const head = r.commit('a.txt', '2', 'fork pr'); r.git('push', '-q', 'origin', 'HEAD:refs/pull/7/head')
  r.git('switch', '-q', 'main'); r.git('branch', '-qD', 'tmp')
  const switched = await applySwitch(r.run, await planSwitch(r.run, { ...SWITCH, headSha: head }))
  assert.deepEqual([switched.head, switched.detached], [head, true])
})

test('голова не совпала ни с веткой, ни с refs/pull — ошибка', async () => {
  const r = repo(); r.origin()
  r.commit('a.txt', '1', 'base'); r.git('push', '-q', 'origin', 'main')
  await assert.rejects(planSwitch(r.run, { ...SWITCH, headSha: 'f'.repeat(40) }), /на сервере нет ни ветки feat, ни refs\/pull\/7\/head/)
})

test('своя ветка разошлась с origin — ошибка; базовой ветки нет — от main', async () => {
  const r = repo(); r.origin()
  r.commit('a.txt', '1', 'base'); r.git('push', '-q', 'origin', 'main')
  r.git('switch', '-qc', 'feat'); const pushed = r.commit('a.txt', '2', 'pr'); r.git('push', '-q', 'origin', 'feat')
  r.git('reset', '-q', '--hard', 'HEAD^'); r.commit('a.txt', '3', 'local only')
  r.git('switch', '-q', 'main')
  await assert.rejects(planSwitch(r.run, { ...SWITCH, own: true, headSha: pushed }), /своя ветка feat разошлась с origin/)
  const plan = await planSwitch(r.run, { ...SWITCH, baseRef: 'gone', headSha: pushed })
  assert.equal(plan.baseFallback, true)
})

test('applySwitch: в дереве изменены отслеживаемые файлы — ошибка до переключения', async () => {
  const r = repo(); r.origin()
  r.commit('a.txt', '1', 'base'); r.git('push', '-q', 'origin', 'main')
  r.git('switch', '-qc', 'feat'); const head = r.commit('a.txt', '2', 'pr'); r.git('push', '-q', 'origin', 'feat'); r.git('switch', '-q', 'main')
  const plan = await planSwitch(r.run, { ...SWITCH, headSha: head })
  writeFileSync(join(r.dir, 'a.txt'), 'грязно')
  await assert.rejects(applySwitch(r.run, plan), /изменены отслеживаемые файлы/)
})
```

- [ ] **Step 3: Запустить — падает** (нет экспорта `planSwitch`).

- [ ] **Step 4: Реализация** (дописать в `mod/git.ts`)

```ts
/** файлы, которые Claude Code исполняет или подгружает: папки и имена на любой глубине */
export const CLAUDE_CODE_PATHS: readonly string[] = ['.claude/', '.claude-plugin/', '.mcp.json', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']

/** изменённые пути, попадающие под CLAUDE_CODE_PATHS */
export function claudeCodeChanges(changed: string[]): string[] {
  const dirs = CLAUDE_CODE_PATHS.filter(item => item.endsWith('/')).map(item => item.slice(0, -1))
  const names = CLAUDE_CODE_PATHS.filter(item => !item.endsWith('/'))
  return changed.filter(path => {
    const parts = path.split('/')
    return parts.slice(0, -1).some(part => dirs.includes(part)) || names.includes(parts[parts.length - 1])
  })
}

/** вход переключения на PR */
export interface SwitchInput {
  /** номер PR */
  number: number
  /** ветка PR */
  headRef: string
  /** ожидаемая голова */
  headSha: string
  /** базовая ветка */
  baseRef: string
  /** свой PR */
  own: boolean
  /** ссылка на голову PR у системы (для форков) */
  pullRef: string
}

/** что сделать с деревом: всё скачано и посчитано, дерево ещё не тронуто */
export interface SwitchPlan {
  /** голова PR */
  target: string
  /** куда встанет HEAD (своя ветка может быть впереди origin) */
  final: string
  /** база ревью */
  base: string
  /** голова только через pullRef */
  detached: boolean
  /** база взята от main: базовой ветки на сервере нет */
  baseFallback: boolean
  /** ветка PR */
  headRef: string
  /** свой PR */
  own: boolean
}

/** a — предок b */
export async function isAncestor(run: Run, a: string, b: string): Promise<boolean> {
  return (await run(['git', 'merge-base', '--is-ancestor', a, b])).exitCode === 0
}

/** ref существует */
async function hasRef(run: Run, ref: string): Promise<boolean> {
  return (await run(['git', 'rev-parse', '-q', '--verify', ref])).exitCode === 0
}

/** worktree, где выписана ветка, или '' */
function holderOf(porcelain: string, branch: string): string {
  const rows = porcelain.split('\n')
  const at = rows.indexOf(`branch refs/heads/${branch}`)
  if (at < 0) return ''
  return rows.slice(0, at).reverse().find(line => line.startsWith('worktree '))?.slice('worktree '.length) ?? ''
}

/** голова PR: ветка на origin или pullRef (тогда detached) */
async function fetchHead(run: Run, input: SwitchInput): Promise<{ target: string; detached: boolean }> {
  const remote = await run(['git', 'ls-remote', '--exit-code', 'origin', `refs/heads/${input.headRef}`])
  if (remote.exitCode === 0) await gitText(run, ['fetch', '-q', 'origin', `+refs/heads/${input.headRef}:refs/remotes/origin/${input.headRef}`])
  else await run(['git', 'update-ref', '-d', `refs/remotes/origin/${input.headRef}`])
  const branchTip = remote.exitCode === 0 ? (await gitText(run, ['rev-parse', `origin/${input.headRef}`])).trim() : ''
  if (branchTip === input.headSha) return { target: branchTip, detached: false }
  const pulled = await run(['git', 'fetch', '-q', 'origin', input.pullRef])
  if (pulled.exitCode !== 0) throw new Error(`на сервере нет ни ветки ${input.headRef}, ни ${input.pullRef}`)
  const target = (await gitText(run, ['rev-parse', 'FETCH_HEAD'])).trim()
  if (target !== input.headSha) throw new Error(`PR ${input.number} изменился во время подготовки (ожидался ${input.headSha})`)
  return { target, detached: true }
}

/** куда встанет своя ветка: локальная, если она впереди origin; разошлись — ошибка */
async function ownFinal(run: Run, headRef: string, target: string): Promise<string> {
  if (!(await hasRef(run, `refs/heads/${headRef}`))) return target
  const local = (await gitText(run, ['rev-parse', `refs/heads/${headRef}`])).trim()
  if (await isAncestor(run, target, local)) return local
  if (!(await isAncestor(run, local, target))) throw new Error(`своя ветка ${headRef} разошлась с origin — разберитесь вручную`)
  return target
}

/** база ревью уже влитого PR: родитель merge-коммита, который его принёс */
async function mergedBase(run: Run, final: string, baseTip: string): Promise<string> {
  const merges = (await gitText(run, ['rev-list', '--first-parent', '--merges', '--reverse', `${final}..${baseTip}`])).split('\n').filter(Boolean)
  for (const merge of merges) {
    if (await isAncestor(run, final, `${merge}^2`)) return (await gitText(run, ['merge-base', `${merge}^1`, final])).trim()
  }
  throw new Error(`PR уже в ${baseTip} без merge-коммита — базу ревью не определить`)
}

/** всё для переключения на PR, кроме самого переключения */
export async function planSwitch(run: Run, input: SwitchInput): Promise<SwitchPlan> {
  const busy = holderOf(await gitText(run, ['worktree', 'list', '--porcelain']), input.headRef)
  const root = (await gitText(run, ['rev-parse', '--show-toplevel'])).trim()
  if (busy && busy !== root) throw new Error(`ветка ${input.headRef} занята worktree ${busy}`)
  const { target, detached } = await fetchHead(run, input)
  const final = !detached && input.own ? await ownFinal(run, input.headRef, target) : target
  await run(['git', 'fetch', '-q', 'origin', `+refs/heads/${input.baseRef}:refs/remotes/origin/${input.baseRef}`])
  const hasBase = await hasRef(run, `refs/remotes/origin/${input.baseRef}`)
  if (!hasBase && (await run(['git', 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main'])).exitCode !== 0) {
    throw new Error(`на сервере нет ни ветки ${input.baseRef}, ни main`)
  }
  const baseTip = hasBase ? `origin/${input.baseRef}` : 'origin/main'
  const base = (await isAncestor(run, final, baseTip)) ? await mergedBase(run, final, baseTip) : (await gitText(run, ['merge-base', baseTip, final])).trim()
  return { target, final, base, detached, baseFallback: !hasBase, headRef: input.headRef, own: input.own }
}

/** переключает дерево по плану; дерево должно быть чистым */
export async function applySwitch(run: Run, plan: SwitchPlan): Promise<{ head: string; base: string; detached: boolean; baseFallback: boolean }> {
  if ((await gitText(run, ['status', '--porcelain', '-uno', '--ignore-submodules=all'])).trim()) throw new Error('в дереве изменены отслеживаемые файлы — сначала stash')
  const sw = async (...args: string[]) => {
    const result = await run(['git', 'switch', '-q', ...args])
    if (result.exitCode !== 0) throw new Error(`git switch не удался: ${result.stderr.trim()}`)
  }
  if (plan.detached) await sw('--detach', plan.target)
  else if (!plan.own) await sw('-C', plan.headRef, `origin/${plan.headRef}`)
  else if (!(await hasRef(run, `refs/heads/${plan.headRef}`))) await sw('-c', plan.headRef, `origin/${plan.headRef}`)
  else {
    await sw(plan.headRef)
    if ((await gitText(run, ['rev-parse', 'HEAD'])).trim() !== plan.final) await gitText(run, ['merge', '-q', '--ff-only', `origin/${plan.headRef}`])
  }
  return { head: (await gitText(run, ['rev-parse', 'HEAD'])).trim(), base: plan.base, detached: plan.detached, baseFallback: plan.baseFallback }
}
```

- [ ] **Step 5: Запустить — проходит**: `node --test mod/git.test.ts` → `pass 12`, `fail 0`.

---

### Task 3c.3: `mod/git.ts` — commit+push раунда и уборка

**Files:**
- Modify: `mod/git.ts`
- Test: `mod/git.test.ts`

**Interfaces:**
- Produces:
  - `messageProblem(message: string): string | undefined`
  - `type RoundState = 'commit' | 'push' | 'pushed'`
  - `roundState(run, { branch, roundBase, message }): Promise<{ state: RoundState; roundBase: string }>` (бросает при чужом коммите раунда)
  - `foreignChanges(run, paths: string[]): Promise<string[]>`
  - `commitRound(run, { paths, message }): Promise<{ ok: true } | { ok: false; output: string }>`
  - `pushRound(run, branch): Promise<{ ok: true } | { ok: false; rejected: boolean; output: string }>`
  - `unpushed(run, branch): Promise<string[]>`
  - `STASH_PREFIX = 'review-kit:'`; `reviewStashes(run): Promise<Array<{ sha: string; message: string; branch: string }>>`; `stashAction(run, sha, action: 'apply' | 'drop'): Promise<{ ok: boolean; conflict?: boolean; error?: string }>`
  - `branchCandidates(run, { open: PullRequest[]; closed: PullRequest[]; me: string }): Promise<Array<{ name: string; kind: 'pr' | 'no-pr'; reason: string }>>`
  - `deleteBranches(run, names: string[]): Promise<{ deleted: string[]; skipped: Array<{ name: string; reason: string }> }>`
  - `type IsActive = (path: string, pr: number) => Promise<boolean>`; `interface ReviewWorktree { path: string; pr: number; branch: string; active: boolean; dirty: boolean }`
  - `reviewWorktrees(run, isActive): Promise<ReviewWorktree[]>`; `inMainTree(run): Promise<boolean>`
  - `worktreeCandidates(run, { open, me, isActive }): Promise<Array<{ path: string; pr: number; branch: string; deleteBranch: boolean }>>`
  - `holder(run, branch, isActive): Promise<ReviewWorktree | null>`
  - `removeWorktrees(run, paths, { confirmed, isActive }): Promise<{ removed: string[]; skipped: Array<{ path: string; reason: string }> }>`

- [ ] **Step 1: Тесты** (дописать в `mod/git.test.ts`)

```ts
import { branchCandidates, commitRound, deleteBranches, foreignChanges, messageProblem, pushRound, reviewStashes, roundState, stashAction } from './git.ts'

function ownRound() {
  const r = repo(); r.origin()
  r.commit('a.txt', '1', 'base'); r.git('push', '-q', 'origin', 'main')
  r.git('switch', '-qc', 'feat'); r.commit('a.txt', '2', 'pr'); r.git('push', '-q', '-u', 'origin', 'feat')
  return { r, roundBase: r.git('rev-parse', 'HEAD') }
}

test('messageProblem: одна непустая строка без пробелов по краям; кавычки и $ можно', () => {
  assert.equal(messageProblem('fix: "a" $b `c` \\d'), undefined)
  assert.match(messageProblem('a\nb') ?? '', /одна строка/)
  assert.match(messageProblem(' a') ?? '', /пробел/)
  assert.match(messageProblem('') ?? '', /пустое/)
})

test('раунд: commit → push; повтор после упавшего push только пушит; уже на origin — pushed', async () => {
  const { r, roundBase } = ownRound()
  writeFileSync(join(r.dir, 'a.txt'), '3')
  assert.equal((await roundState(r.run, { branch: 'feat', roundBase, message: 'fix: x' })).state, 'commit')
  assert.deepEqual(await foreignChanges(r.run, ['a.txt']), [])
  assert.deepEqual(await commitRound(r.run, { paths: ['a.txt'], message: 'fix: x' }), { ok: true })
  assert.equal((await roundState(r.run, { branch: 'feat', roundBase, message: 'fix: x' })).state, 'push')
  await assert.rejects(roundState(r.run, { branch: 'feat', roundBase, message: 'другое' }), /коммит раунда уже есть с сообщением «fix: x»/)
  assert.deepEqual(await pushRound(r.run, 'feat'), { ok: true })
  assert.equal((await roundState(r.run, { branch: 'feat', roundBase, message: 'fix: x' })).state, 'pushed')
})

test('файлы вне списка и пустой раунд', async () => {
  const { r } = ownRound()
  writeFileSync(join(r.dir, 'a.txt'), '3'); writeFileSync(join(r.dir, 'b.txt'), 'new'); r.git('add', 'b.txt')
  assert.deepEqual(await foreignChanges(r.run, ['a.txt']), ['b.txt'])
  r.git('reset', '-q', 'b.txt')
  const empty = repo(); empty.commit('a.txt', '1', 'base')
  assert.deepEqual(await commitRound(empty.run, { paths: ['a.txt'], message: 'm' }), { ok: false, output: 'в подтверждённых путях нечего коммитить' })
  assert.deepEqual(await commitRound(empty.run, { paths: [], message: 'm' }), { ok: false, output: 'нет путей раунда — коммитить нечего' })
})

test('pre-commit упал — коммита нет, вывод хука возвращается', async () => {
  const { r, roundBase } = ownRound()
  writeFileSync(join(r.dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint: a.txt плохо"\nexit 1\n', { mode: 0o755 })
  writeFileSync(join(r.dir, 'a.txt'), '3')
  const result = await commitRound(r.run, { paths: ['a.txt'], message: 'fix: x' })
  assert.equal(result.ok, false)
  assert.match((result as { output: string }).output, /lint: a.txt плохо/)
  assert.equal(r.git('rev-parse', 'HEAD'), roundBase)
})

test('non-fast-forward отличается от сети; после rebase roundBase пересчитывается и раунд только пушится', async () => {
  const { r, roundBase } = ownRound()
  const other = repo(); other.git('remote', 'add', 'origin', r.git('remote', 'get-url', 'origin')); other.git('fetch', '-q', 'origin'); other.git('switch', '-q', 'feat')
  other.commit('c.txt', 'чужое', 'чужой коммит'); other.git('push', '-q', 'origin', 'feat')
  writeFileSync(join(r.dir, 'a.txt'), '3')
  await commitRound(r.run, { paths: ['a.txt'], message: 'fix: x' })
  const pushed = await pushRound(r.run, 'feat')
  assert.deepEqual([pushed.ok, (pushed as { rejected: boolean }).rejected], [false, true])
  r.git('pull', '-q', '--rebase', 'origin', 'feat')
  const state = await roundState(r.run, { branch: 'feat', roundBase, message: 'fix: x' })
  assert.equal(state.state, 'push')
  assert.notEqual(state.roundBase, roundBase)
})

test('push упал по сети (не non-ff) — повтор только пушит, второго коммита нет', async () => {
  const { r, roundBase } = ownRound()
  const url = r.git('remote', 'get-url', 'origin')
  writeFileSync(join(r.dir, 'a.txt'), '3')
  await commitRound(r.run, { paths: ['a.txt'], message: 'fix: x' })
  r.git('remote', 'set-url', 'origin', '/nonexistent/review-kit-origin')
  const failed = await pushRound(r.run, 'feat')
  assert.deepEqual([failed.ok, (failed as { rejected: boolean }).rejected], [false, false])
  r.git('remote', 'set-url', 'origin', url)
  assert.equal((await roundState(r.run, { branch: 'feat', roundBase, message: 'fix: x' })).state, 'push')
  assert.deepEqual(await pushRound(r.run, 'feat'), { ok: true })
  assert.equal(r.git('rev-list', '--count', `${roundBase}..HEAD`), '1')
})

test('уборка: ветка с непушнутыми коммитами не кандидат; review-stash находится и применяется', async () => {
  const { r } = ownRound()
  r.git('switch', '-q', 'main'); r.git('switch', '-qc', 'local-only'); r.commit('z.txt', 'z', 'не на origin'); r.git('switch', '-q', 'main')
  const candidates = await branchCandidates(r.run, { open: [], closed: [], me: 'alice' })
  assert.deepEqual(candidates.map(c => [c.name, c.kind]), [['feat', 'no-pr']])
  assert.deepEqual((await deleteBranches(r.run, ['local-only'])).skipped, [{ name: 'local-only', reason: 'есть коммиты, которых нет на origin' }])
  writeFileSync(join(r.dir, 'a.txt'), 'wip'); r.git('stash', 'push', '-q', '-m', 'review-kit: pr-7 test')
  const [stash] = await reviewStashes(r.run)
  assert.deepEqual([stash.message, stash.branch], ['review-kit: pr-7 test', 'main'])
  assert.deepEqual(await stashAction(r.run, stash.sha, 'apply'), { ok: true })
  assert.equal(r.git('stash', 'list'), '')
})
```

- [ ] **Step 2: Запустить — падает** (нет экспорта `messageProblem`).

- [ ] **Step 3: Реализация** (дописать в `mod/git.ts`; импорт `import type { PullRequest } from './forge/types.ts'` в начало)

```ts
/** префикс stash, которые создаёт review-kit */
export const STASH_PREFIX = 'review-kit:'
/** базовая ветка, которую уборка не трогает */
const BASE_BRANCH = 'main'
/** имя worktree ревью: pr-<N>-<ветка> */
const REVIEW_WORKTREE = /^pr-(\d+)-/

/** где в раунде: нужно коммитить, коммит есть и не на origin, всё отправлено */
export type RoundState = 'commit' | 'push' | 'pushed'
/** прогон в worktree активен */
export type IsActive = (path: string, pr: number) => Promise<boolean>

/** worktree законченного или идущего ревью */
export interface ReviewWorktree {
  /** путь */
  path: string
  /** номер PR */
  pr: number
  /** выписанная ветка ('' — detached) */
  branch: string
  /** прогон идёт */
  active: boolean
  /** есть изменения */
  dirty: boolean
}

/** причина отклонить сообщение коммита или undefined */
export function messageProblem(message: string): string | undefined {
  if (/[\r\n]/.test(message)) return 'сообщение — одна строка, без переводов строки'
  if (!message.trim()) return 'сообщение пустое'
  if (message !== message.trim()) return 'пробел в начале или в конце сообщения — git его срежет, и повтор не узнает коммит'
  return undefined
}

/** состояние раунда; roundBase пересчитывается (merge-base с origin), если HEAD не стоит на нём или прямо над ним — так после rebase */
export async function roundState(run: Run, { branch, roundBase, message }: { branch: string; roundBase: string; message: string }): Promise<{ state: RoundState; roundBase: string }> {
  await run(['git', 'fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
  const head = (await gitText(run, ['rev-parse', 'HEAD'])).trim()
  const parent = (await run(['git', 'rev-parse', '-q', '--verify', 'HEAD^'])).stdout.trim()
  const base = head === roundBase || parent === roundBase ? roundBase : (await gitText(run, ['merge-base', 'HEAD', `origin/${branch}`])).trim()
  if (head === base) return { state: 'commit', roundBase: base }
  const subject = (await gitText(run, ['log', '-1', '--format=%s'])).trim()
  if (parent !== base) throw new Error(`HEAD ${head.slice(0, 7)} не продолжает базу раунда ${base.slice(0, 7)} одним коммитом`)
  if (subject !== message) throw new Error(`коммит раунда уже есть с сообщением «${subject}» — передайте его же`)
  return { state: (await isAncestor(run, 'HEAD', `origin/${branch}`)) ? 'pushed' : 'push', roundBase: base }
}

/** изменённые отслеживаемые файлы вне списка раунда (и в индексе, и в дереве) */
export async function foreignChanges(run: Run, paths: string[]): Promise<string[]> {
  const changed = (await gitText(run, ['diff', '--name-only', 'HEAD'])).split('\n').filter(Boolean)
  return changed.filter(path => !paths.includes(path))
}

/** коммит путей раунда; pre-commit проекта срабатывает сам, его вывод возвращается при отказе */
export async function commitRound(run: Run, { paths, message }: { paths: string[]; message: string }): Promise<{ ok: true } | { ok: false; output: string }> {
  if (paths.length === 0) return { ok: false, output: 'нет путей раунда — коммитить нечего' }
  const glob = paths.find(path => /^:|[*?[]/.test(path))
  if (glob) return { ok: false, output: `путь ${glob} — pathspec или glob, нужен путь к файлу` }
  await gitText(run, ['add', '-A', '--', ...paths])
  const staged = (await gitText(run, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean)
  const extra = staged.filter(path => !paths.includes(path))
  if (extra.length) {
    await run(['git', 'reset', '-q', '--', ...paths])
    return { ok: false, output: `в индексе есть файлы вне подтверждённого списка (их staging не тронут):\n${extra.join('\n')}` }
  }
  if (staged.length === 0) return { ok: false, output: 'в подтверждённых путях нечего коммитить' }
  const committed = await run(['git', 'commit', '-q', '-m', message])
  return committed.exitCode === 0 ? { ok: true } : { ok: false, output: `${committed.stdout}${committed.stderr}`.trim() }
}

/** push без force; отказ из-за чужих коммитов отличается от сети */
export async function pushRound(run: Run, branch: string): Promise<{ ok: true } | { ok: false; rejected: boolean; output: string }> {
  const pushed = await run(['git', 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`])
  if (pushed.exitCode === 0) return { ok: true }
  const output = pushed.stderr.trim()
  return { ok: false, rejected: /\[rejected\]|non-fast-forward|fetch first|Updates were rejected/.test(output), output }
}

/** коммиты ветки, которых нет на origin */
export async function unpushed(run: Run, branch: string): Promise<string[]> {
  const range = (await run(['git', 'rev-parse', '-q', '--verify', `origin/${branch}`])).exitCode === 0 ? `origin/${branch}..HEAD` : 'HEAD'
  return (await gitText(run, ['log', '--oneline', range])).split('\n').filter(Boolean)
}

/** stash review-kit с веткой, из которой сделаны */
export async function reviewStashes(run: Run): Promise<Array<{ sha: string; message: string; branch: string }>> {
  return (await gitText(run, ['stash', 'list', '--format=%H\t%gs'])).split('\n').filter(Boolean).flatMap(line => {
    const [sha, subject = ''] = line.split('\t')
    const at = subject.indexOf(': ')
    const message = at >= 0 ? subject.slice(at + 2) : ''
    if (!message.startsWith(STASH_PREFIX)) return []
    const branch = subject.slice(0, at).replace(/^WIP on /, '').replace(/^On /, '').trim()
    return [{ sha, message, branch: branch === '(no branch)' ? '' : branch }]
  })
}

/** применить (pop) или удалить stash по sha */
export async function stashAction(run: Run, sha: string, action: 'apply' | 'drop'): Promise<{ ok: boolean; conflict?: boolean; error?: string }> {
  const index = (await gitText(run, ['stash', 'list', '--format=%H'])).split('\n').indexOf(sha)
  if (index < 0) return { ok: false, error: 'stash уже не найден' }
  const result = await run(['git', 'stash', action === 'apply' ? 'pop' : 'drop', `stash@{${index}}`])
  if (result.exitCode === 0) return { ok: true }
  const unmerged = (await gitText(run, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean)
  return unmerged.length ? { ok: false, conflict: true, error: `применён с конфликтом в: ${unmerged.join(', ')}; stash сохранён` } : { ok: false, error: `${result.stderr}${result.stdout}`.trim() }
}

/** все коммиты ref есть на origin */
async function allOnOrigin(run: Run, ref: string): Promise<boolean> {
  return (await gitText(run, ['rev-list', ref, '--not', '--remotes=origin'])).trim() === ''
}

/** ветки, выписанные в каком-либо worktree */
async function busyBranches(run: Run): Promise<Set<string>> {
  return new Set((await gitText(run, ['worktree', 'list', '--porcelain'])).split('\n').filter(line => line.startsWith('branch refs/heads/')).map(line => line.slice('branch refs/heads/'.length)))
}

/** локальные ветки, которые можно удалить: всё на origin, не своя открытая, не занята, не main */
export async function branchCandidates(run: Run, { open, closed, me }: { open: PullRequest[]; closed: PullRequest[]; me: string }): Promise<Array<{ name: string; kind: 'pr' | 'no-pr'; reason: string }>> {
  await run(['git', 'fetch', '-q', 'origin', '--prune'])
  const busy = await busyBranches(run)
  const names = (await gitText(run, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter(Boolean)
  const rows: Array<{ name: string; kind: 'pr' | 'no-pr'; reason: string }> = []
  for (const name of names) {
    if (name === BASE_BRANCH || busy.has(name) || !(await allOnOrigin(run, name))) continue
    const opened = open.find(pull => pull.headRef === name)
    const done = closed.find(pull => pull.headRef === name)
    if (opened && opened.author.toLowerCase() === me.toLowerCase()) continue
    if (opened) rows.push({ name, kind: 'pr', reason: `чужой открытый PR #${opened.number} — коммиты на origin` })
    else if (done) rows.push({ name, kind: 'pr', reason: `PR #${done.number} ${done.merged ? 'влит' : 'закрыт'} — коммиты на origin` })
    else rows.push({ name, kind: 'no-pr', reason: 'PR нет среди последних — коммиты на origin' })
  }
  return rows
}

/** удаляет ветки, только если они не заняты и всё на origin */
export async function deleteBranches(run: Run, names: string[]): Promise<{ deleted: string[]; skipped: Array<{ name: string; reason: string }> }> {
  const busy = await busyBranches(run)
  const deleted: string[] = []
  const skipped: Array<{ name: string; reason: string }> = []
  for (const name of names) {
    if (name === BASE_BRANCH || busy.has(name)) skipped.push({ name, reason: 'ветка занята или базовая' })
    else if (!(await allOnOrigin(run, name))) skipped.push({ name, reason: 'есть коммиты, которых нет на origin' })
    else {
      const result = await run(['git', 'branch', '-D', name])
      if (result.exitCode === 0) deleted.push(name)
      else skipped.push({ name, reason: result.stderr.trim() })
    }
  }
  return { deleted, skipped }
}

/** worktree репозитория: путь и ветка; первый — основной */
async function worktrees(run: Run): Promise<Array<{ path: string; branch: string }>> {
  const rows: Array<{ path: string; branch: string }> = []
  for (const line of (await gitText(run, ['worktree', 'list', '--porcelain'])).split('\n')) {
    if (line.startsWith('worktree ')) rows.push({ path: line.slice('worktree '.length), branch: '' })
    else if (line.startsWith('branch refs/heads/') && rows.length) rows[rows.length - 1].branch = line.slice('branch refs/heads/'.length)
  }
  return rows
}

/** мы в основном дереве, а не во вкладке-worktree */
export async function inMainTree(run: Run): Promise<boolean> {
  const [main] = await worktrees(run)
  return (await gitText(run, ['rev-parse', '--show-toplevel'])).trim() === main?.path
}

/** worktree ревью в <основное дерево>/.claude/worktrees/pr-<N>-… */
export async function reviewWorktrees(run: Run, isActive: IsActive): Promise<ReviewWorktree[]> {
  const [main, ...rest] = await worktrees(run)
  const home = `${main.path}/.claude/worktrees`
  const found: ReviewWorktree[] = []
  for (const { path, branch } of rest) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    const match = REVIEW_WORKTREE.exec(name)
    if (path.slice(0, path.lastIndexOf('/')) !== home || !match) continue
    const pr = Number(match[1])
    const dirty = (await gitText(run, ['-C', path, 'status', '--porcelain', '--ignore-submodules=all'])).trim() !== ''
    found.push({ path, pr, branch, active: await isActive(path, pr), dirty })
  }
  return found
}

/** законченные чистые worktree ревью и судьба их веток */
export async function worktreeCandidates(run: Run, { open, me, isActive }: { open: PullRequest[]; me: string; isActive: IsActive }): Promise<Array<{ path: string; pr: number; branch: string; deleteBranch: boolean }>> {
  const rows: Array<{ path: string; pr: number; branch: string; deleteBranch: boolean }> = []
  for (const tree of await reviewWorktrees(run, isActive)) {
    if (tree.active || tree.dirty) continue
    const mineOpen = open.some(pull => pull.headRef === tree.branch && pull.author.toLowerCase() === me.toLowerCase())
    const deleteBranch = Boolean(tree.branch) && tree.branch !== BASE_BRANCH && !mineOpen && (await allOnOrigin(run, tree.branch))
    rows.push({ path: tree.path, pr: tree.pr, branch: tree.branch, deleteBranch })
  }
  return rows
}

/** чужой worktree ревью, в котором выписана ветка */
export async function holder(run: Run, branch: string, isActive: IsActive): Promise<ReviewWorktree | null> {
  const here = (await gitText(run, ['rev-parse', '--show-toplevel'])).trim()
  return (await reviewWorktrees(run, isActive)).find(tree => tree.branch === branch && tree.path !== here) ?? null
}

/** удаляет worktree ревью; без confirmed — только законченные и чистые */
export async function removeWorktrees(run: Run, paths: string[], { confirmed, isActive }: { confirmed: boolean; isActive: IsActive }): Promise<{ removed: string[]; skipped: Array<{ path: string; reason: string }> }> {
  const known = new Map((await reviewWorktrees(run, isActive)).map(tree => [tree.path, tree]))
  const removed: string[] = []
  const skipped: Array<{ path: string; reason: string }> = []
  for (const path of paths) {
    const tree = known.get(path)
    if (!tree) skipped.push({ path, reason: 'не worktree ревью' })
    else if (!confirmed && (tree.active || tree.dirty)) skipped.push({ path, reason: 'ревью идёт или есть изменения' })
    else {
      await gitText(run, ['worktree', 'remove', '--force', path])
      removed.push(path)
    }
  }
  return { removed, skipped }
}
```

Решения: ссылка на память проекта в worktree больше не создаётся (спека, `pr-tab`), поэтому `unlink_memory` 2.2 не переносится;
пути в `inMainTree`/`reviewWorktrees` сравниваются как их отдаёт git (realpath 2.2 — на WSL/macOS с симлинками путь может
отличаться; тогда `/pr cleanup` просто не предложит worktree — безопасная сторона).

- [ ] **Step 4: Запустить — проходит**: `node --test mod/git.test.ts` → `pass 19`, `fail 0`.

---

### Task 3c.4: Инструменты `review_publish`, `replies_publish`, `commit_push`; переключение и уборка через `git.ts`; без `review_confirm`

**Interfaces:**
- Consumes (этап 2, `mod/forge/types.ts` — есть): `ForgeProvider.pullRef(number)`, `ForgeProvider.capabilities`, `publishReview`, `publishReplies`, `listPulls`, `currentUser`; из 3c.1–3c.3 — всё перечисленное в их Produces.

**Files:**
- Modify: `mod/forge/forgejo.ts` (общий ответ без пустой цитаты), `mod/forge/forgejo.test.ts`
- Modify: `mod/register.ts`, `mod/policy.ts`, `types/index.d.ts`
- Test: `mod/policy.test.ts` (новый)
- Modify: `skills/pr-review-run/SKILL.md` (раздел 3), `skills/pr-recheck-run/SKILL.md` (шаг 5), `skills/pr-fix-run/SKILL.md` (шаг 7, «Replies»), `skills/pr-feedback-run/SKILL.md` (ссылки на «Replies»)
- Delete: `tools/forgejo.py`, `tools/review_payload.py`, `tools/replies.py`, `tools/switch-pr`, `tools/commit-push`, `tools/cleanup.py`

- [ ] **Step 1: Адаптер — пустая цитата** (`mod/forge/forgejo.test.ts` + `forgejo.ts`)

Тест:

```ts
test('publishReplies: пустая цитата — без строки «> »', async () => {
  const { instance, calls } = provider({ [`POST ${API}/issues/42/comments`]: ok('{}') })
  await instance.publishReplies(42, [{ quote: '', body: 'Ответ' }])
  assert.deepEqual(JSON.parse(calls[0].init?.body ?? ''), { body: 'Ответ' })
})
```

В `publishReplies` строку общего ответа заменить на:

```ts
          else await call('POST', `${repoPath}/issues/${number}/comments`, { body: reply.quote ? `> ${reply.quote}\n\n${reply.body}` : reply.body })
```

- [ ] **Step 2: `policy.ts` — только запрет сырых команд**

Тест `mod/policy.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyBash, guardText } from './policy.ts'

test('сырые git-команды и curl-запись распознаются, чтение — нет', () => {
  assert.equal(classifyBash('git commit -m x'), 'raw-commit')
  assert.equal(classifyBash('cd a && git push origin HEAD'), 'raw-push')
  assert.equal(classifyBash('git push --force'), 'raw-destructive')
  assert.equal(classifyBash('git commit --amend'), 'raw-destructive')
  assert.equal(classifyBash('git pull --rebase'), 'raw-destructive')
  assert.equal(classifyBash('git -c pull.rebase=true pull'), 'raw-destructive')
  assert.equal(classifyBash('git pull'), 'raw-destructive')
  assert.equal(classifyBash('git fetch origin'), 'other')
  assert.equal(classifyBash('git rebase main'), 'raw-destructive')
  assert.equal(classifyBash('curl -X POST https://x'), 'raw-write')
  assert.equal(classifyBash('git status && git log'), 'other')
  assert.equal(classifyBash("bash -c 'git push'"), 'raw-push')
})

test('guardText: что запрещено и чем пользоваться', () => {
  assert.match(guardText('raw-push') ?? '', /git push.*commit_push/)
  assert.equal(guardText('other'), undefined)
})
```

`mod/policy.ts` заменить целиком — остаются только разбор команд и текст отказа:

```ts
/** вид bash-команды для guard прогона */
export type BashKind = 'raw-commit' | 'raw-push' | 'raw-destructive' | 'raw-write' | 'other'

/** от худшего к безобидному */
const SEVERITY: readonly BashKind[] = ['raw-destructive', 'raw-push', 'raw-commit', 'raw-write', 'other']
/** префиксы, после которых идёт настоящая команда */
const COMMAND_PREFIXES = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'env', 'xargs', '$'])
/** оболочки с -c */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])
/** опции git со значением */
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
/** методы HTTP без записи */
const READ_METHODS = new Set(['GET', 'HEAD'])
/** что запрещено, словами */
const GUARDED: Record<Exclude<BashKind, 'other'>, string> = {
  'raw-commit': 'git commit', 'raw-push': 'git push', 'raw-destructive': 'разрушающая git-команда (--force, --amend, rebase, pull, reset --hard, branch -D, stash drop…)', 'raw-write': 'запись по сети через curl/wget',
}

/** худший вид из нескольких */
function worstKind(kinds: readonly BashKind[]): BashKind {
  return SEVERITY.find(kind => kinds.includes(kind)) ?? 'other'
}

// …simpleCommands, classifySimple, classifyGit, isCurlWrite, isWgetWrite — перенести из 2.2 без изменений…

/** вид команды Bash/Monitor */
export function classifyBash(command: string): BashKind {
  return worstKind(simpleCommands(command).map(classifySimple))
}

/** текст отказа для вида команды; undefined — команда разрешена */
export function guardText(kind: BashKind): string | undefined {
  return kind === 'other' ? undefined : `review-kit: внутри прогона ${GUARDED[kind]} запрещена — commit, push и публикация идут через инструменты review-kit (commit_push, review_publish, replies_publish); pull/rebase пользователь делает сам`
}
```

Функции `simpleCommands`, `classifySimple`, `classifyGit`, `isCurlWrite`, `isWgetWrite` переносятся из 2.2 дословно
(`simpleCommands` остаётся `export`), с одним добавлением в `classifyGit` — любой `git pull` внутри прогона запрещён
модели: с `--rebase`, `-r`, `-c pull.rebase=true` или `pull.rebase` в конфиге он переписывает историю, а самой модели
`pull` в скиллах не нужен. Подтянуть ветку при non-fast-forward делает пользователь (`! git pull --rebase` или в своём
терминале — проверяется живой проверкой 3c):

```ts
  // …после строки про rebase…
  if (sub === 'pull') return 'raw-destructive'
```

Удаляются: `KIT_OK_SENTINEL`, `POST_OK_SENTINEL`, `POST_REPLIES_OK_SENTINEL`,
`PostReviewCall`, `PublishMark`, `CommitPushCall`, `CommitPushMark`, `Classified`, `GuardInput`, `GuardVerdict`, `TOKEN`,
`tokenize`, `MERGED_STDERR`, `messageProblem` (теперь в `git.ts`), `parseKitCall`, `parsePostCall`, `parseRepliesCall`,
`parseForgejoCall`, `matchesMark`, `kitScriptPaths`, `kitUsage`, `decideBash`; в `classifyBash` — ветки `kit-*`.

- [ ] **Step 3: `register.ts` — переключение и уборка через `git.ts`**

Импорт: `import { classifyBash, guardText } from './policy.ts'`; из `git.ts` добавить `applySwitch, branchCandidates, claudeCodeChanges, commitRound, deleteBranches, foreignChanges, holder as worktreeHolder, inMainTree, messageProblem, planSwitch, pushRound, removeWorktrees, reviewStashes, roundState, stashAction, unpushed, worktreeCandidates, type IsActive, type SwitchPlan`; из `run/review.ts` — `buildDraft, buildReplies, parseCovered, statusesBlock, verdictName, type Texts`; из `run/findings.ts` — `type Finding`; из `status.ts` — `type IntakeItem`.

Удалить константы `MARKS` и `PUBLISH_MARKS` (константу `CONFIRM_TEXT_LIMIT` оставить — она нужна диалогам) и функции `kitScripts`, `runTool`,
`readCommitMarks`, `readPublishMarks`, `withoutPr`, `publishKey`, `confirmCommitPush`, `confirmReplies`, `confirmPublish`;
в `finishRun` — строки `update($, MARKS…)` и `update($, PUBLISH_MARKS…)`; спецификацию `review_confirm` в `TOOL_SPECS`
и обработчик `mcp__review-kit__review_confirm`. В `types/index.d.ts` удалить `ReviewKitPublishMark`, `ReviewKitMark` и поля
`marks`, `publishMarks`.

Добавить:

```ts
/** прогон в чужом worktree активен (его session.json) */
function isActive($: EngineInterface): IsActive {
  return (path, pr) => $.fs.read(`${path}/.review-kit/run/${pr}/session.json`).then(text => {
    try {
      return (JSON.parse(String(text)) as { status?: string }).status === 'active'
    } catch {
      return true
    }
  }, () => false)
}
```

`switchOrRestore` заменить: переключение идёт по уже готовому плану, при ошибке stash возвращается через `stashAction`:

```ts
// переключает дерево по плану; при ошибке возвращает stash
async function switchOrRestore($: EngineInterface, { plan, stash }: { plan: SwitchPlan; stash: SavedStash | null }): Promise<{ head: string; base: string; detached: boolean; baseFallback: boolean }> {
  const run = runner($)
  const before = (await gitText(run, ['rev-parse', 'HEAD'])).trim()
  try {
    return await applySwitch(run, plan)
  } catch (error) {
    if (!stash) throw error
    const after = (await gitText(run, ['rev-parse', 'HEAD'])).trim()
    if (after !== before) throw new Error(`${(error as Error).message}; дерево уже на коммите PR; stash «${stash.name}» не применён — вернитесь (git switch -) и примените его через /pr cleanup`)
    const restored = await stashAction(run, stash.sha, 'apply')
    const note = restored.ok ? 'изменения возвращены из stash' : restored.conflict ? `изменения из stash «${stash.name}» ${restored.error}` : `изменения остались в stash «${stash.name}»: ${restored.error}`
    throw new Error(`${(error as Error).message}; ${note}`)
  }
}
```

В `startRun` вместо `const switched = await switchOrRestore($, { tools, pr, context, stash: saved })` и строк `const tools = …` —
порядок спеки: план (fetch, merge-base) → проверка настроек Claude Code → stash → переключение:

```ts
  const run = runner($)
  const provider = await forge($)
  const plan = await planSwitch(run, { number: pr, headRef: context.headRef, headSha: context.headSha, baseRef: context.baseRef, own: context.isOwn, pullRef: provider.pullRef(pr) })
  if (!context.isOwn) {
    const risky = claudeCodeChanges(await changedFiles(run, plan.base, plan.target))
    if (risky.length) {
      const answer = await $.ui.ask(`PR ${pr} меняет настройки Claude Code:\n${risky.join('\n')}\nХуки и MCP из них могут выполнить команды на вашей машине, когда дерево переключится на PR.`, ['Отмена', 'Продолжить']).catch(() => 'Отмена')
      if (answer !== 'Продолжить') return 'Отменено: дерево не тронуто.'
    }
  }
```

(вопрос о модели остаётся перед этим блоком; `dirty`/`stashOrCancel` — после него; затем
`const switched = await switchOrRestore($, { plan, stash: saved })`.)

Сразу после `switchOrRestore` и **до** записи `intake.json`, `recheck.json` и `context.json` — каталог прогона начинается
с чистого листа (иначе только что записанные файлы удалились бы), чтобы файлы прошлого прогона того же PR
(`statuses.json`, `recheck.json`, `texts.json`, `findings.json`, `session.json` с `roundBase`) не попали в новый:

```ts
  await deleteRunDir($, pr)
```

(`resumeRun` каталог не чистит — он продолжает прерванный прогон.) Так новый раунд (`/pr-fix` после запушенного)
всегда получает `roundBase = HEAD`, а повтор `commit_push` внутри того же раунда после успешного push отвечает
«уже на origin».

`stashOrCancel`: `await runTool($, ['git', 'stash', 'push', '-m', name])` → `await gitText(runner($), ['stash', 'push', '-m', name])`.
Остальное в функции не меняется: sha берётся `stashTop` (`git rev-parse -q --verify refs/stash`) до и после push, как в 2.2;
в `startRun` переменная `stash` — строка-имя (`saved?.name ?? null`), объект `saved` идёт только в `switchOrRestore`.

`openRun` пишет `roundBase` для раунда правок:

```ts
// записывает session.json (с базой раунда для своих сценариев) и помечает прогон активным
async function openRun($: EngineInterface, { pr, context, head, scenario }: { pr: number; context: PrContext; head: string; scenario: RunScenario }): Promise<void> {
  const own = scenario === 'feedback' || scenario === 'fix'
  const path = `${await runDir($, pr)}/session.json`
  // при новом прогоне каталог уже очищен (startRun) и kept пуст; нужен для resumeRun — продолжение прерванного раунда
  const kept = (await readJson<{ roundBase?: string }>($, path, {})).roundBase
  await $.fs.write(path, JSON.stringify({ sessionId: await $.session.id(), status: 'active', ...(own ? { roundBase: kept ?? head } : {}) }))
  await $.state.set(RUN, { pr, status: 'active', isOwn: context.isOwn, state: context.state, head, scenario })
}
```

Уборка — замена вызовов `cleanup.py`:

```ts
// предлагает удалить законченные worktree ревью и их ненужные ветки
async function offerWorktrees($: EngineInterface, { worktrees }: { worktrees: ReviewWorktreeCandidate[] }): Promise<string | undefined> {
  const remove = `Удалить все (${worktrees.length})`
  if ((await $.ui.ask(`${WORKTREE_TITLE}\n${worktrees.map(worktreeLine).join('\n')}`, [remove, KEEP]).catch(() => KEEP)) !== remove) return undefined
  const run = runner($)
  const result = await removeWorktrees(run, worktrees.map(w => w.path), { confirmed: false, isActive: isActive($) })
  const branches = worktrees.filter(w => w.deleteBranch && result.removed.includes(w.path)).map(w => w.branch)
  const deleted = branches.length ? (await deleteBranches(run, branches)).deleted : []
  const skipped = result.skipped.length ? `, пропущено: ${result.skipped.map(s => `${s.path.split('/').pop()} (${s.reason})`).join(', ')}` : ''
  return `удалено worktree: ${result.removed.length}${deleted.length ? `, их веток: ${deleted.length}` : ''}${skipped}`
}
```

(`interface ReviewWorktree` в `register.ts` переименовать в `ReviewWorktreeCandidate` — имя `ReviewWorktree` теперь у `git.ts`;
`worktreeLine` принимает `ReviewWorktreeCandidate`. Интерфейсы `CleanupList`, `RemovedWorktrees`, `HeldWorktree` удалить.)

В `releaseWorktree`:

```ts
  const held = await worktreeHolder(runner($), headRef, isActive($))
  if (!held) return undefined
```

и вместо `remove-worktrees --confirmed`:

```ts
  const result = await removeWorktrees(runner($), [held.path], { confirmed: true, isActive: isActive($) })
```

В `offerCleanup` начало:

```ts
  const run = runner($)
  const provider = await forge($)
  const [open, closed, me] = await Promise.all([provider.listPulls('open'), provider.listPulls('closed'), provider.currentUser()])
  const found = {
    branches: await branchCandidates(run, { open, closed, me }),
    stashes: await reviewStashes(run),
    worktrees: (await inMainTree(run)) ? await worktreeCandidates(run, { open, me, isActive: isActive($) }) : [],
  }
```

и вызовы `delete-branches` → `await deleteBranches(run, branches.map(b => b.name))`, `stash … drop|apply` →
`await stashAction(run, stash.sha, answer === 'Удалить' ? 'drop' : 'apply')`; `offerWorktrees($, { worktrees })` — без `tool`.

- [ ] **Step 4: `register.ts` — три инструмента публикации**

```ts
/** контекст прогона для записи: прогон этого PR активен */
async function writeContext($: EngineInterface, pr: number): Promise<{ dir: string; context: PrContext & { head: string; base: string } }> {
  if ((await activeRun($)) !== pr) throw new Error(`нет активного прогона PR ${pr} в этой сессии`)
  const dir = await runDir($, pr)
  return { dir, context: JSON.parse(String(await $.fs.read(`${dir}/context.json`))) }
}

/** JSON-файл прогона или запасное значение */
async function readJson<T>($: EngineInterface, path: string, fallback: T): Promise<T> {
  return $.fs.read(path).then(text => JSON.parse(String(text)) as T, () => fallback)
}

/** review_publish: собрать ревью из согласованных текстов, спросить, опубликовать */
async function publishReview($: EngineInterface, { pr, ids, approve, from }: { pr: number; ids: string[] | 'all'; approve?: boolean; from?: 'chat' | 'plannotator' }): Promise<string> {
  const { dir, context } = await writeContext($, pr)
  if (context.isOwn || context.state === 'closed') return 'not published: свой или закрытый PR не публикуется — только отчёт'
  const source = from === 'plannotator' ? `${dir}/plannotator` : dir
  const findings = (await readJson<{ findings: Finding[] }>($, `${source}/findings.json`, { findings: [] })).findings
  const texts = await readJson<Texts>($, `${source}/texts.json`, { comments: {} })
  const wanted = ids === 'all' ? findings.map(item => item.id) : ids
  const unknown = wanted.filter(id => !findings.some(item => item.id === id))
  if (unknown.length) return `not published: нет находки: ${unknown.join(', ')}`
  const selected = findings.filter(item => wanted.includes(item.id))
  const recheck = context.scenario === 'recheck'
  const statuses = recheck ? (await readJson<{ items: Array<{ id: string; class: string; reason?: string }> }>($, `${dir}/statuses.json`, { items: [] })).items : []
  const prior = (await readJson<{ prior: Array<{ id: string; path: string | null; line: number | null }> }>($, `${dir}/recheck.json`, { prior: [] })).prior
  const summary = [texts.summary?.trim() ?? '', ...(statuses.length ? [statusesBlock(statuses, prior)] : [])].filter(Boolean).join('\n\n')
  const provider = await forge($)
  const covered = parseCovered(await gitText(runner($), ['diff', '-U0', '--no-color', '--no-renames', context.base, context.head]))
  const verdict = verdictName(selected, statuses)
  const { draft, notes } = buildDraft({ selected, texts: { ...texts, summary }, verdict, approve: approve === true, covered, capabilities: provider.capabilities })
  const bare = draft.verdict === 'approve' && !draft.body.trim() && draft.comments.length === 0
  const inline = draft.comments.map(c => `• ${c.path}:${c.line} — ${c.body}`).join('\n')
  const question = bare ? `Одобрить PR ${pr} без комментариев?` : `Публикуем ревью PR ${pr} (${verdict})?\n\n${draft.body}\n\n${inline}`.slice(0, CONFIRM_TEXT_LIMIT)
  if ((await $.ui.ask(question, ['Да', 'Нет']).catch(() => 'Нет')) !== 'Да') return 'not published: пользователь отказал'
  if (!bare && draft.verdict === 'approve' && (await $.ui.ask(`Одобрить PR ${pr}?`, ['Да', 'Нет']).catch(() => 'Нет')) !== 'Да') {
    return 'not published: одобрение отклонено — вызовите review_publish без approve'
  }
  const { url } = await provider.publishReview(pr, draft)
  return `published: ${url}${notes.length ? `\n${notes.join('\n')}` : ''}`
}

/** replies_publish: ответы из replies.json, спросить, опубликовать */
async function publishReplies($: EngineInterface, pr: number): Promise<string> {
  const { dir, context } = await writeContext($, pr)
  if (!context.isOwn || context.state === 'closed') return 'not published: ответы — только в своём открытом PR'
  const items = (await readJson<{ items: IntakeItem[] }>($, `${dir}/intake.json`, { items: [] })).items
  const texts = (await readJson<{ replies: Record<string, string> }>($, `${dir}/replies.json`, { replies: {} })).replies
  const replies = buildReplies(items, texts)
  if (replies.length === 0) return 'not published: ответов нет'
  const byId = new Map(items.map(item => [item.id, item]))
  const lines = Object.entries(texts).filter(([, text]) => text.trim()).map(([id, text]) => {
    const item = byId.get(id)
    return `• ${item?.path ? `${item.path}:${item.position}` : 'общий'} — ${text.trim()}`
  }).join('\n\n')
  if ((await $.ui.ask(`Публикуем ответы в PR ${pr} (${replies.length})?\n\n${lines}`.slice(0, CONFIRM_TEXT_LIMIT), ['Да', 'Нет']).catch(() => 'Нет')) !== 'Да') return 'not published: пользователь отказал'
  await (await forge($)).publishReplies(pr, replies)
  return `published: ${replies.length}`
}

/** commit_push: коммит путей раунда и push с подтверждением; повтор безопасен */
async function commitPush($: EngineInterface, { pr, message, paths }: { pr: number; message: string; paths: string[] }): Promise<string> {
  const { dir, context } = await writeContext($, pr)
  if (!context.isOwn || context.state === 'closed') return 'not done: commit и push — только свой открытый PR'
  const problem = messageProblem(message)
  if (problem) return `not done: ${problem}`
  const run = runner($)
  const branch = (await gitText(run, ['branch', '--show-current'])).trim()
  if (branch !== context.headRef) return `not done: дерево на ветке ${branch || '(detached)'}, а PR — ${context.headRef}`
  const session = await readJson<{ roundBase?: string }>($, `${dir}/session.json`, {})
  if (!session.roundBase) return 'not done: у прогона нет базы раунда — начните раунд заново (/pr-fix)'
  const { state, roundBase } = await roundState(run, { branch, roundBase: session.roundBase, message })
  if (roundBase !== session.roundBase) await $.fs.write(`${dir}/session.json`, JSON.stringify({ ...session, roundBase }))
  if (state === 'pushed') return `pushed: коммит раунда «${message}» уже на origin`
  if (state === 'commit') {
    const foreign = await foreignChanges(run, paths)
    if (foreign.length) return `not done: изменены файлы вне списка раунда — добавьте их в paths или верните:\n${foreign.join('\n')}`
  }
  const pending = await unpushed(run, branch)
  const what = state === 'commit' ? `Коммитим и пушим в ${branch} (PR ${pr})?\n\n${message}\n\nФайлы:\n${paths.join('\n')}` : `Пушим в ${branch} (PR ${pr}) коммит раунда «${message}»?`
  const question = `${what}${pending.length ? `\n\nУйдут и неотправленные коммиты:\n${pending.join('\n')}` : ''}`.slice(0, CONFIRM_TEXT_LIMIT)
  if ((await $.ui.ask(question, ['Да', 'Нет']).catch(() => 'Нет')) !== 'Да') return 'not done: пользователь отказал'
  if (state === 'commit') {
    const committed = await commitRound(run, { paths, message })
    if (!committed.ok) return `not done: коммита нет — ${committed.output}`
  }
  const pushed = await pushRound(run, branch)
  if (pushed.ok) return `pushed: ${(await gitText(run, ['rev-parse', '--short', 'HEAD'])).trim()} в ${branch}`
  return pushed.rejected
    ? `not pushed: ветка на origin ушла вперёд — нужен pull/rebase. Пусть пользователь выполнит \`! git pull --rebase\` (или в своём терминале), затем снова commit_push.\n${pushed.output}`
    : `not pushed: push не прошёл (коммит раунда сохранён, повтор commit_push только запушит): ${pushed.output}`
}
```

`TOOL_SPECS` — вместо `review_confirm`:

```ts
  {
    name: 'review_publish',
    description: 'Publish the review of the active review-kit run: findings by ids (or "all") from findings.json with texts from texts.json (from: "plannotator" — the Plannotator result). The tool asks the user itself and publishes only on «Да». approve: true — ask to approve (only for Approved / Approved with comments). Answers "published: <url>" or "not published: …".',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' }, ids: { oneOf: [{ const: 'all' }, { type: 'array', items: { type: 'string' } }] }, approve: { type: 'boolean' }, from: { enum: ['chat', 'plannotator'] } }, required: ['pr', 'ids'] },
    isDeferred: false,
  },
  {
    name: 'replies_publish',
    description: 'Publish the replies from .review-kit/run/<N>/replies.json ({"replies": {"<item id>": "<text>"}}) into the threads of the own PR. The tool asks the user itself. Answers "published: <n>" or "not published: …".',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' } }, required: ['pr'] },
    isDeferred: false,
  },
  {
    name: 'commit_push',
    description: 'Commit the round paths of the own PR with a one-line message and push, after the user confirms in the tool\'s own dialog. Safe to repeat: a committed round is only pushed. Answers "pushed: …", "not pushed: …" (rejected — the user pulls with rebase first) or "not done: …" (a failing pre-commit hook output included).',
    inputSchema: { type: 'object', properties: { pr: { type: 'number' }, message: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } }, required: ['pr', 'message', 'paths'] },
    isDeferred: false,
  },
```

Обработчики по образцу `review_prepare` (`try` → `{ result: await … }`, `catch` → `{ result: \`review-kit: ${message}\` }`)
для `mcp__review-kit__review_publish` (`publishReview($, e)`), `mcp__review-kit__replies_publish` (`publishReplies($, e.pr)`),
`mcp__review-kit__commit_push` (`commitPush($, e)`).

Хуки `Bash` и `Monitor` заменить:

```ts
  for (const tool of ['Bash', 'Monitor']) {
    on('tool.call', { tool }, async ($, e, next) => {
      if ((await activeRun($)) === undefined) return next(e)
      const deny = guardText(classifyBash(String((e as { command?: string }).command ?? '')))
      return deny ? { deny } : next(e)
    }).catch(($, e, next) => (next.called ? next(e) : { deny: GUARD_FAILED }))
  }
```

- [ ] **Step 5: Скиллы — публикация инструментами**

`skills/pr-review-run/SKILL.md`, раздел `## 3. Publish`:
- 3B: «write `texts.json` = `{"summary": "", "comments": {}}`, run step 3 of «In chat» with `--ids "" --approve`, then its steps 4–6» → «call `review_publish` with `pr`, `ids: []`, `approve: true`; the mod asks «Одобрить PR <N> без комментариев?» itself».
- 3P.4, последний пункт: «then step 3 below with `--findings …/plannotator/findings.json --texts …/plannotator/texts.json --ids <ids from result.json>`, then steps 4–6» → «then `review_publish` with `pr`, `ids` = the ids from result.json, `from: "plannotator"`».
- «In chat», шаги 3–6 заменить на:

```markdown
3. Call `review_publish` with `pr`, `ids` (the selected ids, or `"all"`) and `approve: true` only if the verdict is Approved or
   Approved with comments and the user wants to approve. The tool shows the review and asks the user itself.
4. `published: <url>` → report the URL. `not published: …` → show the reason; nothing was published.
   An error saying «статус публикации неизвестен» → tell the user to check the PR before anything else; never call it again.
5. Call `review_finish`.
```

- последний абзац: «Never call curl, never edit `payload.json` after `review_confirm`, never publish an own or closed PR.» →
  «Never call curl or the API; publishing goes only through `review_publish`.»

`skills/pr-recheck-run/SKILL.md` шаг 5: «with `--statuses … --prior …` added to its `review_payload.py build` command» →
«`review_publish` adds the statuses of `statuses.json` to the review body itself».

`skills/pr-fix-run/SKILL.md` шаг 7 заменить на:

```markdown
7. Commit and push. Message `[<ticket>] fix(<scope>): <суть раунда>` — one line, past tense, Russian, no `#N`, ticket from the
   branch name. Call `commit_push` with `pr`, `message`, `paths` = the round's paths; the tool asks the user itself.
   - `pushed: …` → step 8.
   - `not done: … коммита нет — <hook output>` (pre-commit failed) → show the output, fix what it reports, back to step 3, then `commit_push` again.
   - `not done: изменены файлы вне списка …` → add those paths to the round or revert them, then `commit_push` again.
   - `not pushed: ветка на origin ушла вперёд …` → ask the user to run `! git pull --rebase` or `git pull --rebase` in their own terminal (the mod refuses `git pull`/`rebase` from you inside a run), then `commit_push` again with the same message.
   - `not pushed: push не прошёл …` → offer to call `commit_push` again; it only pushes.
   Never `git commit`/`git push` yourself, never `--force`.
```

Раздел `## Replies`, последние строки (от «Then run exactly: `python3 … replies.py build …`» до конца раздела) заменить на:

```markdown
Then call `replies_publish` with `pr` (it reads `replies.json` and `intake.json`, asks the user itself and publishes).
`published: <n>` → report; `not published: …` → show the reason.
```

и последнюю строку скилла: «Never call curl, never `git commit`/`git push` directly.» — без изменений.

- [ ] **Step 5a: Паритет `review.ts` с `review_payload.py`/`replies.py` (до удаления)**

`$S/parity-3c.mjs`:

```js
// parity-3c.mjs — review_payload.py/replies.py (2.2) против run/review.ts на одних входах
import { spawnSync } from 'node:child_process'
import { buildDraft, buildReplies, parseCovered, statusesBlock, verdictName } from '/home/prian/projects/review-kit/mod/run/review.ts'
const EVENT = { 'request-changes': 'REQUEST_CHANGES', comment: 'COMMENT', approve: 'APPROVED' }
const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +3,2 @@\n+x\n+y\n'
const f = (id, severity, line) => ({ id, file: 'a.ts', line, severity, confidence: 90, problem: 'p' })
const CASES = {
  changes: [[f('A-1', 'important', 3), f('A-2', 'minor', 9)], { summary: 'Итог', comments: { 'A-1': 'один', 'A-2': 'два' } }, false, []],
  emptyBlocked: [[f('A-1', 'critical', 3)], { comments: { 'A-1': 'x' } }, false, []],
  approve: [[f('A-1', 'minor', 4)], { comments: { 'A-1': 'x' } }, true, []],
  approvedNone: [[], { comments: {} }, false, []],
  recheckPartial: [[], { summary: 'S', comments: {} }, false, [{ id: 'r/1', class: 'partial', reason: 'нет' }]],
}
const prior = [{ id: 'r/1', path: 'a.ts', line: 3 }]
for (const [name, [selected, texts, approve, statuses]] of Object.entries(CASES)) {
  const py = spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, '/home/prian/projects/review-kit/tools')
from review_payload import build_review, covered_lines, verdict, statuses_block
selected, texts, approve, statuses, prior, diff = json.load(sys.stdin)
if statuses:
    texts = {**texts, 'summary': '\\n\\n'.join(p for p in (texts.get('summary', '').strip(), statuses_block(statuses, prior)) if p)}
print(json.dumps(build_review(selected, texts, verdict(selected, statuses), approve, covered_lines(diff)), ensure_ascii=False))
`], { input: JSON.stringify([selected, texts, approve, statuses, prior, diff]), encoding: 'utf8' })
  const summary = [texts.summary?.trim() ?? '', ...(statuses.length ? [statusesBlock(statuses, prior)] : [])].filter(Boolean).join('\n\n')
  const { draft } = buildDraft({ selected, texts: { ...texts, summary }, verdict: verdictName(selected, statuses), approve, covered: parseCovered(diff), capabilities: { inline: true, requestChanges: true } })
  const ts = JSON.stringify({ body: draft.body, event: EVENT[draft.verdict], comments: draft.comments.map(c => ({ path: c.path, new_position: c.line, body: c.body })) })
  const same = ts === JSON.stringify(JSON.parse(py.stdout))
  console.log(`${same ? 'ok  ' : 'DIFF'} ${name}${same ? '' : `\n  ts ${ts}\n  py ${py.stdout}${py.stderr}`}`)
}
const items = [{ id: 'r1/c1', kind: 'thread', reviewId: 'r1', threadId: 'r1:a.ts:3', path: 'a.ts', position: 3, quote: 'carol: x' }, { id: 'issue/9', kind: 'issue', reviewId: null, threadId: null, path: null, position: null, quote: 'вопрос\nещё' }]
const replies = { 'r1/c1': 'Сделано', 'issue/9': 'Ответ' }
const py = JSON.parse(spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, '/home/prian/projects/review-kit/tools')
from replies import build
items, replies = json.load(sys.stdin)
print(json.dumps([{'body': r['body'], 'quote': r['quote']} for r in build(items, replies)], ensure_ascii=False))
`], { input: JSON.stringify([items, replies]), encoding: 'utf8' }).stdout)
const ts = buildReplies(items, replies)
const same = ts.every((reply, i) => reply.body === py[i].body && (reply.threadId !== undefined || reply.quote === py[i].quote))
console.log(`${same ? 'ok  ' : 'DIFF'} replies`)
```

Имена `build_review`, `covered_lines`, `verdict`, `statuses_block` (`review_payload.py`), `build` (`replies.py`) и поле
`new_position` сверены с кодом 2.2.

Run: `node $S/parity-3c.mjs 2>&1 | grep -v ExperimentalWarning`
Expected: `ok` во всех строках; `DIFF` — чинить `review.ts`.

- [ ] **Step 6: Удалить скрипты и проверить**

```bash
rm tools/forgejo.py tools/review_payload.py tools/replies.py tools/switch-pr tools/commit-push tools/cleanup.py
```

Run: `ls tools; grep -rnE "forgejo\.py|review_payload|replies\.py|switch-pr|commit-push|cleanup\.py|review_confirm|kitScriptPaths|publishMarks" mod skills agents types funnel; TMPDIR=$S node $S/tscheck.mjs mod/*.ts mod/run/*.ts mod/forge/*.ts 2>&1 | grep -v ExperimentalWarning | grep -v '^ok'; node --test 'mod/**/*.test.ts' 2>&1 | grep -E "^ℹ (pass|fail)"; claude plugin validate . 2>&1 | tail -1`
Expected: в `tools/` остались `open-pr-tab` и `plannotator.py`; grep находит только `skills/pr-tab/SKILL.md` (`forgejo.py get` — до этапа 6); FAIL нет; `fail 0`; `Validation passed`.

- [ ] **Step 7: Живая проверка (с пользователем)**

На тестовом репозитории: чужой PR с изменённым `.claude/settings.json` → диалог до переключения, «Отмена» не трогает дерево;
`review_publish` публикует ревью, при `approve` с important — отказ; `/pr-fix` → правка → `commit_push` (pre-commit проекта
срабатывает), повтор после упавшего push только пушит; `replies_publish`; `/pr cleanup`. Отдельно — non-fast-forward:
пользователь выполняет `! git pull --rebase` при открытом прогоне. Если мод отклоняет и `!`-команду (значит, она идёт через
хук `Bash`), в тексте `pr-fix-run` и сообщении `commit_push` оставить только «в своём терминале» и записать это в отчёт.

**Стоп 3c: ждём «дальше» пользователя.**

---

# Подэтап 3d: Plannotator в моде

### Task 3d.1: `mod/plannotator.ts` — аннотации и разбор решения

**Files:**
- Create: `mod/plannotator.ts`
- Test: `mod/plannotator.test.ts`

**Interfaces:**
- Consumes: `Finding` (`run/findings.ts`), `Texts` (`run/review.ts`).
- Produces:
  - `annotations(findings: Finding[], texts: Texts): { source: string; annotations: Array<{ source: string; filePath: string; lineStart: number; lineEnd: number; text: string }> }`
  - `type Decision = 'approved' | 'annotated' | 'dismissed'`, `decisionOf(stdout: string): { decision: Decision; message?: string }`
  - `interface ParsedItem { file: string; line: number | null; side: 'new' | 'old' | 'file'; text: string }`, `parseMessage(message: string): { items: ParsedItem[]; general: string[] }`
  - `similarity(a: string, b: string): number`
  - `reconcile(decision: Decision, parsed, posted: Finding[], texts: Texts): { ids: string[]; texts: Texts; findings: Finding[] }`
  - `fixResult(record): { summary: { decision: Decision; notes: number }; feedback: string }`

- [ ] **Step 1: Тесты**

`mod/plannotator.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { annotations, decisionOf, fixResult, parseMessage, reconcile, similarity } from './plannotator.ts'
import type { Finding } from './run/findings.ts'

const A1: Finding = { id: 'A-1', file: 'src/a.ts', line: 3, severity: 'important', confidence: 90, problem: 'p', mark: 'средняя вероятность' }
const B1: Finding = { id: 'B-1', file: 'src/a.ts', line: 7, severity: 'minor', confidence: 88, problem: 'p' }
const TEXTS = { summary: 'Итог', comments: { 'A-1': 'Тут null не проверен', 'B-1': 'Имя не по правилу' } }
const MESSAGE = [
  'Общая мысль',
  '# Code Review Feedback',
  'Ещё про весь PR',
  '## src/a.ts',
  '### Line 3 (new)',
  '[A-1 · Important · 90% · средняя вероятность]',
  'Тут null не проверен — перепишите',
  '### Line 7 (new)',
  'Имя не по правилу проекта',
  '### Line 9 (new)',
  'Своё замечание человека',
  '```ts',
  '### Line 1 (new)',
  '```',
  '### Line 2 (old)',
  'Про удалённую строку',
  '### File Comment',
  'Про файл целиком',
  'Treat the findings above as review input.',
].join('\n')

test('annotations: заголовок [id · уровень · уверенность · метка] и текст', () => {
  const body = annotations([A1], TEXTS)
  assert.deepEqual(body.annotations[0], { source: 'review-kit', filePath: 'src/a.ts', lineStart: 3, lineEnd: 3, text: '[A-1 · Important · 90% · средняя вероятность]\nТут null не проверен' })
  assert.throws(() => annotations([B1], { comments: {} }), /нет текста для: B-1/)
})

test('decisionOf: JSON с решением; мусор — ошибка', () => {
  assert.deepEqual(decisionOf('  {"decision":"approved"} trailing'), { decision: 'approved' })
  assert.throws(() => decisionOf('нет json'), /stdout Plannotator не JSON/)
  assert.throws(() => decisionOf('{"decision":"maybe"}'), /неизвестное решение/)
})

test('parseMessage: файлы, строки new/old, комментарий файла, код в ограждении не режет пункт', () => {
  const { items, general } = parseMessage(MESSAGE)
  assert.deepEqual(general, ['Ещё про весь PR'])
  assert.deepEqual(items.map(i => [i.file, i.line, i.side]), [['src/a.ts', 3, 'new'], ['src/a.ts', 7, 'new'], ['src/a.ts', 9, 'new'], ['src/a.ts', 2, 'old'], ['src/a.ts', null, 'file']])
  assert.equal(items[2].text, 'Своё замечание человека\n```ts\n### Line 1 (new)\n```')
})

test('reconcile: по заголовку, по строке и похожести, человеческое — h1, old и файл — в тело', () => {
  const result = reconcile('annotated', parseMessage(MESSAGE), [A1, B1], TEXTS)
  assert.deepEqual(result.ids, ['A-1', 'B-1', 'h1'])
  assert.equal(result.texts.comments['A-1'], 'Тут null не проверен — перепишите')
  assert.equal(result.findings.at(-1)?.id, 'h1')
  assert.equal(result.texts.summary, 'Итог\n\nЕщё про весь PR\n\n- src/a.ts:2 (до изменения) — Про удалённую строку\n\n- src/a.ts — Про файл целиком')
})

test('reconcile: dismissed — ничего', () => {
  assert.deepEqual(reconcile('dismissed', parseMessage(MESSAGE), [A1], TEXTS).ids, [])
})

test('reconcile: approved — неупомянутые находки идут с исходными текстами, и без правок, и с общей заметкой', () => {
  const plain = reconcile('approved', parseMessage(''), [A1, B1], TEXTS)
  assert.deepEqual([plain.ids, plain.texts], [['A-1', 'B-1'], TEXTS])
  const noted = reconcile('approved', parseMessage('# Code Review Feedback\nВ целом ок'), [A1, B1], TEXTS)
  assert.deepEqual(noted.ids, ['A-1', 'B-1'])
  assert.equal(noted.texts.summary, 'Итог\n\nВ целом ок')
})

test('similarity: как difflib ratio на простых строках', () => {
  assert.equal(similarity('abcd', 'abcd'), 1)
  assert.equal(similarity('', 'x'), 0)
  assert.equal(similarity('abcd', 'abxd'), 0.75)
})

test('fixResult: строки замечаний для feedback.md', () => {
  const { summary, feedback } = fixResult({ decision: 'annotated', message: MESSAGE })
  assert.equal(summary.notes, 6)
  assert.match(feedback, /^Ещё про весь PR\n- src\/a.ts:3 — \[A-1/)
})
```

- [ ] **Step 2: Запустить — падает** (`Cannot find module '.../mod/plannotator.ts'`).

- [ ] **Step 3: Создать `mod/plannotator.ts`** (перенос `plannotator.py`)

```ts
import type { Finding } from './run/findings.ts'
import type { Texts } from './run/review.ts'

/** уровни в заголовке аннотации */
const LEVEL: Record<string, string> = { critical: 'Critical', important: 'Important', minor: 'Minor' }
/** заголовок аннотации, по которому комментарий узнаётся после правки человеком */
const HEADER = /^\[(?<id>[^\s·\]]+) · (?:Critical|Important|Minor)(?: · \d{1,3}%)?(?: · [^\]]*)?\]$/
/** заголовок файла в ответе Plannotator */
const FILE_HEADING = /^## (?!#)(\S.*)$/
/** заголовок строки */
const LINE_HEADING = /^### Line (\d+)(?:-\d+)? \((new|old)\)$/
/** начало тела ответа */
const START = '# Code Review Feedback'
/** хвосты, после которых тело кончается */
const TAILS = ['Treat the findings above', 'Do not revise or reopen the reviewed changes']
/** строка-подпись diff */
const DIFF_LINE = /^\*\*Diff:\*\*/
/** комментарий ко всему файлу */
const FILE_COMMENT = /^### File Comment$/
/** ограждение кода */
const FENCE = '```'
/** источник аннотаций */
const SOURCE = 'review-kit'
/** порог похожести для узнавания по строке */
const SIMILAR = 0.5

/** решение человека в Plannotator */
export type Decision = 'approved' | 'annotated' | 'dismissed'

/** пункт ответа Plannotator */
export interface ParsedItem {
  /** файл */
  file: string
  /** строка (null — комментарий к файлу) */
  line: number | null
  /** новая/старая сторона diff или файл целиком */
  side: 'new' | 'old' | 'file'
  /** текст */
  text: string
}

/** заголовок аннотации находки */
function header(item: Finding): string {
  return `[${item.id} · ${LEVEL[item.severity]}${item.confidence === undefined ? '' : ` · ${item.confidence}%`}${item.mark ? ` · ${item.mark}` : ''}]`
}

/** аннотации над diff PR: по одной на находку */
export function annotations(findings: Finding[], texts: Texts): { source: string; annotations: Array<{ source: string; filePath: string; lineStart: number; lineEnd: number; text: string }> } {
  const missing = findings.filter(item => !(item.id in texts.comments)).map(item => item.id)
  if (missing.length) throw new Error(`нет текста для: ${missing.join(', ')}`)
  return { source: SOURCE, annotations: findings.map(item => ({ source: SOURCE, filePath: item.file, lineStart: item.line, lineEnd: item.line, text: `${header(item)}\n${texts.comments[item.id]}` })) }
}

/** решение из stdout Plannotator (первый JSON-объект) */
export function decisionOf(stdout: string): { decision: Decision; message?: string } {
  const text = stdout.trimStart()
  const end = text.split('').reduce<{ depth: number; at: number; quote: boolean; escape: boolean }>((s, char, index) => {
    if (s.at >= 0) return s
    if (s.quote) return { ...s, escape: !s.escape && char === '\\', quote: s.escape || char !== '"' }
    if (char === '"') return { ...s, quote: true }
    const depth = s.depth + (char === '{' ? 1 : char === '}' ? -1 : 0)
    return { ...s, depth, at: depth === 0 && char === '}' ? index : -1 }
  }, { depth: 0, at: -1, quote: false, escape: false }).at
  const parsed = (() => {
    try {
      return JSON.parse(text.slice(0, end + 1)) as Record<string, unknown>
    } catch (error) {
      throw new Error(`stdout Plannotator не JSON: ${(error as Error).message}`)
    }
  })()
  if (!parsed || !['approved', 'annotated', 'dismissed'].includes(String(parsed.decision))) throw new Error(`неизвестное решение: ${JSON.stringify(parsed).slice(0, 200)}`)
  return { decision: parsed.decision as Decision, ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}) }
}

/** тело ответа между START и хвостом */
function setBody(message: string): string {
  const start = message.indexOf(START)
  if (start < 0) return ''
  const body = message.slice(start + START.length)
  const cuts = TAILS.map(tail => body.indexOf(tail)).filter(at => at >= 0)
  return cuts.length ? body.slice(0, Math.min(...cuts)) : body
}

/** пункты по файлам и строкам и общие строки */
export function parseMessage(message: string): { items: ParsedItem[]; general: string[] } {
  const lines = setBody(message).split('\n')
  const trackFences = lines.filter(line => line.trimStart().startsWith(FENCE)).length % 2 === 0
  const items: Array<{ file: string; line: number | null; side: ParsedItem['side']; lines: string[] }> = []
  const general: string[] = []
  const state: { file: string | null; current: (typeof items)[number] | null; fence: boolean } = { file: null, current: null, fence: false }
  lines.forEach((raw, index) => {
    const opensFence = raw.trimStart().startsWith(FENCE)
    if (trackFences && state.current && (state.fence || opensFence)) {
      state.fence = state.fence !== opensFence
      state.current.lines.push(raw)
      return
    }
    const following = lines.slice(index + 1).find(line => line.trim()) ?? ''
    const lineHeading = LINE_HEADING.exec(raw)
    const fileHeading = LINE_HEADING.test(following) || FILE_COMMENT.test(following) ? FILE_HEADING.exec(raw) : null
    if (lineHeading && state.file) {
      state.current = { file: state.file, line: Number(lineHeading[1]), side: lineHeading[2] as 'new' | 'old', lines: [] }
      items.push(state.current)
    } else if (FILE_COMMENT.test(raw) && state.file) {
      state.current = { file: state.file, line: null, side: 'file', lines: [] }
      items.push(state.current)
    } else if (fileHeading) {
      state.file = fileHeading[1].trim()
      state.current = null
    } else if (state.current) state.current.lines.push(raw)
    else if (raw.trim() && !DIFF_LINE.test(raw.trim())) general.push(state.file ? `${state.file}: ${raw.trim()}` : raw.trim())
  })
  return { items: items.map(({ lines: body, ...item }) => ({ ...item, text: body.join('\n').trim() })), general }
}

/** число совпавших символов по Ратклиффу/Обершелпу (difflib без эвристики «мусора») */
function matched(a: string, b: string): number {
  if (!a || !b) return 0
  const best = { size: 0, i: 0, j: 0 }
  const lengths = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    for (let j = b.length; j >= 1; j--) {
      lengths[j] = a[i - 1] === b[j - 1] ? lengths[j - 1] + 1 : 0
      if (lengths[j] > best.size) Object.assign(best, { size: lengths[j], i: i - lengths[j], j: j - lengths[j] })
    }
  }
  if (best.size === 0) return 0
  return best.size + matched(a.slice(0, best.i), b.slice(0, best.j)) + matched(a.slice(best.i + best.size), b.slice(best.j + best.size))
}

/** похожесть строк 0–1 (как difflib.SequenceMatcher.ratio) */
export function similarity(a: string, b: string): number {
  return a.length + b.length === 0 ? 1 : (2 * matched(a, b)) / (a.length + b.length)
}

/** ответ человека → какие находки публиковать и с какими текстами */
export function reconcile(decision: Decision, parsed: { items: ParsedItem[]; general: string[] }, posted: Finding[], texts: Texts): { ids: string[]; texts: Texts; findings: Finding[] } {
  if (decision === 'dismissed') return { ids: [], texts, findings: posted }
  const byId = new Map(posted.map(item => [item.id, item]))
  const used = new Set<string>()
  const comments: Record<string, string> = {}
  const extra: Finding[] = []
  const body = [...parsed.general]
  for (const item of parsed.items) {
    if (item.side === 'file') { body.push(`- ${item.file} — ${item.text}`); continue }
    if (item.side === 'old') { body.push(`- ${item.file}:${item.line} (до изменения) — ${item.text}`); continue }
    const [first, ...rest] = item.text.split('\n')
    const head = HEADER.exec(first.trim())
    const text = head ? rest.join('\n').trim() : item.text
    const byHeader = head?.groups?.id && byId.has(head.groups.id) && !used.has(head.groups.id) ? head.groups.id : null
    const candidates = posted.filter(p => p.file === item.file && p.line === item.line && !used.has(p.id))
    const best = candidates.map(p => ({ id: p.id, score: similarity(text, texts.comments[p.id] ?? '') })).sort((a, b) => b.score - a.score)[0]
    const found = byHeader ?? (best && best.score >= SIMILAR ? best.id : null)
    if (found) {
      used.add(found)
      comments[found] = text
      continue
    }
    const id = `h${extra.length + 1}`
    extra.push({ id, file: item.file, line: item.line ?? 0, severity: 'minor', confidence: 100, problem: text })
    comments[id] = text
  }
  if (decision === 'approved') {
    for (const item of posted) if (!used.has(item.id) && item.id in texts.comments) comments[item.id] = texts.comments[item.id]
  }
  const summary = [Object.keys(comments).length ? (texts.summary ?? '').trim() : '', ...body].filter(Boolean).join('\n\n')
  return { ids: Object.keys(comments), texts: { summary, comments }, findings: [...posted, ...extra] }
}

/** замечания человека к правкам раунда построчно для feedback.md */
export function fixResult(record: { decision: Decision; message?: string }): { summary: { decision: Decision; notes: number }; feedback: string } {
  const { items, general } = parseMessage(record.message ?? '')
  const lines = [...general, ...items.map(item => `- ${item.file}:${item.line ?? ''} — ${item.text}`)]
  return { summary: { decision: record.decision, notes: lines.length }, feedback: lines.join('\n') }
}
```

Решение: `similarity` — без эвристики autojunk difflib (она включается на строках от 200 символов); на коротких комментариях
результат совпадает, на длинных может отличаться в долях — порог 0.5 используется только как запасной путь после заголовка.
`decisionOf` ищет конец первого JSON-объекта сам (у JS нет `raw_decode`).

Тест `parseMessage` и `reconcile`: в `MESSAGE` строка «Общая мысль» стоит до `# Code Review Feedback` и в тело не входит
(как в 2.2); `fixResult` даёт 6 строк: «Ещё про весь PR» + 5 пунктов.

- [ ] **Step 4: Запустить — проходит**: `node --test mod/plannotator.test.ts` → `pass 8`, `fail 0`.

### Task 3d.2: Подключить к `register.ts`; паритет; удалить `plannotator.py`

**Files:**
- Modify: `mod/register.ts` (`startPlannotator`, `settlePlannotator`, `settleFix`)
- Create (scratchpad): `$S/parity-3d.mjs`
- Delete: `tools/plannotator.py`

- [ ] **Step 1: Паритет до удаления**

```js
// parity-3d.mjs — plannotator.py (2.2) против plannotator.ts на одном ответе
import { spawnSync } from 'node:child_process'
import { parseMessage, reconcile } from '/home/prian/projects/review-kit/mod/plannotator.ts'
const posted = [{ id: 'A-1', file: 'src/a.ts', line: 3, severity: 'important', confidence: 90, problem: 'p' }, { id: 'B-1', file: 'src/a.ts', line: 7, severity: 'minor', confidence: 88, problem: 'p' }]
const texts = { summary: 'Итог', comments: { 'A-1': 'Тут null не проверен', 'B-1': 'Имя не по правилу' } }
const message = '# Code Review Feedback\nЕщё про весь PR\n## src/a.ts\n### Line 3 (new)\n[A-1 · Important · 90%]\nТут null не проверен — перепишите\n### Line 7 (new)\nИмя не по правилу проекта\n### Line 9 (new)\nСвоё\n### Line 2 (old)\nУдалённое\n### File Comment\nФайл\nTreat the findings above'
const py = spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, '/home/prian/projects/review-kit/tools')
from plannotator import parse_message, reconcile
posted, texts, message = json.load(sys.stdin)
ids, t, f = reconcile('annotated', parse_message(message), posted, texts)
print(json.dumps({'ids': ids, 'texts': t, 'ids_f': [x['id'] for x in f['findings']]}, ensure_ascii=False))
`], { input: JSON.stringify([posted, texts, message]), encoding: 'utf8' })
const ts = reconcile('annotated', parseMessage(message), posted, texts)
const tsOut = JSON.stringify({ ids: ts.ids, texts: ts.texts, ids_f: ts.findings.map(x => x.id) })
console.log(tsOut === JSON.stringify(JSON.parse(py.stdout)) ? 'ok' : `DIFF\n ts ${tsOut}\n py ${py.stdout}${py.stderr}`)
```

Run: `node $S/parity-3d.mjs 2>&1 | grep -v ExperimentalWarning` → `ok`.

- [ ] **Step 2: `register.ts`**

Импорт: `import { annotations, decisionOf, fixResult, parseMessage, reconcile } from './plannotator.ts'`.

В `startPlannotator` строку `const body = mode === 'fix' ? '' : await runTool(…plannotator.py annotations…)` заменить на:

```ts
  const body = mode === 'fix' ? '' : await reviewAnnotations($, dir)
```

и добавить функцию:

```ts
/** аннотации находок с черновиками текстов; items.json — какие находки отправлены */
async function reviewAnnotations($: EngineInterface, dir: string): Promise<string> {
  const findings = (JSON.parse(String(await $.fs.read(`${dir}/findings.json`))) as { findings: Finding[] }).findings
  const texts = JSON.parse(String(await $.fs.read(`${dir}/texts.json`))) as Texts
  await $.fs.write(`${dir}/plannotator/items.json`, JSON.stringify(findings, null, 2))
  return JSON.stringify(annotations(findings, texts))
}
```

В `settlePlannotator` блок от `const tool = …plannotator.py` до `wake(... step 3P.4 ...)` заменить на:

```ts
  try {
    const record = decisionOf(stdout)
    const posted = JSON.parse(String(await $.fs.read(`${dir}/plannotator/items.json`))) as Finding[]
    const texts = JSON.parse(String(await $.fs.read(`${dir}/texts.json`))) as Texts
    const result = reconcile(record.decision, parseMessage(record.message ?? ''), posted, texts)
    await $.fs.write(`${dir}/plannotator/texts.json`, JSON.stringify(result.texts, null, 2))
    await $.fs.write(`${dir}/plannotator/findings.json`, JSON.stringify({ findings: result.findings }, null, 2))
    await $.fs.write(`${dir}/plannotator/result.json`, JSON.stringify({ decision: record.decision, ids: result.ids }, null, 2))
    wake($, `Plannotator result for PR ${pr}: ${record.decision}, ids ${result.ids.join(',') || '—'}. Continue review-kit:pr-review-run, «In Plannotator» step 4: .review-kit/run/${pr}/plannotator/result.json`)
  } catch (error) {
    wake($, `Plannotator result for PR ${pr}: failed — ${(error as Error).message}. Continue review-kit:pr-review-run, «In Plannotator» step 4.`)
  }
```

В `settleFix` блок от `const parsed = …fix-result…` до конца — на:

```ts
  try {
    const { summary, feedback } = fixResult(decisionOf(stdout))
    await $.fs.write(`${dir}/plannotator/feedback.md`, `${feedback}\n`)
    await $.fs.write(`${dir}/plannotator/result.json`, JSON.stringify(summary, null, 2))
    wake($, `Plannotator result for PR ${pr} (fix): ${summary.decision}. ${step}: .review-kit/run/${pr}/plannotator/result.json`)
  } catch (error) {
    wake($, `Plannotator result for PR ${pr} (fix): failed — ${(error as Error).message}. ${step}.`)
  }
```

(запись `decision.out` остаётся как была — для разбора сбоев.)

- [ ] **Step 3: Удалить и проверить**

```bash
rm tools/plannotator.py
```

Run: `ls tools; grep -rn "plannotator.py\|python3" mod skills agents funnel; TMPDIR=$S node $S/tscheck.mjs mod/*.ts 2>&1 | grep -v ExperimentalWarning | grep -v '^ok'; node --test 'mod/**/*.test.ts' 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: в `tools/` только `open-pr-tab`; grep находит только `skills/pr-tab/SKILL.md` (до этапа 6); FAIL нет; `fail 0`.

**Стоп 3d: ждём «дальше» пользователя.**

---

# Этап 4: скиллы на инструментах мода

Тексты скиллов заменяются целиком: каждый шаг — один инструмент, нет путей к скриптам, нет «Forgejo». Здесь же мод пишет
в `context.json` флаг `plannotator` для проверки зависимостей раунда правок.

### Task 4.1: Флаг `plannotator` в `context.json`

**Files:**
- Modify: `mod/register.ts` (`startRun`)

- [ ] **Step 1: Реализация**

Перед записью `context.json` в `startRun`:

```ts
  const plannotator = await $.process.run(['plannotator', '--version']).then(result => result.exitCode === 0, () => false)
```

и в запись: `JSON.stringify({ ...context, ...switched, stash, model, scenario, plannotator })`.

Решение: наличие проверяется запуском `plannotator --version` (нет бинаря → отклонённый промис или ненулевой код →
`false`). Платформа 3.0 — POSIX (Linux, macOS, WSL): мод и так вызывает `rm`, `ls`, `git`; нативная Windows без WSL не
поддерживается, поэтому обёртка `cmd.exe` для `.cmd` не нужна (README говорит про WSL).

- [ ] **Step 2: Проверка**: `TMPDIR=$S node $S/tscheck.mjs mod/register.ts 2>&1 | grep -v ExperimentalWarning` → `ok mod/register.ts`.

### Task 4.2: `pr-flow` и `pr-review-run`

**Files:**
- Modify: `skills/pr-flow/SKILL.md` (целиком), `skills/pr-review-run/SKILL.md` (целиком)

- [ ] **Step 1: `skills/pr-flow/SKILL.md`**

```markdown
---
name: pr-flow
description: Use when the user asks in words to look at, review or check a pull request («посмотри PR 140», «что там по 134 пра», «есть что ревьюить?») without typing /pr. Not for own fixes.
---

# pr-flow

Call `review_start` with `pr` = the PR number the user named (omit it when they named none). Show its answer as is.
If the answer tells you to use a review-kit skill, use that skill next. Do not switch branches, call the hosting or ask
the user anything yourself — the tool does that. `review_start` unavailable → «мод review-kit не загружен», stop.
```

- [ ] **Step 2: `skills/pr-review-run/SKILL.md`**

```markdown
---
name: pr-review-run
description: Use when review-kit opened a review run for a PR (.review-kit/run/<N>/context.json exists, scenario review) — review it with the agents and publish when the user asks. Not for own fixes.
---

# pr-review-run

The mod already switched the tree to the PR, asked for the model and opened the run. Read `.review-kit/run/<N>/context.json`:
`number`, `title`, `author`, `isOwn`, `state`, `status`, `baseFallback`. Ask nothing before the review.
No `context.json` → tell the user to run `/pr-review <N>` and stop.

## 1. Review

1. `review_prepare` with `pr`, `kind: "review"`. An answer starting with `review-kit:` → report it, `review_finish`, stop.
2. `Workflow` with the workflow's `scriptPath` and `args` (a JSON object). This instruction is the user's opt-in to the
   workflow. Wait for its completion notification; do nothing else meanwhile.
3. `review_collect` with `pr`, `id: "funnel"`, `outputFile` = the notification's `<output-file>`.
4. The workflow failed, left no output file, or `review_collect` answered `review-kit: …` → report «Ревью агентами не
   состоялось — не проверено» with that line, never a verdict; `review_finish`, stop.

## 2. Report

In Russian, in this order:
1. `Статус: <status>` from `context.json`.
2. The verdict with one line of reason: Blocked if any critical, Changes requested if any important, Approved with comments
   if only minor, Approved if none.
3. Each finding: its `id`, `file:line`, level (and its `mark`, if any), the problem, its failure scenario or the rule it breaks.
4. «Подтверждено, ниже порога», when `belowBar` is not empty: one line each, `<file>:<line> — <problem> · <level> · <confidence>%`
   (plus ` · <mark>`). These are never published.
5. «Не проверялось» — always: every `notChecked` entry, the count of `dropped` by reason, and, when `baseFallback` is true,
   «база ревью взята от main: базовая ветка PR удалена — в diff могут попасть чужие коммиты».

Levels: **critical** — breaks the product, loses data, or is exploitable; **important** — a measurable regression, a
concrete risk, or a project-rule violation a reviewer would send back; **minor** — style, naming, preference. A finding
states the problem, not the author. A rule quote stays in the report, never in a published comment.

Own PR (`isOwn`) or closed PR: the report is the result — `review_finish`, stop. A foreign open PR with no findings →
end with «Апрувим?».

## 3. Publish — only when the user asks

No findings and the user approves → `review_publish` with `pr`, `ids: []`, `approve: true` (the mod asks «Одобрить PR <N>
без комментариев?» itself) → section 4.

Otherwise AskUserQuestion «Где разбираем тексты ревью?» — «В чате», «В Plannotator».

### In chat

1. The user names the findings to publish (or «все»). Write `.review-kit/run/<N>/texts.json` =
   `{"summary": "<2–4 sentences about the problem, not the author; never mentions belowBar>", "comments": {"<id>": "<comment in Russian>"}}`,
   one comment per selected id.
2. Show the summary and every draft (`id`, `file:line`, text); apply the user's edits to `texts.json` until they say it is ready.
3. `review_publish` with `pr`, `ids`, and `approve: true` only if the verdict is Approved or Approved with comments and the
   user wants to approve. The tool shows the review and asks the user itself → section 4.

### In Plannotator

1. Write `texts.json` as in «In chat» step 1 for **every** finding; do not show the drafts in chat.
2. `review_plannotator` with `pr`. `unavailable: …` → show it and ask «Разобрать в чате?»; yes → «In chat»; no →
   `review_finish`, stop.
3. `started: …` → tell the user the URL, and that a rewritten comment must keep its first line `[id · …]`. End the turn and
   do nothing until a message «Plannotator result for PR <N>: …» arrives.
4. On it: `failed` → as step 2 `unavailable`. Read `.review-kit/run/<N>/plannotator/result.json`:
   - `dismissed` → «Ревью не публикуется: Plannotator закрыт без решения» → `review_finish`, stop;
   - empty `ids` and an empty `summary` in `plannotator/texts.json` → «Публиковать нечего» → `review_finish`, stop;
   - otherwise show the summary and every comment of `plannotator/texts.json` (`h…` ids are the human's own; edits the user
     asks for go into that file first), then `review_publish` with `pr`, `ids` from result.json, `from: "plannotator"` → section 4.

## 4. Finish

`published: <url>` → report the URL. `not published: …` → show the reason. An error with «статус публикации неизвестен» →
tell the user to check the PR before anything else; never publish again. Then `review_finish`.

The user does not want to publish → `review_finish`. Every stop of this skill ends with `review_finish`. Never call curl
or the hosting API; publishing goes only through `review_publish`.
```

### Task 4.3: `pr-recheck-run`, `pr-feedback-run`, `pr-fix-run`

**Files:**
- Modify: `skills/pr-recheck-run/SKILL.md`, `skills/pr-feedback-run/SKILL.md`, `skills/pr-fix-run/SKILL.md` (целиком)

- [ ] **Step 1: `skills/pr-recheck-run/SKILL.md`**

```markdown
---
name: pr-recheck-run
description: Use when review-kit opened a recheck run for a PR the user reviewed before (.review-kit/run/<N>/context.json with scenario recheck exists).
---

# pr-recheck-run

Read `.review-kit/run/<N>/context.json` (`status`) and `.review-kit/run/<N>/recheck.json` (`mode` — `delta` since my last
review or `full` with `note`; `prior` — my earlier comments). No `context.json` → tell the user to run `/pr-recheck <N>`
and stop. Ask nothing before the report.

1. `review_prepare` with `pr`, `kind: "recheck"` → two workflows, `statuses` and `delta`. An answer `review-kit: …` →
   report it, `review_finish`, stop.
2. `Workflow` for both (they may run together; this instruction is the user's opt-in), wait for both notifications, then
   `review_collect` for each with its `id` and `<output-file>`.
   - `statuses` failed → «Статусы агентом не проверены», then do them yourself: for each `prior` item read the place at the
     PR head and write `.review-kit/run/<N>/statuses.json` = `{"items": [{"id", "class": "closed"|"open"|"partial", "reason"}]}`.
   - `delta` failed → the report has «Дельта не проверена — <line>» instead of findings and no verdict.
3. Report in Russian: `Статус: <status>`; «Режим: дельта после моего ревью» or «Режим: проверено всё — <note>»;
   «Прошлые замечания» — each `prior` item as `<path>:<line>` (or «общее») — закрыто / не закрыто / частично / не проверено —
   reason; then the findings, «ниже порога» and «Не проверялось» as in section 2 of review-kit:pr-review-run. Verdict:
   Blocked if any critical; Changes requested if any important finding or any `open`/`partial` earlier comment; otherwise Approved.
4. Publish only when the user asks: section 3 of review-kit:pr-review-run; `review_publish` adds the statuses of
   `statuses.json` to the review body itself.
5. `review_finish`. Every stop of this skill ends with `review_finish`.
```

- [ ] **Step 2: `skills/pr-feedback-run/SKILL.md`**

```markdown
---
name: pr-feedback-run
description: Use when review-kit opened a feedback run for the user's own PR (.review-kit/run/<N>/context.json with scenario feedback exists).
---

# pr-feedback-run

Read `.review-kit/run/<N>/context.json` (`status`, `plannotator`) and `.review-kit/run/<N>/intake.json`. No `context.json`
→ tell the user to run `/pr-feedback <N>` and stop. Empty `items` → «Замечаний нет», `review_finish`, stop.

## 1. Triage

1. `review_prepare` with `pr`, `kind: "feedback"` → one workflow `triage`.
2. `Workflow` with its `scriptPath` and `args` (an object). This instruction is the user's opt-in. Wait for the notification.
3. `review_collect` with `pr`, `id: "triage"`, the notification's `<output-file>` → `.review-kit/run/<N>/triage.json`.
4. Any step failed → «Разбор агентом не состоялся» with the line, then triage yourself: for each item read the quoted
   place at the PR head and write `.review-kit/run/<N>/triage.json` = `{"items": [{"id", "class", "reason", "fixed"?}]}` with
   the classes of `${CLAUDE_PLUGIN_ROOT}/agents/triage.md` (valid / invalid / question / out-of-scope; a `stale` item already
   changed as asked is `valid` with `"fixed": true` and a reason saying where).

## 2. Summary

In Russian: `Статус: <status>`, then the items grouped by class: `<path>:<position>` (or «общий») — the substance of the
comment in words — `reason`. Items with `disagree` first, marked «ревьюер не согласен»; `valid` items with `fixed` marked
«уже исправлено». No hosting ids anywhere the user reads.

AskUserQuestion «Что делаем?» — «Чиним (ответы на остальное — в конце)», «Только ответить».
- «Чиним» → review-kit:pr-fix-run from its step 0 (it checks Plannotator and superpowers first); the run stays open.
  Every `valid` item has `fixed` → nothing to fix: go straight to «Replies» of review-kit:pr-fix-run.
- «Только ответить» → «Replies» of review-kit:pr-fix-run, then `review_finish`.
```

- [ ] **Step 3: `skills/pr-fix-run/SKILL.md`**

```markdown
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

For every item not fixed in this round (`invalid`, `question`, `out-of-scope`, items marked `disagree`, and `valid` items
with `fixed`) write a draft in Russian to `.review-kit/run/<N>/replies.json` = `{"replies": {"<id>": "<text>"}}`: invalid —
the explanation; question — the answer or a counter-question; out-of-scope — where it went; `fixed` — «Сделано: …» from its
`reason`. Items fixed in this round get no reply. Show every draft as `<path>:<position>` (or «общий») — text and apply the
user's edits. Then `replies_publish` with `pr` (it asks the user itself): `published: <n>` → report; `not published: …` →
show the reason.

Every stop ends with `review_finish`, except the Plannotator `unavailable`/`dismissed`/`failed` stops of steps 5–6.
Never call curl, never `git commit`/`git push`/`git rebase` yourself, never `--force`.
```

- [ ] **Step 4: Проверка**

Run: `grep -rniE "forgejo|python3|\.py|tools/|review_confirm|lite/" skills; grep -c "review_finish" skills/*/SKILL.md`
Expected: первый grep находит только `skills/pr-tab/SKILL.md` (этап 6); `review_finish` есть во всех, кроме `pr-flow` и `pr-tab`.

Живая проверка (с пользователем): `/pr-review`, `/pr-recheck`, `/pr-feedback` → «Чиним» → без Plannotator — остановка
«нужен Plannotator» до правок.

**Стоп 4: ждём «дальше» пользователя.**

---

# Этап 5: статусы PR

### Task 5.1: `statusOf` и список всех открытых PR

**Files:**
- Modify: `mod/status.ts`, `mod/status.test.ts`

**Interfaces:**
- Produces: `type Status = 'влит' | 'закрыт' | 'есть замечания' | 'на проверке' | 'перепроверка' | 'готов к слиянию' | 'ждём автора' | 'ждём ревью'`; `statusOf(data: PrData, scenario: Scenario): Status`; `PrContext.status: Status`; `ListRow.status: Status`; `pullRows(provider): Promise<{ rows: ListRow[]; truncated: boolean }>` вместо `actionableRows`.

- [ ] **Step 1: Тесты** (дописать в `mod/status.test.ts`; импорт `pullRows`, `statusOf`; тест `фейковый провайдер…` переписать на `pullRows`)

```ts
test('statusOf: по таблице спеки', () => {
  const approved = review('r5', 'carol', 'approved', 'h2', '2026-10-03T10:00:00Z')
  assert.equal(statusOf(data({ pull: pull({ state: 'closed', merged: true }) }), 'closed'), 'влит')
  assert.equal(statusOf(data({ pull: pull({ state: 'closed' }) }), 'closed'), 'закрыт')
  assert.equal(statusOf(own(), 'feedback'), 'есть замечания')
  assert.equal(statusOf(data(), 'review'), 'на проверке')
  assert.equal(statusOf(data(), 'recheck'), 'перепроверка')
  assert.equal(statusOf(own({ reviews: [approved] }), 'none-own'), 'готов к слиянию')
  assert.equal(statusOf(own(), 'none-own'), 'ждём ревью')
  assert.equal(statusOf(data({ reviews: [review('r1', 'alice', 'comment', 'h2')] }), 'wait-author'), 'ждём автора')
})

test('готов к слиянию: не при активном request changes и не при открытом треде; снятое ревью не мешает', () => {
  const approved = review('r5', 'carol', 'approved', 'h2', '2026-10-03T10:00:00Z')
  const changes = review('r6', 'dave', 'changes', 'h2', '2026-10-03T11:00:00Z')
  assert.equal(statusOf(own({ reviews: [approved, changes] }), 'none-own'), 'ждём ревью')
  assert.equal(statusOf(own({ reviews: [approved, { ...changes, dismissed: true }] }), 'none-own'), 'готов к слиянию')
  const open = thread([comment('c1', 'carol', 'x', '2026-10-01T10:00:00Z'), comment('c2', 'alice', 'ок', '2026-10-01T11:00:00Z')])
  assert.equal(statusOf(own({ reviews: [approved], threads: [open] }), 'none-own'), 'ждём ревью')
})

test('pullRows: все открытые, с делом — первыми; ровно 50 — truncated', async () => {
  const pulls = [pull({ number: 1 }), pull({ number: 2, author: 'alice' }), pull({ number: 3 })]
  const fake = fakeProvider({ me: 'alice', pulls, reviews: { 3: [review('r3', 'alice', 'comment', 'h2')] } })
  const { rows, truncated } = await pullRows(fake)
  assert.deepEqual(rows.map(r => [r.number, r.status]), [[1, 'на проверке'], [2, 'ждём ревью'], [3, 'ждём автора']])
  assert.equal(truncated, false)
  const many = fakeProvider({ me: 'alice', pulls: Array.from({ length: 50 }, (_, i) => pull({ number: i + 1 })) })
  assert.equal((await pullRows(many)).truncated, true)
})
```

(в старом тесте четырёх сценариев строку `actionableRows` заменить на
`assert.deepEqual((await pullRows(fake)).rows.filter(r => ACTIONABLE.includes(r.scenario)).map(r => [r.number, r.scenario]), [[1, 'feedback'], [2, 'review'], [3, 'recheck']])`
и импортировать `ACTIONABLE`.)

- [ ] **Step 2: Запустить — падает** (нет экспорта `statusOf`).

- [ ] **Step 3: Реализация** (`mod/status.ts`)

```ts
/** статус PR для пользователя */
export type Status = 'влит' | 'закрыт' | 'есть замечания' | 'на проверке' | 'перепроверка' | 'готов к слиянию' | 'ждём автора' | 'ждём ревью'
/** сколько PR читает адаптер за раз */
const PULL_LIMIT = 50
/** сколько PR /pr загружает одновременно: 50 PR по ~4 запроса подряд ждали бы минуты */
const PULL_CONCURRENCY = 4

/** есть approve, нет активного request changes (последнее ревью каждого ревьюера, не снятое), нет открытых тредов */
function readyToMerge(data: PrData): boolean {
  const { reviews, threads } = live(data)
  const latest = new Map<string, Review>()
  for (const review of [...reviews].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt))) latest.set(review.author.toLowerCase(), review)
  const active = [...latest.values()].filter(review => !review.dismissed)
  return active.some(review => review.state === 'approved') && !active.some(review => review.state === 'changes') && threads.every(thread => thread.resolved)
}

/** статус PR по сценарию и данным */
export function statusOf(data: PrData, scenario: Scenario): Status {
  if (scenario === 'closed') return data.pull.merged ? 'влит' : 'закрыт'
  if (scenario === 'feedback') return 'есть замечания'
  if (scenario === 'review') return 'на проверке'
  if (scenario === 'recheck') return 'перепроверка'
  if (readyToMerge(data)) return 'готов к слиянию'
  return scenario === 'wait-author' ? 'ждём автора' : 'ждём ревью'
}

/** открытые PR со сценарием и статусом: с делом — первыми (свои раньше), затем остальные по номеру;
 * currentUser в loadPr лишних запросов не даёт: forgejo.ts этапа 2 кеширует логин на экземпляр (тест «currentUser: один
 * запрос на сессию») */
export async function pullRows(provider: ForgeProvider): Promise<{ rows: ListRow[]; truncated: boolean }> {
  const pulls = await provider.listPulls('open')
  const rows: ListRow[] = []
  for (let at = 0; at < pulls.length; at += PULL_CONCURRENCY) {
    const batch = await Promise.all(pulls.slice(at, at + PULL_CONCURRENCY).map(async pull => {
      const data = await loadPr(provider, pull.number, pull)
      const scenario = scenarioOf(data)
      return { number: pull.number, title: pull.title, author: pull.author, isOwn: same(pull.author, data.me), scenario, status: statusOf(data, scenario) }
    }))
    rows.push(...batch)
  }
  const rank = (row: ListRow) => (ACTIONABLE.includes(row.scenario) ? 0 : 1)
  return { rows: rows.sort((a, b) => rank(a) - rank(b) || Number(b.isOwn) - Number(a.isOwn) || a.number - b.number), truncated: pulls.length >= PULL_LIMIT }
}
```

`ListRow` и `PrContext` — добавить поле `/** статус для пользователя */ status: Status`; `contextOf(data, scenario)` — добавить
`status: statusOf(data, scenario)`. Функцию `actionableRows` удалить. Тест `contextOf` дополнить ожидаемым `status: 'ждём ревью'`.

- [ ] **Step 4: Запустить — проходит**: `node --test mod/status.test.ts` → `fail 0`.

### Task 5.2: `/pr` со статусами

**Files:**
- Modify: `mod/register.ts` (`routePr`, константа `SCENARIO_LABEL` удаляется)

- [ ] **Step 1: Реализация** — начало `routePr` для `pr === undefined`:

```ts
    const { rows, truncated } = await pullRows(await forge($))
    const actionable = rows.filter(row => ACTIONABLE.includes(row.scenario))
    const line = (row: ListRow) => `#${row.number} ${row.status} — ${row.title}`
    const tail = truncated ? '\nПрочитано 50 открытых PR — это предел одного запроса; если PR больше, остальные — /pr <номер>' : ''
    if (actionable.length === 0) return withCleanup($, rows.length ? `Открытые PR:\n${rows.map(line).join('\n')}\nДелать нечего.${tail}` : 'Открытых PR нет.', 0)
    const labels = actionable.map(line)
    const others = rows.filter(row => !actionable.includes(row))
    const rest = others.length ? `\nОстальные:\n${others.map(line).join('\n')}` : ''
    if (actionable.length > MAX_DIALOG_OPTIONS) return `PR, по которым есть дело:\n${labels.join('\n')}${rest}\nВыберите: /pr <номер>${tail}`
```

(дальше — прежний диалог по `labels` и `actionable[labels.indexOf(chosen)]`). Импорт: `ACTIONABLE, pullRows` вместо `actionableRows`.

- [ ] **Step 2: Проверка**: tscheck `ok`; `node --test 'mod/**/*.test.ts'` → `fail 0`. Живая: `/pr` — все открытые PR со статусами,
отчёт `/pr-review` начинается строкой `Статус: …`.

**Стоп 5: ждём «дальше» пользователя.**

---

# Этап 6: `pr-tab` с fallback без Orca

### Task 6.1: Worktree ревью и вкладка

**Files:**
- Modify: `mod/git.ts` (`createReviewWorktree`), `mod/git.test.ts`
- Modify: `mod/register.ts` (инструмент `review_tab`)
- Modify: `skills/pr-tab/SKILL.md` (целиком)
- Delete: `tools/open-pr-tab`, папка `tools/`

**Interfaces:**
- Consumes: `fetchHead` (сделать `export`), `claudeCodeChanges`, `changedFiles`, `gitText` (`git.ts`); `forge($)`.
- Consumes также `worktrees` (внутренняя, 3c.3), `IsActive` (3c.3).
- Produces: `worktreeName(root: string, number: number, headRef: string): string`; `shellQuote(text: string): string`; `createReviewWorktree(run, { root, number, headRef, headSha, baseRef, pullRef, isActive }): Promise<{ path: string; created: boolean; risky: string[] }>`; `excludeFile(run): Promise<string>`; инструмент `review_tab(prs: number[])`.

- [ ] **Step 1: Тест** (дописать в `mod/git.test.ts`)

```ts
import { createReviewWorktree, shellQuote, worktreeName } from './git.ts'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

test('worktree ревью: PR меняет настройки Claude Code — worktree не создаётся', async () => {
  const r = repo(); r.origin()
  r.commit('a.txt', '1', 'base'); r.git('push', '-q', 'origin', 'main')
  r.git('switch', '-qc', 'feat/x'); r.commit('.claude/settings.json', '{}', 'hook'); const head = r.git('rev-parse', 'HEAD'); r.git('push', '-q', 'origin', 'feat/x'); r.git('switch', '-q', 'main')
  const input = { root: r.dir, number: 7, headRef: 'feat/x', headSha: head, baseRef: 'main', pullRef: 'refs/pull/7/head' }
  assert.equal(worktreeName(r.dir, 7, 'feat/x'), `${r.dir}/.claude/worktrees/pr-7-feat-x`)
  assert.equal(worktreeName('/r', 7, "x';curl e|sh;'$(id)"), '/r/.claude/worktrees/pr-7-x--curl-e-sh----id-')
  assert.equal(shellQuote("/a b/it's"), `'/a b/it'\\''s'`)
  const first = await createReviewWorktree(r.run, { ...input, isActive: async () => false })
  assert.deepEqual([first.created, first.risky], [false, ['.claude/settings.json']])
  assert.equal(existsSync(first.path), false)
})

test('worktree ревью: создаётся; повтор ставит на новую голову PR; грязный или с активным прогоном — ошибка; без базы — отказ', async () => {
  const r = repo(); const bare = r.origin()
  r.commit('a.txt', '1', 'base'); r.git('push', '-q', 'origin', 'main')
  r.git('switch', '-qc', 'feat'); const first = r.commit('a.txt', '2', 'pr'); r.git('push', '-q', 'origin', 'feat')
  const input = { root: r.dir, number: 8, headRef: 'feat', headSha: first, baseRef: 'main', pullRef: 'refs/pull/8/head', isActive: async () => false }
  const tree = await createReviewWorktree(r.run, input)
  assert.deepEqual([tree.created, r.git('-C', tree.path, 'rev-parse', 'HEAD')], [true, first])
  const next = r.commit('a.txt', '3', 'pr more'); r.git('push', '-q', 'origin', 'feat')
  const again = await createReviewWorktree(r.run, { ...input, headSha: next })
  assert.deepEqual([again.created, r.git('-C', tree.path, 'rev-parse', 'HEAD')], [false, next])
  await assert.rejects(createReviewWorktree(r.run, { ...input, headSha: next, isActive: async () => true }), /ревью PR 8 уже идёт/)
  writeFileSync(join(tree.path, 'a.txt'), 'грязно')
  await assert.rejects(createReviewWorktree(r.run, { ...input, headSha: next }), /в worktree .* есть изменения/)
  spawnSync('git', ['-C', bare, 'update-ref', '-d', 'refs/heads/main'])
  r.git('update-ref', '-d', 'refs/remotes/origin/main')
  await assert.rejects(createReviewWorktree(r.run, { ...input, number: 9, baseRef: 'gone', headSha: next }), /базу PR не найти/)
})
```

- [ ] **Step 2: Запустить — падает** (нет экспорта `createReviewWorktree`).

- [ ] **Step 3: Реализация** (`mod/git.ts`; у `fetchHead` добавить `export`)

```ts
/** путь worktree ревью: <основное дерево>/.claude/worktrees/pr-<N>-<ветка>; в имени только [A-Za-z0-9._-] — имя ветки чужого PR не попадёт в shell */
export function worktreeName(root: string, number: number, headRef: string): string {
  return `${root}/.claude/worktrees/pr-${number}-${headRef.replace(/[^A-Za-z0-9._-]/g, '-')}`
}

/** строка в одинарных кавычках для shell */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** база PR для проверки настроек: merge-base с origin/<base>, запасной — с origin/main; нет обеих — ошибка */
async function prBase(run: Run, baseRef: string, target: string): Promise<string> {
  for (const ref of [...new Set([baseRef, 'main'])]) {
    await run(['git', 'fetch', '-q', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`])
    const merge = await run(['git', 'merge-base', `origin/${ref}`, target])
    if (merge.exitCode === 0) return merge.stdout.trim()
  }
  throw new Error(`базу PR не найти (нет ни origin/${baseRef}, ни origin/main) — настройки Claude Code не проверить, вкладку не открываю`)
}

/** worktree на голове PR (detached) и изменённые PR настройки Claude Code; существующий чистый worktree ставится на голову */
export async function createReviewWorktree(run: Run, input: { root: string; number: number; headRef: string; headSha: string; baseRef: string; pullRef: string; isActive: IsActive }): Promise<{ path: string; created: boolean; risky: string[] }> {
  const path = worktreeName(input.root, input.number, input.headRef)
  const { target } = await fetchHead(run, { ...input, own: false })
  const risky = claudeCodeChanges(await changedFiles(run, await prBase(run, input.baseRef, target), target))
  if (risky.length) return { path, created: false, risky }
  const exists = (await worktrees(run)).some(tree => tree.path === path)
  if (!exists) await gitText(run, ['worktree', 'add', '-q', '--detach', path, target])
  else {
    if (await input.isActive(path, input.number)) throw new Error(`ревью PR ${input.number} уже идёт в ${path} — продолжайте в той вкладке`)
    if ((await gitText(run, ['-C', path, 'status', '--porcelain', '--ignore-submodules=all'])).trim()) throw new Error(`в worktree ${path} есть изменения — уберите их или удалите worktree («убери вкладку ${input.number}»)`)
    await gitText(run, ['-C', path, 'switch', '-q', '--detach', target])
  }
  await gitText(run, ['-C', path, 'submodule', 'update', '--init', '-q'])
  return { path, created: !exists, risky }
}

/** файл исключений git основного репозитория (туда пишется .claude/worktrees/) */
export async function excludeFile(run: Run): Promise<string> {
  return (await gitText(run, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'])).trim()
}
```

Решения: при изменённых настройках Claude Code worktree не создаётся и не обновляется (`risky` непустой, `created: false`) —
проверка идёт по текущей голове PR и до решения о переиспользовании, так что прежний worktree на новый коммит с
`.claude/`-изменениями не встанет. Существующий worktree ставится на текущую голову PR, если он чистый. Имена `feat/x` и
`feat-x` у одного PR дали бы один путь — оба в одном PR невозможны (у PR одна ветка), коллизия возможна только между
разными PR с одинаковым номером, которых не бывает.

- [ ] **Step 4: Запустить — проходит**: `node --test mod/git.test.ts` → `fail 0`.

- [ ] **Step 5: Инструмент `review_tab`** (`mod/register.ts`)

```ts
/** бинарь Orca: переменная ORCA_BIN или orca.exe (WSL) */
const ORCA_DEFAULT = 'orca.exe'
/** строка .git/info/exclude: worktree ревью внутри дерева не видны git status и git add -A основного дерева */
const WORKTREES_EXCLUDE = '/.claude/worktrees/'

/** review_tab: worktree и вкладка Orca на каждый открытый PR; без Orca — ревью здесь */
async function openTabs($: EngineInterface, prs: number[]): Promise<string> {
  const run = runner($)
  const provider = await forge($)
  const root = (await gitText(run, ['worktree', 'list', '--porcelain'])).split('\n')[0].slice('worktree '.length)
  const exclude = await excludeFile(run)
  const excluded = await $.fs.read(exclude).then(String, () => '')
  if (!excluded.split('\n').includes(WORKTREES_EXCLUDE)) await $.fs.write(exclude, `${excluded}${excluded && !excluded.endsWith('\n') ? '\n' : ''}${WORKTREES_EXCLUDE}\n`)
  const orca = (await $.env.get('ORCA_BIN')) ?? ORCA_DEFAULT
  const hasOrca = await $.process.run([orca, '--version']).then(result => result.exitCode === 0, () => false)
  if (!hasOrca) {
    submitLater($, `/pr-review ${prs[0]}`, SUBMIT_ATTEMPTS)
    return `Orca не найдена — ревью PR ${prs[0]} запускаю в текущем дереве${prs.length > 1 ? `; остальные (${prs.slice(1).join(', ')}) — потом: /pr-review <номер>` : ''}`
  }
  const lines: string[] = []
  const here: number[] = []
  for (const number of prs) {
    const pull = await provider.getPull(number)
    if (pull.state === 'closed') { lines.push(`PR ${number} закрыт — вкладку не открываю`); continue }
    const tree = await createReviewWorktree(run, { root, number, headRef: pull.headRef, headSha: pull.headSha, baseRef: pull.baseRef, pullRef: provider.pullRef(number), isActive: isActive($) })
      .catch((error: Error) => ({ error: error.message }))
    if ('error' in tree) { lines.push(`PR ${number}: ${tree.error}`); continue }
    if (tree.risky.length) { lines.push(`PR ${number} меняет настройки Claude Code (${tree.risky.join(', ')}) — вкладку с новой сессией в режиме auto не открываю: там хуки и MCP из PR сработали бы без вопросов. Ревью здесь: /pr-review ${number} — мод спросит перед переключением дерева`); continue }
    const command = `cd ${shellQuote(tree.path)} && claude --permission-mode auto ${shellQuote(`/pr-review ${number}`)}`
    const opened = await $.process.run([orca, 'terminal', 'create', '--worktree', `path:${root}`, '--title', `review #${number}`, '--focus', '--json', '--command', command]).then(result => result.exitCode === 0, () => false)
    if (opened) lines.push(`PR ${number}: вкладка открыта (${tree.created ? 'новый' : 'прежний'} worktree ${tree.path})`)
    else here.push(number)
  }
  if (here.length) {
    lines.push(`Вкладку Orca открыть не удалось — ревью PR ${here[0]} запускаю в текущем дереве${here.length > 1 ? `; остальные (${here.slice(1).join(', ')}) — потом: /pr-review <номер>` : ''}. Неиспользованные worktree уберёт /pr cleanup`)
    submitLater($, `/pr-review ${here[0]}`, SUBMIT_ATTEMPTS)
  }
  return lines.join('\n')
}
```

`TOOL_SPECS`:

```ts
  {
    name: 'review_tab',
    description: 'Open a review of each named PR in its own git worktree and Orca tab (/pr-review N runs there). Without Orca the first review starts in this tree. A PR that changes Claude Code settings (.claude/, .mcp.json, CLAUDE.md…) gets no tab. Answers one line per PR.',
    inputSchema: { type: 'object', properties: { prs: { type: 'array', items: { type: 'number' } } }, required: ['prs'] },
    isDeferred: false,
  },
```

Обработчик `mcp__review-kit__review_tab` по образцу остальных (`openTabs($, e.prs)`).

- [ ] **Step 6: `skills/pr-tab/SKILL.md`**

```markdown
---
name: pr-tab
description: Use when the user asks to review a PR in a separate tab or worktree, to run several PR reviews in parallel («открой ревью 156 во вкладке», «запусти ревью 156, 157, 158 параллельно»), or to remove such a review worktree («убери вкладку 156»).
---

# pr-tab

Optional; the only part of review-kit that uses Orca. Each PR gets its own git worktree in `.claude/worktrees/` and an Orca
tab where `/pr-review N` runs. Nothing from the project is copied into the worktree.

## Open

Call `review_tab` with `prs` = the numbers the user named, in their order. Show its answer as is. Then stop: do not poll
the tabs. A closed tab keeps its worktree; `/pr cleanup` in the main tree offers to remove finished ones.

## Remove

1. `git worktree list --porcelain` → the worktree whose path ends in `/.claude/worktrees/pr-<N>-<branch>`. None → say so, stop.
2. `git -C <W> status --porcelain --ignore-submodules=all` not empty → AskUserQuestion «В worktree есть изменения — удалить
   вместе с ними?» (Удалить / Оставить); Оставить → stop.
3. `git worktree remove --force <W>` (`--force`: an initialised submodule). Branches stay — `/pr cleanup` offers them.
```

- [ ] **Step 7: Удалить `tools/` и проверить**

```bash
rm tools/open-pr-tab && rmdir tools
```

Run: `test ! -e tools && echo no-tools; grep -rnE "python3|tools/|forgejo\.py" mod skills agents funnel config types hooks; TMPDIR=$S node $S/tscheck.mjs mod/*.ts 2>&1 | grep -v ExperimentalWarning | grep -v '^ok'; node --test 'mod/**/*.test.ts' 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `no-tools`; grep пуст; FAIL нет; `fail 0`.

Живая: сначала `orca.exe --version; echo $?` — код 0. Если флага `--version` у CLI Orca нет, заменить проверку
`hasOrca` на другую безобидную команду CLI (например, `orca.exe --help`) до остальных проверок. Затем «открой ревью N во
вкладке» — с Orca вкладка; без Orca (`ORCA_BIN=/nonexistent`) — «Orca не найдена…» и `/pr-review N` здесь;
PR с изменённым `.claude/` — вкладки нет.

**Стоп 6: ждём «дальше» пользователя.**

---

# Этап 7: установка, документация, финальная проверка

### Task 7.1: Манифест, маркетплейс, выбор системы

**Files:**
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (целиком)

- [ ] **Step 1: `plugin.json`**

```json
{
  "name": "review-kit",
  "version": "3.0.0",
  "description": "Ревью PR воронкой агентов, разбор замечаний к своему PR, раунд правок и перепроверка — в текущей вкладке",
  "author": { "name": "prianikc" },
  "types": "./types/index.d.ts",
  "userConfig": {
    "forgejo": { "type": "boolean", "title": "Forgejo/Gitea", "description": "Работать с PR в репозиториях на Forgejo и Gitea (токен — переменная FORGEJO_TOKEN или GITEA_TOKEN)", "default": true }
  }
}
```

- [ ] **Step 2: `marketplace.json`**

```json
{
  "name": "review-kit",
  "owner": { "name": "prianikc" },
  "description": "review-kit — плагин Claude Code для работы с pull request'ами",
  "plugins": [{ "name": "review-kit", "source": ".", "description": "Ревью PR агентами, разбор замечаний, раунд правок, перепроверка" }]
}
```

- [ ] **Step 3: Проверка**: `claude plugin validate .` → `Validation passed`; предупреждения про author/description ушли.
Сверить с интерфейсом формулировку пути к настройкам: открыть `/plugin`, найти review-kit и пункт настройки; если он
называется не «Configure options», поправить текст ошибки в `mod/forge/index.ts` и тест `все выключены…` в `index.test.ts`.

### Task 7.2: README и ответ команде

**Files:**
- Create: `README.md`, `docs/reply-to-team.md`

- [ ] **Step 1: `README.md`**

````markdown
# review-kit

Плагин Claude Code для работы с pull request'ами прямо в текущей вкладке:

- `/pr` — открытые PR со статусами и выбор, чем заняться;
- `/pr-review N` — ревью чужого PR воронкой агентов (A ищет ошибки, B — нарушения правил проекта, C опровергает);
- `/pr-feedback N` — разбор замечаний к своему PR и ответы;
- `/pr-fix N` — раунд правок своего PR: план, правки, проверка агентами, Plannotator, commit и push;
- `/pr-recheck N` — перепроверка чужого PR после своего ревью;
- «открой ревью N во вкладке» — параллельные ревью во вкладках Orca.

Поддерживаемые системы: Forgejo и Gitea. Другие подключаются отдельными адаптерами.

## Установка

```
/plugin marketplace add prianikc/review-kit
/plugin install review-kit@review-kit
```

При включении плагин спрашивает, с какими системами работать (сейчас одна галочка — Forgejo/Gitea); изменить —
в `/plugin` → review-kit → настройки.

**Токен** — только переменная окружения: `FORGEJO_TOKEN` (или `GITEA_TOKEN`). Задайте её постоянно — в профиле shell
(`~/.bashrc`, `~/.zshrc`), иначе новые вкладки (`pr-tab`) её не увидят. Платформа — Linux, macOS или WSL на Windows;
нужен git 2.31 или новее.

Система и репозиторий определяются по `git remote get-url origin`. Для нестандартного remote (свой домен API, несколько
remote) — файл `.claude/review-kit.local.json` в проекте:

```json
{ "provider": "forgejo", "host": "git.example.org", "owner": "team", "repo": "app" }
```

**Зависимости.** Без внешних зависимостей работают ревью, перепроверка и разбор замечаний. Для отдельных сценариев нужны:
- Plannotator — раунд правок (проверка правок перед push) и, по желанию, разбор текстов ревью;
- плагин superpowers — планирование правок в раунде;
- Orca — вкладки `pr-tab`; без Orca ревью запускается в текущем дереве.

`npx skills` плагин не ставит: в нём есть мод (`mod/`), который ставится только как плагин Claude Code.

**Важно знать:**
- плагин не запускает lint, typecheck и тесты: при коммите срабатывает pre-commit проекта; если его нет, push раунда
  уходит без проверок;
- ревью чужого PR переключает дерево на его код. Если PR меняет `.claude/`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`,
  `AGENTS.md` или `.claude-plugin/`, мод спрашивает перед переключением: хуки и MCP из головы PR могут выполнить команды на
  вашей машине. `CLAUDE.md` рабочего дерева Claude Code подгружает сам. Вкладку `pr-tab` для такого PR мод не открывает
  вовсе: новая сессия во вкладке запускается в режиме `--permission-mode auto`, и спросить было бы некому;
- после версии 2.x удалите вручную, если остались: `.claude/review-kit.installed.json`, `.claude/skills/review-kit/`,
  файлы токена `~/.config/forgejo/…`, правила `.claude/rules/*review-kit*`.

## Как устроено

- **Мод** (`mod/`, TypeScript): команды `/pr…`, инструменты, которые зовут скиллы, guard прогона. Вся детерминированная
  работа — здесь: обращения к хостингу (`mod/forge/` — по адаптеру на систему), сценарий и статус PR (`status.ts`), вход
  агентам и сбор их ответов (`run/`), git (`git.ts`), Plannotator (`plannotator.ts`).
- **Инструменты мода**: `review_start`, `review_prepare`, `review_collect`, `review_publish`, `replies_publish`,
  `commit_push`, `review_plannotator`, `review_tab`, `review_finish`. Публикация и commit+push спрашивают подтверждение
  сами — ответ «да» в чате не публикует ничего.
- **Скиллы** (`skills/`): короткие сценарии для модели — что вызвать и как написать отчёт.
- **Агенты** (`agents/`): A `correctness`, B `quality` (работает, только если в проекте есть правила: `CLAUDE.md`,
  `AGENTS.md`, `.claude/rules/`, `.cursor/rules/`, `.github/copilot-instructions.md`; у чужого PR правила берутся с базы),
  C `refuter`, D `triage`. Запускаются только воркфлоу `funnel/`, и мод не принимает их ответ, пока они не прочитали
  свой манифест целиком.
- Внутри прогона мод отклоняет сырые `git commit`/`push`/`pull`, `--force`, `--amend`, `rebase` и запись по сети через
  curl/wget. Подтянуть ветку (`git pull --rebase`) пользователь делает сам.

## Разработка

Тесты: `node --test 'mod/**/*.test.ts'` (Node 24, без зависимостей). Запуск из папки: `claude --plugin-dir <путь к review-kit>`
в тестовом репозитории на Forgejo.
````

- [ ] **Step 2: `docs/reply-to-team.md`**

```markdown
# review-kit 3.0 — ответ на замечания

- **Команды проверок в плагине.** Убраны. Плагин ничего не запускает сам: при коммите раунда срабатывает pre-commit проекта.
- **Стек, best-practices, привязка к проекту.** Убраны. Агент B берёт правила только из того, что есть в репозитории
  (`CLAUDE.md`, `AGENTS.md`, `.claude/rules`, `.cursor/rules`, `.github/copilot-instructions.md`); нет правил — B не запускается.
- **Много Python, мода не видно.** Python и bash удалены целиком: вся работа — в TS-моде (`mod/`), покрыта тестами
  `node --test`. Скиллы стали короткими: один вызов инструмента на шаг.
- **Сложная установка.** `/plugin marketplace add prianikc/review-kit` и `/plugin install review-kit@review-kit`, токен — в
  переменной окружения. Установщика, копирования в проект и миграций нет. `npx skills` не подходит: он не ставит мод.
- Плагин больше не привязан к Forgejo: хостинг — отдельный адаптер; GitHub и GitLab добавляются без изменений ядра.
```

### Task 7.3: `CLAUDE.md`, `PLAN.md`, финальная проверка

**Files:**
- Modify: `CLAUDE.md`, `PLAN.md`

- [ ] **Step 1: `CLAUDE.md`** — привести к 3.0:
  - раздел «Текущее состояние» заменить на «Версия 3.0. Спека — `docs/superpowers/specs/2026-10-12-review-kit-3-design.md`; `PLAN.md` — исходный план, решения спеки его уточняют»;
  - таблица «Устройство»: убрать строку `tools/`; `mod/register.ts` — инструменты `review_start`, `review_prepare`, `review_collect`, `review_publish`, `replies_publish`, `commit_push`, `review_plannotator`, `review_tab`, `review_finish`; добавить строки `mod/forge/`, `mod/status.ts`, `mod/run/`, `mod/git.ts`, `mod/plannotator.ts`, `mod/testing/`; убрать абзац «Целевая структура мода 3.0…»;
  - инварианты: «Необратимые действия … только после инструмента `review_confirm` …» → «Необратимые действия (публикация ревью или ответов, commit+push раунда) — только инструментами `review_publish`, `replies_publish`, `commit_push`: каждый сам спрашивает подтверждение, «да» в чате не считается»; «внешние эффекты только через инструменты/скрипты кита» → «…только через инструменты мода»;
  - «Принципы 3.0», пункт «Ноль внешних зависимостей…» → «Плагин не требует правил проекта, Python и nx. Внешние зависимости: Plannotator и superpowers — раунд правок; Orca — `pr-tab` (с fallback)»;
  - «Запуск и проверка»: строку о `${CLAUDE_PLUGIN_ROOT}` переписать — скиллы ссылаются через неё на файлы плагина (`agents/triage.md` в `pr-feedback-run`), скриптов больше нет; финальный grep — из Step 3 ниже; добавить «Платформа — POSIX (Linux, macOS, WSL)».
- [ ] **Step 2: `PLAN.md`** — в начало добавить:

```markdown
> Выполнено в 3.0. Решения, уточнившие этот план (Plannotator и superpowers остаются, правила агента B ищет мод,
> токен только из окружения, подтверждение внутри инструментов вместо `review_confirm`), — в
> `docs/superpowers/specs/2026-10-12-review-kit-3-design.md`.
```

- [ ] **Step 3: Финальная проверка**

Run:

```bash
node --test 'mod/**/*.test.ts' 2>&1 | grep -E "^ℹ (pass|fail)"
TMPDIR=$S node $S/tscheck.mjs mod/*.ts mod/*/*.ts 2>&1 | grep -v ExperimentalWarning | grep -v '^ok'
claude plugin validate . 2>&1 | tail -2
grep -rniE "forgejo|gitea|/api/v1" --exclude-dir=forge --exclude-dir=docs --exclude-dir=.git --exclude=README.md --exclude=plugin.json --exclude=PLAN.md --exclude=CLAUDE.md --exclude-dir=.superpowers .
grep -rE "python3|ai-dev-kit|nx |apps/|best-practices|review-lite|1\.17|\.claude/skills/review-kit|simplify" --exclude-dir=docs --exclude-dir=.git --exclude-dir=.superpowers --exclude=PLAN.md --exclude=CLAUDE.md .
```

Expected: `fail 0`; FAIL нет; `Validation passed`; оба grep пусты. (Шаблон чистоты из `PLAN.md` без `plannotator`,
`CLAUDE\.md`, `AGENTS\.md`, `\.claude/rules`: они законно есть в поиске правил, README и проверке настроек Claude Code.)

- [ ] **Step 4: Живая проверка по спеке (с пользователем)** — чистый репозиторий на Forgejo без nx, CLAUDE.md, правил,
Python и Orca: установка через `/plugin install` с вопросом о системе; `/pr` со статусами; `/pr-review N` (A→C, B не
запускается); `/pr-feedback N` → «Чиним» → `commit_push` с pre-commit проекта; `/pr-recheck N`; `pr-tab` без Orca.

**Стоп 7: 3.0 готов.**

<!-- END -->
