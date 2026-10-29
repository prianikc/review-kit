import type { Comment, ForgeProvider, PullRequest, Review, Thread } from './forge/types.ts'

export const MARKER = '<!-- review-kit -->'
export const ACTIONABLE: readonly Scenario[] = ['feedback', 'conflict', 'review', 'recheck']

export type Scenario = 'closed' | 'conflict' | 'feedback' | 'none-own' | 'review' | 'recheck' | 'wait-author'

export interface PrData {
  pull: PullRequest
  me: string
  reviews: Review[]
  threads: Thread[]
  general: Comment[]
  headAt?: string
}

export interface IntakeItem {
  id: string
  kind: 'thread' | 'issue' | 'review'
  reviewId: string | null
  threadId: string | null
  path: string | null
  position: number | null
  commitId: string
  author: string
  quote: string
  stale: boolean
  disagree: boolean
  at: string
}

export interface PriorItem {
  id: string
  reviewId: string
  threadId: string | null
  path: string | null
  line: number | null
  author: string
  body: string
  quote: string
  replies: PriorReply[]
}

export interface PriorReply {
  author: string
  body: string
}

export interface PrContext {
  number: number
  title: string
  author: string
  isOwn: boolean
  headRef: string
  headSha: string
  baseRef: string
  state: 'open' | 'closed'
  merged: boolean
  url: string
  scenario: Scenario
  status: Status
}

export interface ListRow {
  number: number
  title: string
  author: string
  isOwn: boolean
  headRef: string
  scenario: Scenario
  status: Status
  conflicted: boolean
}

function same(a: string, b: string): boolean {
  return a !== '' && a.toLowerCase() === b.toLowerCase()
}

function mine(comment: Comment, me: string): boolean {
  return same(comment.author, me) || comment.body.includes(MARKER)
}

function lastOf(thread: Thread): Comment {
  return thread.comments[thread.comments.length - 1]
}

export function live(data: PrData): { reviews: Review[]; threads: Thread[] } {
  const drafts = new Set(data.reviews.filter(review => review.state === 'pending').map(review => review.id))
  return {
    reviews: data.reviews.filter(review => !drafts.has(review.id)),
    threads: data.threads.filter(thread => thread.comments.length > 0 && !drafts.has(thread.comments[0].reviewId ?? '')),
  }
}

export async function loadPr(provider: ForgeProvider, number: number, pull?: PullRequest): Promise<PrData> {
  const [loaded, me, reviews, discussion] = await Promise.all([pull ?? provider.getPull(number), provider.currentUser(), provider.listReviews(number), provider.listThreads(number)])
  const headAt = same(loaded.author, me) ? await provider.commitDate(loaded.headSha).catch(() => '') : undefined
  return { pull: loaded, me, reviews, threads: discussion.threads, general: discussion.general, ...(headAt ? { headAt } : {}) }
}

export function intakeItems(data: PrData): IntakeItem[] {
  const { reviews, threads } = live(data)
  const { me } = data
  const myTimes = [
    ...[...threads.flatMap(thread => thread.comments), ...data.general].filter(comment => mine(comment, me)).map(comment => Date.parse(comment.createdAt)),
    ...reviews.filter(review => same(review.author, me)).map(review => Date.parse(review.submittedAt)),
  ]
  const myLast = Math.max(-Infinity, ...myTimes)
  const later = (iso: string) => Date.parse(iso) > myLast

  const threadItems: IntakeItem[] = threads.filter(thread => !thread.resolved && !mine(lastOf(thread), me)).map(thread => {
    const first = thread.comments[0]
    const commit = first.commitSha ?? ''
    return {
      id: `${first.reviewId ?? thread.id}/${first.id}`, kind: 'thread', reviewId: first.reviewId ?? null, threadId: thread.id, path: first.path ?? null,
      position: first.line ?? null, commitId: commit, author: lastOf(thread).author,
      quote: thread.comments.map(comment => `${comment.author}: ${comment.body}`).join('\n'), stale: commit !== data.pull.headSha,
      disagree: thread.comments.slice(0, -1).some(comment => mine(comment, me)), at: lastOf(thread).createdAt,
    }
  })
  const issueItems: IntakeItem[] = data.general.filter(comment => !mine(comment, me) && later(comment.createdAt)).map(comment => ({
    id: `issue/${comment.id}`, kind: 'issue', reviewId: null, threadId: null, path: null, position: null, commitId: '',
    author: comment.author, quote: comment.body, stale: false, disagree: false, at: comment.createdAt,
  }))
  const reviewItems: IntakeItem[] = reviews
    .filter(review => (review.state === 'changes' || review.state === 'comment') && review.body.trim() && !same(review.author, me) && later(review.submittedAt))
    .map(review => ({
      id: `review/${review.id}`, kind: 'review', reviewId: review.id, threadId: null, path: null, position: null, commitId: review.commitSha,
      author: review.author, quote: review.body, stale: false, disagree: false, at: review.submittedAt,
    }))
  return [...threadItems, ...issueItems, ...reviewItems]
}

