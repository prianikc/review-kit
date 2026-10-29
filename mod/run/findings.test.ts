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
const finding = (over: Partial<Finding> = {}): Finding => ({ id: 'A-1', role: 'correctness', file: 'src/a.ts', line: 3, severity: 'blocking', category: 'regression', confidence: 90, problem: 'p', failureScenario: 's', ...over })
const raw = (findings: Finding[], verdicts: unknown[], over = {}) => ({ findings, verdicts, refuter: 'ok', failed: [], roles: ['correctness', 'quality'], notChecked: [], ...over })

test('подтверждённая блокирующая ≥75 — в отчёт; строка из evidence C', () => {
  const result = collectFindings({ ...base, raw: raw([finding()], [{ id: 'A-1', verdict: 'confirmed', evidence: 'src/a.ts:5 — так', severity: 'blocking', confidence: 80 }]) })
  assert.deepEqual(result.findings.map(f => [f.id, f.line, f.verdict]), [['A-1', 5, 'confirmed']])
})

test('опровержение с доказательством в чужом файле → cannot-refute (ниже порога с меткой)', () => {
  const result = collectFindings({ ...base, raw: raw([finding()], [{ id: 'A-1', verdict: 'refuted', evidence: 'src/other.ts:2 — не так' }]) })
  assert.equal(result.belowBar[0].mark, 'C не проверил')
})

test('опровергнутая находка выпадает с причиной', () => {
  const result = collectFindings({ ...base, raw: raw([finding()], [{ id: 'A-1', verdict: 'refuted', evidence: 'src/a.ts:3 — проверено' }]) })
  assert.deepEqual(result.dropped, [{ id: 'A-1', reason: 'refuted:src/a.ts:3 — проверено' }])
})

test('цитата правила: найдена после нормализации; не из RULES — rule-file-not-provided; нет сценария и цитата неверна — выпадает', () => {
  const quoted = finding({ id: 'B-1', role: 'quality', failureScenario: undefined, rule: { file: './CLAUDE.md', quote: 'Все  экспортируемые функции должны иметь *комментарий* над объявлением' } })
  const foreign = finding({ id: 'B-2', role: 'quality', failureScenario: undefined, rule: { file: '.claude/rules/x.md', quote: RULE } })
  const confirm = (id: string) => ({ id, verdict: 'confirmed', evidence: 'src/a.ts:3 — да', severity: 'blocking', confidence: 90 })
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
    { id: 'A-1', verdict: 'confirmed', evidence: 'src/a.ts:3 — да', severity: 'blocking', confidence: 90 },
    { id: 'B-1', verdict: 'confirmed', evidence: 'src/a.ts:4 — да', severity: 'non-blocking', confidence: 90, duplicateOf: 'A-1' },
  ]) })
  assert.deepEqual(result.findings.map(f => [f.id, f.lines]), [['A-1', [3, 4]]])
  assert.deepEqual(result.dropped, [{ id: 'B-1', reason: 'duplicate-of:A-1' }])
})

test('delta перепроверки (minSeverity blocking): неблокирующая уходит в dropped, блокирующая остаётся', () => {
  const result = collectFindings({ ...base, minSeverity: 'blocking', raw: raw([finding({ id: 'A-1', category: 'security' }), finding({ id: 'A-2', line: 6, severity: 'non-blocking' })], [
    { id: 'A-1', verdict: 'confirmed', evidence: 'src/a.ts:3 — да', confidence: 95 },
    { id: 'A-2', verdict: 'confirmed', evidence: 'src/a.ts:6 — да', severity: 'non-blocking', confidence: 95 },
  ]) })
  assert.deepEqual([result.findings.map(f => f.id), result.dropped], [['A-1'], [{ id: 'A-2', reason: 'below-blocking' }]])
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
  assert.deepEqual(finishTriage(answers, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]), [
    { id: 'a', class: 'valid', reason: 'r', fixed: true, evidence: 'e' },
    { id: 'b', class: 'invalid', reason: 'r' },
    { id: 'c', class: 'question', reason: 'агент D не дал ответа по этому пункту' },
    { id: 'd', class: 'question', reason: 'агент D не дал ответа по этому пункту' },
  ])
  assert.equal(finishTriage({ result: { items: [] } }, [{ id: 'x' }])[0].class, 'question')
})

