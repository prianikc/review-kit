import type { Finding } from './run/findings.ts'
import type { Texts } from './run/review.ts'

const LEVEL: Record<string, string> = { critical: 'Critical', important: 'Important', minor: 'Minor' }
const HOTSPOT = 'узкое место гайда'
const HOTSPOT_HEADER = /^\[g\d+ · узкое место гайда\]$/
const HEADER = /^\[(?<id>[^\s·\]]+) · (?:Critical|Important|Minor)(?: · \d{1,3}%)?(?: · [^\]]*)?\]$/
const FILE_HEADING = /^## (?!#)(\S.*)$/
const LINE_HEADING = /^### Line (\d+)(?:-\d+)? \((new|old)\)$/
const START = '# Code Review Feedback'
const TAILS = ['Treat the findings above', 'Do not revise or reopen the reviewed changes']
const DIFF_LINE = /^\*\*Diff:\*\*/
const FILE_COMMENT = /^### File Comment$/
const FENCE = '```'
const SOURCE = 'review-kit'
const SIMILAR = 0.5

export type Decision = 'approved' | 'annotated' | 'dismissed'

export interface ParsedItem {
  file: string
  line: number | null
  side: 'new' | 'old' | 'file'
  text: string
}

function header(item: Finding): string {
  return `[${item.id} · ${LEVEL[item.severity]}${item.confidence === undefined ? '' : ` · ${item.confidence}%`}${item.mark ? ` · ${item.mark}` : ''}]`
}

export function annotations(findings: Finding[], texts: Texts): { source: string; annotations: Array<{ source: string; filePath: string; lineStart: number; lineEnd: number; text: string }> } {
  const missing = findings.filter(item => !(item.id in texts.comments)).map(item => item.id)
  if (missing.length) throw new Error(`нет текста для: ${missing.join(', ')}`)
  return { source: SOURCE, annotations: findings.map(item => ({ source: SOURCE, filePath: item.file, lineStart: item.line, lineEnd: item.line, text: `${header(item)}\n${texts.comments[item.id]}` })) }
}

export interface Hotspot {
  file: string
  line: number
  text: string
}

type Annotation = { source: string; filePath: string; lineStart: number; lineEnd: number; text: string }

export function hotspotAnnotations(items: Hotspot[], lineCounts: Map<string, number>): { annotations: Annotation[]; skipped: string[] } {
  const fits = (item: Hotspot) => Number.isInteger(item.line) && item.line >= 1 && item.line <= (lineCounts.get(item.file) ?? 0) && item.text.trim() !== ''
  return {
    annotations: items.flatMap((item, index) => (fits(item) ? [{ source: SOURCE, filePath: item.file, lineStart: item.line, lineEnd: item.line, text: `[g${index + 1} · ${HOTSPOT}]\n${item.text.trim()}` }] : [])),
    skipped: items.filter(item => !fits(item)).map(item => `${item.file}:${item.line}`),
  }
}

export function decisionOf(stdout: string): { decision: Decision; message?: string } {
  const text = stdout.trimStart()
  const end = text.split('').reduce<{ depth: number; at: number; quote: boolean; escape: boolean }>((s, char, index) => {
    if (s.at >= 0) return s
    if (s.quote) return { ...s, escape: !s.escape && char === '\\', quote: s.escape || char !== '"' }
    if (char === '"') return { ...s, quote: true }
    const depth = s.depth + (char === '{' ? 1 : char === '}' ? -1 : 0)
    return { ...s, depth, at: depth === 0 && char === '}' ? index : -1 }
  }, { depth: 0, at: -1, quote: false, escape: false }).at
  const parsed = (() => {
    try {
      return JSON.parse(text.slice(0, end + 1)) as Record<string, unknown>
    } catch (error) {
      throw new Error(`stdout Plannotator не JSON: ${(error as Error).message}`)
    }
  })()
  if (!parsed || !['approved', 'annotated', 'dismissed'].includes(String(parsed.decision))) throw new Error(`неизвестное решение: ${JSON.stringify(parsed).slice(0, 200)}`)
  return { decision: parsed.decision as Decision, ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}) }
}

function setBody(message: string): string {
  const start = message.indexOf(START)
  if (start < 0) return ''
  const body = message.slice(start + START.length)
  const cuts = TAILS.map(tail => body.indexOf(tail)).filter(at => at >= 0)
  return cuts.length ? body.slice(0, Math.min(...cuts)) : body
}

