import { DELETED } from './input.ts'

const VERDICTS = ['refuted', 'confirmed', 'cannot-refute']
const GATE_FAILURES = ['exhausted', 'stopped', 'hook-error', 'no-manifest']
const EVIDENCE = /(?:^|[\s(`"'])([\p{L}\p{N}_./@-]+):(\d+)(?:-\d+)?/u
const SEVERITY_RANK: Record<Severity, number> = { critical: 3, important: 2, minor: 1 }
const MIN_QUOTE_WORDS = 6
const MIN_QUOTE_CHARS = 30
const CLASSES: Record<TriageMode, string[]> = { feedback: ['valid', 'invalid', 'question', 'out-of-scope'], recheck: ['closed', 'open', 'partial'] }
const FALLBACK: Record<TriageMode, string> = { feedback: 'question', recheck: 'unknown' }
const TYPOGRAPHY: Record<string, string> = { '—': '-', '–': '-', '«': '"', '»': '"', '“': '"', '”': '"', '„': '"', 'ё': 'е', 'Ё': 'Е' }

export type Severity = 'critical' | 'important' | 'minor'
export type TriageMode = 'feedback' | 'recheck'

export interface Finding {
  id: string
  role?: string
  file: string
  line: number
  lines?: number[]
  severity: Severity
  confidence: number
  problem: string
  failureScenario?: string
  rule?: { file: string; quote: string }
  suggestion?: string
  verdict?: string
  evidence?: string
  duplicateOf?: string
  mark?: string
  ruleDropped?: string
}

export interface ThresholdRow {
  verdict: string
  severity: Severity[]
  min: number
  result: 'in' | 'below'
  mark?: string
}

export interface GateRow {
  role?: string
  event?: string
  unread?: string[]
  error?: string
}

export interface FindingsResult {
  findings: Finding[]
  belowBar: Finding[]
  dropped: Array<{ id: string; reason: string }>
  notChecked: string[]
}

export interface TriageAnswer {
  id: string
  class: string
  reason: string
  fixed?: true
  evidence?: string
}

interface RawFunnel {
  findings: Finding[]
  verdicts: Array<Record<string, unknown>>
  refuter: string
  failed: string[]
  roles: string[]
  notChecked: string[]
}

function sameFile(path: string, file: string): boolean {
  const cleaned = path.replace(/^\.\//, '')
  return cleaned === file || file.endsWith(`/${cleaned}`) || cleaned.endsWith(`/${file}`)
}

function evidenceLine(evidence: string | undefined, file: string): number | null {
  const match = EVIDENCE.exec(evidence ?? '')
  return match && sameFile(match[1], file) ? Number(match[2]) : null
}

function verdictOf(item: Finding, verdict: Record<string, unknown> | undefined): Finding {
  const name = verdict?.verdict
  if (!verdict || typeof name !== 'string' || !VERDICTS.includes(name)) return { ...item, verdict: 'cannot-refute' }
  const evidence = typeof verdict.evidence === 'string' ? verdict.evidence : ''
  if (name === 'refuted') return evidenceLine(evidence, item.file) !== null ? { ...item, verdict: 'refuted', evidence } : { ...item, verdict: 'cannot-refute' }
  if (name === 'confirmed') {
    const severity = (verdict.severity as Severity) ?? item.severity
    const ruleFloor = item.rule && SEVERITY_RANK[item.severity] >= SEVERITY_RANK.important && SEVERITY_RANK[severity] < SEVERITY_RANK.important
    return { ...item, verdict: 'confirmed', severity: ruleFloor ? 'important' : severity, confidence: (verdict.confidence as number) ?? item.confidence, ...(evidence ? { evidence } : {}) }
  }
  return { ...item, verdict: 'cannot-refute' }
}

export function normalize(text: string): string {
  const plain = text.normalize('NFKC').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*(?:[-*+>]|\d+\.)\s+/gm, '').replace(/\|/g, ' ')
  const typo = [...plain].map(char => TYPOGRAPHY[char] ?? char).join('')
  return typo.replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim()
}

function resolvePath(path: string, known: readonly string[]): string | null {
  const cleaned = path.replace(/^\.\//, '')
  if (known.includes(cleaned)) return cleaned
  return known.filter(item => cleaned.endsWith(`/${item}`)).sort((a, b) => b.length - a.length)[0] ?? null
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

function ruleReason(rule: { file: string; quote: string }, rules: Map<string, string>): string | null {
  const file = resolvePath(rule.file, [...rules.keys()])
  if (file === null) return 'rule-file-not-provided'
  const quote = normalize(rule.quote)
  if (quote.split(' ').length < MIN_QUOTE_WORDS || quote.length < MIN_QUOTE_CHARS) return 'quote-too-short'
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped(quote)}(?![\\p{L}\\p{N}_])`, 'u')
  return pattern.test(normalize(rules.get(file) ?? '')) ? null : 'quote-not-found'
}

function checkedItem(item: Finding, rules: Map<string, string>, changed: string[], lineCounts: Map<string, number>): { item: Finding } | { reason: string } {
  const file = resolvePath(item.file, changed)
  if (file === null) return { reason: 'file-not-in-diff' }
  if (!lineCounts.has(file)) return { reason: 'file-not-text' }
  if (item.line > (lineCounts.get(file) ?? 0)) return { reason: 'line-out-of-range' }
  const result = { ...item, file }
  const scenario = Boolean(item.failureScenario?.trim())
  if (!item.rule) return scenario ? { item: result } : { reason: 'no-evidence' }
  const problem = ruleReason(item.rule, rules)
  if (problem === null) return { item: { ...result, rule: { ...item.rule, file: resolvePath(item.rule.file, [...rules.keys()]) ?? item.rule.file } } }
  if (!scenario) return { reason: problem }
  const { rule: _rule, ...withoutRule } = result
  return { item: { ...withoutRule, ruleDropped: problem } }
}

function stronger(a: Finding, aBucket: number, b: Finding, bBucket: number): boolean {
  const left = [aBucket, SEVERITY_RANK[a.severity], a.confidence]
  const right = [bBucket, SEVERITY_RANK[b.severity], b.confidence]
  const index = left.findIndex((value, i) => value !== right[i])
  return index >= 0 && left[index] > right[index]
}

function withoutDuplicate({ duplicateOf: _duplicate, ...item }: Finding): Finding {
  return item
}

function foldDuplicates(kept: Finding[], below: Finding[]): [Finding[], Finding[], Array<{ id: string; reason: string }>] {
  const survivors = new Map<string, [Finding, number]>([...kept.map(item => [item.id, [item, 1]] as [string, [Finding, number]]), ...below.map(item => [item.id, [item, 0]] as [string, [Finding, number]])])
  const merged = new Map(survivors)
  const dropped: Array<{ id: string; reason: string }> = []
  for (const id of survivors.keys()) {
    const current = merged.get(id)
    if (!current) continue
    const [item, bucket] = current
    const target = item.duplicateOf ? merged.get(item.duplicateOf) : undefined
    if (!target || item.duplicateOf === id || target[0].file !== item.file) continue
    const [keep, keepBucket, lose] = stronger(item, bucket, target[0], target[1]) ? [item, bucket, target[0]] : [target[0], target[1], item]
    const lines = [...new Set([...(keep.lines ?? [keep.line]), ...(lose.lines ?? [lose.line])])].sort((a, b) => a - b)
    merged.set(keep.id, [{ ...keep, lines, line: lines[0] }, keepBucket])
    merged.delete(lose.id)
    dropped.push({ id: lose.id, reason: `duplicate-of:${keep.id}` })
  }
  const values = [...merged.values()]
  return [values.filter(([, b]) => b === 1).map(([item]) => withoutDuplicate(item)), values.filter(([, b]) => b === 0).map(([item]) => withoutDuplicate(item)), dropped]
}

function applyThreshold(items: Finding[], table: ThresholdRow[]): [Finding[], Finding[], Array<{ id: string; reason: string }>] {
  const kept: Finding[] = []
  const below: Finding[] = []
  const dropped: Array<{ id: string; reason: string }> = []
  for (const item of items) {
    const row = table.find(r => r.verdict === item.verdict && r.severity.includes(item.severity) && item.confidence >= r.min)
    const marked = row?.mark ? { ...item, mark: row.mark } : item
    if (!row) dropped.push({ id: item.id, reason: item.verdict === 'refuted' ? `refuted:${item.evidence}` : `below-threshold:${item.verdict}:${item.severity}:${item.confidence}` })
    else if (row.result === 'in') kept.push(marked)
    else below.push(marked)
  }
  return [kept, below, dropped]
}

function readRaw(raw: unknown): RawFunnel {
  const box = raw as Record<string, unknown> | null
  const result = (box && 'workflowProgress' in box ? box.result : box) as RawFunnel | null
  if (!result || typeof result !== 'object' || !Array.isArray(result.findings)) throw new Error('Workflow не вернул результат — ревью агентами не состоялось')
  if (result.roles?.length && result.roles.every(role => result.failed?.includes(role))) throw new Error(`ни один агент-искатель не ответил (${result.roles.join(', ')}) — ревью агентами не состоялось`)
  return { findings: result.findings, verdicts: result.verdicts ?? [], refuter: result.refuter ?? 'ok', failed: result.failed ?? [], roles: result.roles ?? [], notChecked: result.notChecked ?? [] }
}

function gateNotes(rows: GateRow[]): string[] {
  if (rows.length === 0) return ['гейт чтения: записей нет — чтение агентов не подтверждено']
  return rows.filter(row => GATE_FAILURES.includes(row.event ?? '')).map(row => `агент ${row.role}: гейт чтения — ${row.event}${row.unread?.length ? `: не прочитаны ${row.unread.join(', ')}` : ''}${row.error ? ` (${row.error})` : ''}`)
}

export function collectFindings(input: { raw: unknown; changed: string[]; lineCounts: Map<string, number>; rules: Map<string, string>; skipped: Map<string, string>; table: ThresholdRow[]; manifestNotes: string[]; gateRows: GateRow[]; minSeverity?: Severity }): FindingsResult {
  const raw = readRaw(input.raw)
  const verdicts = new Map(raw.verdicts.filter(v => v && typeof v === 'object').map(v => [v.id as string, v]))
  const resolved = raw.findings.map(item => {
    const verdict = verdicts.get(item.id)
    const duplicate = typeof verdict?.duplicateOf === 'string' ? { duplicateOf: verdict.duplicateOf } : {}
    return { ...verdictOf(item, verdict), lines: [item.line], ...duplicate }
  })
  const valid: Finding[] = []
  const invalid: Array<{ id: string; reason: string }> = []
  for (const item of resolved) {
    if (item.verdict === 'refuted') {
      invalid.push({ id: item.id, reason: `refuted:${item.evidence}` })
      continue
    }
    const line = item.verdict === 'confirmed' ? evidenceLine(item.evidence, item.file) : null
    const located = line !== null && line >= 1 && line <= (input.lineCounts.get(item.file) ?? 0) ? { ...item, line, lines: [line] } : item
    const checked = checkedItem(located, input.rules, input.changed, input.lineCounts)
    if ('reason' in checked) invalid.push({ id: item.id, reason: checked.reason })
    else valid.push(checked.item)
  }
  const [passed, passedBelow, belowDropped] = applyThreshold(valid, input.table)
  const [folded, below, foldDropped] = foldDuplicates(passed, passedBelow)
  const floor = input.minSeverity ? SEVERITY_RANK[input.minSeverity] : 0
  const findings = folded.filter(item => SEVERITY_RANK[item.severity] >= floor)
  const minDropped = folded.filter(item => SEVERITY_RANK[item.severity] < floor).map(item => ({ id: item.id, reason: `below-${input.minSeverity}` }))
  const skipped = [...input.skipped.keys()]
  const notes = [
    ...raw.notChecked.filter(note => !skipped.some(path => note === path || note.startsWith(`${path} `))),
    ...[...input.skipped].filter(([, why]) => why !== DELETED).map(([path, why]) => `${path} — не приложен: ${why}`),
    ...input.manifestNotes,
    ...gateNotes(input.gateRows),
    ...raw.failed.map(role => `агент ${role} не ответил — угол ${role} не проверен`),
    ...(raw.refuter === 'failed' ? ['агент C не ответил — вердиктов нет'] : []),
  ]
  return { findings, belowBar: below, dropped: [...invalid, ...belowDropped, ...foldDropped, ...minDropped], notChecked: [...new Set(notes)] }
}

export function finishTriage(raw: unknown, items: Array<{ id: string }>, mode: TriageMode): TriageAnswer[] {
  const box = raw as { result?: unknown; items?: unknown } | null
  const answer = (box?.result && typeof box.result === 'object' ? box.result : box) as { items?: Array<Record<string, unknown>> } | null
  const answers = new Map((answer?.items ?? []).filter(a => a && typeof a === 'object').map(a => [a.id as string, a]))
  return items.map(item => {
    const found = answers.get(item.id)
    const cls = found?.class
    if (typeof cls !== 'string' || !CLASSES[mode].includes(cls)) return { id: item.id, class: FALLBACK[mode], reason: 'агент D не дал ответа по этому пункту' }
    return {
      id: item.id, class: cls, reason: typeof found?.reason === 'string' ? found.reason : '',
      ...(cls === 'valid' && found?.fixed === true ? { fixed: true as const } : {}),
      ...(typeof found?.evidence === 'string' && found.evidence ? { evidence: found.evidence } : {}),
    }
  })
}