test('«Не проверялось»: удалённый в PR файл не попадает, строка агента о файле, про который сказал мод, — одна', () => {
  const skipped = new Map([['src/gone.ts', 'удалён'], ['big.txt', 'больше 60000 символов']])
  const notChecked = ['src/gone.ts', 'big.txt (не приложен: больше 60000 символов)', 'src/a.ts — не смог проверить вызовы']
  const result = collectFindings({ ...base, skipped, raw: raw([], [], { notChecked }) })
  assert.deepEqual(result.notChecked, ['src/a.ts — не смог проверить вызовы', 'big.txt — не приложен: больше 60000 символов'])
})

test('нарушение правила проекта: C не опускает блокирующую с правилом — она остаётся blocking/rule', () => {
  const ruled = finding({ id: 'B-1', role: 'quality', category: 'rule', failureScenario: undefined, rule: { file: 'CLAUDE.md', quote: RULE } })
  const lowered = collectFindings({ ...base, raw: raw([ruled], [{ id: 'B-1', verdict: 'confirmed', evidence: 'src/a.ts:3 — так', severity: 'non-blocking', confidence: 90 }]) })
  assert.deepEqual([lowered.findings[0].severity, lowered.findings[0].category], ['blocking', 'rule'])
})

test('блокирующая без категории — в «не подтверждено» с причиной no-category', () => {
  const result = collectFindings({ ...base, raw: raw([finding({ category: undefined })], [{ id: 'A-1', verdict: 'confirmed', evidence: 'src/a.ts:3 — да', confidence: 90 }]) })
  assert.equal(result.findings.length, 0)
  assert.deepEqual(result.dropped, [{ id: 'A-1', reason: 'no-category' }])
})

test('категория rule без подтверждённой цитаты — rule-category-without-rule; у неблокирующей категория снимается', () => {
  const badQuote = finding({ category: 'rule', rule: { file: 'CLAUDE.md', quote: 'совсем другая цитата из правил проекта которой нет' } })
  const ok = { id: 'A-1', verdict: 'confirmed', evidence: 'src/a.ts:3 — да', confidence: 90 }
  assert.deepEqual(collectFindings({ ...base, raw: raw([badQuote], [ok]) }).dropped, [{ id: 'A-1', reason: 'rule-category-without-rule' }])
  const plain = collectFindings({ ...base, raw: raw([finding({ severity: 'non-blocking', category: 'goal' })], [{ ...ok, severity: 'non-blocking' }]) })
  assert.equal(plain.findings[0].category, undefined)
})

test('C может сменить категорию блокирующей; неизвестная категория C не принимается', () => {
  const changed = collectFindings({ ...base, raw: raw([finding()], [{ id: 'A-1', verdict: 'confirmed', evidence: 'src/a.ts:3 — да', severity: 'blocking', category: 'goal', confidence: 90 }]) })
  assert.equal(changed.findings[0].category, 'goal')
  const unknown = collectFindings({ ...base, raw: raw([finding()], [{ id: 'A-1', verdict: 'confirmed', evidence: 'src/a.ts:3 — да', category: 'style', confidence: 90 }]) })
  assert.equal(unknown.findings[0].category, 'regression')
})

test('unconfirmed: опровергнутые и отброшенные — с файлом, строкой и проблемой; дубли — нет; пул ревью — все три списка', () => {
  const result = collectFindings({ ...base, raw: raw([
    finding({ id: 'A-1' }), finding({ id: 'A-2', file: 'x.ts' }), finding({ id: 'B-1', role: 'quality', line: 4, severity: 'non-blocking', confidence: 40 }),
    finding({ id: 'B-2', role: 'quality', line: 5 }), finding({ id: 'B-3', role: 'quality', line: 3 }),
  ], [
    { id: 'A-1', verdict: 'refuted', evidence: 'src/a.ts:3 — [так] и задумано' },
    { id: 'B-1', verdict: 'confirmed', evidence: 'src/a.ts:4 — да', severity: 'non-blocking', confidence: 40 },
    { id: 'B-2', verdict: 'confirmed', evidence: 'src/a.ts:5 — да', severity: 'blocking', confidence: 90 },
    { id: 'B-3', verdict: 'confirmed', evidence: 'src/a.ts:3 — да', severity: 'blocking', confidence: 80, duplicateOf: 'B-2' },
  ]) })
  assert.deepEqual(result.unconfirmed.map(f => [f.id, f.file, f.line, f.problem, f.mark]), [
    ['A-1', 'src/a.ts', 3, 'p', 'опровергнуто'], ['A-2', 'x.ts', 3, 'p', 'отброшено: file-not-in-diff'], ['B-1', 'src/a.ts', 4, 'p', 'отброшено: below-threshold:confirmed:non-blocking:40'],
  ])
  assert.equal(result.unconfirmed[0].evidence, 'src/a.ts:3 — [так] и задумано')
  assert.deepEqual(reviewPool(result).map(f => [f.id, f.mark ?? '']), [['B-2', ''], ['A-1', 'опровергнуто'], ['A-2', 'отброшено: file-not-in-diff'], ['B-1', 'отброшено: below-threshold:confirmed:non-blocking:40']])
})

