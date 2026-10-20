import type { Comment, Thread } from '../forge/types.ts'
import { MARKER, type IntakeItem, type PrData } from '../status.ts'
import type { TriageAnswer } from './findings.ts'

const BODY_LIMIT = 500
const LINE_LIMIT = 140
const VERDICTS: Record<string, string> = {
  valid: 'согласны — исправим', fixed: 'уже исправлено', invalid: 'не согласны — отклоняем', question: 'вопрос — нужен ответ', 'out-of-scope': 'вне задачи',
}
const TALLY: Array<[string, string]> = [['valid', 'исправим'], ['fixed', 'уже исправлено'], ['invalid', 'не согласны'], ['question', 'вопросы'], ['out-of-scope', 'вне задачи']]

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function mine(comment: Comment, me: string): boolean {
  return (comment.author !== '' && comment.author.toLowerCase() === me.toLowerCase()) || comment.body.includes(MARKER)
}

function place(path: string | null | undefined, line: number | null | undefined, kind = 'thread'): string {
  return path ? `\`${path}:${line ?? ''}\`` : kind === 'review' ? 'ревью' : 'общий'
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? ''
}

function itemLine(item: IntakeItem): string {
  const said = item.kind === 'thread' ? firstLine(item.quote) : `${item.author}: ${item.quote}`
  return `${place(item.path, item.position, item.kind)} — ${clip(said.replace(MARKER, ''), LINE_LIMIT)}`
}

function threadLine(thread: Thread): string {
  const first = thread.comments[0]
  return `- ${place(first.path, first.line)} — ${clip(`${first.author}: ${first.body.replace(MARKER, '')}`, LINE_LIMIT)}`
}

export function overviewText(data: PrData, items: IntakeItem[]): string {
  const { me } = data
  const drafts = new Set(data.reviews.filter(review => review.state === 'pending').map(review => review.id))
  const threads = data.threads.filter(thread => thread.comments.length > 0 && !drafts.has(thread.comments[0].reviewId ?? ''))
  const byId = new Map(threads.map(thread => [thread.id, thread]))
  const taken = new Set(items.map(item => item.threadId).filter(Boolean))
  const rest = threads.filter(thread => !taken.has(thread.id))
  const resolved = rest.filter(thread => thread.resolved)
  const waiting = rest.filter(thread => !thread.resolved)
  const todo = items.map((item, index) => {
    const marks = [...(item.stale ? ['код с тех пор менялся'] : []), ...(item.disagree ? ['ревьюер не согласен с ответом'] : [])]
    const thread = item.threadId ? byId.get(item.threadId) : undefined
    const comments = thread ? thread.comments : [{ id: item.id, author: item.author, body: item.quote, createdAt: item.at }]
    const said = comments.map(comment => `   > ${mine(comment, me) ? 'я' : comment.author}: ${clip(comment.body.replace(MARKER, ''), BODY_LIMIT)}`)
    return [`${index + 1}. ${place(item.path, item.position, item.kind)} · ${item.author}${marks.length ? ` · ${marks.join(' · ')}` : ''}`, ...said].join('\n')
  })
  return [
    `Замечания к PR ${data.pull.number}: к разбору ${items.length}, закрыто ${resolved.length}, ждут ответа ревьюера ${waiting.length}.`,
    ...(todo.length ? [`**К разбору**\n${todo.join('\n')}`] : []),
    ...(resolved.length ? [`**Закрыто**\n${resolved.map(threadLine).join('\n')}`] : []),
    ...(waiting.length ? [`**Ждут ответа ревьюера**\n${waiting.map(threadLine).join('\n')}`] : []),
  ].join('\n\n')
}

export function triageText(pr: number, items: IntakeItem[], answers: TriageAnswer[]): string {
  const byId = new Map(answers.map(answer => [answer.id, answer]))
  const kindOf = (answer: TriageAnswer | undefined) => (answer?.class === 'valid' && answer.fixed ? 'fixed' : answer?.class ?? 'question')
  const counts = TALLY.map(([kind, word]) => `${word} ${items.filter(item => kindOf(byId.get(item.id)) === kind).length}`)
  const lines = items.map((item, index) => {
    const answer = byId.get(item.id)
    const verdict = VERDICTS[kindOf(answer)] ?? kindOf(answer)
    return `${index + 1}. ${itemLine(item)}${item.disagree ? ' (ревьюер не согласен с прошлым ответом)' : ''}\n   → ${verdict}${answer?.reason ? `: ${answer.reason}` : ''}`
  })
  return [`Итог разбора PR ${pr}: ${counts.join(', ')}.`, ...lines].join('\n')
}
