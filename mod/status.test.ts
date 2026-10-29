import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACTIONABLE, commentIds, contextOf, driftOf, rowLine, placeAll, prListText, pullRows, splitHere, statusOf, intakeItems, loadPr, MARKER, priorComments, scenarioOf, type ListRow, type PrData } from './status.ts'
import { fakeProvider } from './forge/fake.ts'
import type { Comment, PullRequest, Review, Thread } from './forge/types.ts'

const pull = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 5, title: 'T', author: 'bob', headRef: 'f', headSha: 'h2', baseRef: 'main', state: 'open', merged: false, url: 'u', conflicted: false, ...over })
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
    author: 'carol', quote: 'carol: Имя', stale: true, disagree: false, at: '2026-10-01T10:00:00Z',
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

test('свой PR: после моего последнего коммита ревьюеры молчат → ждём ревью, но треды остаются в intake', () => {
  const threads = [thread([comment('c1', 'carol', 'Имя', '2026-10-01T10:00:00Z')])]
  const reviews = [review('r7', 'carol', 'changes', 'h1', '2026-10-01T10:30:00Z', 'Поправьте')]
  const fixed = own({ threads, reviews, headAt: '2026-10-01T11:00:00Z' })
  assert.equal(scenarioOf(fixed), 'none-own')
  assert.equal(statusOf(fixed, 'none-own'), 'ждём ревью')
  assert.deepEqual(intakeItems(fixed).map(i => i.id), ['r1/c1', 'review/r7'])
  const later = [thread([comment('c1', 'carol', 'Имя', '2026-10-01T10:00:00Z'), comment('c2', 'carol', 'И тут', '2026-10-01T12:00:00Z')])]
  assert.equal(scenarioOf(own({ threads: later, headAt: '2026-10-01T11:00:00Z' })), 'feedback')
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
  assert.deepEqual(result?.prior.map(p => p.threadId), [threads[0].id, null])
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

test('priorComments: ответы в треде после моего комментария — в replies, мои и с маркером — нет', () => {
  const reviews = [review('r2', 'alice', 'changes', 'h2', '2026-10-02T10:00:00Z')]
  const threads = [thread([
    comment('c1', 'carol', 'раньше', '2026-10-02T09:00:00Z', 'r2'),
    comment('c5', 'alice', 'тут null', '2026-10-02T10:00:00Z', 'r2'),
    comment('c6', 'bob', 'null сюда не приходит: проверка выше', '2026-10-02T11:00:00Z', 'r2'),
    comment('c7', 'kit', `уточнил\n\n${MARKER}`, '2026-10-02T12:00:00Z', 'r2'),
    comment('c8', 'bob', 'см. validate()', '2026-10-02T13:00:00Z', 'r2'),
  ])]
  const [item] = priorComments(data({ reviews, threads }))?.prior ?? []
  assert.equal(item.id, 'r2/c5')
  assert.deepEqual(item.replies, [{ author: 'bob', body: 'null сюда не приходит: проверка выше' }, { author: 'bob', body: 'см. validate()' }])
  assert.deepEqual(priorComments(data({ reviews: [review('r3', 'alice', 'comment', 'h2', '2026-10-02T10:00:00Z', 'Итог')] }))?.prior[0].replies, [])
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
    me: 'alice', pulls, commits: { h2: '2026-09-30T10:00:00Z' },
    reviews: { 3: [review('r3', 'alice', 'changes', 'h1')], 4: [review('r4', 'alice', 'changes', 'h2')] },
    threads: { 1: { threads: [thread([comment('c1', 'carol', 'Имя', '2026-10-01T10:00:00Z')])], general: [] } },
  })
  const scenarios = await Promise.all([1, 2, 3, 4].map(async n => scenarioOf(await loadPr(fake, n))))
  assert.deepEqual(scenarios, ['feedback', 'review', 'recheck', 'wait-author'])
  assert.equal((await loadPr(fake, 1)).headAt, '2026-09-30T10:00:00Z')
  assert.equal((await loadPr(fake, 2)).headAt, undefined)
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

const row = (number: number, scenario: ListRow['scenario'], status: ListRow['status']): ListRow => ({ number, title: `T${number}`, author: 'bob', isOwn: false, headRef: 'f', scenario, status, conflicted: false })

test('prListText: «на проверку» и «ожидающие решения» — текстом, без выбора', () => {
  const rows = [row(1, 'review', 'на проверке'), row(2, 'feedback', 'есть замечания'), row(3, 'wait-author', 'ждём автора')]
  assert.equal(prListText(rows, false), [
    'PR на проверку:\n#1 на проверке · bob — T1\n#2 есть замечания · bob — T2',
    'PR, ожидающие решения:\n#3 ждём автора · bob — T3',
    'Взять PR: /pr <номер> · все из «на проверку» сразу: /pr all',
  ].join('\n\n'))
})

test('prListText: только «на проверку» — без пустой секции', () => {
  assert.equal(prListText([row(1, 'recheck', 'перепроверка')], false), 'PR на проверку:\n#1 перепроверка · bob — T1\n\nВзять PR: /pr <номер> · все из «на проверку» сразу: /pr all')
})

test('prListText: только ожидающие — «Делать нечего.»; пусто — «Открытых PR нет.»; 50 PR — подсказка про предел', () => {
  assert.equal(prListText([row(3, 'none-own', 'готов к слиянию')], false), 'PR, ожидающие решения:\n#3 готов к слиянию · bob — T3\n\nДелать нечего.')
  assert.equal(prListText([], false), 'Открытых PR нет.')
  assert.match(prListText([row(1, 'review', 'на проверке')], true), /Прочитано 50 открытых PR/)
})

test('placeAll: свой PR на ветке основного дерева — здесь, остальное — во вкладки; без Orca — всё здесь', () => {
  const rows = [
    { number: 1, isOwn: false, headRef: 'feat-a' },
    { number: 2, isOwn: true, headRef: 'my-fix' },
    { number: 3, isOwn: true, headRef: 'my-other' },
  ]
  assert.deepEqual(placeAll(rows, { mainBranch: 'my-fix', hasOrca: true }), { tabs: [1, 3], here: [2] })
  assert.deepEqual(placeAll(rows, { mainBranch: 'main', hasOrca: true }), { tabs: [1, 2, 3], here: [] })
  assert.deepEqual(placeAll(rows, { mainBranch: 'feat-a', hasOrca: true }), { tabs: [1, 2, 3], here: [] })
  assert.deepEqual(placeAll(rows, { mainBranch: 'my-fix', hasOrca: false }), { tabs: [], here: [1, 2, 3] })
})

test('splitHere: первый запускается здесь, если прогона нет; иначе все — потом', () => {
  assert.deepEqual(splitHere([2, 5], false), { start: 2, later: [5] })
  assert.deepEqual(splitHere([2, 5], true), { start: undefined, later: [2, 5] })
  assert.deepEqual(splitHere([], false), { start: undefined, later: [] })
})

test('свой PR с конфликтом → conflict, статус «конфликт», есть дело; замечания важнее', () => {
  const conflicted = own({ pull: pull({ author: 'Alice', conflicted: true }) })
  assert.equal(scenarioOf(conflicted), 'conflict')
  assert.equal(statusOf(conflicted, 'conflict'), 'конфликт')
  assert.ok(ACTIONABLE.includes('conflict'))
  const threads = [thread([comment('c1', 'carol', 'Имя', '2026-10-01T10:00:00Z')])]
  assert.equal(scenarioOf(own({ pull: pull({ author: 'Alice', conflicted: true }), threads })), 'feedback')
})

test('чужой PR с конфликтом — прежний сценарий', () => {
  assert.equal(scenarioOf(data({ pull: pull({ conflicted: true }) })), 'review')
})

test('rowLine: метка конфликта только у PR с конфликтом', () => {
  const row = { number: 7, title: 'T', author: 'bob', isOwn: false, headRef: 'f', scenario: 'review' as const, status: 'на проверке' as const, conflicted: false }
  assert.equal(rowLine(row), '#7 на проверке · bob — T')
  assert.equal(rowLine({ ...row, conflicted: true }), '#7 на проверке · конфликт · bob — T')
})

test('pullRows: строка несёт признак конфликта', async () => {
  const fake = fakeProvider({ me: 'alice', pulls: [pull({ number: 1, author: 'alice', conflicted: true }), pull({ number: 2 })] })
  assert.deepEqual((await pullRows(fake)).rows.map(r => [r.number, r.scenario, r.conflicted]), [[1, 'conflict', true], [2, 'review', false]])
})

test('чужой PR: моё последнее ревью — действующий апрув → дела нет, даже если автор отвечал в старых тредах', () => {
  const threads = [thread([comment('c1', 'alice', 'null тут', '2026-10-01T10:00:00Z'), comment('c2', 'bob', 'поправил', '2026-10-01T11:00:00Z')])]
  const approved = data({ reviews: [review('r1', 'alice', 'changes', 'h1'), review('r2', 'alice', 'approved', 'h2', '2026-10-02T10:00:00Z')], threads })
  assert.equal(scenarioOf(approved), 'wait-author')
  const dismissed = data({ reviews: [{ ...review('r2', 'alice', 'approved', 'h1', '2026-10-02T10:00:00Z'), dismissed: true }] })
  assert.equal(scenarioOf(dismissed), 'recheck')
})

test('driftOf: та же голова и те же комментарии — расхождения нет', () => {
  const d = data({ threads: [thread([comment('c1', 'alice', 'тут', '2026-10-01T10:00:00Z')])] })
  assert.equal(driftOf({ headSha: 'h2', commentIds: commentIds(d) }, d, ['alice']), undefined)
})

test('driftOf: новая голова — короткие sha было/стало', () => {
  const d = data({ pull: pull({ headSha: '842c6f0aaaa' }) })
  assert.equal(driftOf({ headSha: 'd70145dbbbb', commentIds: [] }, d, ['alice']), 'голова была d70145d, стала 842c6f0')
})

test('driftOf: новый комментарий автора — расхождение; мой и бота — нет; снимок без комментариев — только голова', () => {
  const old = comment('c1', 'alice', 'тут', '2026-10-01T10:00:00Z')
  const fresh = (author: string) => data({ threads: [thread([old, comment('c2', author, 'поправил', '2026-10-01T11:00:00Z')])] })
  assert.equal(driftOf({ headSha: 'h2', commentIds: ['c1'] }, fresh('bob'), ['alice', 'ci-bot']), 'новые комментарии — bob (1)')
  assert.equal(driftOf({ headSha: 'h2', commentIds: ['c1'] }, fresh('Alice'), ['alice', 'ci-bot']), undefined)
  assert.equal(driftOf({ headSha: 'h2', commentIds: ['c1'] }, fresh('ci-bot'), ['alice', 'ci-bot']), undefined)
  assert.equal(driftOf({ headSha: 'h2', commentIds: null }, fresh('bob'), ['alice']), undefined)
})

test('driftOf: голова и общий комментарий вместе — одной строкой', () => {
  const d = data({ pull: pull({ headSha: 'bbbbbbbbb' }), general: [{ id: 'g1', author: 'bob', body: 'готово', createdAt: '2026-10-01T11:00:00Z' }, { id: 'g2', author: 'bob', body: 'и тут', createdAt: '2026-10-01T12:00:00Z' }] })
  assert.equal(driftOf({ headSha: 'aaaaaaaaa', commentIds: [] }, d, ['alice']), 'голова была aaaaaaa, стала bbbbbbb; новые комментарии — bob (2)')
})
