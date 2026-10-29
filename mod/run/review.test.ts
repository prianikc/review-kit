import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDraft, buildReplies, chosenVerdict, openThreads, parseCovered, undecidedAnswers, verdictName } from './review.ts'
import { MARKER } from '../status.ts'
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

test('chosenVerdict: явный вердикт пользователя сильнее находок и статусов; решение Plannotator; иначе по находкам и статусам', () => {
  const partial = [{ class: 'partial' }]
  assert.equal(chosenVerdict({ selected: [], statuses: partial }), 'Approved')
  assert.equal(chosenVerdict({ selected: [], statuses: partial, verdict: 'approve' }), 'Approved')
  assert.equal(chosenVerdict({ selected: [f('A-1', 'important')], verdict: 'approve' }), 'Approved with comments')
  assert.equal(chosenVerdict({ selected: [f('A-1', 'minor')], verdict: 'request-changes' }), 'Changes requested')
  assert.equal(chosenVerdict({ selected: [], decision: 'approved' }), 'Approved')
  assert.equal(chosenVerdict({ selected: [f('A-1', 'minor')], decision: 'annotated' }), 'Changes requested')
  assert.equal(chosenVerdict({ selected: [f('A-1', 'critical')] }), 'Blocked')
})

test('buildDraft: явное одобрение при открытых прошлых замечаниях без выбранных находок — голое одобрение', () => {
  const { draft } = buildDraft({ selected: [], texts: { summary: 'Прошлые замечания: закрыто 0, не закрыто 0, частично 1.', comments: {} }, verdict: chosenVerdict({ selected: [], statuses: [{ class: 'partial' }], verdict: 'approve' }), approve: true, covered: COVERED, capabilities: CAPS })
  assert.deepEqual(draft, { verdict: 'approve', body: '', comments: [] })
})

test('parseCovered: строки новых хунков по файлам', () => {
  const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +3,2 @@\n+x\n+y\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-z\n'
  assert.deepEqual([...parseCovered(diff)], [['a.ts', new Set([3, 4])]])
})

test('buildDraft: inline в diff, вне diff — в тело; request changes без лишнего текста', () => {
  const { draft } = buildDraft({ selected: [f('A-1', 'important', 3), f('A-2', 'minor', 9)], texts: { comments: { 'A-1': 'один', 'A-2': 'два' } }, verdict: 'Changes requested', approve: false, covered: COVERED, capabilities: CAPS })
  assert.deepEqual(draft, { verdict: 'request-changes', body: 'Вне diff:\n- a.ts:9 — два', comments: [{ path: 'a.ts', line: 3, body: 'один' }] })
})

test('buildDraft: approve только при одобряемом вердикте; без approve — комментарий', () => {
  assert.throws(() => buildDraft({ selected: [f('A-1', 'important')], texts: { comments: { 'A-1': 'x' } }, verdict: 'Changes requested', approve: true, covered: COVERED, capabilities: CAPS }), /одобрение при вердикте Changes requested невозможно/)
  assert.equal(buildDraft({ selected: [], texts: { comments: {} }, verdict: 'Approved', approve: true, covered: COVERED, capabilities: CAPS }).draft.verdict, 'approve')
  assert.deepEqual(buildDraft({ selected: [], texts: { comments: {} }, verdict: 'Approved', approve: false, covered: COVERED, capabilities: CAPS }).draft, { verdict: 'comment', body: 'Замечаний нет.', comments: [] })
})

test('buildDraft: одобрение без находок — без тела и комментариев, даже с summary', () => {
  assert.deepEqual(buildDraft({ selected: [], texts: { summary: 'Всё хорошо', comments: {} }, verdict: 'Approved', approve: true, covered: COVERED, capabilities: CAPS }).draft, { verdict: 'approve', body: '', comments: [] })
  assert.equal(buildDraft({ selected: [f('A-1', 'minor')], texts: { summary: 'Итог', comments: { 'A-1': 'x' } }, verdict: 'Approved with comments', approve: true, covered: COVERED, capabilities: CAPS }).draft.body, 'Итог')
})

test('chosenVerdict: без содержания запроса изменений нет — вычисленный становится одобрением, явный — ошибка', () => {
  assert.equal(chosenVerdict({ selected: [], statuses: [{ class: 'partial' }] }), 'Approved')
  assert.equal(chosenVerdict({ selected: [], openThreads: 2 }), 'Approved')
  assert.throws(() => chosenVerdict({ selected: [], verdict: 'request-changes' }), /запрос изменений без комментариев не отправляется/)
  assert.throws(() => chosenVerdict({ selected: [], decision: 'annotated' }), /запрос изменений без комментариев не отправляется/)
  assert.equal(chosenVerdict({ selected: [], statuses: [{ class: 'partial' }], content: 1 }), 'Changes requested')
  assert.equal(chosenVerdict({ selected: [f('A-1', 'minor')], openThreads: 1 }), 'Changes requested')
})

