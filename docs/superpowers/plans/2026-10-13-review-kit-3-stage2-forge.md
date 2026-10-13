# review-kit 3.0 — этап 2: интерфейс хостинга и адаптер Forgejo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Появляются общая модель хостинга (`mod/forge/types.ts`), адаптер Forgejo/Gitea на `fetch` (`mod/forge/forgejo.ts`),
выбор адаптера и токена (`mod/forge/index.ts`), фейковый провайдер для будущих тестов ядра и каркас юнит-тестов на
`node --test` — без подключения к `register.ts` (это этап 3).

**Architecture:** Чистые модули без импорта `'claude-code'`: HTTP, переменные окружения и паузы приходят параметром
(`ProviderDeps`), поэтому всё тестируется в Node без Claude Code и без сети. Адаптер разделён на описание
(`ForgeAdapter`: id, имя, переменные токена, `detect`) и экземпляр (`ForgeProvider`: запросы к API), потому что
`detect` и имя переменной нужны до того, как есть токен. Всё, что специфично для Forgejo (`/api/v1`, `APPROVED`,
`new_position`, ключ треда, `refs/pull/N/head`), живёт только в `forgejo.ts`.

**Tech Stack:** TypeScript, исполняемый Node 24 без сборки (стирание типов), `node:test` + `node:assert`, без зависимостей.

**Spec:** `docs/superpowers/specs/2026-10-12-review-kit-3-design.md` (разделы «Хостинг», «Ошибки», «Тесты», «Этапы» п. 2)

## Global Constraints

- Стираемый TS: нет `enum`, `namespace`, параметр-свойств конструктора; относительные импорты с расширением `.ts`; из `'claude-code'` — только `import type` (в этом этапе не нужен вовсе).
- Стиль `mod/`: без точек с запятой, одинарные кавычки, константы `UPPER_CASE` в начале файла; `const` по умолчанию.
- Вне `mod/forge/` нет обращений к API и слов Forgejo/Gitea; записанные ответы API — в `mod/forge/fixtures/`.
- Тексты для пользователя — на русском.
- Компилятора TypeScript в системе нет и ставить зависимости нельзя: типы не проверяются, тесты проверяют поведение. Синтаксис — `tscheck.mjs` из этапа 1 (scratchpad `$S`).
- Ограничение 50 — только у `listPulls`; `listReviews` и общие комментарии читаются всеми страницами.
- Токен — только из переменных окружения адаптера (`FORGEJO_TOKEN`, затем `GITEA_TOKEN`); файлы токена 2.2 не читаются.
- В плане нет шагов `git add`/`git commit`: коммиты — только по просьбе пользователя.

## Review Focus

1. Remote в форме `git@host:owner/repo.git`, `ssh://git@host:2222/owner/repo.git`, `https://host:3000/owner/repo` (без `.git`, со слешем в конце) → правильные `host/owner/repo` (Task 2, тест `parseRemote`).
2. Сеть оборвалась во время публикации ревью, а ревью на сервере создалось → адаптер находит его и не даёт опубликовать дважды; не нашёл за 3 попытки → ошибка «статус публикации неизвестен» (Task 3, тесты reconcile).
3. В PR больше 50 ревью или общих комментариев → свежие не теряются (Task 2, тест пагинации).
4. Ревьюер-«призрак» (удалённый пользователь, `user: null`) в ответе API → маппинг не падает, автор пустой (Task 2, тест).
5. Явная настройка `provider` при снятой галочке и при чужом remote → используется явная настройка (Task 4, тест).

---

## Что на этом этапе не делаем

- Не подключаем `forge/` к `register.ts` и не удаляем `forgejo.py`/`pr_context.py` — этап 3.
- Не пишем `status.ts`, `run.ts`, `git.ts` — этап 3; фейковый провайдер только создаётся и проверяется сам.
- Не добавляем `userConfig` в `plugin.json` — этап 7; до него `options` пустые и все адаптеры считаются включёнными.
- Не читаем `.claude/review-kit.local.json` — `selectProvider` получает уже прочитанный конфиг (чтение файла — этап 3).
- Ответы API в `fixtures/` составлены по документированной форме API Forgejo v1 и полям, которые читает `pr_context.py`; записать настоящие ответы с сервера — при живой проверке (нужны токен и доступ).
- Не пагинируем `GET /pulls/N/reviews/{id}/comments`: в Forgejo этот эндпоинт без пагинации (так же читает 2.2).

## Карта файлов

| Файл | Что это |
|---|---|
| `mod/forge/types.ts` | общая модель, `ForgeProvider`, `ForgeAdapter`, `ProviderDeps`, `Http` |
| `mod/forge/forgejo.ts` | адаптер: разбор remote, запросы, пагинация, маппинг, публикация с reconcile |
| `mod/forge/index.ts` | реестр адаптеров и `selectProvider` (явный конфиг, галочки, remote, токен) |
| `mod/forge/fake.ts` | фейковый провайдер в памяти для тестов ядра на этапе 3 |
| `mod/forge/fixtures/*.json` | ответы API Forgejo для тестов |
| `mod/forge/*.test.ts` | юнит-тесты (`node --test`) |
| `CLAUDE.md` | раздел «Запуск и проверка»: команда тестов |

## Отклонения от спеки (решения)

- `detect` и `tokenEnv` вынесены из `ForgeProvider` в `ForgeAdapter` (описание адаптера): `detect` нужен до токена, а `ForgeProvider` создаётся уже с токеном. Ядро по-прежнему не знает систем: `id`, `name`, `tokenEnv` берёт из адаптера.
- В `Review` добавлено поле `dismissed`: без него `status.ts` не отличит «активный request changes» (строка «готов к слиянию» в спеке).
- Обзоры в состоянии `REQUEST_REVIEW` (это запрос ревью, а не ревью) адаптер не возвращает.
- `detect` у Forgejo принимает любой разбираемый remote, кроме `github.com`, `gitlab.com`, `bitbucket.org`: по URL самохостинг Forgejo не отличить, для чужих случаев есть явная настройка.

---

### Task 1: Каркас тестов и общая модель

**Files:**
- Create: `mod/forge/types.ts`
- Create: `mod/forge/fake.ts`
- Test: `mod/forge/fake.test.ts`
- Modify: `CLAUDE.md` (раздел «Запуск и проверка»)

**Interfaces:**
- Produces: типы `PullRequest`, `Comment`, `Thread`, `Review`, `Verdict`, `ReviewDraft`, `Reply`, `Repo`, `HttpInit`, `HttpResponse`, `Http`, `ProviderDeps`, `ForgeProvider`, `ForgeAdapter` (точно как ниже); `fakeProvider(data: FakeData): FakeProvider`.

- [ ] **Step 1: Убедиться, что `node --test` находит `*.test.ts`**

Run: `node --test 'mod/**/*.test.ts' 2>&1 | tail -3`
Expected: сообщение о том, что тестов нет, или `tests 0` — без ошибки «unknown option». Если glob не поддержан — во всех шагах ниже вместо glob перечислять файлы явно: `node --test mod/forge/fake.test.ts mod/forge/forgejo.test.ts mod/forge/index.test.ts`.

- [ ] **Step 2: Написать тест фейкового провайдера**

