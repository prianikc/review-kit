import type { Comment, ForgeProvider, PullRequest, Review, Thread } from './forge/types.ts'

export const MARKER = '<!-- review-kit -->'
export const ACTIONABLE: readonly Scenario[] = ['feedback', 'review', 'recheck']

export type Scenario = 'closed' | 'feedback' | 'none-own' | 'review' | 'recheck' | 'wait-author'

export interface PrData {
  pull: PullRequest
  me: string
  reviews: Review[]
  threads: Thread[]
  general: Comment[]
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
}

export interface PriorItem {
  id: string
  reviewId: string
  path: string | null
  line: number | null
  author: string
  body: string
  quote: string
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
}

export interface ListRow {
  number: number
  title: string
  author: string
  isOwn: boolean
  scenario: Scenario
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

function live(data: PrData): { reviews: Review[]; threads: Thread[] } {
  const drafts = new Set(data.reviews.filter(review => review.state === 'pending').map(review => review.id))
  return {
    reviews: data.reviews.filter(review => !drafts.has(review.id)),
    threads: data.threads.filter(thread => thread.comments.length > 0 && !drafts.has(thread.comments[0].reviewId ?? '')),
  }
}

export async function loadPr(provider: ForgeProvider, number: number, pull?: PullRequest): Promise<PrData> {
  const [loaded, me, reviews, discussion] = await Promise.all([pull ?? provider.getPull(number), provider.currentUser(), provider.listReviews(number), provider.listThreads(number)])
  return { pull: loaded, me, reviews, threads: discussion.threads, general: discussion.general }
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
      disagree: thread.comments.slice(0, -1).some(comment => mine(comment, me)),
    }
  })
  const issueItems: IntakeItem[] = data.general.filter(comment => !mine(comment, me) && later(comment.createdAt)).map(comment => ({
    id: `issue/${comment.id}`, kind: 'issue', reviewId: null, threadId: null, path: null, position: null, commitId: '',
    author: comment.author, quote: comment.body, stale: false, disagree: false,
  }))
  const reviewItems: IntakeItem[] = reviews
    .filter(review => (review.state === 'changes' || review.state === 'comment') && review.body.trim() && !same(review.author, me) && later(review.submittedAt))
    .map(review => ({
      id: `review/${review.id}`, kind: 'review', reviewId: review.id, threadId: null, path: null, position: null, commitId: review.commitSha,
      author: review.author, quote: review.body, stale: false, disagree: false,
    }))
  return [...threadItems, ...issueItems, ...reviewItems]
}

function latestMine(reviews: Review[], me: string): Review | undefined {
  return reviews.filter(review => same(review.author, me)).sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt)).at(-1)
}

export function scenarioOf(data: PrData): Scenario {
  if (data.pull.state === 'closed') return 'closed'
  if (same(data.pull.author, data.me)) return intakeItems(data).length > 0 ? 'feedback' : 'none-own'

  const { reviews, threads } = live(data)
  const last = latestMine(reviews, data.me)
  if (!last) return 'review'
  if (last.commitSha !== data.pull.headSha) return 'recheck'
  const answered = threads.some(thread => thread.comments.some(comment => same(comment.author, data.me)) && same(lastOf(thread).author, data.pull.author))
  return answered ? 'recheck' : 'wait-author'
}

export function priorComments(data: PrData): { review: Review; prior: PriorItem[] } | null {
  const { reviews, threads } = live(data)
  const last = latestMine(reviews, data.me)
  if (!last) return null
  const toPrior = (comment: Comment): PriorItem => {
    const reviewId = comment.reviewId ?? last.id
    return { id: `${reviewId}/${comment.id}`, reviewId, path: comment.path ?? null, line: comment.line ?? null, author: data.me, body: comment.body, quote: comment.body }
  }
  const latest = threads.flatMap(thread => thread.comments).filter(comment => comment.reviewId === last.id && same(comment.author, data.me))
  const answered = threads
    .filter(thread => thread.comments[0].reviewId !== last.id && same(lastOf(thread).author, data.pull.author))
    .flatMap(thread => thread.comments.filter(comment => same(comment.author, data.me)).slice(0, 1))
  const prior: PriorItem[] = [...latest, ...answered].map(toPrior)
  const body: PriorItem[] = last.body.trim() ? [{ id: `review/${last.id}`, reviewId: last.id, path: null, line: null, author: data.me, body: last.body, quote: last.body }] : []
  return { review: last, prior: [...prior, ...body] }
}

export function contextOf(data: PrData, scenario: Scenario): PrContext {
  const { pull } = data
  return {
    number: pull.number, title: pull.title, author: pull.author, isOwn: same(pull.author, data.me), headRef: pull.headRef, headSha: pull.headSha,
    baseRef: pull.baseRef, state: pull.state, merged: pull.merged, url: pull.url, scenario,
  }
}

export async function actionableRows(provider: ForgeProvider): Promise<ListRow[]> {
  const rows: ListRow[] = []
  for (const pull of await provider.listPulls('open')) {
    const data = await loadPr(provider, pull.number, pull)
    const scenario = scenarioOf(data)
    if (ACTIONABLE.includes(scenario)) rows.push({ number: pull.number, title: pull.title, author: pull.author, isOwn: same(pull.author, data.me), scenario })
  }
  return rows.sort((a, b) => Number(b.isOwn) - Number(a.isOwn) || a.number - b.number)
}
