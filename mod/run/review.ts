import type { Reply, ReviewDraft } from '../forge/types.ts'
import { MARKER } from '../status.ts'
import type { Finding } from './findings.ts'
import type { DiscussionThread } from './discussion.ts'

export const APPROVABLE: readonly VerdictName[] = ['Approved', 'Approved with comments']
const DEFAULT_CHANGES_BODY = 'Нужны правки.'
const DEFAULT_EMPTY_BODY = 'Замечаний нет.'
const UNRESOLVED = ['open', 'partial', 'answered']
const SETTLED = ['closed', 'accepted']
const EMPTY_CHANGES = 'запрос изменений без комментариев не отправляется — выберите находки или одобрите'
const QUOTE_LIMIT = 200
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

export type VerdictName = 'Blocked' | 'Changes requested' | 'Approved with comments' | 'Approved'
export type ExplicitVerdict = 'approve' | 'request-changes'

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

export function chosenVerdict({ selected, statuses = [], decision, verdict, openThreads = 0, content = selected.length }: { selected: Array<{ severity: string }>; statuses?: Array<{ class: string; severity?: string }>; decision?: string; verdict?: ExplicitVerdict; openThreads?: number; content?: number }): VerdictName {
  if (verdict === 'approve' || decision === 'approved') return selected.length ? 'Approved with comments' : 'Approved'
  if (verdict === 'request-changes' || decision === 'annotated') {
    if (content === 0) throw new Error(EMPTY_CHANGES)
    return 'Changes requested'
  }
  if (content === 0) return 'Approved'
  const computed = verdictName(selected, statuses)
  return openThreads > 0 && APPROVABLE.includes(computed) ? 'Changes requested' : computed
}

export function openThreads(threads: DiscussionThread[], statuses: Array<{ id: string; class: string }> = []): string[] {
  const settled = new Set(statuses.filter(s => SETTLED.includes(s.class)).map(s => s.id.split('/').at(-1)))
  return threads.filter(thread => thread.status === 'open' && !thread.commentIds.some(id => settled.has(id))).map(thread => thread.id)
}

export function undecidedAnswers(statuses: Array<{ id: string; class: string }>): string[] {
  return statuses.filter(s => s.class === 'answered').map(s => s.id)
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
  const body = approve && !selected.length ? '' : parts.filter(Boolean).join('\n\n')
  const comments = inline.map(item => ({ path: item.file, line: item.line, body: texts.comments[item.id] }))
  const draftVerdict = approve ? 'approve' : wantsChanges && capabilities.requestChanges ? 'request-changes' : 'comment'
  const finalBody = body || (draftVerdict === 'request-changes' ? DEFAULT_CHANGES_BODY : !comments.length && draftVerdict !== 'approve' ? DEFAULT_EMPTY_BODY : '')
  return { draft: { verdict: draftVerdict, body: finalBody, comments }, notes }
}

export function buildReplies(items: Array<{ id: string; threadId: string | null; quote: string }>, replies: Record<string, string>): Reply[] {
  const byId = new Map(items.map(item => [item.id, item]))
  const unknown = Object.keys(replies).filter(id => !byId.has(id))
  if (unknown.length) throw new Error(`нет пункта для ответа: ${unknown.join(', ')}`)
  return Object.entries(replies).filter(([, text]) => text.trim()).map(([id, text]) => {
    const item = byId.get(id) as { threadId: string | null; quote: string }
    const body = `${text.trim()}\n\n${MARKER}`
    return item.threadId ? { threadId: item.threadId, body } : { quote: item.quote.split('\n')[0].slice(0, QUOTE_LIMIT), body }
  })
}