function latestMine(reviews: Review[], me: string): Review | undefined {
  return reviews.filter(review => same(review.author, me)).sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt)).at(-1)
}

function awaitsMe(data: PrData): boolean {
  const pushed = Date.parse(data.headAt ?? '')
  return intakeItems(data).some(item => !(Date.parse(item.at) <= pushed))
}

export function scenarioOf(data: PrData): Scenario {
  if (data.pull.state === 'closed') return 'closed'
  if (same(data.pull.author, data.me)) return awaitsMe(data) ? 'feedback' : data.pull.conflicted ? 'conflict' : 'none-own'

  const { reviews, threads } = live(data)
  const last = latestMine(reviews, data.me)
  if (!last) return 'review'
  if (last.state === 'approved' && !last.dismissed) return 'wait-author'
  if (last.commitSha !== data.pull.headSha) return 'recheck'
  const answered = threads.some(thread => thread.comments.some(comment => same(comment.author, data.me)) && same(lastOf(thread).author, data.pull.author))
  return answered ? 'recheck' : 'wait-author'
}

export function priorComments(data: PrData): { review: Review; prior: PriorItem[] } | null {
  const { reviews, threads } = live(data)
  const last = latestMine(reviews, data.me)
  if (!last) return null
  const threadOf = (comment: Comment) => threads.find(item => item.comments.some(c => c.id === comment.id))
  const repliesTo = (comment: Comment): PriorReply[] => {
    const thread = threadOf(comment)
    const after = thread ? thread.comments.slice(thread.comments.findIndex(c => c.id === comment.id) + 1) : []
    return after.filter(c => !mine(c, data.me)).map(c => ({ author: c.author, body: c.body }))
  }
  const toPrior = (comment: Comment): PriorItem => {
    const reviewId = comment.reviewId ?? last.id
    return { id: `${reviewId}/${comment.id}`, reviewId, threadId: threadOf(comment)?.id ?? null, path: comment.path ?? null, line: comment.line ?? null, author: data.me, body: comment.body, quote: comment.body, replies: repliesTo(comment) }
  }
  const latest = threads.flatMap(thread => thread.comments).filter(comment => comment.reviewId === last.id && same(comment.author, data.me))
  const answered = threads
    .filter(thread => thread.comments[0].reviewId !== last.id && same(lastOf(thread).author, data.pull.author))
    .flatMap(thread => thread.comments.filter(comment => same(comment.author, data.me)).slice(0, 1))
  const prior: PriorItem[] = [...latest, ...answered].map(toPrior)
  const body: PriorItem[] = last.body.trim() ? [{ id: `review/${last.id}`, reviewId: last.id, threadId: null, path: null, line: null, author: data.me, body: last.body, quote: last.body, replies: [] }] : []
  return { review: last, prior: [...prior, ...body] }
}

export function contextOf(data: PrData, scenario: Scenario): PrContext {
  const { pull } = data
  return {
    number: pull.number, title: pull.title, author: pull.author, isOwn: same(pull.author, data.me), headRef: pull.headRef, headSha: pull.headSha,
    baseRef: pull.baseRef, state: pull.state, merged: pull.merged, url: pull.url, scenario, status: statusOf(data, scenario),
  }
}

