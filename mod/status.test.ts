import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACTIONABLE, contextOf, pullRows, statusOf, intakeItems, loadPr, MARKER, priorComments, scenarioOf, type PrData } from './status.ts'
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
    state: 'open', merged: false, url: 'u', scenario: 'none-own', status: 'ждём ревью',
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
  assert.deepEqual((await pullRows(fake)).rows.filter(r => ACTIONABLE.includes(r.scenario)).map(r => [r.number, r.scenario]), [[1, 'feedback'], [2, 'review'], [3, 'recheck']])
})

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
