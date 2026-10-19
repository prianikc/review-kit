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

test('buildDraft: одобрение без находок — без тела и комментариев, даже с summary', () => {
  assert.deepEqual(buildDraft({ selected: [], texts: { summary: 'Всё хорошо', comments: {} }, verdict: 'Approved', approve: true, covered: COVERED, capabilities: CAPS }).draft, { verdict: 'approve', body: '', comments: [] })
  assert.equal(buildDraft({ selected: [f('A-1', 'minor')], texts: { summary: 'Итог', comments: { 'A-1': 'x' } }, verdict: 'Approved with comments', approve: true, covered: COVERED, capabilities: CAPS }).draft.body, 'Итог')
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