`mod/forge/fake.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeProvider } from './fake.ts'

const PULL = { number: 7, title: 't', author: 'bob', headRef: 'f', headSha: 'h1', baseRef: 'main', state: 'open' as const, merged: false, url: 'u' }

test('fake отдаёт данные и запоминает публикации', async () => {
  const fake = fakeProvider({ me: 'alice', pulls: [PULL], reviews: { 7: [] } })
  assert.equal(await fake.currentUser(), 'alice')
  assert.deepEqual(await fake.listPulls('open'), [PULL])
  assert.deepEqual(await fake.getPull(7), PULL)
  assert.deepEqual(await fake.listReviews(7), [])
  assert.deepEqual(await fake.listThreads(7), { threads: [], general: [] })
  const draft = { verdict: 'comment' as const, body: 'b', comments: [] }
  assert.deepEqual(await fake.publishReview(7, draft), { url: 'fake://7/review/1' })
  await fake.publishReplies(7, [{ body: 'ok' }])
  assert.deepEqual(fake.published, [{ number: 7, draft }])
  assert.deepEqual(fake.replied, [{ number: 7, replies: [{ body: 'ok' }] }])
})

test('fake: неизвестный PR — ошибка', async () => {
  const fake = fakeProvider({ me: 'alice', pulls: [] })
  await assert.rejects(fake.getPull(1), /PR 1 не найден/)
})
```

- [ ] **Step 3: Запустить — падает**

Run: `node --test mod/forge/fake.test.ts 2>&1 | tail -5`
Expected: FAIL — `Cannot find module '.../mod/forge/fake.ts'`.

- [ ] **Step 4: Создать `mod/forge/types.ts`**

```ts
/** PR в общей модели: поля, одинаковые для всех систем */
export interface PullRequest {
  /** номер PR */
  number: number
  /** заголовок */
  title: string
  /** логин автора ('' — пользователь удалён) */
  author: string
  /** ветка PR */
  headRef: string
  /** коммит головы PR */
  headSha: string
  /** ветка, в которую PR вливается */
  baseRef: string
  /** открыт или закрыт; влитой PR — тоже closed */
  state: 'open' | 'closed'
  /** влит ли PR */
  merged: boolean
  /** ссылка на PR для пользователя */
  url: string
}

/** комментарий: в треде к строке кода или общий к PR */
export interface Comment {
  /** id комментария в системе */
  id: string
  /** логин автора ('' — пользователь удалён) */
  author: string
  /** текст */
  body: string
  /** время создания, ISO 8601 */
  createdAt: string
  /** файл — только у комментариев к коду */
  path?: string
  /** строка в файле на коммите commitSha — только у комментариев к коду */
  line?: number
  /** коммит, к которому оставлен комментарий к коду */
  commitSha?: string
  /** ревью, в составе которого оставлен комментарий к коду */
  reviewId?: string
}

/** тред: комментарии к одному месту кода в порядке создания */
export interface Thread {
  /** непрозрачный для ядра id; адаптер по нему отвечает в тред */
  id: string
  /** файл треда */
  path?: string
  /** строка треда */
  line?: number
  /** коммит, к которому открыт тред */
  commitSha?: string
  /** комментарии по времени, первый — открывший тред */
  comments: Comment[]
  /** тред помечен решённым */
  resolved: boolean
}

/** ревью PR */
export interface Review {
  /** id ревью в системе */
  id: string
  /** логин ревьюера ('' — пользователь удалён) */
  author: string
  /** одобрено / нужны правки / комментарий / черновик */
  state: 'approved' | 'changes' | 'comment' | 'pending'
  /** общий текст ревью */
  body: string
  /** коммит, на котором сделано ревью */
  commitSha: string
  /** время отправки, ISO 8601 ('' у черновика) */
  submittedAt: string
  /** ревью снято (не действует) */
  dismissed: boolean
}

/** итог ревью, который ядро просит опубликовать */
export type Verdict = 'approve' | 'request-changes' | 'comment'

/** ревью к публикации */
export interface ReviewDraft {
  /** вердикт; адаптер маппит его на состояния своей системы */
  verdict: Verdict
  /** общий текст ревью */
  body: string
  /** комментарии к строкам кода на голове PR */
  comments: Array<{ path: string; line: number; body: string }>
}

/** ответ: в тред (threadId) или общим комментарием с цитатой (quote) */
export interface Reply {
  /** тред, в который отвечаем; нет — общий комментарий */
  threadId?: string
  /** первая строка цитируемого замечания для общего ответа */
  quote?: string
  /** текст ответа */
  body: string
}

/** репозиторий на хостинге */
export interface Repo {
  /** хост веб-интерфейса и API */
  host: string
  /** владелец (пользователь или организация) */
  owner: string
  /** имя репозитория */
  repo: string
}

/** параметры HTTP-запроса — подмножество $.http.fetch */
export interface HttpInit {
  /** GET по умолчанию */
  method?: string
  /** заголовки запроса */
  headers?: Record<string, string>
  /** тело запроса, текст */
  body?: string
}

/** ответ HTTP — форма $.http.fetch */
export interface HttpResponse {
  /** код статуса */
  status: number
  /** true для 2xx */
  ok: boolean
  /** заголовки, имена в нижнем регистре */
  headers: Record<string, string>
  /** тело ответа, текст */
  text: string
}

/** HTTP-клиент: в моде — $.http.fetch, в тестах — заглушка; сетевая ошибка — reject */
export type Http = (url: string, init?: HttpInit) => Promise<HttpResponse>

/** всё, что адаптеру нужно извне, чтобы работать без Claude Code */
export interface ProviderDeps {
  /** репозиторий, с которым работаем */
  repo: Repo
  /** токен API */
  token: string
  /** HTTP-клиент */
  http: Http
  /** пауза между повторами */
  sleep: (ms: number) => Promise<void>
}

/** экземпляр адаптера: чтение PR и публикация от имени пользователя */
export interface ForgeProvider {
  /** имя системы для текстов пользователю */
  name: string
  /** что система умеет; ядро деградирует явно, а не гадает */
  capabilities: { inline: boolean; requestChanges: boolean }
  /** логин владельца токена */
  currentUser(): Promise<string>
  /** открытые или закрытые PR, не больше 50 */
  listPulls(state: 'open' | 'closed'): Promise<PullRequest[]>
  /** один PR */
  getPull(number: number): Promise<PullRequest>
  /** все ревью PR, включая черновики */
  listReviews(number: number): Promise<Review[]>
  /** все треды к коду и все общие комментарии PR */
  listThreads(number: number): Promise<{ threads: Thread[]; general: Comment[] }>
  /** публикует ревью, возвращает ссылку на него */
  publishReview(number: number, draft: ReviewDraft): Promise<{ url: string }>
  /** публикует ответы по одному, по порядку */
  publishReplies(number: number, replies: Reply[]): Promise<void>
  /** git-ссылка на голову PR, работающая и для PR из форков */
  pullRef(number: number): string
}

/** описание адаптера: то, что нужно до токена, и фабрика экземпляра */
export interface ForgeAdapter {
  /** ключ галочки userConfig и значение provider в конфиге проекта */
  id: string
  /** имя системы для текстов пользователю */
  name: string
  /** переменные окружения с токеном, по порядку */
  tokenEnv: readonly string[]
  /** узнаёт свой remote; null — не наш */
  detect(remoteUrl: string): Repo | null
  /** создаёт экземпляр для репозитория и токена */
  create(deps: ProviderDeps): ForgeProvider
}
```

