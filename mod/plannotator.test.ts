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