export function parseMessage(message: string): { items: ParsedItem[]; general: string[] } {
  const lines = setBody(message).split('\n')
  const trackFences = lines.filter(line => line.trimStart().startsWith(FENCE)).length % 2 === 0
  const items: Array<{ file: string; line: number | null; side: ParsedItem['side']; lines: string[] }> = []
  const general: string[] = []
  const state: { file: string | null; current: (typeof items)[number] | null; fence: boolean } = { file: null, current: null, fence: false }
  lines.forEach((raw, index) => {
    const opensFence = raw.trimStart().startsWith(FENCE)
    if (trackFences && state.current && (state.fence || opensFence)) {
      state.fence = state.fence !== opensFence
      state.current.lines.push(raw)
      return
    }
    const following = lines.slice(index + 1).find(line => line.trim()) ?? ''
    const lineHeading = LINE_HEADING.exec(raw)
    const fileHeading = LINE_HEADING.test(following) || FILE_COMMENT.test(following) ? FILE_HEADING.exec(raw) : null
    if (lineHeading && state.file) {
      state.current = { file: state.file, line: Number(lineHeading[1]), side: lineHeading[2] as 'new' | 'old', lines: [] }
      items.push(state.current)
    } else if (FILE_COMMENT.test(raw) && state.file) {
      state.current = { file: state.file, line: null, side: 'file', lines: [] }
      items.push(state.current)
    } else if (fileHeading) {
      state.file = fileHeading[1].trim()
      state.current = null
    } else if (state.current) state.current.lines.push(raw)
    else if (raw.trim() && !DIFF_LINE.test(raw.trim())) general.push(state.file ? `${state.file}: ${raw.trim()}` : raw.trim())
  })
  return { items: items.map(({ lines: body, ...item }) => ({ ...item, text: body.join('\n').trim() })), general }
}

function matched(a: string, b: string): number {
  if (!a || !b) return 0
  const best = { size: 0, i: 0, j: 0 }
  const lengths = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    for (let j = b.length; j >= 1; j--) {
      lengths[j] = a[i - 1] === b[j - 1] ? lengths[j - 1] + 1 : 0
      if (lengths[j] > best.size) Object.assign(best, { size: lengths[j], i: i - lengths[j], j: j - lengths[j] })
    }
  }
  if (best.size === 0) return 0
  return best.size + matched(a.slice(0, best.i), b.slice(0, best.j)) + matched(a.slice(best.i + best.size), b.slice(best.j + best.size))
}

export function similarity(a: string, b: string): number {
  return a.length + b.length === 0 ? 1 : (2 * matched(a, b)) / (a.length + b.length)
}

export function reconcile(decision: Decision, parsed: { items: ParsedItem[]; general: string[] }, posted: Finding[], texts: Texts): { ids: string[]; texts: Texts; findings: Finding[] } {
  if (decision === 'dismissed') return { ids: [], texts, findings: posted }
  const byId = new Map(posted.map(item => [item.id, item]))
  const used = new Set<string>()
  const comments: Record<string, string> = {}
  const extra: Finding[] = []
  const body = [...parsed.general]
  for (const item of parsed.items) {
    if (HOTSPOT_HEADER.test(item.text.split('\n')[0].trim())) continue
    if (item.side === 'file') { body.push(`- ${item.file} — ${item.text}`); continue }
    if (item.side === 'old') { body.push(`- ${item.file}:${item.line} (до изменения) — ${item.text}`); continue }
    const [first, ...rest] = item.text.split('\n')
    const head = HEADER.exec(first.trim())
    const text = head ? rest.join('\n').trim() : item.text
    const byHeader = head?.groups?.id && byId.has(head.groups.id) && !used.has(head.groups.id) ? head.groups.id : null
    const candidates = posted.filter(p => p.file === item.file && p.line === item.line && !used.has(p.id))
    const best = candidates.map(p => ({ id: p.id, score: similarity(text, texts.comments[p.id] ?? '') })).sort((a, b) => b.score - a.score)[0]
    const found = byHeader ?? (best && best.score >= SIMILAR ? best.id : null)
    if (found) {
      used.add(found)
      comments[found] = text
      continue
    }
    const id = `h${extra.length + 1}`
    extra.push({ id, file: item.file, line: item.line ?? 0, severity: 'minor', confidence: 100, problem: text })
    comments[id] = text
  }
  const summary = [Object.keys(comments).length ? (texts.summary ?? '').trim() : '', ...body].filter(Boolean).join('\n\n')
  return { ids: Object.keys(comments), texts: { summary, comments }, findings: [...posted, ...extra] }
}

export function fixResult(record: { decision: Decision; message?: string }): { summary: { decision: Decision; notes: number }; feedback: string } {
  const { items, general } = parseMessage(record.message ?? '')
  const lines = [...general, ...items.map(item => `- ${item.file}:${item.line ?? ''} — ${item.text}`)]
  return { summary: { decision: record.decision, notes: lines.length }, feedback: lines.join('\n') }
}
