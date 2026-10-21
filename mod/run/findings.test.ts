import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { collectFindings, finishTriage, normalize, reviewPool, type Finding } from './findings.ts'

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

test('опровергнутая находка с плохой цитатой правила — причина refuted, а не проверка цитаты', () => {
  const short = finding({ id: 'B-1', role: 'quality', failureScenario: undefined, rule: { file: 'CLAUDE.md', quote: 'комментарий' } })
  const result = collectFindings({ ...base, raw: raw([short], [{ id: 'B-1', verdict: 'refuted', evidence: 'src/a.ts:3 — так принято' }]) })
  assert.deepEqual(result.dropped, [{ id: 'B-1', reason: 'refuted:src/a.ts:3 — так принято' }])
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

test('«Не проверялось»: удалённый в PR файл не попадает, строка агента о файле, про который сказал мод, — одна', () => {
  const skipped = new Map([['src/gone.ts', 'удалён'], ['big.txt', 'больше 60000 символов']])
  const notChecked = ['src/gone.ts', 'big.txt (не приложен: больше 60000 символов)', 'src/a.ts — не смог проверить вызовы']
  const result = collectFindings({ ...base, skipped, raw: raw([], [], { notChecked }) })
  assert.deepEqual(result.notChecked, ['src/a.ts — не смог проверить вызовы', 'big.txt — не приложен: больше 60000 символов'])
})

test('нарушение правила проекта: C не опускает important ниже important, поднять может', () => {
  const ruled = finding({ id: 'B-1', role: 'quality', failureScenario: undefined, rule: { file: 'CLAUDE.md', quote: RULE } })
  const lowered = collectFindings({ ...base, raw: raw([ruled], [{ id: 'B-1', verdict: 'confirmed', evidence: 'src/a.ts:3 — так', severity: 'minor', confidence: 90 }]) })
  assert.equal(lowered.findings[0].severity, 'important')
  const raised = collectFindings({ ...base, raw: raw([ruled], [{ id: 'B-1', verdict: 'confirmed', evidence: 'src/a.ts:3 — так', severity: 'critical', confidence: 90 }]) })
  assert.equal(raised.findings[0].severity, 'critical')
  const styleMinor = collectFindings({ ...base, raw: raw([{ ...ruled, severity: 'minor' }], [{ id: 'B-1', verdict: 'confirmed', evidence: 'src/a.ts:3 — так', severity: 'minor', confidence: 90 }]) })
  assert.equal(styleMinor.belowBar.concat(styleMinor.findings)[0]?.severity ?? 'minor', 'minor')
})

test('unconfirmed: опровергнутые и отброшенные — с файлом, строкой и проблемой; дубли — нет; пул ревью — все три списка', () => {
  const result = collectFindings({ ...base, raw: raw([
    finding({ id: 'A-1' }), finding({ id: 'A-2', file: 'x.ts' }), finding({ id: 'B-1', role: 'quality', line: 4, severity: 'minor', confidence: 40 }),
    finding({ id: 'B-2', role: 'quality', line: 5 }), finding({ id: 'B-3', role: 'quality', line: 3 }),
  ], [
    { id: 'A-1', verdict: 'refuted', evidence: 'src/a.ts:3 — [так] и задумано' },
    { id: 'B-1', verdict: 'confirmed', evidence: 'src/a.ts:4 — да', severity: 'minor', confidence: 40 },
    { id: 'B-2', verdict: 'confirmed', evidence: 'src/a.ts:5 — да', severity: 'important', confidence: 90 },
    { id: 'B-3', verdict: 'confirmed', evidence: 'src/a.ts:3 — да', severity: 'important', confidence: 80, duplicateOf: 'B-2' },
  ]) })
  assert.deepEqual(result.unconfirmed.map(f => [f.id, f.file, f.line, f.problem, f.mark]), [
    ['A-1', 'src/a.ts', 3, 'p', 'опровергнуто'], ['A-2', 'x.ts', 3, 'p', 'отброшено: file-not-in-diff'], ['B-1', 'src/a.ts', 4, 'p', 'отброшено: below-threshold:confirmed:minor:40'],
  ])
  assert.equal(result.unconfirmed[0].evidence, 'src/a.ts:3 — [так] и задумано')
  assert.deepEqual(reviewPool(result).map(f => [f.id, f.mark ?? '']), [['B-2', ''], ['A-1', 'опровергнуто'], ['A-2', 'отброшено: file-not-in-diff'], ['B-1', 'отброшено: below-threshold:confirmed:minor:40']])
})

test('finishTriage: в перепроверке класс answered принимается, accepted от агента — нет', () => {
  const answers = { items: [{ id: 'a', class: 'answered', reason: 'проверка выше' }, { id: 'b', class: 'accepted', reason: 'x' }] }
  assert.deepEqual(finishTriage(answers, [{ id: 'a' }, { id: 'b' }], 'recheck').map(item => item.class), ['answered', 'unknown'])
})
