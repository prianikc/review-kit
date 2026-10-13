import type { Reply, ReviewDraft } from '../forge/types.ts'
import { MARKER, type IntakeItem } from '../status.ts'
import type { Finding } from './findings.ts'

const APPROVABLE: readonly VerdictName[] = ['Approved', 'Approved with comments']
const DEFAULT_CHANGES_BODY = 'Нужны правки — см. комментарии.'
const DEFAULT_EMPTY_BODY = 'Замечаний нет.'
const UNRESOLVED = ['open', 'partial']
const STATUS_WORDS: Record<string, string> = { open: 'не закрыто', partial: 'частично', unknown: 'не проверено' }
const QUOTE_LIMIT = 200
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

export type VerdictName = 'Blocked' | 'Changes requested' | 'Approved with comments' | 'Approved'

export interface Texts {
  summary?: string
  comments: Record<string, string>
}

export function verdictName(findings: Array<{ severity: string }>, statuses: Array<{ class: string; severity?: string }> = []): VerdictName {
  const levels = new Set([...findings.map(item => item.severity), ...statuses.filter(s => UNRESOLVED.includes(s.class)).map(s => s.severity ?? 'important')])
  if (levels.has('critical')) return 'Blocked'
  if (levels.has('important')) return 'Changes requested'
  return levels.size ? 'Approved with comments' : 'Approved'
}

export function statusesBlock(statuses: Array<{ id: string; class: string; reason?: string }>, prior: Array<{ id: string; path: string | null; line: number | null }>): string {
  const place = new Map(prior.map(p => [p.id, p.path ? `${p.path}:${p.line}` : 'общее']))
  const count = (name: string) => statuses.filter(s => s.class === name).length
  const lines = statuses.filter(s => s.class in STATUS_WORDS).map(s => `- ${place.get(s.id) ?? s.id} — ${STATUS_WORDS[s.class]}: ${s.reason ?? ''}`)
  return [`Прошлые замечания: закрыто ${count('closed')}, не закрыто ${count('open')}, частично ${count('partial')}.`, ...lines].join('\n')
}

export function parseCovered(diffU0: string): Map<string, Set<number>> {
  const covered = new Map<string, Set<number>>()
  const state: { file: string | null } = { file: null }
  for (const line of diffU0.split('\n')) {
    if (line.startsWith('+++ ')) state.file = line === '+++ /dev/null' ? null : line.slice('+++ b/'.length)
    const hunk = HUNK.exec(line)
    if (hunk && state.file) {
      const start = Number(hunk[1])
      const length = hunk[2] === undefined ? 1 : Number(hunk[2])
      const lines = covered.get(state.file) ?? new Set<number>()
      for (let n = start; n < start + length; n++) lines.add(n)
      covered.set(state.file, lines)
    }
  }
  return covered
}

export function buildDraft({ selected, texts, verdict, approve, covered, capabilities }: { selected: Finding[]; texts: Texts; verdict: VerdictName; approve: boolean; covered: Map<string, Set<number>>; capabilities: { inline: boolean; requestChanges: boolean } }): { draft: ReviewDraft; notes: string[] } {
  if (approve && !APPROVABLE.includes(verdict)) throw new Error(`одобрение при вердикте ${verdict} невозможно`)
  const missing = selected.filter(item => !(item.id in texts.comments)).map(item => item.id)
  if (missing.length) throw new Error(`нет текста для: ${missing.join(', ')}`)
  const notes: string[] = []
  const wantsChanges = !approve && !APPROVABLE.includes(verdict)
  if (wantsChanges && !capabilities.requestChanges) notes.push('система не умеет «запросить изменения» — ревью опубликовано комментарием')
  if (!capabilities.inline && selected.length) notes.push('система не умеет комментарии к строкам — все комментарии в теле ревью')
  const inline = capabilities.inline ? selected.filter(item => covered.get(item.file)?.has(item.line)) : []
  const outside = selected.filter(item => !inline.includes(item))
  const parts = [(texts.summary ?? '').trim(), ...(outside.length ? [`Вне diff:\n${outside.map(item => `- ${item.file}:${item.line} — ${texts.comments[item.id]}`).join('\n')}`] : [])]
  const body = parts.filter(Boolean).join('\n\n')
  const comments = inline.map(item => ({ path: item.file, line: item.line, body: texts.comments[item.id] }))
  const draftVerdict = approve ? 'approve' : wantsChanges && capabilities.requestChanges ? 'request-changes' : 'comment'
  const finalBody = body || (draftVerdict === 'request-changes' ? DEFAULT_CHANGES_BODY : !comments.length && draftVerdict !== 'approve' ? DEFAULT_EMPTY_BODY : '')
  return { draft: { verdict: draftVerdict, body: finalBody, comments }, notes }
}

export function buildReplies(items: IntakeItem[], replies: Record<string, string>): Reply[] {
  const byId = new Map(items.map(item => [item.id, item]))
  const unknown = Object.keys(replies).filter(id => !byId.has(id))
  if (unknown.length) throw new Error(`нет пункта для ответа: ${unknown.join(', ')}`)
  return Object.entries(replies).filter(([, text]) => text.trim()).map(([id, text]) => {
    const item = byId.get(id) as IntakeItem
    const body = `${text.trim()}\n\n${MARKER}`
    return item.threadId ? { threadId: item.threadId, body } : { quote: item.quote.split('\n')[0].slice(0, QUOTE_LIMIT), body }
  })
}