- [ ] **Step 5: Создать `mod/forge/fake.ts`**

```ts
import type { Comment, ForgeProvider, PullRequest, Reply, Review, ReviewDraft, Thread } from './types.ts'

/** данные, которые отдаёт фейковый провайдер */
export interface FakeData {
  /** логин «текущего пользователя» */
  me: string
  /** PR в системе */
  pulls: PullRequest[]
  /** ревью по номеру PR */
  reviews?: Record<number, Review[]>
  /** треды и общие комментарии по номеру PR */
  threads?: Record<number, { threads: Thread[]; general: Comment[] }>
}

/** фейковый провайдер, который ещё и запоминает публикации */
export type FakeProvider = ForgeProvider & {
  /** опубликованные ревью по порядку */
  published: Array<{ number: number; draft: ReviewDraft }>
  /** опубликованные ответы по порядку */
  replied: Array<{ number: number; replies: Reply[] }>
}

/** провайдер в памяти для тестов ядра: без сети и без системы */
export function fakeProvider(data: FakeData): FakeProvider {
  const published: FakeProvider['published'] = []
  const replied: FakeProvider['replied'] = []
  const pull = (number: number): PullRequest => {
    const found = data.pulls.find(item => item.number === number)
    if (!found) throw new Error(`PR ${number} не найден`)
    return found
  }
  return {
    name: 'Fake',
    capabilities: { inline: true, requestChanges: true },
    published,
    replied,
    currentUser: async () => data.me,
    listPulls: async state => data.pulls.filter(item => item.state === state),
    getPull: async number => pull(number),
    listReviews: async number => data.reviews?.[number] ?? [],
    listThreads: async number => data.threads?.[number] ?? { threads: [], general: [] },
    publishReview: async (number, draft) => {
      published.push({ number, draft })
      return { url: `fake://${number}/review/${published.length}` }
    },
    publishReplies: async (number, replies) => {
      replied.push({ number, replies })
    },
    pullRef: number => `refs/pull/${number}/head`,
  }
}
```

`getPull` бросает синхронно внутри `async` — это превращается в отклонённый промис, как ждёт тест.

- [ ] **Step 6: Запустить — проходит**

Run: `node --test mod/forge/fake.test.ts 2>&1 | tail -8`
Expected: `pass 2`, `fail 0`.

- [ ] **Step 7: Синтаксис и `CLAUDE.md`**

Run: `TMPDIR=$S node $S/tscheck.mjs mod/forge/types.ts mod/forge/fake.ts 2>&1 | grep -v ExperimentalWarning`
Expected: `ok` для обоих.

В `CLAUDE.md`, раздел «Запуск и проверка», первую строку «Сборки и тестов пока нет …» заменить на:

```markdown
- Сборки нет. Юнит-тесты мода: `node --test 'mod/**/*.test.ts'` (Node 24, TS без сборки, без зависимостей).
  Компилятора TypeScript нет — типы не проверяются, поэтому код мода пишется в «стираемом» TS.
```

---

### Task 2: Адаптер Forgejo — разбор remote, чтение и маппинг

**Files:**
- Create: `mod/forge/forgejo.ts`
- Create: `mod/forge/fixtures/pull.json`, `reviews.json`, `review-comments-11.json`, `review-comments-12.json`, `issue-comments.json`
- Test: `mod/forge/forgejo.test.ts`

**Interfaces:**
- Consumes: типы из `mod/forge/types.ts` (Task 1).
- Produces: `parseRemote(url: string): Repo | null`; `forgejo: ForgeAdapter` (`id: 'forgejo'`, `name: 'Forgejo/Gitea'`, `tokenEnv: ['FORGEJO_TOKEN', 'GITEA_TOKEN']`); экземпляр с методами чтения. Публикация — Task 3 в этом же файле.

- [ ] **Step 1: Фикстуры**

`mod/forge/fixtures/pull.json`:

```json
{
  "number": 42, "title": "Добавить экспорт", "state": "open", "merged": false,
  "html_url": "https://git.example.org/team/app/pulls/42",
  "user": { "login": "Bob" },
  "head": { "ref": "feature/export", "sha": "aaa111" },
  "base": { "ref": "main" }
}
```

`mod/forge/fixtures/reviews.json`:

```json
[
  { "id": 11, "user": { "login": "alice" }, "state": "REQUEST_CHANGES", "body": "Есть замечания", "commit_id": "aaa000", "submitted_at": "2026-10-01T10:00:00Z", "dismissed": false, "html_url": "https://git.example.org/team/app/pulls/42#review-11" },
  { "id": 12, "user": { "login": "carol" }, "state": "APPROVED", "body": "", "commit_id": "aaa111", "submitted_at": "2026-10-02T10:00:00Z", "dismissed": true, "html_url": "https://git.example.org/team/app/pulls/42#review-12" },
  { "id": 13, "user": { "login": "alice" }, "state": "PENDING", "body": "", "commit_id": "aaa111", "submitted_at": null, "dismissed": false, "html_url": "" },
  { "id": 14, "user": { "login": "dave" }, "state": "REQUEST_REVIEW", "body": "", "commit_id": "aaa111", "submitted_at": "2026-10-03T10:00:00Z", "dismissed": false, "html_url": "" },
  { "id": 15, "user": null, "state": "COMMENT", "body": "призрак", "commit_id": "aaa111", "submitted_at": "2026-10-04T10:00:00Z", "dismissed": false, "html_url": "" }
]
```

`mod/forge/fixtures/review-comments-11.json` (ревью 11: тред из двух комментариев к `src/a.ts:5`, отвеченный автором, и отдельный решённый тред к `src/b.ts:9`):

```json
[
  { "id": 101, "user": { "login": "Bob" }, "body": "Поправил", "created_at": "2026-10-01T12:00:00Z", "path": "src/a.ts", "position": 5, "commit_id": "aaa000", "pull_request_review_id": 11, "resolver": null },
  { "id": 100, "user": { "login": "alice" }, "body": "Тут null", "created_at": "2026-10-01T10:00:00Z", "path": "src/a.ts", "position": 5, "commit_id": "aaa000", "pull_request_review_id": 11, "resolver": null },
  { "id": 102, "user": { "login": "alice" }, "body": "Имя", "created_at": "2026-10-01T10:01:00Z", "path": "src/b.ts", "position": 9, "commit_id": "aaa000", "pull_request_review_id": 11, "resolver": { "login": "Bob" } }
]
```

`mod/forge/fixtures/review-comments-12.json`: `[]`

`mod/forge/fixtures/issue-comments.json`:

```json
[
  { "id": 200, "user": { "login": "carol" }, "body": "Когда релиз?", "created_at": "2026-10-02T09:00:00Z" }
]
```

- [ ] **Step 2: Написать тесты чтения**

`mod/forge/forgejo.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { forgejo, parseRemote } from './forgejo.ts'
import type { HttpInit, HttpResponse } from './types.ts'

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const API = 'https://git.example.org/api/v1/repos/team/app'