export type Status = 'влит' | 'закрыт' | 'конфликт' | 'есть замечания' | 'на проверке' | 'перепроверка' | 'готов к слиянию' | 'ждём автора' | 'ждём ревью'
const PULL_LIMIT = 50
const PULL_CONCURRENCY = 4

function readyToMerge(data: PrData): boolean {
  const { reviews, threads } = live(data)
  const latest = new Map<string, Review>()
  for (const review of [...reviews].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt))) latest.set(review.author.toLowerCase(), review)
  const active = [...latest.values()].filter(review => !review.dismissed)
  return active.some(review => review.state === 'approved') && !active.some(review => review.state === 'changes') && threads.every(thread => thread.resolved)
}

export function statusOf(data: PrData, scenario: Scenario): Status {
  if (scenario === 'closed') return data.pull.merged ? 'влит' : 'закрыт'
  if (scenario === 'feedback') return 'есть замечания'
  if (scenario === 'conflict') return 'конфликт'
  if (scenario === 'review') return 'на проверке'
  if (scenario === 'recheck') return 'перепроверка'
  if (readyToMerge(data)) return 'готов к слиянию'
  return scenario === 'wait-author' ? 'ждём автора' : 'ждём ревью'
}

export async function pullRows(provider: ForgeProvider): Promise<{ rows: ListRow[]; truncated: boolean }> {
  const pulls = await provider.listPulls('open')
  const rows: ListRow[] = []
  for (let at = 0; at < pulls.length; at += PULL_CONCURRENCY) {
    const batch = await Promise.all(pulls.slice(at, at + PULL_CONCURRENCY).map(async pull => {
      const data = await loadPr(provider, pull.number, pull)
      const scenario = scenarioOf(data)
      return { number: pull.number, title: pull.title, author: pull.author, isOwn: same(pull.author, data.me), headRef: pull.headRef, scenario, status: statusOf(data, scenario), conflicted: pull.conflicted }
    }))
    rows.push(...batch)
  }
  const rank = (row: ListRow) => (ACTIONABLE.includes(row.scenario) ? 0 : 1)
  return { rows: rows.sort((a, b) => rank(a) - rank(b) || Number(b.isOwn) - Number(a.isOwn) || a.number - b.number), truncated: pulls.length >= PULL_LIMIT }
}

export function rowLine(row: ListRow): string {
  return `#${row.number} ${row.status}${row.conflicted ? ' · конфликт' : ''} · ${row.author} — ${row.title}`
}

export function prListText(rows: readonly ListRow[], truncated: boolean): string {
  if (rows.length === 0) return 'Открытых PR нет.'
  const due = rows.filter(row => ACTIONABLE.includes(row.scenario))
  const waiting = rows.filter(row => !ACTIONABLE.includes(row.scenario))
  const sections = [
    due.length ? `PR на проверку:\n${due.map(rowLine).join('\n')}` : '',
    waiting.length ? `PR, ожидающие решения:\n${waiting.map(rowLine).join('\n')}` : '',
    due.length ? 'Взять PR: /pr <номер> · все из «на проверку» сразу: /pr all' : 'Делать нечего.',
    truncated ? `Прочитано ${PULL_LIMIT} открытых PR — это предел одного запроса; если PR больше, остальные — /pr <номер>` : '',
  ]
  return sections.filter(Boolean).join('\n\n')
}

export function placeAll(rows: ReadonlyArray<{ number: number; isOwn: boolean; headRef: string }>, { mainBranch, hasOrca }: { mainBranch: string; hasOrca: boolean }): { tabs: number[]; here: number[] } {
  const here = rows.filter(row => !hasOrca || (row.isOwn && row.headRef === mainBranch)).map(row => row.number)
  return { tabs: rows.map(row => row.number).filter(number => !here.includes(number)), here }
}

export function splitHere(here: readonly number[], running: boolean): { start: number | undefined; later: number[] } {
  return running ? { start: undefined, later: [...here] } : { start: here[0], later: here.slice(1) }
}