const THREADS = [
  { id: 'T1', place: 'src/a.ts:3', status: 'open' as const, last: 'мы' as const, commentIds: ['c1'] },
  { id: 'T2', place: 'src/a.ts:8', status: 'open' as const, last: 'автор' as const, lastAuthorReply: 'вынесено в #205', commentIds: ['c2', 'c3'] },
]
const confirmed = (id: string) => ({ id, verdict: 'confirmed', evidence: 'src/a.ts:3 — да', severity: 'blocking', confidence: 90 })

test('thread: у каждой находки Tn или null; неизвестный тред — null', () => {
  const result = collectFindings({ ...base, threads: THREADS, raw: raw([finding(), finding({ id: 'A-2', thread: 'T9' }), finding({ id: 'A-3', thread: 'T1' })], ['A-1', 'A-2', 'A-3'].map(confirmed)) })
  assert.deepEqual(result.findings.map(f => [f.id, f.thread]), [['A-1', null], ['A-2', null], ['A-3', 'T1']])
})

test('повтор треда с ответом автора (в треде или общим комментарием) → unconfirmed; follow-up остаётся', () => {
  const inThread = finding({ id: 'A-1', thread: 'T2' })
  const general = finding({ id: 'A-2', thread: 'T1', authorReply: 'валидация вынесена в #205 (issue 8917)' })
  const followUp = finding({ id: 'A-3', thread: 'T2', followUp: '#205 не трогает .env.example' })
  const result = collectFindings({ ...base, threads: THREADS, raw: raw([inThread, general, followUp], ['A-1', 'A-2', 'A-3'].map(confirmed)) })
  assert.deepEqual(result.findings.map(f => [f.id, f.thread, f.followUp]), [['A-3', 'T2', '#205 не трогает .env.example']])
  assert.deepEqual(result.unconfirmed.map(f => [f.id, f.mark]), [['A-1', 'повтор T2, автор ответил: вынесено в #205'], ['A-2', 'повтор T1, автор ответил: валидация вынесена в #205 (issue 8917)']])
  assert.deepEqual(result.dropped.map(d => d.reason), ['repeat:T2', 'repeat:T1'])
})

test('повтор открытого треда без ответа автора — находка остаётся с thread', () => {
  const result = collectFindings({ ...base, threads: THREADS, raw: raw([finding({ thread: 'T1' })], [confirmed('A-1')]) })
  assert.deepEqual(result.findings.map(f => [f.id, f.thread]), [['A-1', 'T1']])
})

test('fix-check (repeats: false): ответ в треде находку не снимает', () => {
  const result = collectFindings({ ...base, threads: THREADS, repeats: false, raw: raw([finding({ thread: 'T2' })], [confirmed('A-1')]) })
  assert.deepEqual(result.findings.map(f => f.id), ['A-1'])
})

test('C: closed с тредом → «закрыто в обсуждении»; без известного треда — cannot-refute', () => {
  const result = collectFindings({ ...base, threads: THREADS, raw: raw([finding(), finding({ id: 'A-2', severity: 'blocking' })], [
    { id: 'A-1', verdict: 'closed', thread: 'T2', evidence: 'автор вынес в #205' },
    { id: 'A-2', verdict: 'closed', thread: 'T7', evidence: '?' },
  ]) })
  assert.deepEqual(result.unconfirmed.map(f => [f.id, f.mark, f.thread, f.evidence]), [['A-1', 'закрыто в обсуждении', 'T2', 'T2 — автор вынес в #205']])
  assert.deepEqual(result.dropped.map(d => d.reason), ['closed-in-discussion:T2'])
  assert.deepEqual(result.belowBar.map(f => [f.id, f.mark]), [['A-2', 'C не проверил']])
})

test('finishTriage: класс todo принимается, класс перепроверки — нет', () => {
  const answers = { items: [{ id: 'a', class: 'todo', reason: 'не блокирует' }] }
  assert.equal(finishTriage(answers, [{ id: 'a' }])[0].class, 'todo')
  assert.equal(finishTriage({ items: [{ id: 'a', class: 'answered', reason: 'r' }] }, [{ id: 'a' }])[0].class, 'question')
})