type Route = HttpResponse | Error
function fakeHttp(routes: Record<string, Route | Route[]>) {
  const calls: Array<{ url: string; init?: HttpInit }> = []
  const http = async (url: string, init?: HttpInit): Promise<HttpResponse> => {
    calls.push({ url, init })
    const key = `${init?.method ?? 'GET'} ${url}`
    const route = routes[key]
    const next = Array.isArray(route) ? route.shift() : route
    if (!next) throw new Error(`нет маршрута ${key}`)
    if (next instanceof Error) throw next
    return next
  }
  return { http, calls }
}
const ok = (text: string): HttpResponse => ({ status: 200, ok: true, headers: {}, text })
const provider = (routes: Record<string, Route | Route[]>) => {
  const { http, calls } = fakeHttp(routes)
  const sleeps: number[] = []
  const instance = forgejo.create({ repo: { host: 'git.example.org', owner: 'team', repo: 'app' }, token: 'T', http, sleep: async ms => { sleeps.push(ms) } })
  return { instance, calls, sleeps }
}
const READ_ROUTES = {
  [`GET ${API}/pulls/42/reviews?page=1&limit=50`]: ok(fixture('reviews.json')),
  [`GET ${API}/pulls/42/reviews/11/comments`]: ok(fixture('review-comments-11.json')),
  [`GET ${API}/pulls/42/reviews/12/comments`]: ok(fixture('review-comments-12.json')),
  [`GET ${API}/pulls/42/reviews/13/comments`]: ok('[]'),
  [`GET ${API}/pulls/42/reviews/15/comments`]: ok('[]'),
  [`GET ${API}/issues/42/comments?page=1&limit=50`]: ok(fixture('issue-comments.json')),
}

test('parseRemote: формы remote', () => {
  const want = { host: 'git.example.org', owner: 'team', repo: 'app' }
  assert.deepEqual(parseRemote('https://git.example.org/team/app.git'), want)
  assert.deepEqual(parseRemote('https://git.example.org:3000/team/app/'), want)
  assert.deepEqual(parseRemote('ssh://git@git.example.org:2222/team/app.git'), want)
  assert.deepEqual(parseRemote('git@git.example.org:team/app.git'), want)
  assert.deepEqual(parseRemote('git.example.org/team/app'), null)
  assert.deepEqual(parseRemote('https://git.example.org/app'), null)
  assert.deepEqual(parseRemote(''), null)
})

test('detect: чужие известные хостинги не наши', () => {
  assert.equal(forgejo.detect('git@github.com:team/app.git'), null)
  assert.equal(forgejo.detect('https://GitLab.com/team/app'), null)
  assert.deepEqual(forgejo.detect('git@git.example.org:team/app.git'), { host: 'git.example.org', owner: 'team', repo: 'app' })
})

test('getPull: маппинг и заголовок авторизации', async () => {
  const { instance, calls } = provider({ [`GET ${API}/pulls/42`]: ok(fixture('pull.json')) })
  assert.deepEqual(await instance.getPull(42), {
    number: 42, title: 'Добавить экспорт', author: 'Bob', headRef: 'feature/export', headSha: 'aaa111', baseRef: 'main',
    state: 'open', merged: false, url: 'https://git.example.org/team/app/pulls/42',
  })
  assert.equal(calls[0].init?.headers?.Authorization, 'token T')
})

test('listReviews: состояния, черновик, снятое, без REQUEST_REVIEW, призрак', async () => {
  const { instance } = provider(READ_ROUTES)
  const reviews = await instance.listReviews(42)
  assert.deepEqual(reviews.map(r => [r.id, r.author, r.state, r.dismissed]), [
    ['11', 'alice', 'changes', false], ['12', 'carol', 'approved', true], ['13', 'alice', 'pending', false], ['15', '', 'comment', false],
  ])
  assert.equal(reviews[2].submittedAt, '')
})

test('listThreads: группировка, порядок, resolved, общие комментарии', async () => {
  const { instance } = provider(READ_ROUTES)
  const { threads, general } = await instance.listThreads(42)
  assert.equal(threads.length, 2)
  const [a, b] = threads
  assert.deepEqual([a.id, a.path, a.line, a.commitSha, a.resolved], ['11:src/a.ts:5', 'src/a.ts', 5, 'aaa000', false])
  assert.deepEqual(a.comments.map(c => [c.id, c.author, c.reviewId]), [['100', 'alice', '11'], ['101', 'Bob', '11']])
  assert.deepEqual([b.id, b.resolved], ['11:src/b.ts:9', true])
  assert.deepEqual(general, [{ id: '200', author: 'carol', body: 'Когда релиз?', createdAt: '2026-10-02T09:00:00Z' }])
})

test('пагинация: 50 + 3 ревью — две страницы, ничего не теряется', async () => {
  const review = (id: number) => ({ id, user: { login: 'x' }, state: 'COMMENT', body: '', commit_id: 'c', submitted_at: '2026-10-01T00:00:00Z', dismissed: false })
  const page1 = Array.from({ length: 50 }, (_, i) => review(i + 1))
  const page2 = [51, 52, 53].map(review)
  const { instance, calls } = provider({
    [`GET ${API}/pulls/42/reviews?page=1&limit=50`]: ok(JSON.stringify(page1)),
    [`GET ${API}/pulls/42/reviews?page=2&limit=50`]: ok(JSON.stringify(page2)),
  })
  assert.equal((await instance.listReviews(42)).length, 53)
  assert.equal(calls.length, 2)
})

test('currentUser: один запрос на сессию', async () => {
  const { instance, calls } = provider({ ['GET https://git.example.org/api/v1/user']: ok('{"login":"alice"}') })
  assert.equal(await instance.currentUser(), 'alice')
  assert.equal(await instance.currentUser(), 'alice')
  assert.equal(calls.length, 1)
})

test('listPulls: одна страница до 50, state передаётся', async () => {
  const { instance, calls } = provider({ [`GET ${API}/pulls?state=closed&page=1&limit=50`]: ok(`[${fixture('pull.json')}]`) })
  assert.equal((await instance.listPulls('closed'))[0].number, 42)
  assert.equal(calls.length, 1)
})

test('ошибка HTTP — сообщение с кодом и путём', async () => {
  const { instance } = provider({ [`GET ${API}/pulls/9`]: { status: 404, ok: false, headers: {}, text: '{"message":"not found"}' } })
  await assert.rejects(instance.getPull(9), /GET \/repos\/team\/app\/pulls\/9: HTTP 404/)
})

test('сетевая ошибка — сообщение «сеть»', async () => {
  const { instance } = provider({ [`GET ${API}/pulls/9`]: new Error('ECONNRESET') })
  await assert.rejects(instance.getPull(9), /pulls\/9: сеть: .*ECONNRESET/)
})

test('pullRef и capabilities', () => {
  const { instance } = provider({})
  assert.equal(instance.pullRef(42), 'refs/pull/42/head')
  assert.deepEqual(instance.capabilities, { inline: true, requestChanges: true })
  assert.equal(instance.name, 'Forgejo/Gitea')
})
```

- [ ] **Step 3: Запустить — падает**

Run: `node --test mod/forge/forgejo.test.ts 2>&1 | tail -5`
Expected: FAIL — `Cannot find module '.../mod/forge/forgejo.ts'`.

- [ ] **Step 4: Создать `mod/forge/forgejo.ts` (чтение; публикация добавляется в Task 3)**

```ts
import type { Comment, ForgeAdapter, ForgeProvider, ProviderDeps, PullRequest, Repo, Review, Thread } from './types.ts'