test('buildDraft: request changes с пустым телом — «Нужны правки.», с комментариями к строкам и без (Forgejo требует тело)', () => {
  assert.equal(buildDraft({ selected: [f('A-1', 'critical')], texts: { comments: { 'A-1': 'x' } }, verdict: 'Blocked', approve: false, covered: COVERED, capabilities: CAPS }).draft.body, 'Нужны правки.')
  assert.equal(buildDraft({ selected: [], texts: { comments: {} }, verdict: 'Changes requested', approve: false, covered: COVERED, capabilities: CAPS }).draft.body, 'Нужны правки.')
})

test('buildReplies: пункты прошлых замечаний — тред или цитата', () => {
  const prior = [{ id: 'r1/c1', threadId: 'r1:a.ts:3', quote: 'null тут' }, { id: 'review/r1', threadId: null, quote: 'Общее\nвторая' }]
  assert.deepEqual(buildReplies(prior, { 'r1/c1': 'Не принято', 'review/r1': 'Ответ' }), [
    { threadId: 'r1:a.ts:3', body: `Не принято\n\n${MARKER}` },
    { quote: 'Общее', body: `Ответ\n\n${MARKER}` },
  ])
})

test('buildDraft: система без request changes и без inline — комментарий, всё в теле, заметки', () => {
  const { draft, notes } = buildDraft({ selected: [f('A-1', 'important')], texts: { comments: { 'A-1': 'x' } }, verdict: 'Changes requested', approve: false, covered: COVERED, capabilities: { inline: false, requestChanges: false } })
  assert.deepEqual(draft, { verdict: 'comment', body: 'Вне diff:\n- a.ts:3 — x', comments: [] })
  assert.equal(notes.length, 2)
})

test('buildDraft: нет текста для находки — ошибка', () => {
  assert.throws(() => buildDraft({ selected: [f('A-1', 'minor')], texts: { comments: {} }, verdict: 'Approved with comments', approve: false, covered: COVERED, capabilities: CAPS }), /нет текста для: A-1/)
})

test('ответ автора: answered без решения — нерешён и требует правок; принятый — закрыт', () => {
  assert.equal(verdictName([], [{ class: 'answered' }]), 'Changes requested')
  assert.equal(verdictName([], [{ class: 'accepted' }]), 'Approved')
  assert.deepEqual(undecidedAnswers([{ id: 'r/1', class: 'answered' }, { id: 'r/2', class: 'accepted' }]), ['r/1'])
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

test('chosenVerdict: открытый тред не даёт одобрить, если есть что отправить; явный вердикт и Plannotator сильнее', () => {
  assert.equal(chosenVerdict({ selected: [], openThreads: 1 }), 'Approved')
  assert.equal(chosenVerdict({ selected: [f('A-1', 'minor')], openThreads: 2 }), 'Changes requested')
  assert.equal(chosenVerdict({ selected: [f('A-1', 'critical')], openThreads: 1 }), 'Blocked')
  assert.equal(chosenVerdict({ selected: [], openThreads: 1, verdict: 'approve' }), 'Approved')
  assert.equal(chosenVerdict({ selected: [], openThreads: 1, decision: 'approved' }), 'Approved')
  assert.equal(chosenVerdict({ selected: [], openThreads: 0 }), 'Approved')
})

test('openThreads: открытые треды без тех, что перепроверка закрыла', () => {
  const threads = [
    { id: 'T1', place: 'a.ts:1', status: 'open' as const, last: 'автор' as const, commentIds: ['c1', 'c2'] },
    { id: 'T2', place: 'a.ts:5', status: 'open' as const, last: 'мы' as const, commentIds: ['c3'] },
    { id: 'T3', place: 'a.ts:9', status: 'resolved' as const, last: 'мы' as const, commentIds: ['c4'] },
  ]
  assert.deepEqual(openThreads(threads), ['T1', 'T2'])
  assert.deepEqual(openThreads(threads, [{ id: 'r1/c1', class: 'closed' }, { id: 'r1/c3', class: 'open' }]), ['T2'])
  assert.deepEqual(openThreads(threads, [{ id: 'r1/c3', class: 'accepted' }]), ['T1'])
})
