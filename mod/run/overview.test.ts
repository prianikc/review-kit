import { test } from 'node:test'
import assert from 'node:assert/strict'
import { overviewText, triageText } from './overview.ts'
import { intakeItems, MARKER, type PrData } from '../status.ts'
import type { Comment, Review, Thread } from '../forge/types.ts'

const comment = (id: string, author: string, body: string, createdAt: string, reviewId = 'r1', line = 3): Comment => ({ id, author, body, createdAt, path: 'a.ts', line, commitSha: 'h2', reviewId })
const thread = (comments: Comment[], resolved = false): Thread => ({ id: `${comments[0].reviewId}:a.ts:${comments[0].line}`, path: 'a.ts', line: comments[0].line, commitSha: 'h2', comments, resolved })
const review = (id: string, author: string, state: Review['state'], body = ''): Review => ({ id, author, state, body, commitSha: 'h2', submittedAt: '2026-10-01T13:00:00Z', dismissed: false })
const data = (over: Partial<PrData> = {}): PrData => ({
  pull: { number: 5, title: 'T', author: 'alice', headRef: 'f', headSha: 'h2', baseRef: 'main', state: 'open', merged: false, url: 'u', conflicted: false },
  me: 'alice', reviews: [], threads: [], general: [], ...over,
})

const PR = data({
  reviews: [review('r9', 'carol', 'pending')],
  threads: [
    thread([comment('c1', 'carol', 'Имя\nплохое', '2026-10-01T10:00:00Z'), comment('c2', 'alice', 'Так принято', '2026-10-01T11:00:00Z'), comment('c3', 'carol', 'Нет', '2026-10-01T12:00:00Z')]),
    thread([comment('c4', 'dave', 'Лишний импорт', '2026-10-01T10:00:00Z', 'r2', 7)], true),
    thread([comment('c5', 'dave', 'Тест?', '2026-10-01T10:00:00Z', 'r3', 9), comment('c6', 'kit', `Добавил\n\n${MARKER}`, '2026-10-01T11:00:00Z', 'r3', 9)]),
    thread([comment('c7', 'carol', 'черновик', '2026-10-01T10:00:00Z', 'r9', 11)]),
  ],
  general: [comment('g1', 'erin', 'Опишите миграцию', '2026-10-01T14:00:00Z', '')],
})

test('overviewText: к разбору с перепиской и пометками, закрытые и ждущие ревьюера; черновик не виден', () => {
  const text = overviewText(PR, intakeItems(PR))
  assert.equal(text, [
    'Замечания к PR 5: к разбору 2, закрыто 1, ждут ответа ревьюера 1.',
    '**К разбору**\n1. `a.ts:3` · carol · ревьюер не согласен с ответом\n   > carol: Имя плохое\n   > я: Так принято\n   > carol: Нет\n2. общий · erin\n   > erin: Опишите миграцию',
    '**Закрыто**\n- `a.ts:7` — dave: Лишний импорт',
    '**Ждут ответа ревьюера**\n- `a.ts:9` — dave: Тест?',
  ].join('\n\n'))
})

test('triageText: номера как в обзоре, вердикт словами и причина, счёт по классам', () => {
  const items = intakeItems(PR)
  const text = triageText(5, items, [
    { id: items[0].id, class: 'invalid', reason: 'так требует API' },
    { id: items[1].id, class: 'valid', reason: 'описал в README', fixed: true },
  ])
  assert.equal(text, [
    'Итог разбора PR 5: исправим 0, в TODO 0, уже исправлено 1, не согласны 1, вопросы 0, вне задачи 0.',
    '1. `a.ts:3` — carol: Имя (ревьюер не согласен с прошлым ответом)\n   → не согласны — отклоняем: так требует API',
    '2. общий — erin: Опишите миграцию\n   → уже исправлено: описал в README',
  ].join('\n'))
})

test('triageText: нет ответа агента — вопрос; длинный текст обрезается', () => {
  const items = intakeItems(data({ general: [comment('g1', 'erin', 'x'.repeat(300), '2026-10-01T14:00:00Z', '')] }))
  const text = triageText(5, items, [])
  assert.match(text, /вопросы 1/)
  assert.match(text, /erin: x+…\n   → вопрос — нужен ответ$/)
  assert.ok(text.split('\n')[1].length < 160)
})

test('triageText: todo — «не блокирует — в TODO» и отдельный счёт', () => {
  const items = intakeItems(PR)
  const text = triageText(5, items, [{ id: items[0].id, class: 'todo', reason: 'стиль, не ломает' }, { id: items[1].id, class: 'valid', reason: 'нет проверки' }])
  assert.match(text, /^Итог разбора PR 5: исправим 1, в TODO 1, /)
  assert.match(text, /→ не блокирует — в TODO: стиль, не ломает/)
})