/** размер страницы API */
const PAGE_LIMIT = 50
/** хостинги, которые точно не Forgejo */
const FOREIGN_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org']
/** состояния ревью Forgejo → общая модель; REQUEST_REVIEW — запрос ревью, не ревью */
const REVIEW_STATES: Record<string, Review['state']> = { APPROVED: 'approved', REQUEST_CHANGES: 'changes', COMMENT: 'comment', PENDING: 'pending' }

/** пользователь в ответе API (null — удалён) */
type RawUser = { login: string } | null
/** PR в ответе API */
interface RawPull { number: number; title: string; user: RawUser; head: { ref: string; sha: string }; base: { ref: string }; state: string; merged?: boolean; html_url: string }
/** ревью в ответе API */
interface RawReview { id: number; user: RawUser; state: string; body?: string; commit_id: string; submitted_at: string | null; dismissed?: boolean; html_url?: string }
/** комментарий к коду в ответе API */
interface RawReviewComment { id: number; user: RawUser; body: string; created_at: string; path: string; position: number; commit_id: string; pull_request_review_id: number; resolver?: RawUser }
/** общий комментарий в ответе API */
interface RawIssueComment { id: number; user: RawUser; body: string; created_at: string }

/** разбирает remote вида https://, ssh:// или git@host:owner/repo в host/owner/repo */
export function parseRemote(url: string): Repo | null {
  const full = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url.trim())
  const scp = /^[^@\s/]+@([^:\s/]+):(.+)$/.exec(url.trim())
  const [, host, path] = full ?? scp ?? []
  if (!host || !path) return null
  const parts = path.replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter(Boolean)
  return parts.length < 2 ? null : { host, owner: parts[parts.length - 2], repo: parts[parts.length - 1] }
}

/** логин или '' для удалённого пользователя */
function login(user: RawUser): string {
  return user?.login ?? ''
}

/** PR Forgejo → общая модель */
function toPull(raw: RawPull): PullRequest {
  return {
    number: raw.number, title: raw.title, author: login(raw.user), headRef: raw.head.ref, headSha: raw.head.sha,
    baseRef: raw.base.ref, state: raw.state === 'closed' ? 'closed' : 'open', merged: Boolean(raw.merged), url: raw.html_url,
  }
}

/** ревью Forgejo → общая модель; null для REQUEST_REVIEW и неизвестных состояний */
function toReview(raw: RawReview): Review | null {
  const state = REVIEW_STATES[raw.state]
  return state ? { id: String(raw.id), author: login(raw.user), state, body: raw.body ?? '', commitSha: raw.commit_id, submittedAt: raw.submitted_at ?? '', dismissed: Boolean(raw.dismissed) } : null
}

/** комментарий к коду Forgejo → общая модель */
function toCodeComment(raw: RawReviewComment): Comment {
  return { id: String(raw.id), author: login(raw.user), body: raw.body, createdAt: raw.created_at, path: raw.path, line: raw.position, commitSha: raw.commit_id, reviewId: String(raw.pull_request_review_id) }
}

/** ключ треда Forgejo: ревью, файл, строка */
function threadKey(raw: RawReviewComment): string {
  return `${raw.pull_request_review_id}:${raw.path}:${raw.position}`
}

/** группирует комментарии к коду в треды, внутри треда — по времени */
function toThreads(comments: RawReviewComment[]): Thread[] {
  const groups = comments.reduce((map, raw) => map.set(threadKey(raw), [...(map.get(threadKey(raw)) ?? []), raw]), new Map<string, RawReviewComment[]>())
  return [...groups].map(([id, group]) => {
    const sorted = [...group].sort((a, b) => a.created_at.localeCompare(b.created_at))
    return { id, path: sorted[0].path, line: sorted[0].position, commitSha: sorted[0].commit_id, comments: sorted.map(toCodeComment), resolved: sorted.some(raw => Boolean(raw.resolver)) }
  })
}

