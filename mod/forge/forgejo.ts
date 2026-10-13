import type { Comment, ForgeAdapter, ForgeProvider, ProviderDeps, PullRequest, Repo, Review, Thread, Verdict } from './types.ts'

const PAGE_LIMIT = 50
const FOREIGN_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org']
const REVIEW_STATES: Record<string, Review['state']> = { APPROVED: 'approved', REQUEST_CHANGES: 'changes', COMMENT: 'comment', PENDING: 'pending' }
const EVENTS: Record<Verdict, string> = { approve: 'APPROVED', 'request-changes': 'REQUEST_CHANGES', comment: 'COMMENT' }
const RECONCILE_ATTEMPTS = 3
const RECONCILE_PAUSE_MS = 5000
const UNKNOWN_STATUS = 'статус публикации неизвестен'

type RawUser = { login: string } | null
interface RawPull { number: number; title: string; user: RawUser; head: { ref: string; sha: string }; base: { ref: string }; state: string; merged?: boolean; html_url: string }
interface RawReview { id: number; user: RawUser; state: string; body?: string; commit_id: string; submitted_at: string | null; dismissed?: boolean; html_url?: string }
interface RawReviewComment { id: number; user: RawUser; body: string; created_at: string; path: string; position: number; commit_id: string; pull_request_review_id: number; resolver?: RawUser }
interface RawIssueComment { id: number; user: RawUser; body: string; created_at: string }

export function parseRemote(url: string): Repo | null {
  const full = /^([a-z+]+):\/\/(?:[^@/]+@)?([^/:]+)(:\d+)?\/(.+)$/i.exec(url.trim())
  const scp = /^[^@\s/]+@([^:\s/]+):(.+)$/.exec(url.trim())
  const web = full && /^https?$/i.test(full[1]) ? full[1].toLowerCase() : undefined
  const host = full ? `${full[2]}${web ? full[3] ?? '' : ''}` : scp?.[1]
  const path = full ? full[4] : scp?.[2]
  if (!host || !path) return null
  const parts = path.replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter(Boolean)
  if (parts.length < 2) return null
  return { host, owner: parts[parts.length - 2], repo: parts[parts.length - 1], ...(web === 'http' ? { scheme: 'http' as const } : {}) }
}

function login(user: RawUser): string {
  return user?.login ?? ''
}

function toPull(raw: RawPull): PullRequest {
  return {
    number: raw.number, title: raw.title, author: login(raw.user), headRef: raw.head.ref, headSha: raw.head.sha,
    baseRef: raw.base.ref, state: raw.state === 'closed' ? 'closed' : 'open', merged: Boolean(raw.merged), url: raw.html_url,
  }
}

function toReview(raw: RawReview): Review | null {
  const state = REVIEW_STATES[raw.state]
  return state ? { id: String(raw.id), author: login(raw.user), state, body: raw.body ?? '', commitSha: raw.commit_id, submittedAt: raw.submitted_at ?? '', dismissed: Boolean(raw.dismissed) } : null
}

function toCodeComment(raw: RawReviewComment): Comment {
  return { id: String(raw.id), author: login(raw.user), body: raw.body, createdAt: raw.created_at, path: raw.path, line: raw.position, commitSha: raw.commit_id, reviewId: String(raw.pull_request_review_id) }
}

function threadKey(raw: RawReviewComment): string {
  return `${raw.pull_request_review_id}:${raw.path}:${raw.position}`
}

function parseThreadKey(key: string): { reviewId: string; path: string; line: number } | null {
  const match = /^(\d+):(.+):(\d+)$/.exec(key)
  return match ? { reviewId: match[1], path: match[2], line: Number(match[3]) } : null
}

function toThreads(comments: RawReviewComment[]): Thread[] {
  const groups = comments.reduce((map, raw) => map.set(threadKey(raw), [...(map.get(threadKey(raw)) ?? []), raw]), new Map<string, RawReviewComment[]>())
  return [...groups].map(([id, group]) => {
    const sorted = [...group].sort((a, b) => a.created_at.localeCompare(b.created_at))
    return { id, path: sorted[0].path, line: sorted[0].position, commitSha: sorted[0].commit_id, comments: sorted.map(toCodeComment), resolved: sorted.some(raw => Boolean(raw.resolver)) }
  })
}

