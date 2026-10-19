export interface PullRequest {
  number: number
  title: string
  body?: string
  author: string
  headRef: string
  headSha: string
  baseRef: string
  state: 'open' | 'closed'
  merged: boolean
  url: string
  conflicted: boolean
}

export interface Comment {
  id: string
  author: string
  body: string
  createdAt: string
  path?: string
  line?: number
  commitSha?: string
  reviewId?: string
}

export interface Thread {
  id: string
  path?: string
  line?: number
  commitSha?: string
  comments: Comment[]
  resolved: boolean
}

export interface Review {
  id: string
  author: string
  state: 'approved' | 'changes' | 'comment' | 'pending'
  body: string
  commitSha: string
  submittedAt: string
  dismissed: boolean
}

export type Verdict = 'approve' | 'request-changes' | 'comment'

export interface ReviewDraft {
  verdict: Verdict
  body: string
  comments: Array<{ path: string; line: number; body: string }>
}

export interface Reply {
  threadId?: string
  quote?: string
  body: string
}

export interface Repo {
  host: string
  owner: string
  repo: string
  scheme?: 'http' | 'https'
}

export interface HttpInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface HttpResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  text: string
}

export type Http = (url: string, init?: HttpInit) => Promise<HttpResponse>

export interface ProviderDeps {
  repo: Repo
  token: string
  http: Http
  sleep: (ms: number) => Promise<void>
}

export interface ForgeProvider {
  name: string
  capabilities: { inline: boolean; requestChanges: boolean }
  currentUser(): Promise<string>
  listPulls(state: 'open' | 'closed'): Promise<PullRequest[]>
  getPull(number: number): Promise<PullRequest>
  commitDate(sha: string): Promise<string>
  listReviews(number: number): Promise<Review[]>
  listThreads(number: number): Promise<{ threads: Thread[]; general: Comment[] }>
  publishReview(number: number, draft: ReviewDraft): Promise<{ url: string }>
  publishReplies(number: number, replies: Reply[]): Promise<void>
  pullRef(number: number): string
}

export interface ForgeAdapter {
  id: string
  name: string
  tokenEnv: readonly string[]
  detect(remoteUrl: string): Repo | null
  create(deps: ProviderDeps): ForgeProvider
}
