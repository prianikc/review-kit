import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discussionOf, NO_DISCUSSION } from './discussion.ts'
import type { PrData } from '../status.ts'
import type { Comment, PullRequest, Review, Thread } from '../forge/types.ts'

const pull = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 201, title: 'T', body: 'Добавить PEP', author: 'afenin', headRef: 'f', headSha: 'h2', baseRef: 'main', state: 'open', merged: false, url: 'u', conflicted: false, ...over })
const review = (id: string, author: string, state: Review['state'], body = '', submittedAt = '2026-10-01T10:00:00Z'): Review => ({ id, author, state, body, commitSha: 'h1', submittedAt, dismissed: false })
const comment = (id: string, author: string, body: string, createdAt: string, reviewId = '1969'): Comment => ({ id, author, body, createdAt, path: '.env.example', line: 13, commitSha: 'h1', reviewId })
const thread = (comments: Comment[], resolved = false, path = '.env.example', line = 13): Thread => ({ id: `${comments[0].reviewId}:${path}:${line}`, path, line, commitSha: 'h1', comments, resolved })
const general = (id: string, author: string, body: string, createdAt: string): Comment => ({ id, author, body, createdAt })
const data = (over: Partial<PrData> = {}): PrData => ({ pull: pull(), me: 'avartamonov', reviews: [], threads: [], general: [], ...over })

test('discussionOf: без комментариев — «обсуждения нет», тредов нет', () => {
  const result = discussionOf(data())
  assert.equal(result.text, `## DISCUSSION\n${NO_DISCUSSION}`)
  assert.deepEqual([result.threads, result.questions, result.truncated], [[], [], false])
})

test('discussionOf: PR 201 — тред T1 с последним словом ревьюера, ответ автора общим комментарием рядом', () => {
  const d = data({
    reviews: [review('1969', 'avartamonov', 'changes')],
    threads: [thread([comment('c1', 'avartamonov', 'PEP_* нет в Joi', '2026-10-01T10:00:00Z')])],
    general: [general('8917', 'afenin', 'Валидация вынесена в #205', '2026-10-02T09:00:00Z')],
  })
  const result = discussionOf(d)
  assert.deepEqual(result.threads, [{ id: 'T1', place: '.env.example:13', status: 'open', last: 'мы', commentIds: ['c1'] }])
  assert.match(result.text, /^### T1 · \.env\.example:13 · open · последнее слово: мы\n- avartamonov \[мы\] \(ревью 1969, REQUEST_CHANGES\): PEP_\* нет в Joi$/m)
  assert.match(result.text, /### Общие комментарии\n- afenin \[автор\] \(issue 8917, 2026-10-02 09:00\): Валидация вынесена в #205/)
  assert.ok(result.text.indexOf('### T1') < result.text.indexOf('### Общие комментарии'))
})

test('discussionOf: ответ автора в треде, закрытый тред, бот и черновик', () => {
  const d = data({
    reviews: [review('1969', 'avartamonov', 'changes'), review('2000', 'ai-review-bot', 'comment'), review('3000', 'avartamonov', 'pending')],
    threads: [
      thread([comment('c1', 'avartamonov', 'null?', '2026-10-01T10:00:00Z'), comment('c2', 'AFenin', 'поправил в abc123', '2026-10-01T11:00:00Z')]),
      thread([comment('c3', 'ai-review-bot', 'стиль', '2026-10-01T12:00:00Z', '2000')], true, 'a.ts', 2),
      thread([comment('c4', 'avartamonov', 'черновик', '2026-10-01T13:00:00Z', '3000')], false, 'b.ts', 1),
    ],
  })
  const result = discussionOf(d, { bots: ['AI-Review-Bot'] })
  assert.deepEqual(result.threads.map(t => [t.id, t.place, t.status, t.last, t.lastAuthorReply]), [['T1', '.env.example:13', 'open', 'автор', 'поправил в abc123'], ['T2', 'a.ts:2', 'resolved', 'ревьюер', undefined]])
  assert.match(result.text, /- ai-review-bot \[бот\] \(ревью 2000, COMMENT\): стиль/)
  assert.doesNotMatch(result.text, /черновик/)
})

test('discussionOf: вопрос без ответа автора; ответ позже снимает вопрос; тело ревью — общий пункт', () => {
  const d = data({
    reviews: [review('77', 'carol', 'comment', 'Почему без миграции?', '2026-10-01T09:00:00Z')],
    general: [general('1', 'dave', 'А тесты где?', '2026-10-01T10:00:00Z'), general('2', 'dave', 'Это зачем?', '2026-10-01T11:00:00Z'), general('3', 'afenin', 'Затем, что…', '2026-10-01T12:00:00Z')],
  })
  const result = discussionOf(d)
  assert.match(result.text, /- carol \(ревью 77, COMMENT\): Почему без миграции\?/)
  assert.deepEqual(result.questions, [])
  const unanswered = discussionOf(data({ general: [general('1', 'dave', 'А тесты где?', '2026-10-01T10:00:00Z')] }))
  assert.deepEqual(unanswered.questions, ['dave: А тесты где? — ответа нет'])
  assert.match(unanswered.text, /### Вопросы без ответа\n- dave: А тесты где\? — ответа нет/)
})

test('discussionOf: описание PR по запросу; свой PR — пометка во вступлении', () => {
  assert.match(discussionOf(data(), { description: true }).text, /### Описание PR\nДобавить PEP/)
  assert.doesNotMatch(discussionOf(data()).text, /Описание PR/)
  assert.match(discussionOf(data({ me: 'afenin' }), { description: true }).text, /свой PR/)
})

test('discussionOf: длинное обсуждение обрезается по блокам, открытые треды первыми', () => {
  const threads = Array.from({ length: 30 }, (_, i) => thread([comment(`c${i}`, 'carol', 'x'.repeat(500), `2026-10-01T10:${String(i).padStart(2, '0')}:00Z`, String(i))], i % 2 === 0, `f${i}.ts`, 1))
  const result = discussionOf(data({ threads }), { limit: 3000 })
  assert.equal(result.truncated, true)
  assert.ok(result.text.length < 3600)
  assert.match(result.text, /обсуждение обрезано: показано \d+ из 30 блоков/)
  assert.match(result.text, /### T2 · f1\.ts:1 · open/)
  assert.equal(result.threads.length, 30)
})