function createForgejo(deps: ProviderDeps): ForgeProvider {
  const repoPath = `/repos/${deps.repo.owner}/${deps.repo.repo}`
  const me: { value?: Promise<string> } = {}

  const request = async (method: string, path: string, body?: unknown): Promise<{ data: unknown; headers: Record<string, string> }> => {
    const response = await deps.http(`${deps.repo.scheme ?? 'https'}://${deps.repo.host}/api/v1${path}`, {
      method,
      headers: { Authorization: `token ${deps.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch(error => { throw new Error(`${method} ${path}: сеть: ${String(error)}`) })
    if (!response.ok) throw Object.assign(new Error(`${method} ${path}: HTTP ${response.status} ${response.text.slice(0, 500)}`), { status: response.status })
    return { data: response.text ? JSON.parse(response.text) : null, headers: response.headers }
  }

  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => (await request(method, path, body)).data

  const paged = async <T>(path: string): Promise<T[]> => {
    const all: T[] = []
    const join = path.includes('?') ? '&' : '?'
    for (let page = 1; ; page++) {
      const { data, headers } = await request('GET', `${path}${join}page=${page}&limit=${PAGE_LIMIT}`)
      const items = (data ?? []) as T[]
      all.push(...items)
      const total = Number(headers['x-total-count'])
      if (items.length === 0 || (Number.isFinite(total) && all.length >= total)) return all
    }
  }

  const rawReviews = (number: number) => paged<RawReview>(`${repoPath}/pulls/${number}/reviews`)

  const currentUser = (): Promise<string> => (me.value ??= call('GET', '/user').then(user => (user as { login: string }).login).catch(error => {
    me.value = undefined
    throw error
  }))

  return {
    name: forgejo.name,
    capabilities: { inline: true, requestChanges: true },
    currentUser,
    listPulls: async state => ((await call('GET', `${repoPath}/pulls?state=${state}&page=1&limit=${PAGE_LIMIT}`)) as RawPull[]).map(toPull),
    getPull: async number => toPull((await call('GET', `${repoPath}/pulls/${number}`)) as RawPull),
    listReviews: async number => (await rawReviews(number)).map(toReview).filter((review): review is Review => review !== null),
    listThreads: async number => {
      const reviews = (await rawReviews(number)).filter(review => REVIEW_STATES[review.state])
      const comments = (await Promise.all(reviews.map(review => call('GET', `${repoPath}/pulls/${number}/reviews/${review.id}/comments`)))).flat() as RawReviewComment[]
      const general = await paged<RawIssueComment>(`${repoPath}/issues/${number}/comments`)
      return { threads: toThreads(comments), general: general.map(raw => ({ id: String(raw.id), author: login(raw.user), body: raw.body, createdAt: raw.created_at })) }
    },
    publishReview: async (number, draft) => {
      const body = { body: draft.body, event: EVENTS[draft.verdict], comments: draft.comments.map(c => ({ path: c.path, new_position: c.line, body: c.body })) }
      const before = new Set((await rawReviews(number)).map(review => review.id))
      const author = (await currentUser()).toLowerCase()
      try {
        const posted = (await call('POST', `${repoPath}/pulls/${number}/reviews`, body)) as { html_url?: string }
        return { url: posted.html_url ?? '' }
      } catch (error) {
        if ((error as { status?: number }).status !== undefined) throw error
        for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
          if (attempt > 0) await deps.sleep(RECONCILE_PAUSE_MS)
          const reviews = await rawReviews(number).catch(() => undefined)
          const found = reviews?.filter(review => !before.has(review.id) && login(review.user).toLowerCase() === author && (review.body ?? '') === draft.body).at(-1)
          if (found) return { url: found.html_url ?? '' }
        }
        throw new Error(`${(error as Error).message}; ${UNKNOWN_STATUS} — проверьте PR ${number} перед повтором`)
      }
    },
    publishReplies: async (number, replies) => {
      const targets = replies.map(reply => {
        if (reply.threadId === undefined) return { reply, thread: null }
        const thread = parseThreadKey(reply.threadId)
        if (!thread) throw new Error(`неизвестный тред ${reply.threadId}`)
        return { reply, thread }
      })
      for (const [index, { reply, thread }] of targets.entries()) {
        try {
          if (thread) await call('POST', `${repoPath}/pulls/${number}/reviews/${thread.reviewId}/comments`, { path: thread.path, new_position: thread.line, body: reply.body })
          else await call('POST', `${repoPath}/issues/${number}/comments`, { body: reply.quote ? `> ${reply.quote}\n\n${reply.body}` : reply.body })
        } catch (error) {
          throw new Error(`${(error as Error).message}; уже отправлено ${index} из ${replies.length}`)
        }
      }
    },
    pullRef: number => `refs/pull/${number}/head`,
  }
}

export const forgejo: ForgeAdapter = {
  id: 'forgejo',
  name: 'Forgejo/Gitea',
  tokenEnv: ['FORGEJO_TOKEN', 'GITEA_TOKEN'],
  detect: remoteUrl => {
    const repo = parseRemote(remoteUrl)
    return repo && !FOREIGN_HOSTS.includes(repo.host.split(':')[0].toLowerCase()) ? repo : null
  },
  create: createForgejo,
}
