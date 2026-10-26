import type { Comment, Review, Thread } from '../forge/types.ts'
import { live, MARKER, type PrData } from '../status.ts'

export const NO_DISCUSSION = 'обсуждения нет'
export const MAX_DISCUSSION_CHARS = 40_000
const BODY_LIMIT = 4_000
const STATES: Record<Review['state'], string> = { approved: 'APPROVED', changes: 'REQUEST_CHANGES', comment: 'COMMENT', pending: 'PENDING' }

export type LastWord = 'ревьюер' | 'автор' | 'мы'

export interface DiscussionThread {
  id: string
  place: string
  status: 'open' | 'resolved'
  last: LastWord
  lastAuthorReply?: string
  commentIds: string[]
}

export interface Discussion {
  threads: DiscussionThread[]
  questions: string[]
  text: string
  truncated: boolean
}

interface Entry {
  author: string
  body: string
  at: string
  source: string
}

function same(a: string, b: string): boolean {
  return a !== '' && a.toLowerCase() === b.toLowerCase()
}

function clip(text: string): string {
  const body = text.replace(MARKER, '').trim()
  return body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}… (обрезано)` : body
}

function at(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ')
}

export function discussionOf(data: PrData, { bots = [], limit = MAX_DISCUSSION_CHARS, description = false }: { bots?: readonly string[]; limit?: number; description?: boolean } = {}): Discussion {
  const { reviews, threads } = live(data)
  const author = data.pull.author
  const mine = (comment: { author: string; body: string }) => same(comment.author, data.me) || comment.body.includes(MARKER)
  const who = (comment: { author: string; body: string }) => {
    const marks = [...(mine(comment) ? ['мы'] : same(comment.author, author) ? ['автор'] : []), ...(bots.some(bot => same(bot, comment.author)) ? ['бот'] : [])]
    return `${comment.author}${marks.length ? ` [${marks.join(', ')}]` : ''}`
  }
  const lastWord = (comment: Comment): LastWord => (mine(comment) ? 'мы' : same(comment.author, author) ? 'автор' : 'ревьюер')
  const stateOf = new Map(reviews.map(review => [review.id, STATES[review.state]]))
  const reviewLabel = (id: string | undefined) => (id ? `ревью ${id}${stateOf.has(id) ? `, ${stateOf.get(id)}` : ''}` : 'ревью')

  const ordered = [...threads].sort((a, b) => a.comments[0].createdAt.localeCompare(b.comments[0].createdAt))
  const found: DiscussionThread[] = ordered.map((thread, index) => {
    const last = thread.comments[thread.comments.length - 1]
    const reply = thread.comments.slice(1).filter(comment => same(comment.author, author) && !mine(comment)).at(-1)
    return {
      id: `T${index + 1}`, place: `${thread.path ?? ''}:${thread.line ?? ''}`, status: thread.resolved ? 'resolved' : 'open', last: lastWord(last),
      ...(reply ? { lastAuthorReply: reply.body.trim() } : {}), commentIds: thread.comments.map(comment => comment.id),
    }
  })
  const threadBlock = (thread: Thread, info: DiscussionThread) => [
    `### ${info.id} · ${info.place} · ${info.status} · последнее слово: ${info.last}`,
    ...thread.comments.map(comment => `- ${who(comment)} (${reviewLabel(comment.reviewId)}): ${clip(comment.body)}`),
  ].join('\n')

  const entries: Entry[] = [
    ...data.general.map(comment => ({ author: comment.author, body: comment.body, at: comment.createdAt, source: `issue ${comment.id}, ${at(comment.createdAt)}` })),
    ...reviews.filter(review => review.body.trim()).map(review => ({ author: review.author, body: review.body, at: review.submittedAt, source: reviewLabel(review.id) })),
  ].sort((a, b) => a.at.localeCompare(b.at))
  const authorTimes = [...entries, ...threads.flatMap(thread => thread.comments).map(comment => ({ author: comment.author, body: comment.body, at: comment.createdAt }))]
    .filter(entry => same(entry.author, author) && !mine(entry)).map(entry => entry.at)
  const questions = entries
    .filter(entry => !same(entry.author, author) && !mine(entry) && entry.body.includes('?') && !authorTimes.some(time => time > entry.at))
    .map(entry => `${who(entry)}: ${clip(entry.body).replace(/\s+/g, ' ')} — ответа нет`)

  const byId = new Map(found.map((info, index) => [info.id, ordered[index]]))
  const threadBlocks = [...found].sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved')).map(info => threadBlock(byId.get(info.id) as Thread, info))
  const blocks: Array<{ section: string; text: string }> = [
    ...threadBlocks.map(text => ({ section: '', text })),
    ...entries.map(entry => ({ section: '### Общие комментарии', text: `- ${who(entry)} (${entry.source}): ${clip(entry.body)}` })),
    ...questions.map(question => ({ section: '### Вопросы без ответа', text: `- ${question}` })),
  ]
  const own = same(author, data.me)
  const summary = description && data.pull.body?.trim() ? [`### Описание PR\n${clip(data.pull.body)}`] : []
  const intro = [
    own
      ? 'Это свой PR: треды — замечания ревьюеров к нашему коду и наши ответы. Ссылайся на тред по его id (T1, T2…).'
      : 'Комментарии PR до этого прогона: инлайн-треды T1, T2… и общие комментарии по времени. Ссылайся на тред по его id.',
    ...summary,
  ].join('\n\n')

  const kept: string[] = []
  let size = intro.length
  let section = ''
  let shown = 0
  for (const block of blocks) {
    const head = block.section && block.section !== section ? `${block.section}\n` : ''
    if (size + head.length + block.text.length > limit) break
    kept.push(`${head}${block.text}`)
    size += head.length + block.text.length + 1
    section = block.section || section
    shown++
  }
  const truncated = shown < blocks.length
  const body = blocks.length === 0 && summary.length === 0 ? NO_DISCUSSION : [intro, kept.length ? kept.join('\n') : NO_DISCUSSION, ...(truncated ? [`… обсуждение обрезано: показано ${shown} из ${blocks.length} блоков`] : [])].join('\n\n')
  return { threads: found, questions, text: `## DISCUSSION\n${body}`, truncated }
}