/** создаёт экземпляр адаптера для репозитория и токена */
function createForgejo(deps: ProviderDeps): ForgeProvider {
  const repoPath = `/repos/${deps.repo.owner}/${deps.repo.repo}`
  const me: { value?: Promise<string> } = {}

  /** запрос к API; ошибка HTTP несёт status, сетевая — нет */
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await deps.http(`https://${deps.repo.host}/api/v1${path}`, {
      method,
      headers: { Authorization: `token ${deps.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch(error => { throw new Error(`${method} ${path}: сеть: ${String(error)}`) })
    if (!response.ok) throw Object.assign(new Error(`${method} ${path}: HTTP ${response.status} ${response.text.slice(0, 500)}`), { status: response.status })
    return response.text ? JSON.parse(response.text) : null
  }

  /** все страницы списка */
  const paged = async <T>(path: string): Promise<T[]> => {
    const all: T[] = []
    const join = path.includes('?') ? '&' : '?'
    for (let page = 1; ; page++) {
      const items = (await call('GET', `${path}${join}page=${page}&limit=${PAGE_LIMIT}`)) as T[]
      all.push(...items)
      if (items.length < PAGE_LIMIT) return all
    }
  }

  /** ревью PR в сыром виде */
  const rawReviews = (number: number) => paged<RawReview>(`${repoPath}/pulls/${number}/reviews`)

  return {
    name: forgejo.name,
    capabilities: { inline: true, requestChanges: true },
    currentUser: () => (me.value ??= call('GET', '/user').then(user => (user as { login: string }).login)),
    listPulls: async state => ((await call('GET', `${repoPath}/pulls?state=${state}&page=1&limit=${PAGE_LIMIT}`)) as RawPull[]).map(toPull),
    getPull: async number => toPull((await call('GET', `${repoPath}/pulls/${number}`)) as RawPull),
    listReviews: async number => (await rawReviews(number)).map(toReview).filter((review): review is Review => review !== null),
    listThreads: async number => {
      const reviews = (await rawReviews(number)).filter(review => REVIEW_STATES[review.state])
      const comments = (await Promise.all(reviews.map(review => call('GET', `${repoPath}/pulls/${number}/reviews/${review.id}/comments`)))).flat() as RawReviewComment[]
      const general = await paged<RawIssueComment>(`${repoPath}/issues/${number}/comments`)
      return { threads: toThreads(comments), general: general.map(raw => ({ id: String(raw.id), author: login(raw.user), body: raw.body, createdAt: raw.created_at })) }
    },
    publishReview: async () => { throw new Error('publishReview: Task 3') },
    publishReplies: async () => { throw new Error('publishReplies: Task 3') },
    pullRef: number => `refs/pull/${number}/head`,
  }
}

/** адаптер Forgejo/Gitea (API v1 у них совместим) */
export const forgejo: ForgeAdapter = {
  id: 'forgejo',
  name: 'Forgejo/Gitea',
  tokenEnv: ['FORGEJO_TOKEN', 'GITEA_TOKEN'],
  detect: remoteUrl => {
    const repo = parseRemote(remoteUrl)
    return repo && !FOREIGN_HOSTS.includes(repo.host.toLowerCase()) ? repo : null
  },
  create: createForgejo,
}
```

Примечания: `listThreads` читает комментарии и черновиков (ревью 13) — отбрасывать их будет `status.ts` по `reviewId`, как 2.2. Комментарии запрашиваются только у ревью с известным состоянием: у `REQUEST_REVIEW` (ревью 14) их нет, и в `READ_ROUTES` для него нет маршрута — лишний запрос уронит тест. `currentUser` здесь — поле литерала; в Task 3 оно выносится в константу.

- [ ] **Step 5: Запустить — проходит**

Run: `node --test mod/forge/forgejo.test.ts 2>&1 | tail -8`
Expected: `pass 11`, `fail 0`.

- [ ] **Step 6: Синтаксис**

Run: `TMPDIR=$S node $S/tscheck.mjs mod/forge/forgejo.ts 2>&1 | grep -v ExperimentalWarning`
Expected: `ok mod/forge/forgejo.ts`.

---

### Task 3: Адаптер Forgejo — публикация ревью и ответов

**Files:**
- Modify: `mod/forge/forgejo.ts` (константы, `publishReview`, `publishReplies`)
- Test: `mod/forge/forgejo.test.ts` (добавить тесты)

**Interfaces:**
- Consumes: `call`, `rawReviews`, `currentUser` внутри `createForgejo` (Task 2); `ReviewDraft`, `Reply` (Task 1).
- Produces: `publishReview(number, draft): Promise<{ url }>` с reconcile; `publishReplies(number, replies): Promise<void>`; ошибки — `Error` с текстом на русском.

- [ ] **Step 1: Дописать тесты публикации в `mod/forge/forgejo.test.ts`**

```ts
const DRAFT = { verdict: 'request-changes' as const, body: 'Нужны правки', comments: [{ path: 'src/a.ts', line: 5, body: 'null' }] }
const REVIEWS_BEFORE = ok('[{"id":11,"user":{"login":"alice"},"state":"COMMENT","body":"старое","commit_id":"c","submitted_at":"2026-10-01T00:00:00Z"}]')
const REVIEWS_AFTER = ok('[{"id":11,"user":{"login":"alice"},"state":"COMMENT","body":"старое","commit_id":"c","submitted_at":"2026-10-01T00:00:00Z"},{"id":16,"user":{"login":"Alice"},"state":"REQUEST_CHANGES","body":"Нужны правки","commit_id":"c","submitted_at":"2026-10-05T00:00:00Z","html_url":"https://git.example.org/team/app/pulls/42#review-16"}]')
const USER = ok('{"login":"alice"}')

test('publishReview: событие, new_position, ссылка', async () => {
  const { instance, calls } = provider({
    [`GET ${API}/pulls/42/reviews?page=1&limit=50`]: REVIEWS_BEFORE,
    [`POST ${API}/pulls/42/reviews`]: ok('{"id":16,"html_url":"https://git.example.org/team/app/pulls/42#review-16"}'),
  })
  assert.deepEqual(await instance.publishReview(42, DRAFT), { url: 'https://git.example.org/team/app/pulls/42#review-16' })
  const post = calls.find(c => c.init?.method === 'POST')
  assert.deepEqual(JSON.parse(post?.init?.body ?? ''), { body: 'Нужны правки', event: 'REQUEST_CHANGES', comments: [{ path: 'src/a.ts', new_position: 5, body: 'null' }] })
})

test('publishReview: approve и comment маппятся на APPROVED и COMMENT', async () => {
  for (const [verdict, event] of [['approve', 'APPROVED'], ['comment', 'COMMENT']] as const) {
    const { instance, calls } = provider({ [`GET ${API}/pulls/42/reviews?page=1&limit=50`]: ok('[]'), [`POST ${API}/pulls/42/reviews`]: ok('{"html_url":"u"}') })
    await instance.publishReview(42, { verdict, body: '', comments: [] })
    assert.equal(JSON.parse(calls[1].init?.body ?? '').event, event)
  }
})

test('publishReview: ошибка HTTP — без reconcile', async () => {
  const { instance, calls } = provider({
    [`GET ${API}/pulls/42/reviews?page=1&limit=50`]: REVIEWS_BEFORE,
    [`POST ${API}/pulls/42/reviews`]: { status: 422, ok: false, headers: {}, text: 'bad' },
  })
  await assert.rejects(instance.publishReview(42, DRAFT), /HTTP 422/)
  assert.equal(calls.length, 2)
})

test('publishReview: обрыв связи, ревью создано — находит его, не публикует снова', async () => {
  const { instance, sleeps } = provider({
    [`GET ${API}/pulls/42/reviews?page=1&limit=50`]: [REVIEWS_BEFORE, REVIEWS_AFTER],
    [`POST ${API}/pulls/42/reviews`]: new Error('socket hang up'),
    ['GET https://git.example.org/api/v1/user']: USER,
  })
  assert.deepEqual(await instance.publishReview(42, DRAFT), { url: 'https://git.example.org/team/app/pulls/42#review-16' })
  assert.deepEqual(sleeps, [])
})

test('publishReview: обрыв связи, ревью не нашлось за 3 попытки — статус неизвестен', async () => {
  const { instance, sleeps } = provider({
    [`GET ${API}/pulls/42/reviews?page=1&limit=50`]: [REVIEWS_BEFORE, REVIEWS_BEFORE, new Error('timeout'), REVIEWS_BEFORE],
    [`POST ${API}/pulls/42/reviews`]: new Error('socket hang up'),
    ['GET https://git.example.org/api/v1/user']: USER,
  })
  await assert.rejects(instance.publishReview(42, DRAFT), /статус публикации неизвестен — проверьте PR 42 перед повтором/)
  assert.deepEqual(sleeps, [5000, 5000])
})

test('publishReplies: в тред и общим комментарием с цитатой', async () => {
  const { instance, calls } = provider({
    [`POST ${API}/pulls/42/reviews/11/comments`]: ok('{}'),
    [`POST ${API}/issues/42/comments`]: ok('{}'),
  })
  await instance.publishReplies(42, [{ threadId: '11:src/a.ts:5', body: 'Сделано' }, { quote: 'Когда релиз?', body: 'В пятницу' }])
  assert.deepEqual(JSON.parse(calls[0].init?.body ?? ''), { path: 'src/a.ts', new_position: 5, body: 'Сделано' })
  assert.deepEqual(JSON.parse(calls[1].init?.body ?? ''), { body: '> Когда релиз?\n\nВ пятницу' })
})

test('publishReplies: ошибка посередине — сколько уже отправлено', async () => {
  const { instance } = provider({
    [`POST ${API}/pulls/42/reviews/11/comments`]: ok('{}'),
    [`POST ${API}/issues/42/comments`]: { status: 500, ok: false, headers: {}, text: 'oops' },
  })
  await assert.rejects(instance.publishReplies(42, [{ threadId: '11:src/a.ts:5', body: 'a' }, { quote: 'q', body: 'b' }]), /HTTP 500.*уже отправлено 1 из 2/s)
})

test('publishReplies: битый threadId — ошибка до отправки', async () => {
  const { instance, calls } = provider({})
  await assert.rejects(instance.publishReplies(42, [{ threadId: 'xyz', body: 'a' }]), /неизвестный тред xyz/)
  assert.equal(calls.length, 0)
})
```

- [ ] **Step 2: Запустить — новые падают**

Run: `node --test mod/forge/forgejo.test.ts 2>&1 | tail -8`
Expected: `fail 8` (новые тесты: `publishReview: Task 3` / `publishReplies: Task 3`), прежние 11 проходят.

- [ ] **Step 3: Реализовать публикацию**

В начало `mod/forge/forgejo.ts`, к константам, добавить:

```ts
/** вердикт общей модели → событие ревью Forgejo */
const EVENTS: Record<Verdict, string> = { approve: 'APPROVED', 'request-changes': 'REQUEST_CHANGES', comment: 'COMMENT' }
/** сколько раз искать ревью после обрыва связи */
const RECONCILE_ATTEMPTS = 3
/** пауза между поисками, мс */
const RECONCILE_PAUSE_MS = 5000
/** текст для случая, когда неизвестно, опубликовалось ли ревью */
const UNKNOWN_STATUS = 'статус публикации неизвестен'
```

и `Verdict` — в список `import type`. Добавить функцию разбора ключа треда:

```ts
/** ключ треда → ревью, файл, строка; null — ключ не наш */
function parseThreadKey(key: string): { reviewId: string; path: string; line: number } | null {
  const match = /^(\d+):(.+):(\d+)$/.exec(key)
  return match ? { reviewId: match[1], path: match[2], line: Number(match[3]) } : null
}
```

В `createForgejo` заменить заглушки `publishReview`/`publishReplies` на:

```ts
    publishReview: async (number, draft) => {
      const body = { body: draft.body, event: EVENTS[draft.verdict], comments: draft.comments.map(c => ({ path: c.path, new_position: c.line, body: c.body })) }
      const before = new Set((await rawReviews(number)).map(review => review.id))
      try {
        const posted = (await call('POST', `${repoPath}/pulls/${number}/reviews`, body)) as { html_url?: string }
        return { url: posted.html_url ?? '' }
      } catch (error) {
        if ((error as { status?: number }).status !== undefined) throw error
        const author = (await currentUser()).toLowerCase()
        for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
          if (attempt > 0) await deps.sleep(RECONCILE_PAUSE_MS)
          const reviews = await rawReviews(number).catch(() => undefined)
          const found = reviews?.filter(review => !before.has(review.id) && login(review.user).toLowerCase() === author && (review.body ?? '') === draft.body).at(-1)
          if (found) return { url: found.html_url ?? '' }
        }
        throw new Error(`${(error as Error).message}; ${UNKNOWN_STATUS} — проверьте PR ${number} перед повтором`)
      }
    },
    publishReplies: async (number, replies) => {
      const targets = replies.map(reply => {
        if (reply.threadId === undefined) return { reply, thread: null }
        const thread = parseThreadKey(reply.threadId)
        if (!thread) throw new Error(`неизвестный тред ${reply.threadId}`)
        return { reply, thread }
      })
      for (const [index, { reply, thread }] of targets.entries()) {
        try {
          if (thread) await call('POST', `${repoPath}/pulls/${number}/reviews/${thread.reviewId}/comments`, { path: thread.path, new_position: thread.line, body: reply.body })
          else await call('POST', `${repoPath}/issues/${number}/comments`, { body: `> ${reply.quote ?? ''}\n\n${reply.body}` })
        } catch (error) {
          throw new Error(`${(error as Error).message}; уже отправлено ${index} из ${replies.length}`)
        }
      }
    },
```

Для этого `currentUser` вынести из литерала в константу внутри `createForgejo` (её зовёт и `publishReview`):

```ts
  /** логин владельца токена, один запрос на экземпляр */
  const currentUser = (): Promise<string> => (me.value ??= call('GET', '/user').then(user => (user as { login: string }).login))
```

а в возвращаемом объекте — `currentUser,`. `publishReplies` проверяет все `threadId` до первой отправки (битый ключ не оставляет полуотправленных ответов). Цикл `for (let attempt …)` — счётчик, `const` не подходит.

- [ ] **Step 4: Запустить — проходит**

Run: `node --test mod/forge/forgejo.test.ts 2>&1 | tail -8`
Expected: `pass 19`, `fail 0`.

- [ ] **Step 5: Синтаксис**

Run: `TMPDIR=$S node $S/tscheck.mjs mod/forge/forgejo.ts 2>&1 | grep -v ExperimentalWarning`
Expected: `ok mod/forge/forgejo.ts`.

---

### Task 4: Выбор адаптера и токена

**Files:**
- Create: `mod/forge/index.ts`
- Test: `mod/forge/index.test.ts`

**Interfaces:**
- Consumes: `forgejo: ForgeAdapter` (Task 2), `ForgeAdapter`, `Repo`, `Http`, `ForgeProvider` (Task 1).
- Produces: `ADAPTERS: readonly ForgeAdapter[]`; `ExplicitConfig`; `Selection`; `selectProvider(input): Selection`; `createProvider(selection, http, sleep): ForgeProvider` — их вызывает `register.ts` на этапе 3.

- [ ] **Step 1: Написать тесты**

`mod/forge/index.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider, selectProvider } from './index.ts'
import type { ForgeAdapter } from './types.ts'

const adapter = (id: string, host: string, tokenEnv = [`${id.toUpperCase()}_TOKEN`]): ForgeAdapter => ({
  id, name: id.toUpperCase(), tokenEnv,
  detect: url => (url.includes(host) ? { host, owner: 'team', repo: 'app' } : null),
  create: deps => ({ name: id, capabilities: { inline: true, requestChanges: true }, currentUser: async () => deps.token } as never),
})
const ALPHA = adapter('alpha', 'a.example', ['ALPHA_TOKEN', 'OLD_ALPHA_TOKEN'])
const BETA = adapter('beta', 'b.example')
const env = (values: Record<string, string>) => (name: string) => values[name]
const base = { options: {}, remoteUrl: 'git@a.example:team/app.git', env: env({ ALPHA_TOKEN: 't' }), adapters: [ALPHA, BETA] }

test('по remote среди включённых; галочка по умолчанию включена', () => {
  assert.deepEqual(selectProvider(base), { adapter: ALPHA, repo: { host: 'a.example', owner: 'team', repo: 'app' }, token: 't' })
})

test('токен — из второй переменной, если первой нет', () => {
  const selection = selectProvider({ ...base, env: env({ OLD_ALPHA_TOKEN: 'old' }) })
  assert.equal('token' in selection && selection.token, 'old')
})

test('нет токена — какую переменную задать', () => {
  assert.deepEqual(selectProvider({ ...base, env: env({}) }), { error: 'Нет токена ALPHA: задайте переменную ALPHA_TOKEN или OLD_ALPHA_TOKEN в окружении терминала.' })
})

test('выключенная галочка — адаптер не участвует', () => {
  const selection = selectProvider({ ...base, options: { alpha: false } })
  assert.match('error' in selection ? selection.error : '', /не распознан.*включены: BETA/)
})

test('все выключены и явной настройки нет', () => {
  assert.deepEqual(selectProvider({ ...base, options: { alpha: false, beta: false } }), { error: 'Все системы выключены — включите нужную в настройках плагина (/plugin → review-kit → Configure options).' })
})

test('явная настройка побеждает галочку и remote', () => {
  const selection = selectProvider({ ...base, options: { alpha: false }, remoteUrl: 'git@other:x/y.git', config: { provider: 'alpha', host: 'h', owner: 'o', repo: 'r' } })
  assert.deepEqual(selection, { adapter: ALPHA, repo: { host: 'h', owner: 'o', repo: 'r' }, token: 't' })
})

test('явный provider без host/owner/repo — repo из remote этого адаптера', () => {
  const selection = selectProvider({ ...base, config: { provider: 'alpha' } })
  assert.deepEqual('repo' in selection && selection.repo, { host: 'a.example', owner: 'team', repo: 'app' })
})

test('явный provider, но remote не его и host/owner/repo нет', () => {
  const selection = selectProvider({ ...base, remoteUrl: 'git@other:x/y.git', config: { provider: 'alpha' } })
  assert.match('error' in selection ? selection.error : '', /укажите host, owner и repo/)
})

test('неизвестный provider в настройке', () => {
  assert.deepEqual(selectProvider({ ...base, config: { provider: 'gamma' } }), { error: 'В настройках review-kit указана неизвестная система «gamma»; есть: alpha, beta.' })
})

test('нет origin', () => {
  const selection = selectProvider({ ...base, remoteUrl: '' })
  assert.match('error' in selection ? selection.error : '', /remote origin не найден/)
})

test('createProvider передаёт репозиторий и токен адаптеру', async () => {
  const selection = selectProvider(base)
  if ('error' in selection) throw new Error(selection.error)
  const provider = createProvider(selection, async () => { throw new Error('no http') }, async () => {})
  assert.equal(await provider.currentUser(), 't')
})

test('реестр по умолчанию узнаёт Forgejo', () => {
  const selection = selectProvider({ options: {}, remoteUrl: 'git@git.example.org:team/app.git', env: env({ FORGEJO_TOKEN: 'f' }) })
  assert.equal('adapter' in selection && selection.adapter.id, 'forgejo')
})
```

- [ ] **Step 2: Запустить — падает**

Run: `node --test mod/forge/index.test.ts 2>&1 | tail -5`
Expected: FAIL — `Cannot find module '.../mod/forge/index.ts'`.

- [ ] **Step 3: Создать `mod/forge/index.ts`**

```ts
import { forgejo } from './forgejo.ts'
import type { ForgeAdapter, ForgeProvider, Http, Repo } from './types.ts'

/** все адаптеры плагина; новая система — одна строка здесь */
export const ADAPTERS: readonly ForgeAdapter[] = [forgejo]

/** явная настройка из конфига проекта для нестандартного remote */
export interface ExplicitConfig {
  /** id адаптера */
  provider?: string
  /** хост API */
  host?: string
  /** владелец репозитория */
  owner?: string
  /** имя репозитория */
  repo?: string
}

/** итог выбора: адаптер, репозиторий и токен — или текст ошибки для пользователя */
export type Selection = { adapter: ForgeAdapter; repo: Repo; token: string } | { error: string }

/** выбирает адаптер: явная настройка → включённые галочки по remote; затем токен из окружения */
export function selectProvider({ options, config, remoteUrl, env, adapters = ADAPTERS }: {
  options: Record<string, unknown>
  config?: ExplicitConfig
  remoteUrl: string
  env: (name: string) => string | undefined
  adapters?: readonly ForgeAdapter[]
}): Selection {
  const chosen = config?.provider ? explicit(config, remoteUrl, adapters) : byRemote(options, remoteUrl, adapters)
  if ('error' in chosen) return chosen
  const token = chosen.adapter.tokenEnv.map(name => env(name)).find(value => value?.trim())
  return token ? { ...chosen, token: token.trim() } : { error: `Нет токена ${chosen.adapter.name}: задайте переменную ${chosen.adapter.tokenEnv.join(' или ')} в окружении терминала.` }
}

/** адаптер и репозиторий из явной настройки */
function explicit(config: ExplicitConfig, remoteUrl: string, adapters: readonly ForgeAdapter[]): { adapter: ForgeAdapter; repo: Repo } | { error: string } {
  const adapter = adapters.find(item => item.id === config.provider)
  if (!adapter) return { error: `В настройках review-kit указана неизвестная система «${config.provider}»; есть: ${adapters.map(item => item.id).join(', ')}.` }
  const repo = config.host && config.owner && config.repo ? { host: config.host, owner: config.owner, repo: config.repo } : adapter.detect(remoteUrl)
  return repo ? { adapter, repo } : { error: `Remote «${remoteUrl}» не похож на ${adapter.name}: укажите host, owner и repo в .claude/review-kit.local.json.` }
}

/** первый включённый адаптер, узнавший remote */
function byRemote(options: Record<string, unknown>, remoteUrl: string, adapters: readonly ForgeAdapter[]): { adapter: ForgeAdapter; repo: Repo } | { error: string } {
  const enabled = adapters.filter(item => options[item.id] !== false)
  if (enabled.length === 0) return { error: 'Все системы выключены — включите нужную в настройках плагина (/plugin → review-kit → Configure options).' }
  if (!remoteUrl.trim()) return { error: 'remote origin не найден: review-kit работает с PR репозитория origin.' }
  const found = enabled.map(adapter => ({ adapter, repo: adapter.detect(remoteUrl) })).find(item => item.repo)
  return found?.repo ? { adapter: found.adapter, repo: found.repo } : { error: `Remote «${remoteUrl}» не распознан; включены: ${enabled.map(item => item.name).join(', ')}. Для своего домена укажите provider, host, owner и repo в .claude/review-kit.local.json.` }
}

/** создаёт экземпляр выбранного адаптера */
export function createProvider(selection: { adapter: ForgeAdapter; repo: Repo; token: string }, http: Http, sleep: (ms: number) => Promise<void>): ForgeProvider {
  return selection.adapter.create({ repo: selection.repo, token: selection.token, http, sleep })
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `node --test mod/forge/index.test.ts 2>&1 | tail -8`
Expected: `pass 12`, `fail 0`.

- [ ] **Step 5: Синтаксис**

Run: `TMPDIR=$S node $S/tscheck.mjs mod/forge/index.ts 2>&1 | grep -v ExperimentalWarning`
Expected: `ok mod/forge/index.ts`.

---

### Task 5: Финальная проверка этапа

- [ ] **Step 1: Все тесты и синтаксис**

Run: `node --test 'mod/**/*.test.ts' 2>&1 | tail -10; TMPDIR=$S node $S/tscheck.mjs mod/*.ts mod/forge/*.ts 2>&1 | grep -v ExperimentalWarning`
Expected: `pass 33`, `fail 0`; `ok` для каждого файла.

- [ ] **Step 2: Хостинг не протёк за пределы `forge/`**

Run: `grep -rniE "forgejo|gitea|/api/v1" mod --exclude-dir=forge`
Expected: пусто (на этапе 2 `register.ts` про `forge/` не знает; старые упоминания `forgejo.py` в `register.ts`/`policy.ts` — см. ниже).
Если grep находит `tools/forgejo.py` в `mod/policy.ts`/`mod/register.ts` — это наследие 2.2, оно уходит на этапе 3; записать в отчёт этапа, не править.

- [ ] **Step 3: Плагин по-прежнему валиден**

Run: `claude plugin validate . 2>&1 | tail -3`
Expected: `Validation passed` (с прежними предупреждениями о метаданных). Если валидатор ругается на `mod/forge/*.ts` или `*.test.ts` как на модули — записать в отчёт: их не подключает `hooks.json`.

**Стоп: этап 2 закончен, ждём «дальше» пользователя перед планом этапа 3.**
